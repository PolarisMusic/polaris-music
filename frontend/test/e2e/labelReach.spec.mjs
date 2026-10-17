/**
 * Which names are on screen, and why.
 *
 * A label used to be earned by proximity alone: inside its type's radius in
 * the Poincaré disk, or selected, or hovered. That is a statement about the
 * layout rather than about what the reader asked for, and the two part company
 * at exactly the wrong moment — a band's own members land at a squared norm of
 * 0.26 against a person's threshold of 0.25, so selecting a band left every
 * one of its members an unnamed dot, by a hundredth.
 *
 * The numbers in these tests are measured from this scene, not assumed.
 */

import { test, expect } from '@playwright/test';

/**
 * A hub band, its two members, one member's side project, and a stranger two
 * bands away. Enough to have a first ring, a second, and a beyond.
 *
 *   per:b ── grp:hub ── per:a ── grp:side ── per:far ── grp:faraway
 */
const GRAPH = {
    nodes: [
        { id: 'grp:hub', name: 'Hub Band', type: 'group' },
        { id: 'per:a', name: 'Member A', type: 'person' },
        { id: 'per:b', name: 'Member B', type: 'person' },
        { id: 'grp:side', name: 'Side Project', type: 'group' },
        { id: 'per:far', name: 'Distant Player', type: 'person' },
        { id: 'grp:faraway', name: 'Far Away Band', type: 'group' },
    ],
    edges: [
        { source: 'per:a', target: 'grp:hub', type: 'MEMBER_OF', role: 'drums' },
        { source: 'per:b', target: 'grp:hub', type: 'MEMBER_OF', role: 'bass' },
        { source: 'per:a', target: 'grp:side', type: 'MEMBER_OF', role: 'drums' },
        { source: 'per:far', target: 'grp:side', type: 'MEMBER_OF', role: 'guitar' },
        { source: 'per:far', target: 'grp:faraway', type: 'MEMBER_OF', role: 'guitar' },
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
}

async function select(page, id) {
    await page.evaluate((nodeId) => {
        const g = window.musicGraph;
        g.handleNodeClick(g.ht.graph.getNode(nodeId));
    }, id);
    await page.waitForFunction(
        (nodeId) => window.musicGraph.selectedNode?.id === nodeId && !window.musicGraph.ht.busy,
        id, { timeout: 15_000 }
    );
    // One more plot after the animation settles, which is what writes the set.
    await page.waitForTimeout(250);
}

/** The ids whose names are actually drawn this frame. */
const labelled = (page) => page.evaluate(
    () => [...(window.musicGraph._visibleLabels || [])].sort());

/** How far outside its own radius a node is sitting. */
const radiusCheck = (page, id) => page.evaluate((nodeId) => {
    const g = window.musicGraph;
    const node = g.ht.graph.getNode(nodeId);
    return {
        centrality: node.pos.getc().squaredNorm(),
        threshold: g.labelThresholdFor(node),
    };
}, id);

test.describe('the names around the node you chose', () => {
    test('a band names its own members, which the radius alone did not', async ({ page }) => {
        // The report, and the whole reason for the change. These two are the
        // selection's immediate neighbours and they sit a hundredth of a unit
        // outside the radius that used to be the only way to earn a label.
        await boot(page);
        await select(page, 'grp:hub');

        for (const member of ['per:a', 'per:b']) {
            const { centrality, threshold } = await radiusCheck(page, member);
            expect(centrality, `${member} is outside the radius`).toBeGreaterThan(threshold);
        }

        expect(await labelled(page)).toEqual(
            expect.arrayContaining(['grp:hub', 'per:a', 'per:b']));
    });

    test('and the ring past that one too, when there is room for it', async ({ page }) => {
        // Two hops from a person: the other members of their bands. Also
        // outside the radius — 0.69 against 0.25 — so this is the hop rule and
        // not proximity wearing its clothes.
        await boot(page);
        await select(page, 'per:a');

        for (const second of ['per:b', 'per:far']) {
            const { centrality, threshold } = await radiusCheck(page, second);
            expect(centrality, `${second} is outside the radius`).toBeGreaterThan(threshold);
        }

        expect(await labelled(page)).toEqual(
            expect.arrayContaining(['per:a', 'per:b', 'per:far']));
    });

    test('three hops out stays anonymous', async ({ page }) => {
        // The bound. Without one, "label what is connected" is just "label
        // everything" in a graph where everything is connected.
        await boot(page);
        await select(page, 'per:a');

        expect(await labelled(page)).not.toContain('grp:faraway');
    });

    test('with nothing selected, proximity is still the only rule', async ({ page }) => {
        // No selection, no hops, and the labels are whatever the radius says —
        // which is what the opening view has always shown.
        await boot(page);

        const shown = await labelled(page);
        const byRadius = await page.evaluate(() => {
            const g = window.musicGraph;
            const ids = [];
            g.ht.graph.eachNode((n) => {
                if ((n.data?.type || '').toLowerCase() === 'root') return;
                if (n.pos.getc().squaredNorm() < g.labelThresholdFor(n)) ids.push(n.id);
            });
            return ids.sort();
        });

        expect(await page.evaluate(() => window.musicGraph.selectedNode)).toBeNull();
        expect(shown).toEqual(byRadius);
    });

    test('the walk does not escape through the synthetic root', async ({ page }) => {
        // Every node hangs off the injected root in some layouts. Following
        // that edge would put the whole graph two hops from anywhere and label
        // all of it.
        await boot(page);
        await select(page, 'grp:hub');

        const hops = await page.evaluate(
            () => Object.fromEntries(window.musicGraph._selectionHopIds(2)));
        expect(hops['grp:faraway']).toBeUndefined();
        expect(hops['per:a']).toBe(1);
        expect(hops['grp:side']).toBe(2);
    });
});
