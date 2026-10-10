/**
 * The release orbit, as a thing you press with a finger.
 *
 * The orbit had no tests at all, which is awkward given that it is a ring of
 * 34px squares laid out by trigonometry. These cover the two things the
 * recording showed: the marks are smaller than a fingertip, and a square
 * carrying two letters of an album title tells a phone user nothing about what
 * it is — "LP" and "TD" in that recording were initials, not formats.
 *
 * The press tests ask the page what is actually under a point rather than
 * measuring a box, because the target is a pseudo-element and has no node of
 * its own. elementFromPoint answers the real question: would a press there hit
 * this tile?
 */

import { test, expect } from '@playwright/test';

const GRAPH = {
    nodes: [
        { id: 'grp:band', name: 'Test Band', type: 'group' },
        { id: 'per:drums', name: 'A Drummer', type: 'person' },
    ],
    edges: [{ source: 'per:drums', target: 'grp:band', type: 'MEMBER_OF', role: 'drums' }],
};

/** A discography of n releases, none with artwork — the case that reads worst. */
function releases(count) {
    return Array.from({ length: count }, (_, i) => ({
        release_id: `rel:${i}`,
        name: `Long Player Number ${i}`,
        type: i % 2 === 0 ? 'LP' : 'EP',
        release_date: `19${70 + i}-01-01`,
    }));
}

async function boot(page, { count = 12, withType = true } = {}) {
    const list = releases(count).map((r) => (withType ? r : { ...r, type: undefined }));

    await page.route('**/api/**', (route) => {
        const url = decodeURIComponent(route.request().url());

        if (/\/group\/[^/]+\/releases/.test(url)) {
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, releases: list }),
            });
        }
        if (/\/release(s)?\/rel:/.test(url)) {
            const id = (url.match(/rel:[^/?]+/) || [])[0];
            const found = list.find((r) => r.release_id === id) || list[0];
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, data: { ...found, guests: [], tracks: [] } }),
            });
        }
        if (url.includes('/stake/')) {
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, units: '0', formatted: '0.0000 MUS', stakerCount: 0 }),
            });
        }
        if (url.endsWith('/grp:band')) {
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ group_id: 'grp:band', name: 'Test Band' }),
            });
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
}

/** Select the group and wait for its orbit to render. */
async function openOrbit(page) {
    await page.evaluate(() => {
        const g = window.musicGraph;
        g.handleNodeClick(g.ht.graph.getNode('grp:band'));
    });
    await page.waitForFunction(
        () => document.querySelectorAll('.release-tile').length > 0,
        { timeout: 15_000 }
    );
}

/**
 * Centre and visual size of every tile.
 *
 * Centres come from the inline left/top the overlay wrote, plus half the size,
 * rather than from getBoundingClientRect: the rect is rounded to device pixels
 * and loses a fraction, and a tolerance wide enough to absorb that is also wide
 * enough to absorb a 1.1% spacing error. These are the numbers the code chose.
 */
const tileBoxes = (page) => page.evaluate(() =>
    [...document.querySelectorAll('.release-tile')].map((el) => {
        const w = parseFloat(el.style.width);
        const h = parseFloat(el.style.height);
        const r = el.getBoundingClientRect();
        return {
            id: el.dataset.releaseId,
            cx: parseFloat(el.style.left) + w / 2,
            cy: parseFloat(el.style.top) + h / 2,
            w,
            // Viewport coordinates, for pressing.
            vx: r.x + r.width / 2,
            vy: r.y + r.height / 2,
        };
    }));

test.describe('press targets on a touch device', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('a press 20px from a tile centre still hits that tile', async ({ page }) => {
        // The visual is 34px, so 20px out is 3px beyond its own edge and inside
        // the 44px target. Before this it would have hit the canvas behind.
        await boot(page);
        await openOrbit(page);

        const boxes = await tileBoxes(page);
        expect(boxes.length).toBeGreaterThan(0);
        expect(boxes[0].w).toBeCloseTo(34, 0);

        const hit = await page.evaluate(({ vx, vy, id }) => {
            const el = document.elementFromPoint(vx + 20, vy);
            return el?.closest('.release-tile')?.dataset.releaseId === id;
        }, boxes[0]);

        expect(hit).toBe(true);
    });

    test('no two tiles share a press point', async ({ page }) => {
        // The ring grows so 44px targets fit. Without that, twelve of them on a
        // circle sized for 34px marks overlap by about 7px a side, and a press
        // near a boundary opens the wrong record.
        await boot(page);
        await openOrbit(page);

        const boxes = await tileBoxes(page);
        const ring = boxes.slice(0, 12);
        expect(ring.length).toBe(12);

        for (let i = 0; i < ring.length; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            const gap = Math.hypot(a.cx - b.cx, a.cy - b.cy);
            expect(gap).toBeGreaterThanOrEqual(50 - 0.01);
        }
    });

    test('a guest chip is pressable too', async ({ page }) => {
        await boot(page);
        // After boot, not before: Playwright matches the most recently added
        // route, so a specific override registered first is shadowed by boot's
        // catch-all.
        await page.route('**/api/release/rel:0', (route) =>
            route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    data: {
                        release_id: 'rel:0', name: 'Long Player Number 0', type: 'LP',
                        guests: [{ person_id: 'per:sax', name: 'A Saxophonist', roles: ['sax'] }],
                        tracks: [],
                    },
                }),
            }));
        await openOrbit(page);

        await page.locator('.release-tile[data-release-id="rel:0"]').click();
        await page.waitForSelector('.release-guest-chip', { timeout: 10_000 });

        const hit = await page.evaluate(() => {
            const chip = document.querySelector('.release-guest-chip');
            const r = chip.getBoundingClientRect();
            // 14px out from a 22px chip: past its own edge, inside the target.
            const el = document.elementFromPoint(r.x + r.width / 2 + 14, r.y + r.height / 2);
            return { visual: r.width, hits: el?.closest('.release-guest-chip') === chip };
        });

        expect(hit.visual).toBeCloseTo(22, 0);
        expect(hit.hits).toBe(true);
    });
});

test.describe('press targets on a mouse', () => {
    test('the mark is the target, and the ring is not pushed out for a finger', async ({ page }) => {
        // A cursor is precise; 34px is a generous click. Growing the ring here
        // would spread a discography across the viewport for no reason.
        await boot(page);
        await openOrbit(page);

        const boxes = await tileBoxes(page);
        const ring = boxes.slice(0, 12);
        const gaps = ring.map((a, i) => {
            const b = ring[(i + 1) % ring.length];
            return Math.hypot(a.cx - b.cx, a.cy - b.cy);
        });

        // Spaced for a 34px mark plus the gap, not for a 44px one.
        // 0.01 of slack, for Math.sin double error of about 2e-5. Not more:
        // sizing the circumference instead of the chord lands 0.47 short here,
        // and a tolerance wide enough to hide that hides the bug.
        expect(Math.min(...gaps)).toBeGreaterThanOrEqual(40 - 0.01);
        expect(Math.min(...gaps)).toBeLessThan(44);
    });
});

test.describe('saying what a release is', () => {
    test('opening one names it, without needing a hover', async ({ page }) => {
        await boot(page);
        await openOrbit(page);

        await page.locator('.release-tile[data-release-id="rel:3"]').click();

        const caption = page.locator('.release-tile__caption');
        await expect(caption).toBeVisible();
        await expect(caption).toHaveText('Long Player Number 3 (1973)');
    });

    test('only the open one carries a caption', async ({ page }) => {
        // Twelve captions on one ring would be unreadable.
        await boot(page);
        await openOrbit(page);
        await page.locator('.release-tile[data-release-id="rel:3"]').click();

        await expect(page.locator('.release-tile__caption')).toHaveCount(1);
    });

    test('a release with no date is named without an empty bracket', async ({ page }) => {
        await boot(page);
        await page.route('**/group/*/releases*', (route) =>
            route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    releases: [{ release_id: 'rel:x', name: 'Undated Record', type: 'LP' }],
                }),
            }));
        await openOrbit(page);

        await page.locator('.release-tile').first().click();
        await expect(page.locator('.release-tile__caption')).toHaveText('Undated Record');
    });

    test('the format is shown on the tile where the data has one', async ({ page }) => {
        await boot(page);
        await openOrbit(page);

        await expect(page.locator('.release-tile[data-release-id="rel:0"] .release-tile__type'))
            .toHaveText('LP');
        await expect(page.locator('.release-tile[data-release-id="rel:1"] .release-tile__type'))
            .toHaveText('EP');
    });

    test('a release with no format gets no badge rather than an empty one', async ({ page }) => {
        await boot(page, { withType: false });
        await openOrbit(page);

        await expect(page.locator('.release-tile__type')).toHaveCount(0);
    });
});

test.describe('opening and closing a crowded ring', () => {
    test('closing a tile puts the ring back where it was', async ({ page }) => {
        // The radius is no longer the node radius plus padding — a crowded ring
        // grows past that — so the close path can no longer recover the node
        // radius by inverting the formula. If it tries, the ring jumps.
        await boot(page);
        await openOrbit(page);

        const before = await tileBoxes(page);

        const tile = page.locator('.release-tile[data-release-id="rel:0"]');
        await tile.click();
        await expect(page.locator('.release-tile--active')).toHaveCount(1);

        await page.locator('.release-tile--active').click();
        await expect(page.locator('.release-tile--active')).toHaveCount(0);

        const after = await tileBoxes(page);
        expect(after.length).toBe(before.length);
        for (let i = 0; i < before.length; i++) {
            expect(after[i].cx).toBeCloseTo(before[i].cx, 1);
            expect(after[i].cy).toBeCloseTo(before[i].cy, 1);
        }
    });
});
