/**
 * Playwright e2e — Hypertree compactness.
 *
 * Selecting a node out at the edge of the graph left everything else
 * unreachably far away. jit.js:17887 names both the cause and the cure:
 * `offset` is "a number in the range [0, 1) that will be substracted to each
 * node position to make a more compact Hypertree. This will avoid placing
 * nodes too far from each other when there's a selected node." It was sitting
 * at the inert default of 0.
 *
 * The load-bearing test here is the behavioural one: it focuses a leaf and
 * measures where the rest of the graph actually lands. Asserting the config
 * key alone would not have caught a key JIT silently ignores, and asserting
 * the source would not have caught it either -- which is roughly how the
 * default survived this long.
 */

import { test, expect } from '@playwright/test';

/**
 * Five levels deep, in the {nodes, edges} shape graphApi.transformToJIT()
 * consumes. Depth matters: the edge-length solver in jit.js:17988 picks a
 * smaller base for deeper trees, so a shallow fixture would flatter the
 * offset and hide the headroom question entirely.
 */
const nodes = [
    { id: 'grp:band', name: 'Test Band', type: 'group' },
    { id: 'rel:one', name: 'Album One', type: 'release' },
];
const edges = [
    { source: 'grp:band', target: 'rel:one', type: 'PERFORMED_ON' },
];
for (let i = 0; i < 6; i++) {
    nodes.push({ id: `trk:${i}`, name: `Track ${i}`, type: 'track' });
    edges.push({ source: 'rel:one', target: `trk:${i}`, type: 'IN_RELEASE' });
    nodes.push({ id: `song:${i}`, name: `Song ${i}`, type: 'song' });
    edges.push({ source: `trk:${i}`, target: `song:${i}`, type: 'RECORDING_OF' });
    nodes.push({ id: `per:${i}`, name: `Writer ${i}`, type: 'person' });
    edges.push({ source: `song:${i}`, target: `per:${i}`, type: 'WROTE' });
}
const GRAPH = { nodes, edges };

/** A leaf: the worst case, and the one the user reported. */
const EDGE_NODE = 'per:3';

/**
 * Boot with graph data stubbed in.
 *
 * Route order matters: Playwright uses the LAST matching route, so the
 * catch-all is registered first or it shadows the graph stub.
 */
async function bootedGraph(page) {
    await page.route('**/api/**', (route) =>
        route.fulfill({ contentType: 'application/json', body: '{}' }));
    await page.route('**/graph/initial*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(GRAPH) }));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 15_000 }
    );
}

/** How long the re-centring animation and its onComplete work need. */
const SETTLE_MS = 900;

/**
 * Select a node the way a user does.
 *
 * Deliberately handleNodeClick() and not ht.onClick(), for the reason
 * navigation.spec.mjs documents: the app's own chain does work in its
 * onComplete that driving JIT directly skips. It also sets `selectedNode`,
 * which is what setGeometryOffset re-focuses on.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 */
async function centreNode(page, id) {
    await page.evaluate((nodeId) => {
        const graph = window.musicGraph;
        graph.handleNodeClick(graph.ht.graph.getNode(nodeId));
    }, id);
    await page.waitForTimeout(SETTLE_MS);
}

/**
 * How far the nodes *other than* the focused one sit from the centre, in the
 * Hypertree's own unit-disk coordinates. 1.0 is the rim.
 *
 * Reading the model rather than pixels is deliberate, for the reason
 * navigation.spec.mjs documents: pos.getc(true) is not a pixel offset, and
 * treating it as one makes every node look centred.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} focusId the node at the origin, excluded from the summary
 * @returns {Promise<{median: number, max: number}>}
 */
async function spreadAround(page, focusId) {
    return page.evaluate((id) => {
        const distances = [];
        window.musicGraph.ht.graph.eachNode((node) => {
            if (node.id === id) return;
            const p = node.pos.getc(true);
            distances.push(Math.hypot(p.x, p.y));
        });
        distances.sort((a, b) => a - b);
        return {
            median: distances[Math.floor(distances.length / 2)],
            max: distances[distances.length - 1],
        };
    }, focusId);
}

test.describe('hypertree compactness', () => {
    test('focusing an edge node leaves the rest of the graph off the rim', async ({ page }) => {
        await bootedGraph(page);
        await centreNode(page, EDGE_NODE);
        const { median, max } = await spreadAround(page, EDGE_NODE);

        // Measured at offset 0: median 0.995, max 1.000 -- every node crushed
        // into the outermost half-percent of the disk, which is the bug.
        // Measured at offset 0.3: median 0.773, max 0.925.
        expect(median).toBeLessThan(0.85);
        expect(max).toBeLessThan(0.96);
    });

    test('the offset reaches the live Hypertree config, not just the source', async ({ page }) => {
        await bootedGraph(page);
        const offset = await page.evaluate(() => window.musicGraph.ht?.config?.offset);

        expect(typeof offset).toBe('number');
        expect(offset).toBeGreaterThan(0);
    });

    test('the offset keeps headroom under the radius the solver allows', async ({ page }) => {
        // jit.js:17988 walks i from 0.51 upward and returns i - 0.01, so on a
        // deep tree the shallowest ring sits at ~0.50 from the origin. An
        // offset at or above that makes its radius negative and folds the
        // layout through itself. Stay clear of the cliff, not merely inside
        // the library's nominal [0, 1).
        await bootedGraph(page);
        const offset = await page.evaluate(() => window.musicGraph.ht.config.offset);
        expect(offset).toBeLessThan(0.45);
    });

    test('setGeometryOffset changes it live, so it can be tuned from the console', async ({ page }) => {
        await bootedGraph(page);
        await centreNode(page, EDGE_NODE);
        const before = await spreadAround(page, EDGE_NODE);

        await page.evaluate(() => window.musicGraph.setGeometryOffset(0.35));
        await page.waitForTimeout(SETTLE_MS);

        expect(await page.evaluate(() => window.musicGraph.ht.config.offset)).toBe(0.35);

        // Storing the number is not the point -- it has to reach the layout,
        // on the node the user currently has selected. setGeometryOffset
        // re-focuses `selectedNode`, which is why this goes through
        // handleNodeClick above rather than driving JIT directly.
        const after = await spreadAround(page, EDGE_NODE);
        expect(after.median).toBeLessThan(before.median);
    });

    test('tuning the offset does not tear down the graph', async ({ page }) => {
        // setGeometryOffset calls refresh(), which recomputes from the root.
        // The instance and its nodes have to survive that.
        await bootedGraph(page);
        const countNodes = () => page.evaluate(() => {
            let n = 0;
            window.musicGraph.ht.graph.eachNode(() => n++);
            return n;
        });

        const before = await countNodes();
        await page.evaluate(() => window.musicGraph.setGeometryOffset(0.3));

        expect(await countNodes()).toBe(before);
        expect(before).toBe(20);
    });

    test('tuning it before any data has loaded stores the value instead of throwing', async ({ page }) => {
        // The console hook exists from boot, but refresh() walks from a root
        // that does not exist yet and dies on `node._depth` (jit.js:5028).
        await page.route('**/api/**', (route) =>
            route.fulfill({ contentType: 'application/json', body: '{}' }));
        await page.goto('/', { waitUntil: 'load' });
        await page.waitForFunction(
            () => typeof window.musicGraph?.setGeometryOffset === 'function',
            { timeout: 15_000 }
        );

        const stored = await page.evaluate(() => {
            window.musicGraph.setGeometryOffset(0.25);
            return window.musicGraph.ht.config.offset;
        });
        expect(stored).toBe(0.25);
    });
});
