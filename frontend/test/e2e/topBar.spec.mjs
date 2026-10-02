/**
 * The top bar at phone width, and stepping through history.
 *
 * The measurement that prompted this: at 390px the bar wanted 512px of content,
 * of which the balance readout alone was 203px, and Favorites, Curate and
 * History were laid out at x=409..491 — present in the DOM, off the side of the
 * screen, and so reported as working by every test that only asked whether they
 * existed. These tests ask where things are.
 */

import { test, expect } from '@playwright/test';

const GRAPH = {
    nodes: [
        { id: 'grp:band', name: 'Test Band', type: 'group' },
        { id: 'per:drums', name: 'A Drummer', type: 'person' },
        { id: 'per:bass', name: 'A Bassist', type: 'person' },
    ],
    edges: [
        { source: 'grp:band', target: 'per:drums', type: 'MEMBER_OF', role: 'drums' },
        { source: 'grp:band', target: 'per:bass', type: 'MEMBER_OF', role: 'bass' },
    ],
};

const DETAILS = {
    'grp:band': { group_id: 'grp:band', name: 'Test Band' },
    'per:drums': { person_id: 'per:drums', name: 'A Drummer' },
    'per:bass': { person_id: 'per:bass', name: 'A Bassist' },
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
        const match = Object.keys(DETAILS).find((id) => url.endsWith(`/${id}`));
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(match ? DETAILS[match] : {}),
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
    // Start from a clean log: it persists to localStorage across tests.
    await page.evaluate(() => {
        window.musicGraph.pathTracker.clearBrowseHistory();
        window.musicGraph.updateHistoryNavButtons();
    });
}

/** Everything in the bar that a person is meant to be able to press. */
async function offScreen(page) {
    return page.evaluate(() => {
        const out = [];
        const selectors = [
            '#nav-back', '#nav-forward', '#connect-wallet',
            '#top-bar-menu-toggle', '#favorites-toggle', '#curate-toggle', '#history-toggle',
        ];
        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (!el || el.offsetParent === null) continue;   // hidden is fine
            const rect = el.getBoundingClientRect();
            if (rect.right > window.innerWidth + 0.5 || rect.left < -0.5) out.push(selector);
        }
        return out;
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

test.describe('the bar on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('nothing visible is pushed off the side', async ({ page }) => {
        await boot(page);
        // Put a balance in, which is the state that caused the overflow.
        await page.evaluate(() => {
            document.getElementById('user-balance').textContent =
                '123.4500 MUS · 50.0000 MUS staked';
        });

        expect(await offScreen(page)).toEqual([]);
    });

    test('the bar does not scroll, which is how the overflow hid', async ({ page }) => {
        await boot(page);
        const { client, scroll } = await page.evaluate(() => {
            const bar = document.getElementById('top-bar');
            return { client: bar.clientWidth, scroll: bar.scrollWidth };
        });
        expect(scroll).toBeLessThanOrEqual(client);
    });

    test('Favorites, Curate and History are reachable, with their names', async ({ page }) => {
        await boot(page);
        await page.locator('#top-bar-menu-toggle').click();

        const menu = page.locator('#top-bar-menu');
        await expect(menu).toBeVisible();
        await expect(menu).toContainText('Favorites');
        await expect(menu).toContainText('Curate');
        await expect(menu).toContainText('History');
    });

    test('a menu item opens its panel and closes the menu', async ({ page }) => {
        await boot(page);
        await page.locator('#top-bar-menu-toggle').click();
        await page.locator('.top-bar-menu-item[data-opens="history"]').click();

        await expect(page.locator('#top-bar-menu')).toBeHidden();
        await expect(page.locator('#history-panel')).toBeVisible();
    });

    test('tapping elsewhere dismisses the menu', async ({ page }) => {
        await boot(page);
        await page.locator('#top-bar-menu-toggle').click();
        await expect(page.locator('#top-bar-menu')).toBeVisible();

        await page.locator('#infovis').click({ position: { x: 10, y: 10 } });
        await expect(page.locator('#top-bar-menu')).toBeHidden();
    });

    test('the balance lives in the menu, not in the bar', async ({ page }) => {
        await boot(page);
        await expect(page.locator('#user-balance')).toBeHidden();

        await page.locator('#top-bar-menu-toggle').click();
        await expect(page.locator('#menu-balance')).toBeVisible();
    });

    test('back and forward stay in the bar, where they are pressed most', async ({ page }) => {
        await boot(page);
        await expect(page.locator('#nav-back')).toBeVisible();
        await expect(page.locator('#nav-forward')).toBeVisible();
    });
});

test.describe('the bar on a desktop', () => {
    test('keeps the stats inline and hides the overflow menu', async ({ page }) => {
        await boot(page);
        await expect(page.locator('#history-toggle')).toBeVisible();
        await expect(page.locator('#top-bar-menu-toggle')).toBeHidden();
        expect(await offScreen(page)).toEqual([]);
    });
});

test.describe('back and forward', () => {
    test('are disabled until there is somewhere to go', async ({ page }) => {
        await boot(page);
        await expect(page.locator('#nav-back')).toBeDisabled();
        await expect(page.locator('#nav-forward')).toBeDisabled();

        await select(page, 'grp:band');
        // One visit is still nowhere to go back to.
        await expect(page.locator('#nav-back')).toBeDisabled();

        await select(page, 'per:drums');
        await expect(page.locator('#nav-back')).toBeEnabled();
        await expect(page.locator('#nav-forward')).toBeDisabled();
    });

    test('step back through the nodes that were visited', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');
        await select(page, 'per:drums');
        await select(page, 'per:bass');

        await page.locator('#nav-back').click();
        await page.waitForFunction(() => window.musicGraph.selectedNode?.id === 'per:drums');
        await expect(page.locator('#info-title')).toHaveText('A Drummer');

        await page.locator('#nav-back').click();
        await page.waitForFunction(() => window.musicGraph.selectedNode?.id === 'grp:band');
    });

    test('forward retraces, and does not multiply the log', async ({ page }) => {
        // Stepping must not record: a back that appends its own destination
        // leaves forward permanently empty and the log full of ghosts.
        await boot(page);
        await select(page, 'grp:band');
        await select(page, 'per:drums');
        await select(page, 'per:bass');

        const before = await page.evaluate(() =>
            window.musicGraph.pathTracker.getBrowseHistory().length);

        await page.locator('#nav-back').click();
        await page.waitForFunction(() => window.musicGraph.selectedNode?.id === 'per:drums');
        await page.locator('#nav-forward').click();
        await page.waitForFunction(() => window.musicGraph.selectedNode?.id === 'per:bass');

        const after = await page.evaluate(() =>
            window.musicGraph.pathTracker.getBrowseHistory().length);
        expect(after).toBe(before);
    });

    test('forward goes dead once you walk somewhere new', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');
        await select(page, 'per:drums');

        await page.locator('#nav-back').click();
        await page.waitForFunction(() => window.musicGraph.selectedNode?.id === 'grp:band');
        await expect(page.locator('#nav-forward')).toBeEnabled();

        await select(page, 'per:bass');
        await expect(page.locator('#nav-forward')).toBeDisabled();
    });
});
