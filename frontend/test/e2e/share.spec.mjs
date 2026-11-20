/**
 * Linking to one particular thing.
 *
 * The registry is a single page that opens on whatever the lottery drew, so
 * there was no way to say "look at this one". The share button names what the
 * panel is showing — and where that only makes sense in a context, names the
 * context too: a guest chip exists in the orbit of one release, and is only
 * drawn when a toggle is on.
 *
 * The clipboard is stubbed rather than permitted, so the assertion is on the
 * string the page tried to copy rather than on a browser permission.
 */

import { test, expect } from '@playwright/test';

const BAND = { id: 'grp:band', name: 'Test Band', type: 'group' };
const DRUMMER = { id: 'per:drums', name: 'A Drummer', type: 'person', color: '#aabbcc' };
const SAX = { id: 'per:sax', name: 'A Saxophonist', type: 'person', color: '#ff8800' };

const RELEASE = {
    release_id: 'rel:0', name: 'Long Player', type: 'LP', release_date: '1991-01-01',
    guests: [{ person_id: 'per:sax', name: 'A Saxophonist', roles: ['saxophone'] }],
    groups: [{ group_id: 'grp:band', name: 'Test Band', members: [] }],
    tracks: [],
};

function payloadFor(url) {
    const asked = (name) => url.searchParams.get(name) === 'true';
    const nodes = [BAND, DRUMMER];
    const edges = [{ source: 'per:drums', target: 'grp:band', type: 'MEMBER_OF', role: 'drums' }];
    if (asked('musicalGuests') || asked('guests')) {
        nodes.push(SAX);
        edges.push({
            source: 'per:sax', target: 'grp:band', type: 'GUEST_ON',
            trackCount: 1, scope: 'track', role: 'saxophone', roles: ['saxophone'],
        });
    }
    return { nodes, edges };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} [query] - Appended to the page URL, e.g. "?node=grp:band".
 */
async function boot(page, query = '') {
    // Capture what the page copies, and take the share sheet out of the
    // picture so the clipboard branch is the one under test.
    await page.addInitScript(() => {
        window.__copied = [];
        delete window.navigator.share;
        Object.defineProperty(window.navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async (text) => { window.__copied.push(text); } },
        });
    });

    await page.route('**/api/**', (route) =>
        route.fulfill({ contentType: 'application/json', body: '{}' }));
    await page.route('**/graph/initial*', (route) =>
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(payloadFor(new URL(route.request().url()))),
        }));
    await page.route('**/graph/sponsored*', (route) =>
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ success: true, node: null }),
        }));
    await page.route('**/group/grp:band/releases*', (route) =>
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ success: true, releases: [RELEASE] }),
        }));
    await page.route('**/api/release/rel:0', (route) =>
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: RELEASE }),
        }));
    await page.route('**/api/person/*', (route) => {
        const id = decodeURIComponent(route.request().url().split('/person/')[1]).split('?')[0];
        const name = { 'per:sax': 'A Saxophonist', 'per:drums': 'A Drummer' }[id] || 'Someone';
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                data: {
                    person_id: id, name, groups: [], songsWritten: 0,
                    guestAppearances: 1, mainPage: null, releases: [],
                },
            }),
        });
    });

    await page.goto(`/${query}`, { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 15_000 }
    );
}

const select = async (page, id) => {
    await page.evaluate((nodeId) => {
        const g = window.musicGraph;
        g.handleNodeClick(g.ht.graph.getNode(nodeId));
    }, id);
    await page.waitForFunction(
        (nodeId) => window.musicGraph.selectedNode?.id === nodeId && !window.musicGraph.ht.busy,
        id, { timeout: 10_000 });
};

const copied = (page) => page.evaluate(() => window.__copied.at(-1) ?? null);

test.describe('the share button', () => {
    test('is dead until there is something to point at', async ({ page }) => {
        await boot(page);

        await expect(page.locator('#node-share')).toBeDisabled();
    });

    test('wakes up when a node is selected', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');

        await expect(page.locator('#node-share')).toBeEnabled();
    });

    test('copies a link naming that node', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');
        await page.locator('#node-share').click();

        const url = await copied(page);
        expect(url).toContain('node=grp%3Aband');
    });

    test('and says so', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');
        await page.locator('#node-share').click();

        await expect(page.locator('#node-share')).toHaveClass(/btn-share--done/);
    });

    test('carries a toggle that is on, and omits one that is off', async ({ page }) => {
        // A link to an ordinary member should not carry flags that say
        // nothing; a guest's link has to, or it opens on an empty graph.
        await boot(page);
        await page.locator('#show-musical-guests').check();
        await page.waitForFunction(() => !!window.musicGraph.ht.graph.getNode('per:sax'));
        await select(page, 'per:sax');
        await page.locator('#node-share').click();

        const url = await copied(page);
        expect(url).toContain('musicalGuests=true');
        expect(url).not.toContain('technicians=true');
    });
});

test.describe('following a link', () => {
    test('opens on the node it names', async ({ page }) => {
        await boot(page, '?node=per%3Adrums');

        await page.waitForFunction(
            () => window.musicGraph.selectedNode?.id === 'per:drums', { timeout: 10_000 });
        await expect(page.locator('#info-title')).toHaveText('A Drummer');
    });

    test('turns on the toggle it carries, boxes and all', async ({ page }) => {
        await boot(page, '?node=per%3Asax&musicalGuests=true');

        await expect(page.locator('#show-musical-guests')).toBeChecked();
        await expect(page.locator('#menu-show-musical-guests')).toBeChecked();
        await page.waitForFunction(
            () => window.musicGraph.selectedNode?.id === 'per:sax', { timeout: 10_000 });
    });

    test('a node this graph does not have is survivable', async ({ page }) => {
        // A link may name somebody the reader's toggles leave out, or a node
        // merged away since. Opening the registry is better than an error.
        await boot(page, '?node=per%3Anobody');

        await expect(page.locator('#node-share')).toBeAttached();
        expect(await page.evaluate(() => window.musicGraph.selectedNode?.id ?? null))
            .toBeNull();
    });
});

test.describe('a link to a guest keeps its context', () => {
    const GUEST_LINK = '?node=grp%3Aband&release=rel%3A0&guest=per%3Asax&musicalGuests=true';

    test('opens the release in the orbit and marks the chip', async ({ page }) => {
        await boot(page, GUEST_LINK);

        await page.waitForSelector('.release-guest-chip--selected', { timeout: 15_000 });
        await expect(page.locator('#info-title')).toHaveText('A Saxophonist');
    });

    test('and the panel says what they did there', async ({ page }) => {
        await boot(page, GUEST_LINK);
        await page.waitForSelector('.release-guest-chip--selected', { timeout: 15_000 });

        await expect(page.locator('#info-content')).toContainText('On Long Player');
        await expect(page.locator('#info-content')).toContainText('saxophone');
    });

    test('and sharing from there reproduces the same link', async ({ page }) => {
        // The round trip is the point: what a reader lands on is what the
        // sender was looking at, and can be passed on again unchanged.
        await boot(page, GUEST_LINK);
        await page.waitForSelector('.release-guest-chip--selected', { timeout: 15_000 });

        await page.locator('#node-share').click();
        const url = new URL(await copied(page));

        expect(url.searchParams.get('node')).toBe('grp:band');
        expect(url.searchParams.get('release')).toBe('rel:0');
        expect(url.searchParams.get('guest')).toBe('per:sax');
        expect(url.searchParams.get('musicalGuests')).toBe('true');
    });
});
