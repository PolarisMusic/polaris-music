/**
 * How much of the circle each neighbour of the selected node gets.
 *
 * JIT hands every node's children slices of its wedge in proportion to subtree
 * size, which is right in a tree — a branch with four hundred descendants
 * needs room for them. At the selection it is wrong: `_treeAngularWidth` makes
 * no distinction between "this child is a leaf" and "this child is worth
 * looking at", so a band's five members, all leaves, shared a couple of
 * degrees between them while one sibling with a large subtree took the rest of
 * the circle. They came out bunched into a slot narrower than their own
 * labels.
 *
 * Driven against a stub hypertree rather than a browser: what is at stake is
 * the arithmetic of the shares, and the e2e suite can only see that the fan
 * looks wider.
 */

import { describe, test, expect } from '@jest/globals';
import { computeStablePositions } from '../../../frontend/src/visualization/stableRadialLayout.js';

/**
 * A node that behaves enough like JIT's for the layout.
 *
 * @param {string} id
 * @param {number} subtreeWidth - What computeAngularWidths would have set.
 * @param {{x: number, y: number}} at - Where it currently sits on screen.
 */
function node(id, subtreeWidth, at) {
    const data = {};
    return {
        id,
        _treeAngularWidth: subtreeWidth,
        children: [],
        pos: { getc: () => at },
        endPos: {
            setp(theta, radius) { this.theta = theta; this.radius = radius; },
        },
        setData(key, value) { data[key] = value; },
        getData(key) { return data[key]; },
        eachSubnode(fn) { this.children.forEach(fn); },
    };
}

/** Lay out a root with the given children and report each one's span. */
function spansFor(children) {
    const root = node('root', children.reduce((s, c) => s + c._treeAngularWidth, 0),
        { x: 0, y: 0 });
    root.children = children;

    const nodes = [root, ...children];
    const ht = {
        root: 'root',
        graph: {
            getNode: (id) => nodes.find((n) => n.id === id),
            computeLevels: () => {},
        },
        computeAngularWidths: () => {},
        createLevelDistanceFunc: () => () => 0.5,
    };
    const graphUtil = {
        eachBFS: (_graph, _rootId, fn) => { fn(root); children.forEach(fn); },
    };

    computeStablePositions(ht, graphUtil);
    return new Map(children.map((c) => [c.id, c.getData('span')]));
}

/** Five leaves and one branch with a large subtree, spread round the circle. */
const around = (count) => Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    return node(`n${i}`, 1, { x: Math.cos(angle), y: Math.sin(angle) });
});

describe('the ring around the selected node', () => {
    test('a leaf beside a large branch is not squeezed into nothing', () => {
        // The shape of the complaint: before this, the leaves shared
        // 6/(6+400) of the circle — about five degrees between the five of
        // them, label included.
        const children = around(6);
        children[5]._treeAngularWidth = 400;

        const spans = spansFor(children);
        const leafDegrees = (spans.get('n0') * 180) / Math.PI;

        expect(leafDegrees).toBeGreaterThan(25);
    });

    test('every neighbour clears half of an equal share', () => {
        const children = around(6);
        children[5]._treeAngularWidth = 400;

        const spans = spansFor(children);
        const equal = (Math.PI * 2) / 6;
        for (const [, span] of spans) {
            expect(span).toBeGreaterThanOrEqual(equal * 0.5 - 1e-9);
        }
    });

    test('the big branch still gets the most room', () => {
        // A floor, not a levelling: subtree size still decides the remainder,
        // so a branch that needs space still gets it.
        const children = around(6);
        children[5]._treeAngularWidth = 400;

        const spans = spansFor(children);
        expect(spans.get('n5')).toBeGreaterThan(spans.get('n0') * 3);
    });

    test('the shares still fill the circle exactly', () => {
        const children = around(6);
        children[5]._treeAngularWidth = 400;

        const total = [...spansFor(children).values()].reduce((a, b) => a + b, 0);
        expect(total).toBeCloseTo(Math.PI * 2, 9);
    });

    test('equal subtrees are still spread evenly', () => {
        const spans = spansFor(around(5));

        for (const [, span] of spans) {
            expect(span).toBeCloseTo((Math.PI * 2) / 5, 9);
        }
    });

    test('a lone neighbour still takes the whole circle', () => {
        const spans = spansFor(around(1));

        expect(spans.get('n0')).toBeCloseTo(Math.PI * 2, 9);
    });

    test('the order on the ring is unchanged', () => {
        // The floor changes widths only. Nobody crossing anybody is what makes
        // the motion followable, and it must survive this.
        const children = around(6);
        children[5]._treeAngularWidth = 400;
        spansFor(children);

        // CYCLIC order: where the fan starts is free — the root's offset is
        // the circular mean of where its children already are — so the ring
        // can be rotated without anybody having crossed anybody.
        const byAngle = [...children]
            .sort((a, b) => a.endPos.theta - b.endPos.theta)
            .map((c) => c.id);
        const from = byAngle.indexOf('n0');
        const rotated = [...byAngle.slice(from), ...byAngle.slice(0, from)];
        expect(rotated).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
    });
});

describe('rings further out, which keep JIT’s proportions', () => {
    /**
     * The floor is for the selection's own ring and nowhere else. Deeper
     * down, subtree size is the right allocator and the radii depend on it: a
     * branch with four hundred descendants needs room for them, and levelling
     * the shares would overlap them.
     */
    function grandchildSpans(widths) {
        const grandchildren = widths.map((width, i) => {
            const angle = (i / widths.length) * Math.PI * 2;
            return node(`g${i}`, width, { x: 2 * Math.cos(angle), y: 2 * Math.sin(angle) });
        });
        const child = node('child', widths.reduce((a, b) => a + b, 0), { x: 1, y: 0 });
        child.children = grandchildren;
        const root = node('root', child._treeAngularWidth, { x: 0, y: 0 });
        root.children = [child];

        const nodes = [root, child, ...grandchildren];
        const ht = {
            root: 'root',
            graph: {
                getNode: (id) => nodes.find((n) => n.id === id),
                computeLevels: () => {},
            },
            computeAngularWidths: () => {},
            createLevelDistanceFunc: () => () => 0.5,
        };
        const graphUtil = {
            eachBFS: (_graph, _rootId, fn) => { fn(root); fn(child); grandchildren.forEach(fn); },
        };

        computeStablePositions(ht, graphUtil);
        return grandchildren.map((g) => g.getData('span'));
    }

    test('a deep leaf beside a deep branch is NOT floored', () => {
        // This is what the mutation that applied the floor everywhere got
        // wrong, and nothing caught it until this test existed.
        const [leaf, branch] = grandchildSpans([1, 99]);

        expect(branch / leaf).toBeCloseTo(99, 6);
    });

    test('a deep ring still fills its parent’s wedge exactly', () => {
        const spans = grandchildSpans([1, 99]);
        const child = Math.PI * 2; // the only child of the root takes it all

        expect(spans.reduce((a, b) => a + b, 0)).toBeCloseTo(child, 9);
    });
});
