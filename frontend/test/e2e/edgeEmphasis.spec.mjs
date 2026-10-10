/**
 * Making the current neighbourhood the loudest thing on screen.
 *
 * The graph coloured and weighted every edge identically regardless of what was
 * selected, so a dense group read as uniformly important — the whole universe
 * at once, with the thing being looked at no louder than the rest.
 *
 * The thing to guard is not "an edge got dimmer" but which edges did, and that
 * the dimming follows the selection as it moves. The styling runs from
 * onBeforePlotLine on every edge of every frame, so a rule that is right once
 * and wrong on the next plot looks identical in a screenshot.
 */

import { test, expect } from '@playwright/test';

const GRAPH = {
    nodes: [
        { id: 'grp:a', name: 'Band A', type: 'group' },
        { id: 'grp:b', name: 'Band B', type: 'group' },
        { id: 'per:shared', name: 'Shared Member', type: 'person' },
        { id: 'per:only-a', name: 'Only In A', type: 'person' },
        { id: 'per:only-b', name: 'Only In B', type: 'person' },
    ],
    edges: [
        { source: 'per:shared', target: 'grp:a', type: 'MEMBER_OF', role: 'drums' },
        { source: 'per:shared', target: 'grp:b', type: 'MEMBER_OF', role: 'drums' },
        { source: 'per:only-a', target: 'grp:a', type: 'MEMBER_OF', role: 'bass' },
        { source: 'per:only-b', target: 'grp:b', type: 'MEMBER_OF', role: 'guitar' },
    ],
};

const DETAILS = {
    'grp:a': { group_id: 'grp:a', name: 'Band A' },
    'grp:b': { group_id: 'grp:b', name: 'Band B' },
    'per:shared': { person_id: 'per:shared', name: 'Shared Member' },
    'per:only-a': { person_id: 'per:only-a', name: 'Only In A' },
    'per:only-b': { person_id: 'per:only-b', name: 'Only In B' },
};

async function boot(page) {
    await page.route('**/api/**', (route) => {
        const url = decodeURIComponent(route.request().url());
        if (url.includes('/stake/')) {
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, units: '0', formatted: '0.0000 MUS', stakerCount: 0 }),
            });
        }
        const id = Object.keys(DETAILS).find((key) => url.endsWith(`/${key}`));
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(id ? DETAILS[id] : {}),
        });
    });
    await page.route('**/graph/initial*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(GRAPH) }));
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
        { timeout: 10_000 }
    );
}

/**
 * The alpha each edge was last drawn with, keyed by its endpoints.
 *
 * Read after a plot rather than computed, so this reflects what the renderer
 * was actually handed.
 */
const edgeAlphas = (page) => page.evaluate(() => {
    const out = {};
    window.musicGraph.ht.graph.eachNode((node) => {
        node.eachAdjacency((adj) => {
            if ((adj.data?.type || '') === 'ROOT') return;
            const ids = [adj.nodeFrom.id, adj.nodeTo.id].sort();
            const color = String(adj.getData('color') || '');
            const m = /^rgba\([^)]*,\s*([\d.]+)\)$/.exec(color);
            out[ids.join('|')] = m ? Number(m[1]) : 1;
        });
    });
    return out;
});

test.describe('with nothing selected', () => {
    test('every edge is at full strength', async ({ page }) => {
        // The opening view is the universe. There is no focus to contrast
        // against, so dimming any of it would just make the graph murky.
        await boot(page);
        await page.evaluate(() => window.musicGraph.ht.plot());

        const alphas = await edgeAlphas(page);
        expect(Object.keys(alphas).length).toBe(4);
        for (const [edge, alpha] of Object.entries(alphas)) {
            expect(alpha, edge).toBe(1);
        }
    });
});

test.describe('with a node selected', () => {
    test('its own edges stay loud and the rest go quiet', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:a');

        const alphas = await edgeAlphas(page);

        // Touching grp:a.
        expect(alphas['grp:a|per:shared']).toBe(1);
        expect(alphas['grp:a|per:only-a']).toBe(1);
        // Not touching it.
        expect(alphas['grp:b|per:shared']).toBeLessThan(1);
        expect(alphas['grp:b|per:only-b']).toBeLessThan(1);
    });

    test('the quiet ones are still visible, not hidden', async ({ page }) => {
        // Dimming keeps the universe there to navigate into; hiding would leave
        // the selection floating with no context, which is the opposite of what
        // a map is for.
        await boot(page);
        await select(page, 'grp:a');

        const alphas = await edgeAlphas(page);
        expect(alphas['grp:b|per:only-b']).toBeGreaterThan(0.15);
    });

    test('the emphasis follows the selection', async ({ page }) => {
        // onBeforePlotLine restyles every edge on every frame, so a rule that
        // is right once and stale on the next plot looks the same in a still.
        await boot(page);
        await select(page, 'grp:a');
        await select(page, 'grp:b');

        const alphas = await edgeAlphas(page);
        expect(alphas['grp:b|per:shared']).toBe(1);
        expect(alphas['grp:b|per:only-b']).toBe(1);
        expect(alphas['grp:a|per:only-a']).toBeLessThan(1);
    });

    test('an edge shared between two groups is loud from either end', async ({ page }) => {
        await boot(page);
        await select(page, 'per:shared');

        const alphas = await edgeAlphas(page);
        expect(alphas['grp:a|per:shared']).toBe(1);
        expect(alphas['grp:b|per:shared']).toBe(1);
        // The person's bandmates are two hops away and not part of this.
        expect(alphas['grp:a|per:only-a']).toBeLessThan(1);
    });

    test('it survives a re-plot with no new selection', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:a');
        await page.evaluate(() => window.musicGraph.ht.plot());
        await page.evaluate(() => window.musicGraph.ht.plot());

        const alphas = await edgeAlphas(page);
        expect(alphas['grp:a|per:shared']).toBe(1);
        expect(alphas['grp:b|per:only-b']).toBeLessThan(1);
    });

    test('widths are untouched, so the shape of the graph does not move', async ({ page }) => {
        // Thinning unrelated edges as well would change the graph's shape as
        // you browse, and the shape is the data.
        await boot(page);
        const before = await page.evaluate(() => {
            const out = {};
            window.musicGraph.ht.graph.eachNode((n) => n.eachAdjacency((adj) => {
                if ((adj.data?.type || '') === 'ROOT') return;
                out[[adj.nodeFrom.id, adj.nodeTo.id].sort().join('|')] = adj.getData('lineWidth');
            }));
            return out;
        });

        await select(page, 'grp:a');

        const after = await page.evaluate(() => {
            const out = {};
            window.musicGraph.ht.graph.eachNode((n) => n.eachAdjacency((adj) => {
                if ((adj.data?.type || '') === 'ROOT') return;
                out[[adj.nodeFrom.id, adj.nodeTo.id].sort().join('|')] = adj.getData('lineWidth');
            }));
            return out;
        });

        expect(after).toEqual(before);
    });
});

test.describe('the hovered edge beats the dimming', () => {
    test('a highlighted edge is drawn in the highlight colour regardless', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:a');

        const highlighted = await page.evaluate(() => {
            const nav = window.musicGraph.edgeNavigator;
            const edge = nav.candidates().find((c) => c.other.id === 'per:only-a');
            nav._highlight(edge);
            window.musicGraph.ht.plot();
            return edge.adj.getData('color');
        });

        expect(highlighted).toBe('#ffffff');
    });
});
