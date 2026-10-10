/**
 * Labels in a crowd.
 *
 * Each label used to decide its own visibility from distance, selection and
 * hover, with no knowledge of the others, so a dense neighbourhood produced a
 * pile: several names drawn over each other, none readable, none attributable
 * to a node.
 *
 * The fixture puts many people on one group deliberately. A graph with room for
 * everybody proves nothing here.
 */

import { test, expect } from '@playwright/test';

const GROUP_COUNT = 12;

/*
 * Many groups, not one group with many people.
 *
 * The person radius already hides a rim person's name — 0.5 against a
 * squaredNorm near 1 — so a single band with fourteen members produces no pile
 * at all, just one label. What piles up is group names, which hold almost to
 * the rim, and that is what the dense RHCP and QOTSA views are: lots of groups.
 * Shared members keep them in one connected component.
 */
const GRAPH = {
    nodes: [
        ...Array.from({ length: GROUP_COUNT }, (_, i) => ({
            id: `grp:${i}`,
            name: `A Band With Quite A Long Name ${i}`,
            type: 'group',
        })),
        { id: 'per:hub', name: 'The Busy Session Player', type: 'person' },
    ],
    edges: Array.from({ length: GROUP_COUNT }, (_, i) => ({
        source: 'per:hub', target: `grp:${i}`, type: 'MEMBER_OF', role: 'player',
    })),
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
        const node = GRAPH.nodes.find((n) => url.endsWith(`/${n.id}`));
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(node
                ? (node.type === 'group'
                    ? { group_id: node.id, name: node.name }
                    : { person_id: node.id, name: node.name })
                : {}),
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

/**
 * Make every label eligible, so collision resolution is what decides.
 *
 * Without this the proximity radii do all the suppressing on their own — a
 * twelve-group star puts its groups past 0.9 and they are never candidates —
 * and a test of the resolver would be measuring the thresholds instead. A real
 * dense view reaches the same state by having many nodes inside the radius;
 * this reaches it directly.
 */
async function makeEveryLabelEligible(page) {
    await page.evaluate(() => {
        const g = window.musicGraph;
        g.labelProximityThreshold = 1;
        g.groupLabelProximityThreshold = 1;
        g.ht.plot();
    });
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

/** Every label currently drawn, with its rect. */
const shownLabels = (page) => page.evaluate(() => {
    const out = [];
    window.musicGraph.ht.graph.eachNode((node) => {
        const el = window.musicGraph.ht.labels?.getLabel?.(node.id);
        if (!el || el.style.display === 'none') return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        out.push({ id: node.id, text: el.textContent, x: r.x, y: r.y, w: r.width, h: r.height });
    });
    return out;
});

/** Pairs of drawn labels whose rects intersect. */
function collidingPairs(labels) {
    const pairs = [];
    for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
            const a = labels[i];
            const b = labels[j];
            if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
                pairs.push([a.id, b.id]);
            }
        }
    }
    return pairs;
}

test.describe('a crowd of groups', () => {
    test('draws no two labels on top of each other', async ({ page }) => {
        await boot(page);
        await select(page, 'per:hub');
        await makeEveryLabelEligible(page);

        const labels = await shownLabels(page);
        expect(labels.length).toBeGreaterThan(1);
        expect(collidingPairs(labels)).toEqual([]);
    });

    test('suppresses some of them, rather than fitting all fourteen', async ({ page }) => {
        // If everything fits, the test above proves nothing.
        await boot(page);
        await select(page, 'per:hub');
        await makeEveryLabelEligible(page);

        const labels = await shownLabels(page);
        expect(labels.length).toBeLessThan(GROUP_COUNT + 1);
    });

    test('the selected name is never the one suppressed', async ({ page }) => {
        await boot(page);
        await select(page, 'per:hub');

        const labels = await shownLabels(page);
        expect(labels.map((l) => l.id)).toContain('per:hub');
    });

    test('the selection keeps its label after moving to a person in the pile', async ({ page }) => {
        await boot(page);
        await select(page, 'per:hub');
        await select(page, 'grp:7');
        await makeEveryLabelEligible(page);

        const labels = await shownLabels(page);
        expect(labels.map((l) => l.id)).toContain('grp:7');
        expect(collidingPairs(labels)).toEqual([]);
    });

    test('a hovered node gets its name even in the middle of a pile', async ({ page }) => {
        await boot(page);
        await select(page, 'per:hub');

        await page.evaluate(() => {
            const node = window.musicGraph.ht.graph.getNode('grp:3');
            node.setData('hoverTooltip', true);
            window.musicGraph.ht.plot();
        });

        const labels = await shownLabels(page);
        expect(labels.map((l) => l.id)).toContain('grp:3');
    });

    test('the resolution is stable across repeated plots', async ({ page }) => {
        // Two labels at the same radius must not swap every frame; where they
        // overlap that reads as flicker.
        await boot(page);
        await select(page, 'per:hub');
        await makeEveryLabelEligible(page);

        const first = (await shownLabels(page)).map((l) => l.id).sort();
        await page.evaluate(() => {
            window.musicGraph.ht.plot();
            window.musicGraph.ht.plot();
            window.musicGraph.ht.plot();
        });
        const second = (await shownLabels(page)).map((l) => l.id).sort();

        expect(second).toEqual(first);
    });

    test('the frame the animation settles on is already resolved', async ({ page }) => {
        // No forced plot after selecting. The label set has to be correct for
        // the plot the animation itself ended on, which is the case a wrapper
        // on viz.plot misses: JIT calls viz.fx.plot() directly, so that wrapper
        // catches our own calls only and leaves the set one frame behind.
        await boot(page);
        await page.evaluate(() => {
            window.musicGraph.labelProximityThreshold = 1;
            window.musicGraph.groupLabelProximityThreshold = 1;
        });

        await select(page, 'per:hub');

        const labels = await shownLabels(page);
        expect(labels.length).toBeGreaterThan(1);
        expect(collidingPairs(labels)).toEqual([]);
    });

    test('hiding labels altogether still works', async ({ page }) => {
        await boot(page);
        await select(page, 'per:hub');
        expect((await shownLabels(page)).length).toBeGreaterThan(0);

        await page.evaluate(() => {
            window.musicGraph.labelsVisible = false;
            window.musicGraph.ht.plot();
        });

        expect(await shownLabels(page)).toEqual([]);
    });
});

test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('groups hold their names over a smaller radius than on a monitor', async ({ page }) => {
        // A third of the width holds a third of the names, so the radius comes
        // in rather than leaving collision resolution to say no to most of what
        // it is handed.
        await boot(page);

        const threshold = await page.evaluate(() => window.musicGraph.groupLabelProximityThreshold);
        expect(threshold).toBeCloseTo(0.68 ** 2, 6);
    });

    test('still draws no overlapping labels', async ({ page }) => {
        await boot(page);
        await select(page, 'per:hub');
        await makeEveryLabelEligible(page);

        const labels = await shownLabels(page);
        expect(collidingPairs(labels)).toEqual([]);
    });
});

test.describe('on a monitor', () => {
    test('groups keep the wider radius', async ({ page }) => {
        await boot(page);
        const threshold = await page.evaluate(() => window.musicGraph.groupLabelProximityThreshold);
        expect(threshold).toBeCloseTo(0.9 ** 2, 6);
    });
});
