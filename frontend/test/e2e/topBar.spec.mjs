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
            // The search was missing from this list, which is part of why it
            // could go hidden on a phone for as long as it did: every test
            // asked after the controls it already knew about.
            '#search-toggle', '.node-search-input',
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

    test('the search is reachable at all', async ({ page }) => {
        // The ticket: invisible on mobile. Not clipped and not off-screen —
        // `.top-bar-center` was display:none at this width, so the input was
        // in the DOM at 0x0 with no offsetParent, and the comment next to the
        // rule promised an icon that was never built.
        await boot(page);

        await expect(page.locator('#search-toggle')).toBeVisible();
        await page.locator('#search-toggle').click();

        await expect(page.locator('.node-search-input')).toBeVisible();
    });

    test('and wide enough to type a band name into', async ({ page }) => {
        // There is about 80px of slack in the bar at this width. An input that
        // fits in the slack is not a search box, which is why this opens over
        // the bar instead of squeezing in beside it.
        //
        // Most of the bar, not merely more than the slack: the box centres
        // itself at its own intrinsic width unless told otherwise, which left
        // it indented with empty bar either side — the width was taken and
        // then not used.
        await boot(page);
        await page.locator('#search-toggle').click();

        const width = await page.locator('.node-search-input')
            .evaluate((el) => el.getBoundingClientRect().width);
        expect(width).toBeGreaterThan(300);
    });

    test('and the results can actually be touched', async ({ page }) => {
        // The bug the screenshots caught and none of the tests above did. The
        // bar sets overflow:hidden on a phone to stop its own content spilling,
        // and the results list hangs below the bar from inside it — so it was
        // clipped a few pixels down. Typing worked, the request went out, the
        // answers came back, and the reader saw a sliver of the first one.
        //
        // Asked through elementFromPoint, because that is the question: a rect
        // is reported in full whether or not an ancestor clips it away, so
        // measuring one proves nothing about what a finger would land on.
        await boot(page);
        await page.route('**/api/search/nodes*', (route) => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ success: true, results: [
                { id: 'per:drums', type: 'Person', display_name: 'A Drummer', subtitle: 'Test Band' },
                { id: 'grp:band', type: 'Group', display_name: 'Test Band', subtitle: '2 members' },
            ] }),
        }));

        await page.locator('#search-toggle').click();
        await page.locator('.node-search-input').fill('dr');
        await expect(page.locator('.node-search-item')).toHaveCount(2);

        const reachable = await page.evaluate(() => [...document.querySelectorAll('.node-search-item')]
            .map((item) => {
                const r = item.getBoundingClientRect();
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return !!hit && item.contains(hit);
            }));
        expect(reachable).toEqual([true, true]);
    });

    test('the input takes focus, so the keyboard comes up with it', async ({ page }) => {
        await boot(page);
        await page.locator('#search-toggle').click();

        await expect(page.locator('.node-search-input')).toBeFocused();
    });

    test('closing it puts the bar back', async ({ page }) => {
        await boot(page);
        await page.locator('#search-toggle').click();
        await expect(page.locator('.node-search-input')).toBeVisible();

        await page.locator('#search-toggle').click();

        await expect(page.locator('.node-search-input')).toBeHidden();
        await expect(page.locator('.logo')).toBeVisible();
        await expect(page.locator('#connect-wallet')).toBeVisible();
        expect(await offScreen(page)).toEqual([]);
    });

    test('Escape closes it too', async ({ page }) => {
        await boot(page);
        await page.locator('#search-toggle').click();

        await page.keyboard.press('Escape');

        await expect(page.locator('.node-search-input')).toBeHidden();
    });

    test('choosing a result travels there and gives the bar back', async ({ page }) => {
        await boot(page);
        await page.route('**/api/search/nodes*', (route) => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ success: true, results: [
                { id: 'per:drums', type: 'Person', display_name: 'A Drummer', subtitle: '' },
            ] }),
        }));

        await page.locator('#search-toggle').click();
        await page.locator('.node-search-input').fill('drum');
        await page.locator('.node-search-item').first().click();

        await expect.poll(() => page.evaluate(
            () => window.musicGraph.selectedNode?.id ?? null)).toBe('per:drums');
        // Left open, the bar would still be a search box over a graph that had
        // already moved.
        await expect(page.locator('.node-search-input')).toBeHidden();
    });

    test('opening the search does not push anything off the side', async ({ page }) => {
        await boot(page);
        await page.locator('#search-toggle').click();

        expect(await offScreen(page)).toEqual([]);
        const { client, scroll } = await page.evaluate(() => {
            const bar = document.getElementById('top-bar');
            return { client: bar.clientWidth, scroll: bar.scrollWidth };
        });
        expect(scroll).toBeLessThanOrEqual(client);
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

test.describe('the bar at 320px, the narrowest phone still in use', () => {
    test.use({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });

    test('adding the search control did not push the menu off the side', async ({ page }) => {
        // It did, at first: the ⋯ laid out at 325..355 in a 320px window, which
        // is how Favorites, Curate and History were lost the last time. The
        // bar's own padding and gaps paid for the new control.
        await boot(page);

        expect(await offScreen(page)).toEqual([]);
        const { client, scroll } = await page.evaluate(() => {
            const bar = document.getElementById('top-bar');
            return { client: bar.clientWidth, scroll: bar.scrollWidth };
        });
        expect(scroll).toBeLessThanOrEqual(client);
    });

    test('and the search still opens', async ({ page }) => {
        await boot(page);
        await page.locator('#search-toggle').click();

        await expect(page.locator('.node-search-input')).toBeVisible();
        expect(await offScreen(page)).toEqual([]);
    });
});

test.describe('the bar on a desktop', () => {
    test('keeps the stats inline and hides the overflow menu', async ({ page }) => {
        await boot(page);
        await expect(page.locator('#history-toggle')).toBeVisible();
        await expect(page.locator('#top-bar-menu-toggle')).toBeHidden();
        expect(await offScreen(page)).toEqual([]);
    });

    test('the search is just there, with nothing to press first', async ({ page }) => {
        // Where there is room for it the box stays in the bar, and the phone's
        // magnifier is not in the way.
        await boot(page);

        await expect(page.locator('.node-search-input')).toBeVisible();
        await expect(page.locator('#search-toggle')).toBeHidden();
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
