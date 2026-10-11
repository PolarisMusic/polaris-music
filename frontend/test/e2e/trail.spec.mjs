/**
 * The trail: where you have been, and the way back.
 *
 * Navigation is a Mobius translation, so the view is rigid and followable —
 * but it is still a hyperbolic view, and only about two hops of it are
 * legible. After three selections everything on screen is new, and the layout
 * cannot fix that without giving up the rigid motion. A record of the route is
 * the answer the geometry cannot give.
 *
 * Overlaid on the canvas, never stacked above it: a strip that changed the
 * canvas height would rescale the whole hypertree each time it gained a step,
 * which is the exact failure vizStability.spec.mjs exists to catch.
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

    // History persists across sessions, so a leftover trail would make these
    // read whatever the last run left behind.
    await page.addInitScript(() => {
        try { window.localStorage.clear(); } catch { /* private mode */ }
    });

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

const steps = (page) => page.locator('#graph-trail .graph-trail-step');
const stepNames = async (page) => (await steps(page).allTextContents());

test.describe('the trail', () => {
    test('is not drawn until there is somewhere to go back to', async ({ page }) => {
        await boot(page);
        await expect(page.locator('#graph-trail')).toBeHidden();

        await select(page, 'grp:0');
        await expect(page.locator('#graph-trail')).toBeHidden();
    });

    test('appears on the second selection, oldest first', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        await select(page, 'per:0_1');

        await expect(page.locator('#graph-trail')).toBeVisible();
        expect(await stepNames(page)).toEqual(['Band 0', 'Member 0-1']);
    });

    test('is actually on screen, not clipped out of the container', async ({ page }) => {
        // toBeVisible does not notice clipping, and #viz-container is
        // overflow:hidden with the strip declared after the canvas — so a
        // trail that fell out of the overlay and back into the flow would be
        // laid out below the fold, invisible to a visitor and passing every
        // other assertion in this file. It did, twice.
        await boot(page);
        await select(page, 'grp:0');
        await select(page, 'per:0_1');

        const inside = await page.evaluate(() => {
            const trail = document.getElementById('graph-trail').getBoundingClientRect();
            const box = document.getElementById('viz-container').getBoundingClientRect();
            return {
                trail: { t: Math.round(trail.top), b: Math.round(trail.bottom), h: Math.round(trail.height) },
                box: { t: Math.round(box.top), b: Math.round(box.bottom) },
            };
        });

        expect(inside.trail.h).toBeGreaterThan(0);
        expect(inside.trail.t).toBeGreaterThanOrEqual(inside.box.t);
        expect(inside.trail.b).toBeLessThanOrEqual(inside.box.b);
    });

    test('marks where you are, and only that step', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        await select(page, 'per:0_1');
        await select(page, 'per:hub');

        const current = page.locator('#graph-trail .graph-trail-step[aria-current="true"]');
        await expect(current).toHaveCount(1);
        await expect(current).toHaveText('Session Player');
    });

    test('keeps to five steps and says there are more', async ({ page }) => {
        await boot(page);
        for (const id of ['grp:0', 'per:0_1', 'grp:0', 'per:hub', 'grp:2', 'per:2_0', 'grp:2']) {
            await select(page, id);
        }

        await expect(steps(page)).toHaveCount(5);
        await expect(page.locator('#graph-trail .graph-trail-more')).toBeVisible();
    });

    test('a step takes you back to it', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        await select(page, 'per:0_1');
        await select(page, 'per:hub');

        await steps(page).first().click();
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
        await page.waitForTimeout(300);

        expect(await page.evaluate(() => window.musicGraph.selectedNode.id)).toBe('grp:0');
        expect(await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('grp:0').pos.rho)).toBeLessThan(0.01);
    });

    test('going back leaves the steps ahead of you in place', async ({ page }) => {
        // The trail is not a stack that pops. Stepping back moves the marker
        // along it; the steps you can go forward to stay listed. Written
        // because the first version shrank the window from behind, so walking
        // to the oldest entry left a trail of one and then hid it — losing the
        // route at the moment the visitor had most obviously lost their place.
        await boot(page);
        await select(page, 'grp:0');
        await select(page, 'per:0_1');
        await select(page, 'per:hub');

        await steps(page).first().click();
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
        await page.waitForTimeout(300);

        expect(await stepNames(page)).toEqual(['Band 0', 'Member 0-1', 'Session Player']);
        await expect(page.locator('#graph-trail .graph-trail-step[aria-current="true"]'))
            .toHaveText('Band 0');
        expect(await page.evaluate(() => window.musicGraph.pathTracker.canGoForward())).toBe(true);
    });

    test('and going forward again from a step works', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        await select(page, 'per:0_1');
        await select(page, 'per:hub');

        await steps(page).first().click();
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
        await page.waitForTimeout(300);
        await steps(page).last().click();
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
        await page.waitForTimeout(300);

        expect(await page.evaluate(() => window.musicGraph.selectedNode.id)).toBe('per:hub');
    });

    test('the step you are on is inert', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        await select(page, 'per:0_1');

        await expect(steps(page).last()).toBeDisabled();
    });

    test('does not move or resize the canvas', async ({ page }) => {
        // The reason it is an overlay. In the flow it takes a line at the top
        // of #viz-container and pushes the canvas down by its height; the
        // canvas keeps height:100%, so it does not shrink — it overhangs the
        // container and the bottom of the graph is clipped away.
        //
        // So measuring clientWidth/clientHeight is not enough, and the first
        // version of this test passed against exactly that bug. Compare the
        // canvas box against the container's.
        const box = () => page.evaluate(() => {
            const inner = document.getElementById('infovis').getBoundingClientRect();
            const outer = document.getElementById('viz-container').getBoundingClientRect();
            return {
                dTop: Math.round(inner.top - outer.top),
                dLeft: Math.round(inner.left - outer.left),
                w: Math.round(inner.width),
                h: Math.round(inner.height),
            };
        });

        await boot(page);
        const before = await box();
        expect(before.dTop).toBe(0);

        await select(page, 'grp:0');
        await select(page, 'per:0_1');
        await expect(page.locator('#graph-trail')).toBeVisible();

        expect(await box()).toEqual(before);
    });

    test('a tap on the strip between steps reaches the graph behind it', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        await select(page, 'per:0_1');

        const gaps = await page.evaluate(() => {
            const el = document.getElementById('graph-trail');
            const r = el.getBoundingClientRect();
            // A point inside the strip but to the right of the last step.
            const last = el.querySelector('.graph-trail-step:last-of-type').getBoundingClientRect();
            return document.elementFromPoint(last.right + 40, r.top + r.height / 2)?.id || '';
        });
        expect(gaps).not.toBe('graph-trail');
    });
});

test.describe('the trail on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('fits the screen without pushing anything off the side', async ({ page }) => {
        await boot(page);
        for (const id of ['grp:0', 'per:0_1', 'per:hub', 'grp:2', 'per:2_0']) {
            await select(page, id);
        }

        const fits = await page.evaluate(() => {
            const el = document.getElementById('graph-trail');
            const r = el.getBoundingClientRect();
            return r.left >= 0 && r.right <= window.innerWidth && el.scrollWidth <= el.clientWidth + 1;
        });
        expect(fits).toBe(true);
    });
});
