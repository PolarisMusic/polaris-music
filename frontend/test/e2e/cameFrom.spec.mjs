/**
 * The node you came from, marked.
 *
 * Navigation is a Mobius translation, which is an isometry — so when you leave
 * a node it does not move anywhere useful, it just takes up its position at
 * whatever radius its depth in the layout tree dictates. Measured, that is
 * usually past 0.9, out among a crowd of unlabelled strangers.
 *
 * It is also the one node on screen the visitor is certain to recognise. So it
 * keeps its name whatever its radius, and wears a dashed ring. That is one
 * known point in a view that is otherwise all new, which is the cheapest
 * answer available to "it is easy to get lost" — the layout itself cannot
 * provide one without giving up the rigid motion.
 */

import { test, expect } from '@playwright/test';

const GRAPH = {
    nodes: [
        { id: 'per:hub', name: 'Session Player', type: 'person' },
        ...Array.from({ length: 4 }, (_, g) => ({ id: `grp:${g}`, name: `Band ${g}`, type: 'group' })),
        ...Array.from({ length: 4 }, (_, g) => Array.from({ length: 4 }, (_, m) => ({
            id: `per:${g}_${m}`, name: `Member ${g}-${m}`, type: 'person',
        }))).flat(),
    ],
    edges: [
        ...Array.from({ length: 4 }, (_, g) => ({
            source: 'per:hub', target: `grp:${g}`, type: 'MEMBER_OF', role: 'guest',
        })),
        ...Array.from({ length: 4 }, (_, g) => Array.from({ length: 4 }, (_, m) => ({
            source: `per:${g}_${m}`, target: `grp:${g}`, type: 'MEMBER_OF', role: 'player',
        }))).flat(),
    ],
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
        route.fulfill({ contentType: 'application/json', body: '{}' });
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
    await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
    await page.waitForTimeout(300);
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
    await page.waitForTimeout(200);
}

const marked = (page) => page.evaluate(() => {
    const out = [];
    window.musicGraph.ht.graph.eachNode((n) => {
        if (n.getData('isPrevious')) out.push(n.id);
    });
    return out.sort();
});

const labelled = (page, id) => page.evaluate((nodeId) => {
    const el = window.musicGraph.ht.labels?.getLabel?.(nodeId);
    return !!(el && el.style.display !== 'none' && el.textContent);
}, id);

test.describe('the node you came from', () => {
    test('is marked once you have moved off it', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        expect(await marked(page)).toEqual([]);

        await select(page, 'per:0_1');
        expect(await marked(page)).toEqual(['grp:0']);
    });

    test('is exactly one node, never two', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        await select(page, 'per:0_1');
        await select(page, 'per:hub');
        await select(page, 'grp:2');

        expect(await marked(page)).toEqual(['per:hub']);
    });

    test('keeps its name even out at the rim', async ({ page }) => {
        // The whole point. Measured, a band's own member sits at 0.937 after
        // centring on it, well past the 0.5 a person's label needs.
        await boot(page);
        await select(page, 'grp:0');
        await select(page, 'per:0_1');

        const rho = await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('grp:0').pos.rho);
        expect(rho).toBeGreaterThan(0.6);
        expect(await labelled(page, 'grp:0')).toBe(true);
    });

    test('is not the selection as well', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        await select(page, 'per:0_1');

        expect(await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('per:0_1').getData('isPrevious'))).toBeFalsy();
        expect(await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('grp:0').getData('isSelected'))).toBeFalsy();
    });

    test('re-selecting the same node does not make it its own predecessor', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        await select(page, 'per:0_1');
        await select(page, 'per:0_1');

        expect(await marked(page)).toEqual(['grp:0']);
    });

    test('walking back clears the mark from the node you return to', async ({ page }) => {
        // Going A -> B -> A: the mark belongs on B now, and must not be left
        // on A, which is the node at the centre.
        await boot(page);
        await select(page, 'grp:0');
        await select(page, 'per:0_1');
        await select(page, 'grp:0');

        expect(await marked(page)).toEqual(['per:0_1']);
    });
});
