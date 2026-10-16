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

/**
 * A graph crowded enough to have a real rim.
 *
 * The sparse scene above spreads its outermost nodes about fifty pixels
 * apart, which no finger can confuse. With eight bands of thirty the
 * Poincare disk packs the outermost pair five pixels apart — measured, not
 * assumed — and five pixels is less than the distance between two taps
 * aimed at the same thing. That gap is the whole subject of the second
 * describe block below.
 */
const DENSE = scene(8, 30);

async function boot(page, data = SCENE) {
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
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) }));
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

/**
 * The two closest nodes on the canvas, and how far apart they are.
 *
 * Found rather than named, because which pair the layout crowds is the
 * layout's business and changes with the scene.
 */
const closestPair = (page) => page.evaluate(() => {
    const centres = [];
    window.musicGraph.ht.graph.eachNode((n) => {
        const c = n.pos.getc().$scale(n.scale);
        centres.push({ id: n.id, x: c.x, y: c.y });
    });
    let best = null;
    for (let i = 0; i < centres.length; i++) {
        for (let j = i + 1; j < centres.length; j++) {
            const d = Math.hypot(centres[i].x - centres[j].x, centres[i].y - centres[j].y);
            if (!best || d < best.gap) {
                best = { gap: d, a: centres[i].id, b: centres[j].id };
            }
        }
    }
    return best;
});

/** The viewport point a fraction of the way from one node's centre to another's. */
const pointBetween = (page, aId, bId, t) => page.evaluate(({ aId, bId, t }) => {
    const ht = window.musicGraph.ht;
    const centre = (id) => {
        const n = ht.graph.getNode(id);
        return n.pos.getc().$scale(n.scale);
    };
    const a = centre(aId);
    const b = centre(bId);
    const c = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const canvas = ht.canvas;
    const pos = canvas.getPos(true);
    const size = canvas.getSize();
    return {
        x: pos.x - window.scrollX + size.width / 2 + c.x * canvas.scaleOffsetX + canvas.translateOffsetX,
        y: pos.y - window.scrollY + size.height / 2 + c.y * canvas.scaleOffsetY + canvas.translateOffsetY,
    };
}, { aId, bId, t });

/**
 * Which node the resolver gives for a canvas point between two nodes.
 *
 * Canvas coordinates rather than viewport ones, because this asks the
 * resolver directly rather than going through a tap.
 */
const resolvedBetween = (page, aId, bId, t) => page.evaluate(({ aId, bId, t }) => {
    const ht = window.musicGraph.ht;
    const centre = (id) => {
        const n = ht.graph.getNode(id);
        return n.pos.getc().$scale(n.scale);
    };
    const a = centre(aId);
    const b = centre(bId);
    return window.musicGraph._nodeAt({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
    })?.id ?? null;
}, { aId, bId, t });

test.describe('out at the rim, where the nodes are a finger-width apart', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('the second tap confirms the named node, not the nearer neighbour', async ({ page }) => {
        // The bug this exists for, reported from a phone: tap a node at the
        // edge, see its name, tap again to go there — and land on something
        // else. Each tap was resolved on its own, nearest-centre-wins, and out
        // here the nodes are five pixels apart while two taps aimed at the
        // same thing are not. So the second tap, two or three pixels off,
        // belonged to the neighbour, and the preview moved instead of the
        // graph.
        await boot(page, DENSE);
        const pair = await closestPair(page);
        expect(pair.gap).toBeLessThan(12);   // the premise of the test

        await page.touchscreen.tap(...Object.values(await pointFor(page, pair.a)));
        await expect.poll(() => named(page, pair.a)).toBe(true);

        // Seven tenths of the way across: a few pixels of jitter, landing
        // nearer the neighbour than the node the reader is looking at.
        const jittered = await pointBetween(page, pair.a, pair.b, 0.7);
        await page.touchscreen.tap(jittered.x, jittered.y);

        await expect.poll(() => page.evaluate(
            () => window.musicGraph.selectedNode?.id ?? null)).toBe(pair.a);
        expect(await named(page, pair.b)).toBe(false);
    });

    test('and the graph travels, rather than the name moving sideways', async ({ page }) => {
        await boot(page, DENSE);
        const pair = await closestPair(page);

        await page.touchscreen.tap(...Object.values(await pointFor(page, pair.a)));
        await expect.poll(() => named(page, pair.a)).toBe(true);
        const jittered = await pointBetween(page, pair.a, pair.b, 0.7);
        await page.touchscreen.tap(jittered.x, jittered.y);

        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
        expect((await state(page)).root).toBe(pair.a);
    });

    test('the confirmation lasts as long as the name is up', async ({ page }) => {
        // Not a timer and not a count of taps: the preview is the reader's
        // standing claim about what they are aiming at, so it holds that aim
        // for exactly as long as it is on screen.
        await boot(page, DENSE);
        const pair = await closestPair(page);

        await page.touchscreen.tap(...Object.values(await pointFor(page, pair.a)));
        await expect.poll(() => named(page, pair.a)).toBe(true);

        expect(await resolvedBetween(page, pair.a, pair.b, 0.7)).toBe(pair.a);

        // Name put away, and the same point belongs to whoever is nearest
        // again — the rule is a property of the preview, not of the geometry.
        const empty = await emptyPoint(page);
        await page.touchscreen.tap(empty.x, empty.y);
        await expect.poll(() => named(page, pair.a)).toBe(false);

        expect(await resolvedBetween(page, pair.a, pair.b, 0.7)).toBe(pair.b);
    });

    test('a tap further off than a finger still moves the name', async ({ page }) => {
        // The escape hatch, and it is distance rather than ink: these two
        // groups are a long way apart, so the second tap is plainly aimed
        // somewhere else and names it instead of confirming the first.
        //
        // Ink was the first attempt at this test's rule and it was wrong. Out
        // at the rim a node is drawn at the two-pixel floor with its
        // neighbour's centre five pixels away, so a tap that lands on the
        // neighbour's ink has not chosen it — it has missed by two pixels.
        await boot(page, DENSE);

        await page.touchscreen.tap(...Object.values(await pointFor(page, 'grp:1')));
        await expect.poll(() => named(page, 'grp:1')).toBe(true);

        await page.touchscreen.tap(...Object.values(await pointFor(page, 'grp:2')));

        await expect.poll(() => named(page, 'grp:2')).toBe(true);
        expect(await named(page, 'grp:1')).toBe(false);
        expect(await page.evaluate(
            () => window.musicGraph.selectedNode?.id ?? null)).toBeNull();
    });

    test('the name can still be put away by tapping the canvas', async ({ page }) => {
        // The incumbent holds its aim within a finger's width, not across the
        // whole canvas: dismissing has to keep working.
        await boot(page, DENSE);
        const pair = await closestPair(page);

        await page.touchscreen.tap(...Object.values(await pointFor(page, pair.a)));
        await expect.poll(() => named(page, pair.a)).toBe(true);

        const empty = await emptyPoint(page);
        expect(empty).not.toBeNull();
        await page.touchscreen.tap(empty.x, empty.y);

        await expect.poll(() => named(page, pair.a)).toBe(false);
        expect(await page.evaluate(
            () => window.musicGraph.selectedNode?.id ?? null)).toBeNull();
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
