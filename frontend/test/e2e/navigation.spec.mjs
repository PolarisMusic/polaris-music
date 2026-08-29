/**
 * Playwright e2e — graph navigation.
 *
 * Every other e2e spec runs without graph data: the layout and CSP specs only
 * need the page shell. That gap let a total navigation regression ship with 22
 * tests passing — clicking a node centred on it and then snapped straight back
 * to the root, on desktop and phone alike, because openInfoPanel() called
 * _handleCanvasResize() and canvas.resize() zeroes the pan and zoom offsets
 * (jit.js:2941).
 *
 * These stub the graph endpoint so a node can actually be clicked, and assert
 * the view is still where it was sent a moment later. That second part is the
 * whole test: the broken build centred correctly first, then reset.
 */

import { test, expect } from '@playwright/test';

/** Minimal {nodes, edges} in the shape graphApi.transformToJIT() consumes. */
const GRAPH = {
    nodes: [
        { id: 'grp:band', name: 'Test Band', type: 'group' },
        { id: 'per:drums', name: 'Drummer', type: 'person' },
        { id: 'per:bass', name: 'Bassist', type: 'person' },
    ],
    edges: [
        { source: 'grp:band', target: 'per:drums', type: 'MEMBER_OF', role: 'drums' },
        { source: 'grp:band', target: 'per:bass', type: 'MEMBER_OF', role: 'bass' },
    ],
};

async function gotoWithGraph(page) {
    // Order matters: Playwright uses the LAST matching route, so the catch-all
    // must be registered first or it shadows the graph stub — which is exactly
    // what happened on the first run here, and the graph never loaded.
    await page.route('**/api/**', (route) =>
        route.fulfill({ contentType: 'application/json', body: '{}' }));
    await page.route('**/graph/initial*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(GRAPH) }));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 10_000 }
    );
}

/**
 * How far a node sits from the centre of the hypertree, in the Hypertree's own
 * unit-disk coordinates: the focused node is moved to the origin and everything
 * else is pushed outward, so 0 means "centred".
 *
 * Reading the model rather than pixels is deliberate. The first version of this
 * helper treated pos.getc(true) as pixel offsets and added canvas.width/2,
 * which put every node within about a pixel of centre — three specs then passed
 * against a build where navigation was still broken.
 *
 * Observed values: focused node 0.00, its neighbours 0.75-0.96.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @returns {Promise<number>} distance from the centre, 0 to ~1
 */
async function distanceFromCentre(page, id) {
    return page.evaluate((nodeId) => {
        const node = window.musicGraph.ht.graph.getNode(nodeId);
        if (!node) return null;
        const p = node.pos.getc(true);
        return Math.hypot(p.x, p.y);
    }, id);
}

const CENTRED = 0.05;      // focused node lands on the origin
const AWAY_FROM_CENTRE = 0.3;

/**
 * Select a node the way a user does.
 *
 * Deliberately handleNodeClick() and not ht.onClick(): the reset lived in the
 * app's own chain — handleNodeClick -> ht.onClick -> onComplete ->
 * updateInfoPanel -> openInfoPanel -> _handleCanvasResize -> canvas.resize().
 * Driving ht.onClick directly skips all of that, and specs written that way
 * passed against the broken build.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 */
async function centreNode(page, id) {
    await page.evaluate((nodeId) => {
        const graph = window.musicGraph;
        graph.handleNodeClick(graph.ht.graph.getNode(nodeId));
    }, id);
    // handleNodeClick animates and then runs its onComplete work; there is no
    // promise to await, so allow for both.
    await page.waitForTimeout(900);
}

test.describe('graph navigation', () => {
    test('clicking a node centres on it and stays there', async ({ page }) => {
        await gotoWithGraph(page);

        await centreNode(page, 'per:drums');

        const distance = await distanceFromCentre(page, 'per:drums');
        expect(distance).not.toBeNull();
        expect(distance).toBeLessThan(CENTRED);
    });

    test('the root does not reclaim the centre after a selection', async ({ page }) => {
        await gotoWithGraph(page);

        // Capture the starting root BEFORE navigating: ht.onClick reassigns
        // ht.root to the node it centres, so reading it afterwards just returns
        // whatever was selected — which made the first version of this
        // assertion measure the wrong node and pass vacuously.
        const startRoot = await page.evaluate(() => window.musicGraph.ht.root);

        await centreNode(page, 'per:bass');

        // Stated the other way round, because this is precisely what went
        // wrong: the node that had been centred snapped back into place.
        expect(await distanceFromCentre(page, startRoot))
            .toBeGreaterThan(AWAY_FROM_CENTRE);
    });

    test('navigating twice ends on the second node', async ({ page }) => {
        await gotoWithGraph(page);

        await centreNode(page, 'per:drums');
        await centreNode(page, 'per:bass');

        expect(await distanceFromCentre(page, 'per:bass')).toBeLessThan(CENTRED);
    });
});

test.describe('graph navigation on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('centring survives the sheet resizing the canvas', async ({ page }) => {
        await gotoWithGraph(page);

        // The other branch of the fix: here the sheet genuinely changes the
        // canvas height, so canvas.resize() does run and does zero the offsets.
        // The focus has to be restored afterwards rather than left at the root.
        await centreNode(page, 'per:drums');
        await page.evaluate(() => window.musicGraph.openInfoPanel());
        await page.waitForTimeout(600);

        expect(await distanceFromCentre(page, 'per:drums')).toBeLessThan(CENTRED);
    });
});
