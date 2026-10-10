/**
 * Dragging the info sheet by its handle.
 *
 * The handle was a 36×3px grabber above a sheet whose only control was the ✕
 * beside the title — it looked draggable and was not. The sheet already had two
 * states, so the fix was to connect them rather than remove the affordance.
 *
 * The snapping arithmetic is unit-tested. What these cover is the plumbing:
 * that a real pointer sequence reaches it, that the sheet follows the finger
 * and then lands in a state, and that the browser does not steal the gesture
 * for scrolling — which is the failure mode that looks like an intermittently
 * dead handle.
 */

import { test, expect } from '@playwright/test';

const GRAPH = {
    nodes: [
        { id: 'grp:band', name: 'Test Band', type: 'group' },
        { id: 'per:drums', name: 'A Drummer', type: 'person' },
    ],
    edges: [{ source: 'per:drums', target: 'grp:band', type: 'MEMBER_OF', role: 'drums' }],
};

async function boot(page) {
    await page.route('**/api/**', (route) => {
        const url = decodeURIComponent(route.request().url());
        if (url.includes('/stake/')) {
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, units: '0', formatted: '0.0000 MUS', stakerCount: 0 }),
            });
        }
        if (url.endsWith('/grp:band')) {
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ group_id: 'grp:band', name: 'Test Band', bio: 'A '.repeat(400) }),
            });
        }
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) });
    });
    await page.route('**/graph/initial*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(GRAPH) }));
    await page.route('**/graph/sponsored*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, node: null }) }));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 15_000 }
    );
}

/**
 * Wait for the sheet to finish moving between its two states.
 *
 * Its height is CSS-animated, so a box measured while the class is still
 * landing is wrong — one run reported the collapsed row at y=828.7 of an 844px
 * viewport, mostly below the fold, and a drag aimed at its centre hit nothing.
 *
 * Waits for transitionend rather than sampling the rect. Sampling looked
 * reasonable and was not: an eased transition starts slowly enough that
 * consecutive frames can read equal while the sheet is still moving, and the
 * tests then measured a handle in flight.
 */
async function waitForSheetSettled(page) {
    await page.evaluate(() => new Promise((resolve) => {
        const sheet = document.getElementById('info-viewer');
        if (!sheet) return resolve();

        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            sheet.removeEventListener('transitionend', finish);
            // One more frame, so the post-transition layout is readable.
            requestAnimationFrame(() => resolve());
        };

        sheet.addEventListener('transitionend', finish);
        // A state change that animates nothing fires no transitionend at all.
        setTimeout(finish, 600);
    }));
}

/** Select the group, which on a phone leaves the sheet collapsed. */
async function selectAndPeek(page) {
    await page.evaluate(() => {
        const g = window.musicGraph;
        g.handleNodeClick(g.ht.graph.getNode('grp:band'));
    });
    await page.waitForFunction(
        () => document.getElementById('info-viewer')?.classList.contains('peek'),
        { timeout: 10_000 }
    );
    await waitForSheetSettled(page);
}

const sheetState = (page) => page.evaluate(() => {
    const el = document.getElementById('info-viewer');
    return { open: el.classList.contains('open'), peek: el.classList.contains('peek') };
});

/**
 * Drag the handle by dy, in `steps` moves over `ms`.
 *
 * Real pointer events rather than dispatched ones: the point is partly to prove
 * the browser does not claim the gesture for scrolling, and a synthetic event
 * cannot be claimed.
 */
async function dragHandle(page, dy, { steps = 10, ms = 300, grab = null } = {}) {
    // The handle is hidden while collapsed; there the row is the grab area.
    const selector = grab || (await page.evaluate(() =>
        document.getElementById('info-viewer').classList.contains('open')
            ? '#info-sheet-handle'
            : '#info-peek'));
    await waitForSheetSettled(page);
    const box = await page.locator(selector).boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
        await page.mouse.move(x, y + (dy * i) / steps);
        await page.waitForTimeout(ms / steps);
    }
    await page.mouse.up();
}

test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('the handle is big enough to grab', async ({ page }) => {
        // 3px of visible bar is not a target. The strip around it is.
        await boot(page);
        await selectAndPeek(page);
        await page.evaluate(() => window.musicGraph.openInfoPanel());
        await waitForSheetSettled(page);

        const box = await page.locator('#info-sheet-handle').boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(20);
        expect(box.width).toBeGreaterThan(100);
    });

    test('it declares touch-action none, or the browser takes the gesture', async ({ page }) => {
        await boot(page);
        await selectAndPeek(page);
        await page.evaluate(() => window.musicGraph.openInfoPanel());
        await waitForSheetSettled(page);

        const touchAction = await page.evaluate(() =>
            getComputedStyle(document.getElementById('info-sheet-handle')).touchAction);
        expect(touchAction).toBe('none');
    });

    test('dragging up from the collapsed row opens the sheet', async ({ page }) => {
        await boot(page);
        await selectAndPeek(page);

        await dragHandle(page, -120);

        expect(await sheetState(page)).toEqual({ open: true, peek: false });
    });

    test('dragging down from the open sheet collapses it', async ({ page }) => {
        await boot(page);
        await selectAndPeek(page);
        await page.evaluate(() => window.musicGraph.openInfoPanel());
        await waitForSheetSettled(page);

        await dragHandle(page, 140);

        expect(await sheetState(page)).toEqual({ open: false, peek: true });
    });

    test('a short drag snaps back rather than changing state', async ({ page }) => {
        await boot(page);
        await selectAndPeek(page);

        // Well under the snap distance, and slow enough not to be a flick.
        await dragHandle(page, -20, { steps: 10, ms: 600 });

        expect(await sheetState(page)).toEqual({ open: false, peek: true });
    });

    test('the sheet follows the finger while dragging, then lets go', async ({ page }) => {
        await boot(page);
        await selectAndPeek(page);

        await waitForSheetSettled(page);
        const box = await page.locator('#info-peek').boundingBox();
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;

        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, y - 60);

        const during = await page.evaluate(() => ({
            transform: document.getElementById('info-viewer').style.transform,
            dragging: document.getElementById('info-viewer').classList.contains('sheet-dragging'),
        }));
        expect(during.dragging).toBe(true);
        expect(during.transform).toMatch(/translateY\(-\d/);

        await page.mouse.up();

        // The inline transform has to go, or it fights the class that places
        // the sheet in its new state.
        const after = await page.evaluate(() => ({
            transform: document.getElementById('info-viewer').style.transform,
            dragging: document.getElementById('info-viewer').classList.contains('sheet-dragging'),
        }));
        expect(after.transform).toBe('');
        expect(after.dragging).toBe(false);
    });

    test('the keyboard can work the handle too', async ({ page }) => {
        // From open, which is where the handle exists — collapsed, the row is
        // the control and answers Enter as the button it already is.
        await boot(page);
        await selectAndPeek(page);
        await page.evaluate(() => window.musicGraph.openInfoPanel());
        await waitForSheetSettled(page);

        await page.locator('#info-sheet-handle').press('Enter');
        expect(await sheetState(page)).toEqual({ open: false, peek: true });
    });

    test('it is reachable by assistive tech, having become a control', async ({ page }) => {
        await boot(page);
        await selectAndPeek(page);
        await page.evaluate(() => window.musicGraph.openInfoPanel());
        await waitForSheetSettled(page);

        const handle = page.locator('#info-sheet-handle');
        await expect(handle).toHaveAttribute('role', 'button');
        await expect(handle).toHaveAttribute('aria-label', /details/i);
        expect(await handle.getAttribute('aria-hidden')).toBeNull();
    });
});

test.describe('on a desktop', () => {
    test('the handle is not shown, because there is no sheet to drag', async ({ page }) => {
        await boot(page);
        await expect(page.locator('#info-sheet-handle')).toBeHidden();
    });

    test('a drag attempt cannot move the panel', async ({ page }) => {
        // The gesture declines outside the phone layout rather than being bound
        // conditionally, which would leave it unbound after a rotation.
        await boot(page);
        await page.evaluate(() => {
            const handle = document.getElementById('info-sheet-handle');
            handle.dispatchEvent(new PointerEvent('pointerdown', { clientY: 400, bubbles: true }));
            handle.dispatchEvent(new PointerEvent('pointermove', { clientY: 200, bubbles: true }));
        });

        const transform = await page.evaluate(() =>
            document.getElementById('info-viewer').style.transform);
        expect(transform).toBe('');
    });
});
