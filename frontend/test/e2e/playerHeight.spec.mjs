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

/**
 * Put the player into embed mode with a card in it, as _showEmbed does, then
 * publish the resulting height the way MiniPlayer._notifyHeightChange() does.
 *
 * Publishing matters: --mini-player-height is how the layout learns what the
 * player occupies, and every assertion about who gives up height for it is
 * vacuous while the property sits at its 0px default. Measuring rather than
 * passing a constant is what the real code does — and it has to be, because
 * the player renders 137px on a desktop and 24px collapsed on a phone, so any
 * fixed number would describe one viewport and lie about the other.
 *
 * @param {import('@playwright/test').Page} page
 */
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

    // Second evaluate for the same reason _notifyHeightChange defers a frame:
    // the class that grows the player is applied above, and measuring in the
    // same tick returns the old height.
    await page.evaluate(() => {
        const height = document.getElementById('mini-player-container').offsetHeight;
        document.body.style.setProperty('--mini-player-height', `${height}px`);
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

    test('the card is bounded above, not stretched across the window', async ({ page }) => {
        // Both bounds on purpose. Unbounded, the card spanned ~2000px and
        // Spotify's controls ended up an arm's length from the artwork. Fixed,
        // it clipped — which is the bug the earlier version of this test caught.
        await page.setViewportSize({ width: 1600, height: 900 });
        await showEmbed(page);

        const { frame, container } = await page.evaluate(() => ({
            frame: document.querySelector('.mp-embed iframe').getBoundingClientRect().width,
            container: document.querySelector('.mp-embed').clientWidth,
        }));

        expect(frame).toBeLessThan(container);
        expect(frame).toBeLessThanOrEqual(560);
        // Still wide enough that Spotify's own title and controls do not collide.
        expect(frame).toBeGreaterThan(300);
    });

    test('the card still fills a container narrower than the cap', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await showEmbed(page);

        const { frame, container } = await page.evaluate(() => ({
            frame: document.querySelector('.mp-embed iframe').getBoundingClientRect().width,
            container: document.querySelector('.mp-embed').clientWidth,
        }));

        // Within the container's horizontal padding.
        expect(container - frame).toBeLessThanOrEqual(24);
    });
});

test.describe('the player and the info viewer column', () => {
    /**
     * The player was pinned `left: 0; right: 0`, so it ran underneath the info
     * viewer — a full-height column — and covered its last rows. With something
     * playing, the tracklist visibly stopped partway down.
     *
     * Geometry, so it is measurable, unlike anything about Spotify's own
     * rendering inside the iframe.
     *
     * Both widths are checked because the column is 400px and narrows to 320px
     * at the 1024px breakpoint, and the player reads that width from a shared
     * custom property. If the two ever desynchronise, one of these fails.
     */
    for (const [label, width] of [
        ['where the column is 400px', 1280],
        ['where the breakpoint narrows it to 320px', 1024],
    ]) {
        test(`the player stops at the column, ${label}`, async ({ page }) => {
            await page.setViewportSize({ width, height: 800 });
            await showEmbed(page);

            const { playerRight, columnLeft } = await page.evaluate(() => ({
                playerRight: document.getElementById('mini-player-container')
                    .getBoundingClientRect().right,
                columnLeft: document.getElementById('info-viewer')
                    .getBoundingClientRect().left,
            }));

            expect(playerRight).toBeLessThanOrEqual(columnLeft + 1);
        });
    }

    test('on a phone it still spans the full width', async ({ page }) => {
        // There the sheet is full width and there is no column to avoid, so the
        // desktop rule must not leak in.
        await page.setViewportSize({ width: 390, height: 844 });
        await showEmbed(page);

        const right = await page.evaluate(() =>
            document.getElementById('mini-player-container').getBoundingClientRect().right);

        expect(right).toBeGreaterThanOrEqual(389);
    });
});

test.describe('who gives up height for the player', () => {
    /**
     * The player is fixed above the bottom bar, so something has to shorten
     * itself or the player covers it. Which column that is became a real
     * question once the player stopped spanning the window.
     *
     * #main-container holds both columns and used to subtract the player's
     * height from itself. That shortened the info viewer as well, for a player
     * no longer underneath it: a band of page background appeared below the
     * panel, exactly as tall as the player, and the tracklist still stopped
     * partway down. The inset now sits on #viz-container alone.
     *
     * Both edges are asserted because moving an inset is exactly the kind of
     * change that fixes one column by breaking the other.
     */
    test('the info viewer runs down to the bottom bar', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await showEmbed(page);

        const { columnBottom, barTop } = await page.evaluate(() => ({
            columnBottom: document.getElementById('info-viewer')
                .getBoundingClientRect().bottom,
            barTop: document.getElementById('bottom-bar')
                .getBoundingClientRect().top,
        }));

        // They meet. A gap here is the black band; an overlap would put the
        // bar over the panel's last rows.
        expect(Math.abs(columnBottom - barTop)).toBeLessThanOrEqual(1);
    });

    test.describe('the graph never runs under the player', () => {
        // True on both layouts, by different routes — the desktop takes the
        // inset off this column, the phone off the container — which is what
        // makes it worth asserting on both.
        for (const [label, size] of [
            ['desktop', { width: 1280, height: 800 }],
            ['phone', { width: 390, height: 844 }],
        ]) {
            test(label, async ({ page }) => {
                await page.setViewportSize(size);
                await showEmbed(page);

                const { vizBottom, playerTop } = await page.evaluate(() => ({
                    vizBottom: document.getElementById('viz-container')
                        .getBoundingClientRect().bottom,
                    playerTop: document.getElementById('mini-player-container')
                        .getBoundingClientRect().top,
                }));

                // Meeting, not merely clearing: a one-sided assertion would
                // let both columns subtract the player and call the wasted
                // canvas a pass.
                expect(Math.abs(vizBottom - playerTop)).toBeLessThanOrEqual(1);
            });
        }
    });
});
