/**
 * Where the graph opens.
 *
 * Each period has a drawn node, and the view should simply be on it. It used to
 * render centred on whichever node the layout picked for itself — in practice
 * the first band in the data — and then visibly travel to the drawn one, an
 * opening journey from somewhere arbitrary that said nothing and happened on
 * every load.
 *
 * So the draw is fetched alongside the graph and the root is set before the
 * first paint. The fallback still matters: a chain that is slow or down must
 * not hold up the graph.
 */

import { test, expect } from '@playwright/test';

const GRAPH = {
    nodes: [
        { id: 'grp:first', name: 'First Band', type: 'group' },
        { id: 'grp:drawn', name: 'Drawn Band', type: 'group' },
        { id: 'per:shared', name: 'Shared Player', type: 'person' },
    ],
    edges: [
        { source: 'per:shared', target: 'grp:first', type: 'MEMBER_OF', role: 'player' },
        { source: 'per:shared', target: 'grp:drawn', type: 'MEMBER_OF', role: 'player' },
    ],
};

/**
 * @param {object} options
 * @param {string|null} options.sponsored - id the draw returns, or null for none
 * @param {number} options.delayMs - how long the draw endpoint takes
 */
async function boot(page, { sponsored = 'grp:drawn', delayMs = 0 } = {}) {
    await page.route('**/api/**', (route) =>
        route.fulfill({ contentType: 'application/json', body: '{}' }));
    await page.route('**/graph/initial*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(GRAPH) }));
    await page.route('**/graph/sponsored*', async (route) => {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ success: true, node: sponsored ? { id: sponsored } : null }),
        });
    });

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 15_000 }
    );
}

/** Every distinct node that has been at the centre, in order. */
async function watchCentre(page) {
    await page.evaluate(() => {
        window.__centres = [];
        const tick = () => {
            // Read the graph every frame. loadJSON replaces ht.graph outright,
            // so a reference captured when the observer attached points at the
            // empty graph that existed before the data arrived — and the
            // observer records nothing at all, which looks exactly like
            // "nothing was ever centred".
            const graph = window.musicGraph?.ht?.graph;
            if (!graph) { window.requestAnimationFrame(tick); return; }

            let best = null;
            let bestRho = Infinity;
            let spread = false;
            graph.eachNode((n) => {
                if ((n.data?.type || '').toLowerCase() === 'root') return;
                if (n.pos.rho > 0.2) spread = true;
                if (n.pos.rho < bestRho) { bestRho = n.pos.rho; best = n.id; }
            });
            // Until the layout has run, every node is at the origin and
            // "nearest the centre" is just whichever one iterates first. Those
            // frames are not a view anybody saw.
            if (spread && best && bestRho < 0.01 && window.__centres.at(-1) !== best) {
                window.__centres.push(best);
            }
            window.requestAnimationFrame(tick);
        };
        window.requestAnimationFrame(tick);
    });
}

test.describe('the opening view', () => {
    test('is already on the drawn node', async ({ page }) => {
        await boot(page);
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
        await page.waitForTimeout(400);

        expect(await page.evaluate(() => window.musicGraph.ht.root)).toBe('grp:drawn');
        expect(await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('grp:drawn').pos.rho)).toBeLessThan(0.01);
    });

    test('and never travels there from somewhere else', async ({ page }) => {
        // The actual complaint: the graph went to one band and then set off for
        // the drawn one. Nothing but the drawn node should ever hold the centre.
        await page.route('**/api/**', (route) =>
            route.fulfill({ contentType: 'application/json', body: '{}' }));
        await page.route('**/graph/initial*', (route) =>
            route.fulfill({ contentType: 'application/json', body: JSON.stringify(GRAPH) }));
        await page.route('**/graph/sponsored*', (route) =>
            route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, node: { id: 'grp:drawn' } }),
            }));

        await page.goto('/', { waitUntil: 'commit' });
        await page.waitForFunction(() => window.musicGraph?.ht?.graph, { timeout: 15_000 });
        await watchCentre(page);
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
        await page.waitForTimeout(600);

        const centres = await page.evaluate(() => window.__centres);
        expect(centres).toEqual(['grp:drawn']);
    });

    test('the drawn node is selected, not merely centred', async ({ page }) => {
        await boot(page);
        await page.waitForFunction(
            () => window.musicGraph.selectedNode?.id === 'grp:drawn', { timeout: 15_000 });
        expect(await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('grp:drawn').getData('isSelected'))).toBeTruthy();
    });

    test('a draw that never answers does not hold up the graph', async ({ page }) => {
        // The reason the fetch is raced rather than awaited. Timed, because
        // "the graph eventually appeared" is true however long it took — the
        // first version of this assertion would have passed against a build
        // that blocked for the full four seconds.
        const started = Date.now();
        await boot(page, { delayMs: 4000 });
        const drawn = Date.now() - started;

        expect(await page.evaluate(
            () => Object.keys(window.musicGraph.ht.graph.nodes).length)).toBeGreaterThan(1);
        expect(drawn).toBeLessThan(3000);
    });

    test('and is still honoured when it arrives late', async ({ page }) => {
        // Past the grace it travels, which is what this did before the draw
        // was part of the opening at all.
        await boot(page, { delayMs: 1200 });
        await page.waitForFunction(
            () => window.musicGraph.selectedNode?.id === 'grp:drawn', { timeout: 15_000 });
    });

    test('no draw at all leaves the layout to choose', async ({ page }) => {
        await boot(page, { sponsored: null });
        await page.waitForTimeout(500);
        expect(await page.evaluate(() => window.musicGraph.ht.root)).toBeTruthy();
    });
});
