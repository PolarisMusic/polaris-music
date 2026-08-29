/**
 * Playwright e2e — phone layout.
 *
 * The visualizer was unusable on a phone, and the largest cause was a plain
 * bug rather than styling: MusicGraph called infoViewer.classList.add('open')
 * in two places and nothing anywhere removed it, with no close control. On a
 * phone the panel covers the graph, so selecting a node buried the
 * visualization with no way back.
 *
 * These run at a real phone viewport rather than asserting on CSS text, so they
 * fail if the layout regresses for any reason — a changed breakpoint, a
 * specificity collision, a removed control.
 *
 * The graph itself needs no backend to lay out: #viz-container is sized by CSS
 * and present before any data loads.
 */

import { test, expect } from '@playwright/test';

const PHONE = { width: 390, height: 844 };   // iPhone 14 class

/**
 * Navigate to the app, capturing anything that would stop it booting.
 *
 * The first version of these tests called
 * `window.musicGraph.openInfoPanel()`. That optional chaining silently does
 * nothing when the bootstrap has not run, so a CI failure reported "class is
 * empty" — a symptom three steps from the cause — and cost a run to learn
 * nothing. Listeners are attached before navigating so a boot-time exception is
 * captured rather than lost, and readiness is asserted explicitly.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ requireApp?: boolean }} [opts] - requireApp:false for specs that
 *   only exercise CSS and must still pass if the backend is unreachable.
 */
async function gotoApp(page, { requireApp = true } = {}) {
    const pageErrors = [];
    const failedRequests = [];

    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
    page.on('requestfailed', (r) =>
        failedRequests.push(`${r.url()} — ${r.failure()?.errorText ?? 'unknown'}`));

    await page.goto('/', { waitUntil: 'load' });

    if (!requireApp) return { pageErrors, failedRequests };

    try {
        await page.waitForFunction(
            () => typeof window.musicGraph?.openInfoPanel === 'function',
            { timeout: 10_000 }
        );
    } catch {
        const detail = (label, list) =>
            `${label}:\n` + (list.length ? list.map(x => `  ${x}`).join('\n') : '  (none captured)');
        throw new Error(
            'The app never finished booting — window.musicGraph.openInfoPanel is unavailable, ' +
            'so index.html\'s DOMContentLoaded handler did not reach past ' +
            'new MusicGraph(). The layout assertions below cannot mean anything until this ' +
            `is fixed.\n\n${detail('Page errors', pageErrors)}\n${detail('Failed requests', failedRequests)}`
        );
    }

    return { pageErrors, failedRequests };
}

/**
 * Wait for the sheet's slide-in transition to finish.
 *
 * #info-viewer animates transform over 0.28s, so a boundingBox read straight
 * after `.open` is applied catches it mid-slide — this measured y=818 then 697
 * on retry before the wait was added.
 *
 * @param {import('@playwright/test').Page} page
 */
async function settleSheet(page) {
    await page.waitForFunction(() => {
        const el = document.getElementById('info-viewer');
        if (!el) return false;
        const t = getComputedStyle(el).transform;
        return t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';
    });
}

test.describe('phone layout', () => {
    test.use({ viewport: PHONE });

    // First, and deliberately separate: if this fails, every JS-dependent spec
    // below is meaningless and the message says so directly rather than leaving
    // a trail of empty-class assertions to interpret.
    test('the app boots without a backend', async ({ page }) => {
        const { pageErrors } = await gotoApp(page);

        expect(await page.evaluate(() => typeof window.musicGraph)).toBe('object');
        expect(await page.evaluate(
            () => typeof window.musicGraph.openInfoPanel)).toBe('function');
        // A page that throws during boot is broken for real users during any
        // API outage, not merely awkward to test.
        expect(pageErrors).toEqual([]);
    });

    test('the graph gets the full width before a node is selected', async ({ page }) => {
        await gotoApp(page, { requireApp: false });

        const viz = page.locator('#viz-container');
        await expect(viz).toBeVisible();

        const box = await viz.boundingBox();
        // Previously the info panel held a 320px column on a 390px screen,
        // leaving the graph 70px. It should now have essentially all of it.
        expect(box.width).toBeGreaterThan(PHONE.width * 0.9);
    });

    test('the info sheet starts closed', async ({ page }) => {
        await gotoApp(page, { requireApp: false });

        await expect(page.locator('#info-viewer')).not.toHaveClass(/\bopen\b/);
    });

    test('the sheet can be closed once opened — the regression', async ({ page }) => {
        await gotoApp(page);

        // Drive the same entry point the node-click handler uses, so this does
        // not depend on graph data being present.
        await page.evaluate(() => window.musicGraph.openInfoPanel());

        const sheet = page.locator('#info-viewer');
        await expect(sheet).toHaveClass(/\bopen\b/);

        await page.locator('#info-close').click();

        await expect(sheet).not.toHaveClass(/\bopen\b/);
    });

    test('the graph shrinks above the sheet instead of hiding behind it', async ({ page }) => {
        await gotoApp(page);

        const before = (await page.locator('#viz-container').boundingBox()).height;
        await page.evaluate(() => window.musicGraph.openInfoPanel());
        await settleSheet(page);
        const after = (await page.locator('#viz-container').boundingBox()).height;

        // The sheet used to cover the graph, so the whole visualization was
        // only ever half-visible while details were open.
        expect(after).toBeLessThan(before);
        expect(after).toBeGreaterThan(0);
    });

    test('the graph stays tappable while the sheet is open', async ({ page }) => {
        await gotoApp(page);
        await page.evaluate(() => window.musicGraph.openInfoPanel());
        await settleSheet(page);

        // A backdrop used to sit over the graph, swallowing every tap — which
        // is why selecting an album appeared to dismiss the panel rather than
        // showing the album.
        const onTop = await page.evaluate(() => {
            const viz = document.getElementById('viz-container').getBoundingClientRect();
            const el = document.elementFromPoint(viz.x + viz.width / 2, viz.y + viz.height / 2);
            return document.getElementById('viz-container').contains(el);
        });
        expect(onTop).toBe(true);
    });

    test('Escape closes the sheet', async ({ page }) => {
        await gotoApp(page);
        await page.evaluate(() => window.musicGraph.openInfoPanel());

        await expect(page.locator('#info-viewer')).toHaveClass(/\bopen\b/);
        await page.keyboard.press('Escape');
        await expect(page.locator('#info-viewer')).not.toHaveClass(/\bopen\b/);
    });

    test('the sheet leaves the graph visible above it', async ({ page }) => {
        await gotoApp(page);
        await page.evaluate(() => window.musicGraph.openInfoPanel());

        // Assert it is genuinely open first. Without this the geometry below
        // is satisfied by a CLOSED sheet — translateY(100%) puts it at y=844
        // with height 70vh — so this spec passed in CI while the app was not
        // running at all. A false negative by construction.
        await expect(page.locator('#info-viewer')).toHaveClass(/\bopen\b/);
        await settleSheet(page);

        const box = await page.locator('#info-viewer').boundingBox();
        // A sheet, not a takeover: the selected node stays on screen above it.
        // Half the viewport: enough for the details, little enough that the
        // selected node and its neighbours stay visible above.
        expect(box.height).toBeLessThan(PHONE.height * 0.55);
        expect(box.y).toBeGreaterThan(PHONE.height * 0.4);
    });

    test('the header stays on one line', async ({ page }) => {
        await gotoApp(page, { requireApp: false });

        const bar = await page.locator('#top-bar').boundingBox();
        // Three lines of wrapped title was ~120px; one row is well under that.
        expect(bar.height).toBeLessThan(80);
        await expect(page.locator('.logo-short')).toBeVisible();
        await expect(page.locator('.logo-full')).toBeHidden();
    });

    test('the bottom bar collapses behind one control', async ({ page }) => {
        await gotoApp(page);

        const toggle = page.locator('#actions-toggle');
        await expect(toggle).toBeVisible();
        await expect(page.locator('#submit-project')).toBeHidden();

        await toggle.click();
        await expect(page.locator('#submit-project')).toBeVisible();
    });

    test('Favorites, Curate and History remain reachable', async ({ page }) => {
        await gotoApp(page, { requireApp: false });

        // These used to be display:none below 1024px, which removed the
        // features on mobile rather than adapting them.
        await expect(page.locator('#favorites-toggle')).toBeVisible();
        await expect(page.locator('#curate-toggle')).toBeVisible();
        await expect(page.locator('#history-toggle')).toBeVisible();

        // Icon-only. Assert on rendered text rather than on the label elements:
        // innerText excludes hidden nodes, so this catches a label that is
        // visible for ANY reason — including one that was never wrapped in a
        // span and so cannot be hidden by CSS at all, which is the bug this
        // replaces. Looping over .stat-label elements could not see a missing
        // one and passed against the broken markup.
        const statsText = await page.locator('.stats').innerText();
        expect(statsText).not.toMatch(/Favorites|Curate|History/);

        // #top-bar has overflow:hidden, so its boundingBox is clamped to the
        // viewport and cannot reveal overflow. scrollWidth can.
        const { scrollWidth, clientWidth } = await page.evaluate(() => {
            const bar = document.getElementById('top-bar');
            return { scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth };
        });
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });
});

test.describe('desktop layout is unaffected', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('sheet chrome stays hidden and the panel is a side column', async ({ page }) => {
        await gotoApp(page, { requireApp: false });

        await expect(page.locator('#info-close')).toBeHidden();
        await expect(page.locator('#actions-toggle')).toBeHidden();
        await expect(page.locator('.logo-full')).toBeVisible();
        await expect(page.locator('#submit-project')).toBeVisible();

        const panel = await page.locator('#info-viewer').boundingBox();
        expect(panel.width).toBeGreaterThan(300);
        expect(panel.width).toBeLessThan(500);
    });
});
