/**
 * What the panel shows while you browse quickly.
 *
 * Two separate problems, and the tests keep them separate.
 *
 * The first is sequencing: selection, the 700ms recentring animation and the
 * details request used to happen one after another, so the earliest a name could
 * appear was 700ms after the tap and the earliest the content could was 700ms
 * plus a round trip. Nothing here shortens the animation; the tests assert the
 * details no longer wait behind it.
 *
 * The second is ordering. Several requests are in flight while someone browses,
 * and they do not return in the order they were sent. Each test below delays one
 * response deliberately, because a race that is left to chance is a test that
 * passes on a fast machine and fails in CI.
 */

import { test, expect } from '@playwright/test';

const GRAPH = {
    nodes: [
        { id: 'grp:band', name: 'Test Band', type: 'group' },
        { id: 'per:slow', name: 'Slow Person', type: 'person' },
        { id: 'per:fast', name: 'Fast Person', type: 'person' },
    ],
    edges: [
        { source: 'per:slow', target: 'grp:band', type: 'MEMBER_OF', role: 'drums' },
        { source: 'per:fast', target: 'grp:band', type: 'MEMBER_OF', role: 'bass' },
    ],
};

const DETAILS = {
    'grp:band': { group_id: 'grp:band', name: 'Test Band', bio: 'Band biography' },
    'per:slow': { person_id: 'per:slow', name: 'Slow Person', city: 'Slowville' },
    'per:fast': { person_id: 'per:fast', name: 'Fast Person', city: 'Fasttown' },
};

/**
 * Boot with per-node detail latency under the test's control.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{delays?: Record<string, number>, releaseDelays?: Record<string, number>}} [options]
 */
async function boot(page, { delays = {}, releaseDelays = {} } = {}) {
    const seen = { details: [], releases: [] };

    await page.route('**/api/**', async (route) => {
        const url = decodeURIComponent(route.request().url());

        if (url.includes('/stake/')) {
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, units: '0', formatted: '0.0000 MUS', stakerCount: 0 }),
            });
        }

        // Group releases, for the orbit.
        const releaseMatch = url.match(/\/groups?\/([^/]+)\/releases/);
        if (releaseMatch) {
            const groupId = releaseMatch[1];
            seen.releases.push(groupId);
            const wait = releaseDelays[groupId] ?? 0;
            if (wait) await new Promise((r) => setTimeout(r, wait));
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    releases: [{ release_id: `rel:${groupId}`, title: `Album of ${groupId}`, type: 'LP' }],
                }),
            });
        }

        const id = Object.keys(DETAILS).find((key) => url.endsWith(`/${key}`));
        if (id) {
            seen.details.push(id);
            const wait = delays[id] ?? 0;
            if (wait) await new Promise((r) => setTimeout(r, wait));
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify(DETAILS[id]) });
        }

        route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) });
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
    return seen;
}

/** Tap a node without waiting for anything. */
const tap = (page, id) => page.evaluate((nodeId) => {
    const g = window.musicGraph;
    g.handleNodeClick(g.ht.graph.getNode(nodeId));
}, id);

test.describe('the details no longer wait for the animation', () => {
    test('the name appears without waiting 700ms for the recentring', async ({ page }) => {
        await boot(page);

        const started = Date.now();
        await tap(page, 'per:fast');
        await expect(page.locator('#info-title')).toHaveText('Fast Person');
        const elapsed = Date.now() - started;

        // The animation is 700ms and unchanged. A title that arrives inside half
        // of that cannot have been waiting behind it.
        expect(elapsed).toBeLessThan(350);
    });

    test('the request is sent on tap, not after the animation', async ({ page }) => {
        const seen = await boot(page);
        const before = seen.details.length;

        await tap(page, 'per:fast');
        // Well inside the 700ms animation.
        await page.waitForTimeout(150);

        expect(seen.details.length).toBeGreaterThan(before);
        expect(seen.details).toContain('per:fast');
    });

    test('the content lands too, not just the name', async ({ page }) => {
        await boot(page);
        await tap(page, 'per:fast');

        await expect(page.locator('#info-content')).toContainText('Fasttown');
    });

    test('the animation still runs — nothing here shortened it', async ({ page }) => {
        await boot(page);
        await tap(page, 'per:fast');

        // Busy immediately after the tap, settled later: the recentring is
        // still a 700ms animation, it just no longer gates the request.
        expect(await page.evaluate(() => window.musicGraph.ht.busy)).toBe(true);
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 5_000 });
    });
});

test.describe('a slow response cannot overwrite a newer selection', () => {
    test('the panel keeps the node you are on', async ({ page }) => {
        // per:slow answers after 1200ms, per:fast immediately. Tap slow, then
        // fast: without a guard the slow response lands last and wins.
        await boot(page, { delays: { 'per:slow': 1200 } });

        await tap(page, 'per:slow');
        await tap(page, 'per:fast');

        await expect(page.locator('#info-title')).toHaveText('Fast Person');
        await expect(page.locator('#info-content')).toContainText('Fasttown');

        // Past the slow response's arrival, it must still say Fast Person.
        await page.waitForTimeout(1600);
        await expect(page.locator('#info-title')).toHaveText('Fast Person');
        await expect(page.locator('#info-content')).toContainText('Fasttown');
        await expect(page.locator('#info-content')).not.toContainText('Slowville');
    });

    test('a stale failure does not replace a good panel with an error', async ({ page }) => {
        await boot(page, { delays: { 'per:slow': 1200 } });
        // Make the slow one fail, slowly.
        await page.route('**/per:slow', async (route) => {
            await new Promise((r) => setTimeout(r, 1200));
            route.fulfill({ status: 500, body: 'nope' });
        });

        await tap(page, 'per:slow');
        await tap(page, 'per:fast');
        await expect(page.locator('#info-title')).toHaveText('Fast Person');

        await page.waitForTimeout(1600);
        await expect(page.locator('#info-content')).not.toContainText('Error loading details');
        await expect(page.locator('#info-content')).toContainText('Fasttown');
    });

    test('three taps in a row leave the last one showing', async ({ page }) => {
        await boot(page, { delays: { 'per:slow': 900, 'grp:band': 400 } });

        await tap(page, 'per:slow');
        await tap(page, 'grp:band');
        await tap(page, 'per:fast');

        await page.waitForTimeout(1400);
        await expect(page.locator('#info-title')).toHaveText('Fast Person');
    });

    test('a release taking the panel over is not overwritten by a node fetch', async ({ page }) => {
        await boot(page, { delays: { 'per:slow': 1000 } });

        await tap(page, 'per:slow');
        // The overlay hands a release to the panel while the person's details
        // are still in flight.
        await page.evaluate(() => {
            window.musicGraph._onOverlayReleaseSelect({
                release_id: 'rel:x', name: 'Some Album', type: 'LP', tracks: [],
            });
        });
        await expect(page.locator('#info-title')).toHaveText('Some Album');

        await page.waitForTimeout(1400);
        await expect(page.locator('#info-title')).toHaveText('Some Album');
    });
});

test.describe('the release orbit cannot be left holding another group', () => {
    test('a slow release response is dropped once the selection moves', async ({ page }) => {
        await boot(page, { releaseDelays: { 'grp:band': 1200 } });

        // Select the group so its orbit starts fetching, then leave.
        await tap(page, 'grp:band');
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 5_000 });
        await tap(page, 'per:fast');

        await page.waitForTimeout(1600);

        // The overlay belongs to nobody now, and must not be holding the
        // group's discography — selectRelease() and every tile handler read it.
        const state = await page.evaluate(() => ({
            visible: window.musicGraph.releaseOverlay.visible,
            releases: window.musicGraph.releaseOverlay.releases.length,
            anchor: window.musicGraph.releaseOverlay.anchorNodeId,
        }));

        expect(state.releases).toBe(0);
        expect(state.anchor).not.toBe('grp:band');
    });

    test('hiding the overlay mid-flight drops the response', async ({ page }) => {
        await boot(page, { releaseDelays: { 'grp:band': 1000 } });

        await page.evaluate(() => {
            const g = window.musicGraph;
            // Start a show, then hide before it resolves.
            g.releaseOverlay.show('grp:band', { x: 100, y: 100 }, 30);
            g.releaseOverlay.hide();
        });

        await page.waitForTimeout(1400);

        const state = await page.evaluate(() => ({
            visible: window.musicGraph.releaseOverlay.visible,
            releases: window.musicGraph.releaseOverlay.releases.length,
        }));
        expect(state.visible).toBe(false);
        expect(state.releases).toBe(0);
    });

    test('the newest show wins when two are in flight', async ({ page }) => {
        await boot(page, { releaseDelays: { slowgroup: 1200 } });
        await page.route('**/group/fastgroup/releases*', (route) =>
            route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, releases: [{ release_id: 'rel:fast', title: 'Fast Album', type: 'LP' }] }),
            }));

        await page.evaluate(() => {
            const overlay = window.musicGraph.releaseOverlay;
            overlay.show('slowgroup', { x: 100, y: 100 }, 30);
            overlay.show('fastgroup', { x: 100, y: 100 }, 30);
        });

        await page.waitForTimeout(1600);

        const titles = await page.evaluate(() =>
            window.musicGraph.releaseOverlay.releases.map((r) => r.title));
        expect(titles).toEqual(['Fast Album']);
    });
});
