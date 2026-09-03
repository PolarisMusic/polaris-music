/**
 * The embed must stay small.
 *
 * The player's height is published to `--mini-player-height`, which the info
 * sheet derives its own height from, so the embed growing does not just make
 * the player bigger — it shrinks the panel beside it and the graph above it.
 *
 * That is not hypothetical. Sizing the embed as a 232px square, on a wrong
 * assumption that Spotify would render a cover-art tile for it, took the region
 * from 84px to nearly 300px and pushed the rest of the page around. Spotify
 * renders its horizontal card whatever box it is handed; the square only
 * clipped it, play button included.
 *
 * So this measures the one thing about the embed that is ours to control. It
 * makes no claim about how Spotify renders inside the iframe, which is not
 * observable from here and is what I got wrong.
 */

import { test, expect } from '@playwright/test';

/** Put the player into embed mode with a card in it, as _showEmbed does. */
async function showEmbed(page) {
    await page.goto('/');
    await page.evaluate(() => {
        document.body.classList.add('mini-player-embed');

        const player = document.querySelector('.mini-player')
            ?? document.body.appendChild(Object.assign(
                document.createElement('div'), { className: 'mini-player' }));
        player.style.display = '';

        let embed = player.querySelector('.mp-embed');
        if (!embed) {
            embed = document.createElement('div');
            embed.className = 'mp-embed';
            player.appendChild(embed);
        }
        embed.innerHTML = '';

        // Same element _showEmbed builds, pointed at a blank page so the test
        // does not depend on reaching Spotify.
        const frame = document.createElement('iframe');
        frame.src = 'about:blank';
        frame.width = '100%';
        frame.height = '80';
        frame.title = 'Spotify player';
        embed.appendChild(frame);
    });
}

test.describe('the embed region', () => {
    test('stays under 100px on desktop', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await showEmbed(page);

        const height = await page.evaluate(() =>
            document.querySelector('.mp-embed').getBoundingClientRect().height);

        expect(height).toBeGreaterThan(0);
        expect(height).toBeLessThan(100);
    });

    test('stays under 100px on a phone', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await showEmbed(page);

        const height = await page.evaluate(() =>
            document.querySelector('.mp-embed').getBoundingClientRect().height);

        expect(height).toBeLessThan(100);
    });

    test('the iframe fills the width rather than a fixed square', async ({ page }) => {
        // A fixed width is what clipped the card. It should track its container.
        await page.setViewportSize({ width: 1280, height: 800 });
        await showEmbed(page);

        const { frame, container } = await page.evaluate(() => ({
            frame: document.querySelector('.mp-embed iframe').getBoundingClientRect().width,
            container: document.querySelector('.mp-embed').clientWidth,
        }));

        // Within the container's horizontal padding.
        expect(container - frame).toBeLessThanOrEqual(24);
    });
});
