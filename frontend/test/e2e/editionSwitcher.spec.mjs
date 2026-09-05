/**
 * The edition switcher must survive a long edition label.
 *
 * The switcher is a three-part row inside the info panel: an earlier arrow, a
 * label naming what distinguishes this edition, and a later arrow. The panel is
 * a fixed 400px column, and the label's text is whatever the release data says
 * — a date, a format, a country and a catalogue number joined together, some of
 * which run long ("Deluxe Anniversary Edition, 0602508007443").
 *
 * A flex child defaults to `min-width: auto`, which refuses to shrink below its
 * content. So without `min-width: 0` on the label, a long one pushes the later
 * arrow past the panel's right edge and the reader simply cannot reach the next
 * edition. That is a layout fact jsdom cannot see: it performs no layout, so
 * the unit tests covering which arrow is disabled would pass with the arrow
 * rendered off-screen. Only a browser can answer this.
 *
 * The switcher markup is built here rather than driven through the app, for the
 * same reason playerHeight.spec.mjs injects its embed: reaching a release with
 * sibling editions needs a populated Neo4j, and this asserts CSS, not data flow.
 * It must stay in step with InfoPanelRenderer._renderEditionSwitcher — the
 * class names below are the contract between them.
 */

import { test, expect } from '@playwright/test';

/**
 * Render the switcher into the real info panel, with the real stylesheet.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} detail - the edition label text
 */
async function showSwitcher(page, detail) {
    await page.goto('/');
    await page.evaluate((detailText) => {
        const content = document.getElementById('info-content');
        content.replaceChildren();

        const el = (tag, className, text) => {
            const node = document.createElement(tag);
            if (className) node.className = className;
            if (text != null) node.textContent = text;
            return node;
        };

        const row = el('div', 'info-edition');
        row.appendChild(el('button', 'info-edition__arrow', '‹'));

        const label = el('span', 'info-edition__label');
        label.appendChild(el('span', 'info-edition__count', 'Edition 2 of 3'));
        label.appendChild(el('span', 'info-edition__detail', detailText));
        row.appendChild(label);

        const forward = el('button', 'info-edition__arrow', '›');
        forward.id = 'test-forward-arrow';
        row.appendChild(forward);

        content.appendChild(row);
    }, detail);
}

test.describe('edition switcher layout', () => {
    test('the later arrow stays inside the panel under a long label', async ({ page }) => {
        await showSwitcher(
            page,
            '2019/09/27 · Super Deluxe Anniversary Box Set · United Kingdom · 0602508007443'
        );

        const panel = await page.locator('#info-viewer').boundingBox();
        const arrow = await page.locator('#test-forward-arrow').boundingBox();

        expect(arrow).not.toBeNull();
        // The whole arrow, not just its left edge, must sit within the panel.
        expect(arrow.x + arrow.width).toBeLessThanOrEqual(panel.x + panel.width);
        expect(arrow.width).toBeGreaterThan(0);
    });

    test('a long label is clipped rather than widening the row', async ({ page }) => {
        await showSwitcher(page, 'A'.repeat(400));

        const row = await page.locator('.info-edition').boundingBox();
        const panel = await page.locator('#info-viewer').boundingBox();

        expect(row.width).toBeLessThanOrEqual(panel.width);
    });

    test('both arrows and the label share one row', async ({ page }) => {
        await showSwitcher(page, '2019 · CD');

        const boxes = await page.locator('.info-edition__arrow').evaluateAll(
            (els) => els.map(e => e.getBoundingClientRect().top)
        );
        expect(boxes).toHaveLength(2);
        // Same top edge: the row has not wrapped the second arrow onto a new line.
        expect(Math.abs(boxes[0] - boxes[1])).toBeLessThan(2);
    });

    test('a short label leaves the arrows at the row\'s two ends', async ({ page }) => {
        await showSwitcher(page, '2002');

        const row = await page.locator('.info-edition').boundingBox();
        const arrows = await page.locator('.info-edition__arrow').all();
        const back = await arrows[0].boundingBox();
        const forward = await arrows[1].boundingBox();

        expect(back.x).toBeLessThan(row.x + row.width / 2);
        expect(forward.x).toBeGreaterThan(row.x + row.width / 2);
    });
});
