/**
 * Deciding whether the layout tree can be rebuilt without anyone noticing.
 *
 * Navigation is a Mobius translation, which is an isometry and so leaves the
 * nodes next to the selection wherever their depth in the layout tree put them
 * — measured, a band's own members sit at 0.937 while nodes two hops away sit
 * at 0.809. Rebuilding the tree on the selection fixes that and rearranges the
 * scene, which is worse to use.
 *
 * But not every rebuild is visible. The cost of one is paid only by the nodes
 * the viewer can actually resolve, and after a step to somewhere sparse there
 * may be none. Measured across four scenes: on 4 of 25 steps a rebuild moved
 * no legible node at all, while bringing the selection's own neighbours in
 * from 0.93 to 0.51.
 *
 * So the rule is not "rebuild at the extremes" — being stuck fires on 58% of
 * steps and costs 22 to 214 pixels of median movement when it does. The rule
 * is "rebuild when it is free", which cannot produce a visible rearrangement
 * because not producing one is the entry condition.
 *
 * It also pays forward. A rebuild re-anchors the tree where the visitor is, so
 * the *translations* that follow land better: across the same walks, the share
 * of a selection's neighbours that are legible goes from 38% to 51%, and most
 * of that gain is on steps where nothing was rebuilt at all.
 *
 * Only one transform is available for hiding the change. Both the old and the
 * new layout put the selection at the origin, so anything carrying one onto
 * the other has to fix the origin, and the only such Mobius transformation is
 * a rotation. One degree of freedom is the entire budget — which is why the
 * answer is to pick the moments when nothing needs hiding rather than to hide
 * harder.
 */

/**
 * A node at the origin has no angle. theta is whatever the layout last left in
 * the field and a sub-pixel wobble swings it by pi, so the focused node — the
 * one the eye cares about most — is exactly the sample that must not vote.
 */
export const ORIGIN_RADIUS = 0.15;

/**
 * Past this radius a node is a dot among dots: no label, nothing to track,
 * nothing to notice moving. Everything beyond it is free to be rearranged.
 */
export const LEGIBLE_RADIUS = 0.9;

/**
 * How much a node's angle counts towards the fit.
 *
 * Only what is on screen now has a vote. The fit exists to make the rebuilt
 * layout agree with the view the visitor is looking at, and a node they cannot
 * resolve has no opinion about that — including one that is about to arrive
 * from the rim, which is the gain being sought rather than a cost to minimise.
 *
 * @param {number} rho radius in the layout being left
 * @returns {number} weight, 0 when the node is not something being tracked
 */
export function angleWeight(rho) {
    if (!(rho >= ORIGIN_RADIUS)) return 0;
    if (!(rho < LEGIBLE_RADIUS)) return 0;
    return 1 - rho;
}

/**
 * The rotation that best carries the new layout onto the old one.
 *
 * This is the circular mean of the per-node angular differences, which is the
 * exact minimiser of the weighted sum of 1 - cos(error) — the right objective
 * on a circle, and the reason this needs no iteration. Averaging the angles as
 * numbers would be wrong: 359 and 1 degree average to 180.
 *
 * @param {Array<{fromTheta: number, fromRho: number, toTheta: number, toRho: number}>} samples
 * @returns {number} radians to add to every angle of the new layout; 0 when
 *   nothing in the two layouts can be compared
 */
export function bestFitRotation(samples) {
    let re = 0;
    let im = 0;

    for (const s of samples) {
        const w = angleWeight(s.fromRho);
        if (w === 0) continue;
        const d = s.fromTheta - s.toTheta;
        re += w * Math.cos(d);
        im += w * Math.sin(d);
    }

    // No usable samples, or samples that cancel exactly: both give a resultant
    // at the origin, where the mean direction is undefined. Not rotating is the
    // honest answer, and atan2(0, 0) returning 0 happens to be it — but say so
    // rather than leaning on that.
    if (re === 0 && im === 0) return 0;

    return Math.atan2(im, re);
}

/**
 * Euclidean distance between two angles-and-radii, in rendered pixels.
 *
 * @param {{theta: number, rho: number}} a
 * @param {{theta: number, rho: number}} b
 * @param {number} diskRadius pixels from the centre of the disk to its rim
 * @returns {number}
 */
function separationPx(a, b, diskRadius) {
    const dx = a.rho * Math.cos(a.theta) - b.rho * Math.cos(b.theta);
    const dy = a.rho * Math.sin(a.theta) - b.rho * Math.sin(b.theta);
    return Math.hypot(dx, dy) * diskRadius;
}

/**
 * Whether a rebuilt layout can replace the current one unnoticed.
 *
 * Reports in pixels, not in disk units, because the question is whether an eye
 * would catch it and "0.1 of a disk radius" answers that for nobody.
 *
 * @param {Array<{fromTheta: number, fromRho: number, toTheta: number, toRho: number}>} samples
 *   one per node: where it is now, and where the rebuilt layout would put it
 * @param {number} diskRadius pixels from the centre of the disk to its rim
 * @param {number} gatePx the most any legible node may move
 * @returns {{spin: number, worstPx: number, free: boolean, judged: number}}
 *   `spin` is the rotation to apply to the rebuilt layout; `judged` is how many
 *   nodes had a say, which is 0 when the view holds nothing to disturb.
 */
export function rebuildVerdict(samples, diskRadius, gatePx) {
    const spin = bestFitRotation(samples);

    let worstPx = 0;
    let judged = 0;
    for (const s of samples) {
        // The gate is about what is visible now. A node arriving from the rim
        // is the point of the exercise, not a cost.
        if (!(s.fromRho < LEGIBLE_RADIUS)) continue;
        // The focused node sits at the origin in both layouts, so it cannot
        // move and its angle means nothing. Only it qualifies: a node merely
        // *near* the centre that moves is as visible as anything on screen,
        // which is why this tests both radii and not just one.
        if (s.fromRho < ORIGIN_RADIUS && s.toRho < ORIGIN_RADIUS) continue;
        judged++;
        worstPx = Math.max(worstPx, separationPx(
            { theta: s.fromTheta, rho: s.fromRho },
            { theta: s.toTheta + spin, rho: s.toRho },
            diskRadius
        ));
    }

    return { spin, worstPx, free: worstPx < gatePx, judged };
}
