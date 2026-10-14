/**
 * The first tap names the node; the second one goes there.
 *
 * Navigating is a commitment — it moves the whole graph, replaces the panel
 * and adds a history entry. With a mouse you never make it blind, because
 * hovering tells you what you are about to open. A finger has no such gesture:
 * it is either touching or it is not. Out at the rim, where the nodes are
 * small and crowded and the labels are hidden, that means tapping something
 * and finding out afterwards what it was.
 *
 * So on a device that cannot hover, the first tap is spent on the name and the
 * second on the journey. The predicate is `hover: none` rather than screen
 * width, because that is the thing the behaviour actually depends on: a narrow
 * desktop window still has a pointer, and a tablet at full width still does
 * not.
 */

import { test, expect } from '@playwright/test';

function scene(groups = 4, members = 6) {
    const nodes = [{ id: 'per:hub', name: 'Session Player', type: 'person' }];
    const edges = [];
    for (let g = 0; g < groups; g++) {
        nodes.push({ id: `grp:${g}`, name: `Band ${g}`, type: 'group' });
        edges.push({ source: 'per:hub', target: `grp:${g}`, type: 'MEMBER_OF', role: 'guest' });
        for (let m = 0; m < members; m++) {
            nodes.push({ id: `per:${g}_${m}`, name: `Member ${g}-${m}`, type: 'person' });
            edges.push({ source: `per:${g}_${m}`, target: `grp:${g}`, type: 'MEMBER_OF', role: 'player' });
        }
    }
    return { nodes, edges };
}

const SCENE = scene();

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
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(SCENE) }));
    await page.route('**/graph/sponsored*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, node: null }) }));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 15_000 }
    );
    await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
    await page.waitForTimeout(300);
}

/** The viewport point that lands on a node's drawn centre. */
const pointFor = (page, nodeId) => page.evaluate((id) => {
    const ht = window.musicGraph.ht;
    const node = ht.graph.getNode(id);
    const c = node.pos.getc().$scale(node.scale);
    const canvas = ht.canvas;
    const pos = canvas.getPos(true);
    const size = canvas.getSize();
    return {
        x: pos.x - window.scrollX + size.width / 2 + c.x * canvas.scaleOffsetX + canvas.translateOffsetX,
        y: pos.y - window.scrollY + size.height / 2 + c.y * canvas.scaleOffsetY + canvas.translateOffsetY,
    };
}, nodeId);

/**
 * A point on the canvas with no node anywhere near it.
 *
 * Found rather than assumed: the layout decides where the gaps are, and a
 * hardcoded corner is one info panel away from being outside the canvas.
 */
const emptyPoint = (page) => page.evaluate(() => {
    const ht = window.musicGraph.ht;
    const canvas = ht.canvas;
    const pos = canvas.getPos(true);
    const size = canvas.getSize();
    const nodes = [];
    ht.graph.eachNode((n) => nodes.push(n.pos.getc().$scale(n.scale)));

    for (let r = 10; r < Math.min(size.width, size.height) / 2 - 10; r += 5) {
        for (let i = 0; i < 24; i++) {
            const theta = (i / 24) * Math.PI * 2;
            const c = { x: r * Math.cos(theta), y: r * Math.sin(theta) };
            if (nodes.every((n) => Math.hypot(n.x - c.x, n.y - c.y) > 45)) {
                return {
                    x: pos.x - window.scrollX + size.width / 2 + c.x * canvas.scaleOffsetX + canvas.translateOffsetX,
                    y: pos.y - window.scrollY + size.height / 2 + c.y * canvas.scaleOffsetY + canvas.translateOffsetY,
                };
            }
        }
    }
    return null;
});

const named = (page, nodeId) => page.evaluate((id) => {
    const node = window.musicGraph.ht.graph.getNode(id);
    return !!node.getData('hoverTooltip');
}, nodeId);

const state = (page) => page.evaluate(() => ({
    root: window.musicGraph.ht.root,
    selected: window.musicGraph.selectedNode?.id ?? null,
}));

test.describe('on a device that cannot hover', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('the first tap shows the name and goes nowhere', async ({ page }) => {
        await boot(page);
        const before = await state(page);

        await page.touchscreen.tap(...Object.values(await pointFor(page, 'grp:1')));

        await expect.poll(() => named(page, 'grp:1')).toBe(true);
        expect(await state(page)).toEqual(before);
    });

    test('the name is there at once, not after a dwell', async ({ page }) => {
        // The hover path waits half a second before naming anything, which is
        // right for a pointer drifting across the canvas and wrong for a tap:
        // the tap *is* the request, and half a second of nothing reads as a
        // tap that missed.
        await boot(page);
        const point = await pointFor(page, 'grp:1');

        await page.touchscreen.tap(point.x, point.y);
        expect(await named(page, 'grp:1')).toBe(true);
    });

    test('the second tap on the same node goes there', async ({ page }) => {
        await boot(page);
        const point = await pointFor(page, 'grp:1');

        await page.touchscreen.tap(point.x, point.y);
        await expect.poll(() => named(page, 'grp:1')).toBe(true);

        // Re-read: nothing has moved, but reading it again is what a finger
        // does and costs nothing.
        const again = await pointFor(page, 'grp:1');
        await page.touchscreen.tap(again.x, again.y);

        await expect.poll(() => page.evaluate(
            () => window.musicGraph.selectedNode?.id ?? null)).toBe('grp:1');
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
        expect((await state(page)).root).toBe('grp:1');
    });

    test('tapping a different node moves the name rather than travelling', async ({ page }) => {
        await boot(page);
        const before = await state(page);

        await page.touchscreen.tap(...Object.values(await pointFor(page, 'grp:1')));
        await expect.poll(() => named(page, 'grp:1')).toBe(true);

        await page.touchscreen.tap(...Object.values(await pointFor(page, 'grp:2')));
        await expect.poll(() => named(page, 'grp:2')).toBe(true);

        expect(await named(page, 'grp:1')).toBe(false);
        expect(await state(page)).toEqual(before);
    });

    test('tapping the canvas puts the name away', async ({ page }) => {
        await boot(page);

        await page.touchscreen.tap(...Object.values(await pointFor(page, 'grp:1')));
        await expect.poll(() => named(page, 'grp:1')).toBe(true);

        const empty = await emptyPoint(page);
        expect(empty).not.toBeNull();
        await page.touchscreen.tap(empty.x, empty.y);

        await expect.poll(() => named(page, 'grp:1')).toBe(false);
    });

    test('and the tap after that one starts over rather than travelling', async ({ page }) => {
        // The count belongs to a node, not to the device. Putting the preview
        // away and tapping the same node again is a first tap.
        await boot(page);
        const point = await pointFor(page, 'grp:1');
        const before = await state(page);

        await page.touchscreen.tap(point.x, point.y);
        await expect.poll(() => named(page, 'grp:1')).toBe(true);

        const empty = await emptyPoint(page);
        await page.touchscreen.tap(empty.x, empty.y);
        await expect.poll(() => named(page, 'grp:1')).toBe(false);

        await page.touchscreen.tap(point.x, point.y);
        await expect.poll(() => named(page, 'grp:1')).toBe(true);
        expect(await state(page)).toEqual(before);
    });
});

test.describe('on a device with a pointer', () => {
    test('one click still goes there', async ({ page }) => {
        // Nothing is spent on a preview that hovering already gave for free.
        await boot(page);
        const point = await pointFor(page, 'grp:1');

        await page.mouse.click(point.x, point.y);

        await expect.poll(() => page.evaluate(
            () => window.musicGraph.selectedNode?.id ?? null)).toBe('grp:1');
    });
});
