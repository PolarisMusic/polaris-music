/**
 * The show-guests checkbox.
 *
 * Two things to hold onto. The refetch has to actually ask for guests — a
 * checkbox that toggles a flag nobody reads looks identical to one that works
 * against a graph with no guest credits in it. And a guest edge must not be
 * painted as a membership: both run Person → Group, the styling rules key off
 * the node types at each end, and the member/guest distinction is the one this
 * registry exists to record.
 */

import { test, expect } from '@playwright/test';

const MEMBERS_ONLY = {
    nodes: [
        { id: 'grp:band', name: 'Test Band', type: 'group' },
        { id: 'per:drums', name: 'A Drummer', type: 'person', color: '#aabbcc' },
    ],
    edges: [{ source: 'per:drums', target: 'grp:band', type: 'MEMBER_OF', role: 'drums' }],
};

const WITH_GUESTS = {
    nodes: [
        ...MEMBERS_ONLY.nodes,
        { id: 'per:sax', name: 'A Saxophonist', type: 'person', color: '#ff8800' },
    ],
    edges: [
        ...MEMBERS_ONLY.edges,
        {
            source: 'per:sax', target: 'grp:band', type: 'GUEST_ON',
            trackCount: 2, scope: 'track', roles: ['saxophone'],
        },
    ],
};

async function boot(page) {
    const requested = [];
    // Registered first on purpose: Playwright matches the most recently added
    // route, so the broad catch-all has to go down before the specific ones or
    // it answers /api/graph/initial with an empty object and the graph never
    // boots.
    await page.route('**/api/**', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) }));
    await page.route('**/graph/initial*', (route) => {
        const url = route.request().url();
        requested.push(url);
        const body = url.includes('guests=true') ? WITH_GUESTS : MEMBERS_ONLY;
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.route('**/graph/sponsored*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, node: null }) }));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 15_000 }
    );
    return requested;
}

/** Every node id currently in the hypertree. */
const nodeIds = (page) => page.evaluate(() => {
    const ids = [];
    window.musicGraph.ht.graph.eachNode((n) => ids.push(n.id));
    return ids.sort();
});

test.describe('the checkbox', () => {
    test('starts unticked, and the first load does not ask for guests', async ({ page }) => {
        const requested = await boot(page);

        await expect(page.locator('#show-guests')).not.toBeChecked();
        expect(requested.some((url) => url.includes('guests=true'))).toBe(false);
        expect(await nodeIds(page)).not.toContain('per:sax');
    });

    test('ticking it refetches with guests and the guest appears', async ({ page }) => {
        const requested = await boot(page);
        await page.locator('#show-guests').check();

        await page.waitForFunction(
            () => !!window.musicGraph.ht.graph.getNode('per:sax'),
            { timeout: 10_000 }
        );
        expect(requested.some((url) => url.includes('guests=true'))).toBe(true);
    });

    test('unticking it takes them away again', async ({ page }) => {
        await boot(page);
        await page.locator('#show-guests').check();
        await page.waitForFunction(() => !!window.musicGraph.ht.graph.getNode('per:sax'));

        await page.locator('#show-guests').uncheck();
        await page.waitForFunction(
            () => !window.musicGraph.ht.graph.getNode('per:sax'),
            { timeout: 10_000 }
        );
    });

    test('a guest edge is drawn as a credit, not as a membership', async ({ page }) => {
        // Half-alpha from the palette's GUEST_ON branch, and thinner. An opaque
        // colour here means the type-pair rules claimed it as MEMBER_OF.
        await boot(page);
        await page.locator('#show-guests').check();
        await page.waitForFunction(() => !!window.musicGraph.ht.graph.getNode('per:sax'));

        const styles = await page.evaluate(() => {
            const graph = window.musicGraph.ht.graph;
            const out = {};
            graph.eachNode((node) => {
                node.eachAdjacency((adj) => {
                    const type = adj.data?.type;
                    if (type !== 'MEMBER_OF' && type !== 'GUEST_ON') return;
                    out[type] = {
                        color: adj.getData('color'),
                        lineWidth: adj.getData('lineWidth'),
                    };
                });
            });
            return out;
        });

        expect(styles.GUEST_ON).toBeDefined();
        expect(styles.MEMBER_OF).toBeDefined();
        expect(styles.GUEST_ON.color).toMatch(/^rgba\(/);
        expect(styles.GUEST_ON.color).not.toBe(styles.MEMBER_OF.color);
        expect(styles.GUEST_ON.lineWidth).toBeLessThan(styles.MEMBER_OF.lineWidth);
    });

    test('a guest edge is navigable like any other', async ({ page }) => {
        await boot(page);
        await page.locator('#show-guests').check();
        await page.waitForFunction(() => !!window.musicGraph.ht.graph.getNode('per:sax'));

        await page.evaluate(() => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode('grp:band'));
        });
        await page.waitForFunction(
            () => window.musicGraph.selectedNode?.id === 'grp:band' && !window.musicGraph.ht.busy
        );

        const targets = await page.evaluate(() =>
            window.musicGraph.edgeNavigator.candidates().map((c) => c.other.id).sort());
        expect(targets).toEqual(['per:drums', 'per:sax']);
    });

    test('the menu copy stays in step with the bar copy', async ({ page }) => {
        await boot(page);
        await page.locator('#show-guests').check();
        await page.waitForFunction(() => !!window.musicGraph.ht.graph.getNode('per:sax'));

        await expect(page.locator('#menu-show-guests')).toBeChecked();
    });
});

test.describe('the checkbox on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('is in the menu, where there is room to say what it does', async ({ page }) => {
        await boot(page);
        await expect(page.locator('#show-guests')).toBeHidden();

        await page.locator('#top-bar-menu-toggle').click();
        const menuBox = page.locator('#menu-show-guests');
        await expect(menuBox).toBeVisible();

        await menuBox.check();
        await page.waitForFunction(
            () => !!window.musicGraph.ht.graph.getNode('per:sax'),
            { timeout: 10_000 }
        );
    });

    test('does not push anything off the side of the bar', async ({ page }) => {
        await boot(page);
        const overflowing = await page.evaluate(() => {
            const out = [];
            for (const selector of ['#nav-back', '#nav-forward', '#connect-wallet', '#top-bar-menu-toggle']) {
                const el = document.querySelector(selector);
                if (!el || el.offsetParent === null) continue;
                const rect = el.getBoundingClientRect();
                if (rect.right > window.innerWidth + 0.5 || rect.left < -0.5) out.push(selector);
            }
            return out;
        });
        expect(overflowing).toEqual([]);
    });
});
