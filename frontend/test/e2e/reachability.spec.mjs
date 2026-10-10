/**
 * Whether the node you selected has its own neighbours around it.
 *
 * The Hypertree lays out a BFS tree and navigates by Möbius transform, which is
 * an isometry — so a node's radius after centring is fixed by its distance in
 * the *layout tree*, not in the graph. In a tree those agree. This is not a
 * tree: two bands sharing a session player are one hop apart in the graph and
 * two levels apart in the layout, and hyperbolic space charges exponentially
 * for the difference.
 *
 * Measured before the fix, focusing a band put its own members at a median
 * radius of 0.937 while nodes two hops away sat at 0.809 — nearer. The
 * screenshots in scripts/compareReachability.mjs show what that means: the
 * selected band's members pressed into the rim, unlabelled, their node circles
 * clipped by the canvas edge. Not literally off-canvas — measured, their
 * centres stay inside the canvas rect by about 16px, which is why the obvious
 * "is it on screen" assertion cannot tell the two builds apart and is not
 * written here. Radius and legibility can.
 *
 * The property worth pinning is monotonicity. "One-hop neighbours are close" is
 * a threshold that will drift with the layout; "nothing two hops away is nearer
 * than something one hop away" is the thing that was false and made the view
 * read as arbitrary.
 */

import { test, expect } from '@playwright/test';

/** Bands sharing one session player: graph distance and tree distance disagree. */
function sharedScene(groups, members) {
    const nodes = [{ id: 'per:hub', name: 'Session Player', type: 'person' }];
    const edges = [];
    for (let g = 0; g < groups; g++) {
        nodes.push({ id: `grp:${g}`, name: `Band ${g}`, type: 'group' });
        edges.push({ source: 'per:hub', target: `grp:${g}`, type: 'MEMBER_OF', role: 'guest' });
        for (let m = 0; m < members; m++) {
            nodes.push({ id: `per:${g}_${m}`, name: `Member ${g}-${m}`, type: 'person' });
            edges.push({ source: `per:${g}_${m}`, target: `grp:${g}`, type: 'MEMBER_OF', role: 'player' });
        }
    }
    return { nodes, edges };
}

const SCENE = sharedScene(4, 4);

async function boot(page, graph = SCENE) {
    await page.route('**/api/**', (route) => {
        const url = decodeURIComponent(route.request().url());
        if (url.includes('/stake/')) {
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, units: '0', formatted: '0.0000 MUS', stakerCount: 0 }),
            });
        }
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) });
    });
    await page.route('**/graph/initial*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(graph) }));
    await page.route('**/graph/sponsored*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, node: null }) }));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 15_000 }
    );
}

async function select(page, id) {
    await page.evaluate((nodeId) => {
        const g = window.musicGraph;
        g.handleNodeClick(g.ht.graph.getNode(nodeId));
    }, id);
    await page.waitForFunction(
        (nodeId) => window.musicGraph.selectedNode?.id === nodeId && !window.musicGraph.ht.busy,
        id,
        { timeout: 15_000 }
    );
}

/** Radius of every node, with its graph-hop distance from the focus. */
const radiiByHops = (page, focusId) => page.evaluate((id) => {
    const graph = window.musicGraph.ht.graph;

    const hops = new Map([[id, 0]]);
    let frontier = [id];
    while (frontier.length > 0) {
        const next = [];
        for (const current of frontier) {
            graph.getNode(current).eachAdjacency((adj) => {
                if ((adj.data?.type || '') === 'ROOT') return;
                const other = adj.nodeFrom.id === current ? adj.nodeTo.id : adj.nodeFrom.id;
                if (hops.has(other)) return;
                hops.set(other, hops.get(current) + 1);
                next.push(other);
            });
        }
        frontier = next;
    }

    const out = {};
    graph.eachNode((node) => {
        if ((node.data?.type || '').toLowerCase() === 'root') return;
        const p = node.pos.getc();
        const h = hops.get(node.id);
        if (h === undefined) return;
        (out[h] = out[h] || []).push(Math.hypot(p.x, p.y));
    });
    return out;
}, focusId);

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

test.describe('the selected node is surrounded by its own neighbours', () => {
    test('is itself at the centre', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');

        const byHops = await radiiByHops(page, 'grp:0');
        expect(byHops[0][0]).toBeLessThan(0.01);
    });

    test('radius never decreases with graph distance', async ({ page }) => {
        // The property that was false. Before the fix a band's own members sat
        // at 0.937 and nodes two hops out at 0.809, so the layout asserted
        // something about the data that is not true.
        await boot(page);
        await select(page, 'grp:0');

        const byHops = await radiiByHops(page, 'grp:0');
        const distances = Object.keys(byHops).map(Number).sort((a, b) => a - b);
        expect(distances.length).toBeGreaterThan(2);

        for (let i = 1; i < distances.length; i++) {
            const nearer = median(byHops[distances[i - 1]]);
            const further = median(byHops[distances[i]]);
            expect(further, `hop ${distances[i]} vs ${distances[i - 1]}`)
                .toBeGreaterThan(nearer);
        }
    });

    test('one-hop neighbours are well inside the disk, not against the rim', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');

        const byHops = await radiiByHops(page, 'grp:0');
        expect(Math.max(...byHops[1])).toBeLessThan(0.7);
    });

    test('every one-hop neighbour is named, not just drawn', async ({ page }) => {
        // Measured pre-fix: the members sat at 0.93-0.97 and were anonymous,
        // while the shared session player at 0.61 kept its name. So "at least
        // one neighbour is named" is true of the broken build too — the
        // assertion has to be all of them.
        //
        // Re-rooting brings them to ~0.54, which the old person-label
        // threshold of 0.5 still excluded by a hair; that is what raising
        // PERSON_LABEL_PROXIMITY_RADIUS to 0.62 is for.
        await boot(page);
        await select(page, 'grp:0');

        const { neighbours, named } = await page.evaluate(() => {
            const g = window.musicGraph;
            const all = [];
            const shown = [];
            g.ht.graph.getNode('grp:0').eachAdjacency((adj) => {
                const other = adj.nodeFrom.id === 'grp:0' ? adj.nodeTo : adj.nodeFrom;
                all.push(other.id);
                const el = g.ht.labels?.getLabel?.(other.id);
                if (el && el.style.display !== 'none') shown.push(other.id);
            });
            return { neighbours: all.sort(), named: shown.sort() };
        });

        expect(neighbours.length).toBeGreaterThan(1);
        expect(named).toEqual(neighbours);
    });
});

test.describe('navigating onwards', () => {
    test('the second selection is centred, not the first', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        await select(page, 'per:0_1');

        const byHops = await radiiByHops(page, 'per:0_1');
        expect(byHops[0][0]).toBeLessThan(0.01);
    });

    test('and brings its own neighbours in with it', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        await select(page, 'per:0_1');

        const byHops = await radiiByHops(page, 'per:0_1');
        expect(Math.max(...byHops[1])).toBeLessThan(0.7);
    });

    test('a selection made mid-animation still arrives', async ({ page }) => {
        // Two overlapping animations on the same positions interleave into a
        // mess, so the second selection skips the glide. It still has to land.
        await boot(page);

        await page.evaluate(() => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode('grp:0'));
            g.handleNodeClick(g.ht.graph.getNode('grp:2'));
        });
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });

        expect(await page.evaluate(() => window.musicGraph.selectedNode.id)).toBe('grp:2');
        const byHops = await radiiByHops(page, 'grp:2');
        expect(byHops[0][0]).toBeLessThan(0.01);
    });
});
