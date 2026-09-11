/**
 * The minimise button must minimise the player on a desktop viewport.
 *
 * It did not. Every `body.mini-player-collapsed` rule was written inside the
 * `@media (max-width: 768px)` block, so above that width clicking minimise
 * toggled the flag, added the class and changed the glyph to "▴ Player" —
 * and then nothing matched the class, leaving the bar fully expanded. A screen
 * recording caught it: a player captioned "▴ Player" with its artwork and
 * controls still showing.
 *
 * That is invisible to jsdom, which performs no layout and would happily
 * report the class as applied while the pixels disagreed. So this measures
 * height, at a desktop width, which is the only thing that actually answers it.
 */

import { test, expect } from '@playwright/test';

const DESKTOP = { width: 1440, height: 900 };

/**
 * Put a populated player on the page, as _show() does, and return a handle to
 * its bar. Built directly rather than driven through the app because reaching
 * a playable track needs a populated graph; this is a CSS assertion.
 *
 * @param {import('@playwright/test').Page} page
 */
async function showPlayer(page) {
    await page.goto('/');
    await page.evaluate(() => {
        document.body.classList.add('mini-player-visible');
        document.body.classList.remove('mini-player-collapsed');

        const player = document.querySelector('.mini-player')
            ?? document.body.appendChild(
                Object.assign(document.createElement('div'), { className: 'mini-player' }));
        player.style.display = 'flex';
        player.innerHTML = `
            <div class="mp-bar">
              <div class="mp-art-frame"><div class="mp-art"></div></div>
              <div class="mp-info"><div>A Track</div><div>An Artist</div></div>
              <div class="mp-controls"><button>play</button></div>
              <div class="mp-scrubber-area"><div class="mp-scrubber"></div></div>
              <div class="mp-right">
                <button class="mp-queue-toggle">queue</button>
                <button class="mp-collapse-toggle">▾</button>
              </div>
            </div>`;
    });
    return page.locator('.mp-bar');
}

test.use({ viewport: DESKTOP });

test.describe('player collapse on desktop', () => {
    test('collapsing makes the bar shorter', async ({ page }) => {
        const bar = await showPlayer(page);
        const expanded = (await bar.boundingBox()).height;

        await page.evaluate(() => document.body.classList.add('mini-player-collapsed'));
        const collapsed = (await bar.boundingBox()).height;

        // The exact heights are the stylesheet's business; that collapsing
        // reclaims real vertical space is the whole point of the control.
        expect(collapsed).toBeLessThan(expanded);
    });

    test('collapsing hides the artwork, controls and track info', async ({ page }) => {
        await showPlayer(page);
        await page.evaluate(() => document.body.classList.add('mini-player-collapsed'));

        for (const sel of ['.mp-art-frame', '.mp-controls', '.mp-info', '.mp-scrubber-area']) {
            await expect(page.locator(sel), `${sel} should be hidden when collapsed`)
                .toBeHidden();
        }
    });

    test('the button that brings the player back stays visible', async ({ page }) => {
        // Hiding the only way out is the dead end this must not create.
        await showPlayer(page);
        await page.evaluate(() => document.body.classList.add('mini-player-collapsed'));
        await expect(page.locator('.mp-collapse-toggle')).toBeVisible();
    });

    test('expanding again restores the full bar', async ({ page }) => {
        const bar = await showPlayer(page);
        const expanded = (await bar.boundingBox()).height;

        await page.evaluate(() => document.body.classList.add('mini-player-collapsed'));
        await page.evaluate(() => document.body.classList.remove('mini-player-collapsed'));

        expect((await bar.boundingBox()).height).toBe(expanded);
        await expect(page.locator('.mp-controls')).toBeVisible();
    });
});
