/**
 * Deciding which labels survive when they would overlap.
 *
 * The graph places each label under its node and decides visibility from
 * distance, selection and hover — one label at a time, with no knowledge of
 * the others. In a dense neighbourhood that produces a pile: several names
 * drawn on top of each other, none of them readable, and no way to tell which
 * belongs to which node.
 *
 * Suppressing rather than stacking means something has to lose, so the order
 * matters more than the geometry. The order is what the visitor is doing: the
 * node they chose, the one they are pointing at, the ones connected to their
 * choice, then groups, then everybody else. Within a tier the one nearer the
 * centre of the disk wins, because that is the one they can actually read.
 *
 * Pure: boxes and ranks in, a set of survivors out. The measuring and the DOM
 * belong to the caller.
 *
 * @module visualization/labelPriority
 */

/**
 * Priority tiers, lowest number wins.
 *
 * Exported so the caller names a tier instead of writing a number, and so a
 * test fails if the order is ever quietly rearranged.
 */
export const LABEL_TIER = {
    SELECTED: 0,
    HOVERED: 1,
    NEIGHBOUR: 2,
    GROUP: 3,
    OTHER: 4,
};

/** Pixels of clear space required between two labels. */
export const LABEL_PADDING_PX = 2;

/**
 * @typedef {object} LabelCandidate
 * @property {string} id
 * @property {number} tier - one of LABEL_TIER
 * @property {number} centrality - squared Poincaré norm; smaller is nearer
 * @property {{x: number, y: number, w: number, h: number}} box - screen rect
 */

/**
 * Order candidates by what the visitor is doing, then by readability.
 *
 * Returns a new array; the caller's order is often the graph's own iteration
 * order and should not be disturbed.
 *
 * @param {LabelCandidate[]} candidates
 * @returns {LabelCandidate[]}
 */
export function rankLabels(candidates) {
    return [...candidates].sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        if (a.centrality !== b.centrality) return a.centrality - b.centrality;
        // Ties broken by id so the result is stable frame to frame. Without
        // this, two labels at the same radius could swap on every plot and
        // flicker against each other.
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/**
 * Whether two screen rects are within the padding of each other.
 *
 * @param {{x: number, y: number, w: number, h: number}} a
 * @param {{x: number, y: number, w: number, h: number}} b
 * @param {number} [padding]
 * @returns {boolean}
 */
export function overlaps(a, b, padding = LABEL_PADDING_PX) {
    return (
        a.x < b.x + b.w + padding &&
        b.x < a.x + a.w + padding &&
        a.y < b.y + b.h + padding &&
        b.y < a.y + a.h + padding
    );
}

/**
 * The labels that get drawn.
 *
 * Greedy in priority order: the highest-priority label is always kept, and
 * each one after it is kept only if it is clear of everything already kept.
 * Greedy rather than optimal on purpose — the optimal set would maximise the
 * *number* of labels drawn, which is a different thing from showing the ones
 * being looked at, and would also let the selected node's own name lose.
 *
 * @param {LabelCandidate[]} candidates
 * @param {number} [padding]
 * @returns {Set<string>} ids to draw
 */
export function resolveLabelCollisions(candidates, padding = LABEL_PADDING_PX) {
    const kept = [];
    const ids = new Set();

    for (const candidate of rankLabels(candidates)) {
        // A label with no measured size cannot be collided against; drawing it
        // is better than suppressing it on no evidence, and it will have a size
        // by the next frame.
        if (!candidate.box || candidate.box.w <= 0 || candidate.box.h <= 0) {
            ids.add(candidate.id);
            continue;
        }

        const clear = kept.every((other) => !overlaps(candidate.box, other, padding));
        if (clear) {
            kept.push(candidate.box);
            ids.add(candidate.id);
        }
    }

    return ids;
}
