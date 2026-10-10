/**
 * Which label wins when two would overlap.
 *
 * The geometry here is trivial; the ordering is the whole point. A collision
 * resolver that keeps the most labels, or keeps whichever it happened to see
 * first, will cheerfully suppress the name of the node the visitor just
 * selected — which is worse than the pile it replaced.
 */

import {
    LABEL_TIER,
    rankLabels,
    overlaps,
    resolveLabelCollisions,
} from '../../../frontend/src/visualization/labelPriority.js';

/** A candidate at a given spot, 100x20 unless told otherwise. */
const at = (id, x, y, extra = {}) => ({
    id,
    tier: LABEL_TIER.OTHER,
    centrality: 0.5,
    box: { x, y, w: 100, h: 20 },
    ...extra,
});

describe('the tier order', () => {
    test('is selection, then hover, then neighbours, then groups, then the rest', () => {
        // Spelled out so a reordering has to be deliberate.
        expect(LABEL_TIER.SELECTED).toBeLessThan(LABEL_TIER.HOVERED);
        expect(LABEL_TIER.HOVERED).toBeLessThan(LABEL_TIER.NEIGHBOUR);
        expect(LABEL_TIER.NEIGHBOUR).toBeLessThan(LABEL_TIER.GROUP);
        expect(LABEL_TIER.GROUP).toBeLessThan(LABEL_TIER.OTHER);
    });
});

describe('ranking', () => {
    test('puts a lower tier first regardless of position', () => {
        const ranked = rankLabels([
            at('person', 0, 0, { tier: LABEL_TIER.OTHER, centrality: 0.01 }),
            at('selected', 500, 500, { tier: LABEL_TIER.SELECTED, centrality: 0.99 }),
        ]);
        expect(ranked.map((c) => c.id)).toEqual(['selected', 'person']);
    });

    test('within a tier, nearer the centre comes first', () => {
        const ranked = rankLabels([
            at('far', 0, 0, { centrality: 0.9 }),
            at('near', 0, 0, { centrality: 0.1 }),
            at('middle', 0, 0, { centrality: 0.5 }),
        ]);
        expect(ranked.map((c) => c.id)).toEqual(['near', 'middle', 'far']);
    });

    test('an exact tie is broken by id, so the order cannot flicker', () => {
        // Two labels at the same radius swapping on every plot would flicker
        // against each other where they overlap.
        const input = [at('b', 0, 0), at('a', 0, 0)];
        expect(rankLabels(input).map((c) => c.id)).toEqual(['a', 'b']);
        expect(rankLabels([...input].reverse()).map((c) => c.id)).toEqual(['a', 'b']);
    });

    test('does not disturb the caller array', () => {
        const input = [at('b', 0, 0), at('a', 0, 0)];
        rankLabels(input);
        expect(input.map((c) => c.id)).toEqual(['b', 'a']);
    });
});

describe('overlap', () => {
    test('two boxes side by side with a gap do not overlap', () => {
        expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 })).toBe(false);
    });

    test('touching counts as overlapping, because adjacent text is unreadable', () => {
        expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(true);
    });

    test('the padding is respected', () => {
        const a = { x: 0, y: 0, w: 10, h: 10 };
        const b = { x: 11, y: 0, w: 10, h: 10 };
        expect(overlaps(a, b, 0)).toBe(false);
        expect(overlaps(a, b, 5)).toBe(true);
    });

    test('vertical separation alone is enough', () => {
        expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 40, w: 10, h: 10 })).toBe(false);
    });
});

describe('resolving a pile', () => {
    test('the selected label is kept even when everything overlaps it', () => {
        const kept = resolveLabelCollisions([
            at('a', 0, 0),
            at('b', 2, 2),
            at('selected', 1, 1, { tier: LABEL_TIER.SELECTED }),
        ]);
        expect(kept.has('selected')).toBe(true);
        expect(kept.size).toBe(1);
    });

    test('labels that do not overlap are all kept', () => {
        const kept = resolveLabelCollisions([
            at('a', 0, 0), at('b', 0, 40), at('c', 0, 80),
        ]);
        expect([...kept].sort()).toEqual(['a', 'b', 'c']);
    });

    test('a hovered label beats a group, and a group beats a person', () => {
        const kept = resolveLabelCollisions([
            at('person', 0, 0, { tier: LABEL_TIER.OTHER }),
            at('group', 1, 1, { tier: LABEL_TIER.GROUP }),
            at('hovered', 2, 2, { tier: LABEL_TIER.HOVERED }),
        ]);
        expect([...kept]).toEqual(['hovered']);
    });

    test('a neighbour of the selection outranks an unrelated group', () => {
        const kept = resolveLabelCollisions([
            at('unrelated-group', 0, 0, { tier: LABEL_TIER.GROUP }),
            at('neighbour', 1, 1, { tier: LABEL_TIER.NEIGHBOUR }),
        ]);
        expect([...kept]).toEqual(['neighbour']);
    });

    test('a loser does not block a third label it never touched', () => {
        // Greedy over *kept* boxes, not over all candidates: the suppressed one
        // must not cast a shadow.
        //
        // The three rows are 20 tall and stacked at 0, 18 and 36, which is the
        // only arrangement that tests this: 'shadow' has to overlap 'loser'
        // without overlapping 'winner', or it survives either way and the test
        // says nothing. Placed further down it is out of reach of the shadow
        // and the assertion passes against a resolver that keeps every box it
        // has seen.
        const kept = resolveLabelCollisions([
            at('winner', 0, 0, { tier: LABEL_TIER.GROUP }),
            at('loser', 0, 18, { tier: LABEL_TIER.OTHER, centrality: 0.5 }),
            at('shadow', 0, 36, { tier: LABEL_TIER.OTHER, centrality: 0.6 }),
        ]);
        expect([...kept].sort()).toEqual(['shadow', 'winner']);
    });

    test('an unmeasured label is drawn rather than suppressed on no evidence', () => {
        // A label that has never been visible has no offsetWidth. Hiding it for
        // that reason would mean a label that can never appear.
        const kept = resolveLabelCollisions([
            at('measured', 0, 0),
            { id: 'fresh', tier: LABEL_TIER.OTHER, centrality: 0.5, box: { x: 0, y: 0, w: 0, h: 0 } },
        ]);
        expect(kept.has('fresh')).toBe(true);
    });

    test('an unmeasured label does not block a measured one either', () => {
        const kept = resolveLabelCollisions([
            { id: 'fresh', tier: LABEL_TIER.SELECTED, centrality: 0, box: { x: 0, y: 0, w: 0, h: 0 } },
            at('measured', 0, 0),
        ]);
        expect([...kept].sort()).toEqual(['fresh', 'measured']);
    });

    test('nothing in, nothing out', () => {
        expect(resolveLabelCollisions([]).size).toBe(0);
    });

    test('the result is the same whatever order the caller supplies', () => {
        const candidates = [
            at('p1', 0, 0, { tier: LABEL_TIER.OTHER, centrality: 0.7 }),
            at('g1', 4, 4, { tier: LABEL_TIER.GROUP, centrality: 0.3 }),
            at('p2', 0, 60, { tier: LABEL_TIER.OTHER, centrality: 0.2 }),
            at('g2', 0, 120, { tier: LABEL_TIER.GROUP, centrality: 0.9 }),
        ];
        const forward = [...resolveLabelCollisions(candidates)].sort();
        const backward = [...resolveLabelCollisions([...candidates].reverse())].sort();
        expect(forward).toEqual(backward);
    });
});
