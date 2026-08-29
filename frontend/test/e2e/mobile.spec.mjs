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

test.describe('phone layout', () => {
    test.use({ viewport: PHONE });

    test('the graph gets the full width before a node is selected', async ({ page }) => {
        await page.goto('/', { waitUntil: 'load' });

        const viz = page.locator('#viz-container');
        await expect(viz).toBeVisible();

        const box = await viz.boundingBox();
        // Previously the info panel held a 320px column on a 390px screen,
        // leaving the graph 70px. It should now have essentially all of it.
        expect(box.width).toBeGreaterThan(PHONE.width * 0.9);
    });

    test('the info sheet starts closed', async ({ page }) => {
        await page.goto('/', { waitUntil: 'load' });

        await expect(page.locator('#info-viewer')).not.toHaveClass(/\bopen\b/);
        await expect(page.locator('#info-backdrop')).toBeHidden();
    });

    test('the sheet can be closed once opened — the regression', async ({ page }) => {
        await page.goto('/', { waitUntil: 'load' });

        // Drive the same entry point the node-click handler uses, so this does
        // not depend on graph data being present.
        await page.evaluate(() => window.musicGraph?.openInfoPanel());

        const sheet = page.locator('#info-viewer');
        await expect(sheet).toHaveClass(/\bopen\b/);
        await expect(page.locator('#info-backdrop')).toBeVisible();

        await page.locator('#info-close').click();

        await expect(sheet).not.toHaveClass(/\bopen\b/);
        await expect(page.locator('#info-backdrop')).toBeHidden();
    });

    test('tapping the backdrop also closes the sheet', async ({ page }) => {
        await page.goto('/', { waitUntil: 'load' });
        await page.evaluate(() => window.musicGraph?.openInfoPanel());

        await expect(page.locator('#info-viewer')).toHaveClass(/\bopen\b/);

        // The backdrop is position:fixed inset:0, so its own (10,10) is the
        // viewport corner — under the top bar. Click where the graph is
        // actually visible: below the 60px header, above the sheet at ~253.
        await page.mouse.click(195, 150);

        await expect(page.locator('#info-viewer')).not.toHaveClass(/\bopen\b/);
    });

    test('Escape closes the sheet', async ({ page }) => {
        await page.goto('/', { waitUntil: 'load' });
        await page.evaluate(() => window.musicGraph?.openInfoPanel());

        await expect(page.locator('#info-viewer')).toHaveClass(/\bopen\b/);
        await page.keyboard.press('Escape');
        await expect(page.locator('#info-viewer')).not.toHaveClass(/\bopen\b/);
    });

    test('the sheet leaves the graph visible above it', async ({ page }) => {
        await page.goto('/', { waitUntil: 'load' });
        await page.evaluate(() => window.musicGraph?.openInfoPanel());

        const box = await page.locator('#info-viewer').boundingBox();
        // A sheet, not a takeover: the selected node stays on screen above it.
        expect(box.height).toBeLessThan(PHONE.height * 0.8);
        expect(box.y).toBeGreaterThan(PHONE.height * 0.2);
    });

    test('the header stays on one line', async ({ page }) => {
        await page.goto('/', { waitUntil: 'load' });

        const bar = await page.locator('#top-bar').boundingBox();
        // Three lines of wrapped title was ~120px; one row is well under that.
        expect(bar.height).toBeLessThan(80);
        await expect(page.locator('.logo-short')).toBeVisible();
        await expect(page.locator('.logo-full')).toBeHidden();
    });

    test('the bottom bar collapses behind one control', async ({ page }) => {
        await page.goto('/', { waitUntil: 'load' });

        const toggle = page.locator('#actions-toggle');
        await expect(toggle).toBeVisible();
        await expect(page.locator('#submit-project')).toBeHidden();

        await toggle.click();
        await expect(page.locator('#submit-project')).toBeVisible();
    });

    test('Favorites, Curate and History remain reachable', async ({ page }) => {
        await page.goto('/', { waitUntil: 'load' });

        // These used to be display:none below 1024px, which removed the
        // features on mobile rather than adapting them.
        await expect(page.locator('#favorites-toggle')).toBeVisible();
        await expect(page.locator('#curate-toggle')).toBeVisible();
        await expect(page.locator('#history-toggle')).toBeVisible();
    });
});

test.describe('desktop layout is unaffected', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('sheet chrome stays hidden and the panel is a side column', async ({ page }) => {
        await page.goto('/', { waitUntil: 'load' });

        await expect(page.locator('#info-close')).toBeHidden();
        await expect(page.locator('#actions-toggle')).toBeHidden();
        await expect(page.locator('.logo-full')).toBeVisible();
        await expect(page.locator('#submit-project')).toBeVisible();

        const panel = await page.locator('#info-viewer').boundingBox();
        expect(panel.width).toBeGreaterThan(300);
        expect(panel.width).toBeLessThan(500);
    });
});
