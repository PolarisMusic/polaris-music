/**
 * The graph must not resize as the player comes and goes.
 *
 * The hypertree sizes its disk as min(width, height) / 2 and the graph column
 * is wider than it is tall, so height is the binding dimension: every pixel
 * the player takes rescales the whole visualisation. The player passes through
 * four heights in an ordinary session — absent, collapsed, expanded, and
 * expanded with the Spotify embed — and the graph visibly shrank at each one.
 * Four different sizes in the course of selecting a node and pressing play.
 *
 * `--viz-player-floor` reserves the standard bar height up front so all four of
 * those states share one layout. These assert that, in pixels, at a
 * desktop width — jsdom performs no layout and would report the custom
 * property as set while the geometry did whatever it liked.
 */

import { test, expect } from '@playwright/test';

const DESKTOP = { width: 1440, height: 900 };

/** Height of the graph column right now. */
const vizHeight = (page) =>
    page.evaluate(() => document.getElementById('viz-container').getBoundingClientRect().height);

/**
 * Put the player into one of its states, the way MiniPlayer does: the classes
 * pick the CSS defaults, and _notifyHeightChange publishes the measured height
 * as an inline custom property that overrides them.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{visible?: boolean, embed?: boolean, measured?: string}} state
 */
async function setPlayerState(page, { visible = false, embed = false, measured = null }) {
    await page.evaluate(({ visible, embed, measured }) => {
        document.body.classList.toggle('mini-player-visible', visible);
        document.body.classList.toggle('mini-player-embed', embed);
        if (measured === null) document.body.style.removeProperty('--mini-player-height');
        else document.body.style.setProperty('--mini-player-height', measured);
    }, { visible, embed, measured });
}

test.use({ viewport: DESKTOP });

test.describe('graph size stability', () => {
    test('the graph is the same size with no player and with a collapsed one', async ({ page }) => {
        await page.goto('/');
        await setPlayerState(page, { visible: false });
        const absent = await vizHeight(page);

        // Collapsed measures well under the reserved floor.
        await setPlayerState(page, { visible: true, measured: '28px' });
        expect(await vizHeight(page)).toBe(absent);
    });

    test('expanding the player does not resize the graph either', async ({ page }) => {
        await page.goto('/');
        await setPlayerState(page, { visible: false });
        const absent = await vizHeight(page);

        await setPlayerState(page, { visible: true, measured: '54px' });
        expect(await vizHeight(page)).toBe(absent);
    });

    test('the whole absent -> collapsed -> expanded run is one single size', async ({ page }) => {
        // The sequence an ordinary session walks through.
        await page.goto('/');
        const heights = [];
        for (const state of [
            { visible: false },
            { visible: true, measured: '28px' },
            { visible: true, measured: '54px' },
            { visible: true, measured: '28px' },
        ]) {
            await setPlayerState(page, state);
            heights.push(await vizHeight(page));
        }
        expect(new Set(heights).size).toBe(1);
    });

    test('the Spotify embed does not resize the graph either', async ({ page }) => {
        // This is the assertion that reversed. The embed used to be the one
        // state allowed to move the graph; it is now the state most worth
        // pinning, because it is the largest jump of the four and the one a
        // visitor triggers in the middle of reading the graph.
        await page.goto('/');
        await setPlayerState(page, { visible: true, measured: '54px' });
        const expanded = await vizHeight(page);

        await setPlayerState(page, { visible: true, embed: true, measured: '138px' });
        expect(await vizHeight(page)).toBe(expanded);
    });

    test('the reserve is a constant, not the player height', async ({ page }) => {
        // Stated as the mechanism and not just the outcome: a build that
        // tracked the player again would still pass a same-height check if the
        // two states happened to round together, and this would not.
        await page.goto('/');
        await setPlayerState(page, { visible: true, embed: true, measured: '138px' });

        const reserved = await page.evaluate(() => parseFloat(
            getComputedStyle(document.getElementById('viz-container')).marginBottom));

        expect(reserved).toBe(54);
    });

    test('the expanded player overlaps the graph rather than displacing it', async ({ page }) => {
        // The other half of the trade: the pixels the graph keeps are pixels
        // the player covers. Worth asserting because "same size" would also be
        // true of a build that left a 138px gap and drew nothing in it.
        await page.goto('/');
        await setPlayerState(page, { visible: true, embed: true, measured: '138px' });

        const { vizBottom, playerTop } = await page.evaluate(() => ({
            vizBottom: document.getElementById('viz-container').getBoundingClientRect().bottom,
            playerTop: document.getElementById('mini-player-container').getBoundingClientRect().top,
        }));

        expect(playerTop).toBeLessThan(vizBottom - 1);
    });
});
