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
 * `--viz-player-floor` reserves the standard bar height up front so the first
 * three of those states share one layout. These assert that, in pixels, at a
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

    test('the graph still yields height to the Spotify embed', async ({ page }) => {
        // The floor must not crop the embed — that is the one state allowed to
        // move the graph, and it has to actually move it.
        await page.goto('/');
        await setPlayerState(page, { visible: true, measured: '54px' });
        const expanded = await vizHeight(page);

        await setPlayerState(page, { visible: true, embed: true, measured: '138px' });
        expect(await vizHeight(page)).toBeLessThan(expanded);
    });

    test('the graph never overlaps the player', async ({ page }) => {
        // The reserve is a floor, not a replacement: whatever the player's real
        // height, the graph must still end at or above its top edge.
        await page.goto('/');
        await setPlayerState(page, { visible: true, embed: true, measured: '138px' });

        const { vizBottom, reserved } = await page.evaluate(() => ({
            vizBottom: document.getElementById('viz-container').getBoundingClientRect().bottom,
            reserved: parseFloat(
                getComputedStyle(document.getElementById('viz-container')).marginBottom),
        }));
        expect(reserved).toBeGreaterThanOrEqual(138);
        expect(vizBottom).toBeGreaterThan(0);
    });
});
