/**
 * Travelling along an edge.
 *
 * The geometry is unit-tested; what this covers is whether the pointer
 * arithmetic agrees with where the renderer put the arc, and whether a hover
 * and a tap mean what they are supposed to. Those are precisely the parts no
 * amount of pure-function testing reaches: the pick inverts the canvas's own
 * pan, zoom and backing-store scaling, and getting any of that wrong produces
 * a feature that works everywhere except on screen.
 *
 * Rather than guessing at pixel coordinates, each test asks the page where the
 * edge actually is — the midpoint of the arc JIT drew — and points there.
 */

import { test, expect } from '@playwright/test';

const GRAPH = {
    nodes: [
        { id: 'grp:band', name: 'Test Band', type: 'group' },
        { id: 'per:drums', name: 'A Drummer', type: 'person' },
        { id: 'per:bass', name: 'A Bassist', type: 'person' },
    ],
    edges: [
        { source: 'grp:band', target: 'per:drums', type: 'MEMBER_OF', role: 'drums' },
        { source: 'grp:band', target: 'per:bass', type: 'MEMBER_OF', role: 'bass' },
    ],
};

const DETAILS = {
    'grp:band': { group_id: 'grp:band', name: 'Test Band' },
    'per:drums': { person_id: 'per:drums', name: 'A Drummer' },
    'per:bass': { person_id: 'per:bass', name: 'A Bassist' },
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
        const match = Object.keys(DETAILS).find((id) => url.endsWith(`/${id}`));
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(match ? DETAILS[match] : {}),
        });
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

/** Select a node and wait for the centring animation to settle. */
async function select(page, id) {
    await page.evaluate((nodeId) => {
        const g = window.musicGraph;
        g.handleNodeClick(g.ht.graph.getNode(nodeId));
    }, id);
    await page.waitForFunction(
        (nodeId) => window.musicGraph.selectedNode?.id === nodeId && !window.musicGraph.ht.busy,
        id,
        { timeout: 10_000 }
    );
}

/**
 * Where on screen the midpoint of a live edge is.
 *
 * Asked of the navigator itself, through the same projection it uses to place
 * a label on a touch device — so the test points at the pixels rather than at
 * a number somebody typed, and a projection bug fails here instead of hiding
 * behind matching arithmetic in the test.
 */
async function edgeMidpoint(page, otherId) {
    return page.evaluate((targetId) => {
        const nav = window.musicGraph.edgeNavigator;
        const edge = nav.candidates().find((c) => c.other.id === targetId);
        return edge ? nav.diskToViewport(nav.midpointOf(edge)) : null;
    }, otherId);
}

test.describe('hovering an edge', () => {
    test('names the node at the far end', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');

        const point = await edgeMidpoint(page, 'per:drums');
        expect(point).not.toBeNull();
        await page.mouse.move(point.x, point.y);

        await expect(page.locator('.edge-label-name')).toHaveText('A Drummer');
    });

    test('names the far end from either direction along the same edge', async ({ page }) => {
        // One edge, both ways round. Reading the name off a fixed end of the
        // adjacency rather than off the end you are not standing on happens to
        // be right half the time, and JIT decides which half.
        await boot(page);

        await select(page, 'grp:band');
        const fromGroup = await edgeMidpoint(page, 'per:drums');
        await page.mouse.move(fromGroup.x, fromGroup.y);
        await expect(page.locator('.edge-label-name')).toHaveText('A Drummer');

        await select(page, 'per:drums');
        const fromPerson = await edgeMidpoint(page, 'grp:band');
        await page.mouse.move(fromPerson.x, fromPerson.y);
        await expect(page.locator('.edge-label-name')).toHaveText('Test Band');
    });

    test('says what the relationship is, using the role where there is one', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');

        const point = await edgeMidpoint(page, 'per:bass');
        await page.mouse.move(point.x, point.y);

        await expect(page.locator('.edge-label-relation')).toHaveText('member · bass');
    });

    test('highlights the edge it is naming, and only that one', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');

        const point = await edgeMidpoint(page, 'per:drums');
        await page.mouse.move(point.x, point.y);

        const highlighted = await page.evaluate(() => {
            const nav = window.musicGraph.edgeNavigator;
            return nav.candidates()
                .filter((c) => c.adj.getData('color') === '#ffffff')
                .map((c) => c.other.id);
        });

        expect(highlighted).toEqual(['per:drums']);
    });

    test('lets go when the pointer leaves the edge', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');

        const point = await edgeMidpoint(page, 'per:drums');
        await page.mouse.move(point.x, point.y);
        await expect(page.locator('.edge-label-name')).toBeVisible();

        // Far enough to be outside the pick radius of either edge.
        await page.mouse.move(point.x, point.y + 120);
        await expect(page.locator('.edge-label-name')).toBeHidden();

        const restored = await page.evaluate(() =>
            window.musicGraph.edgeNavigator.candidates()
                .every((c) => c.adj.getData('color') !== '#ffffff'));
        expect(restored).toBe(true);
    });

    test('an edge that does not touch the current node is inert', async ({ page }) => {
        // Only the selection's own edges are live; every other arc on screen
        // has to stay un-pickable or the graph becomes a minefield.
        await boot(page);
        await select(page, 'per:drums');

        const liveTargets = await page.evaluate(() =>
            window.musicGraph.edgeNavigator.candidates().map((c) => c.other.id));

        expect(liveTargets).toEqual(['grp:band']);
    });
});

test.describe('clicking an edge', () => {
    test('travels to the node at the far end', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');

        const point = await edgeMidpoint(page, 'per:bass');
        await page.mouse.move(point.x, point.y);
        await page.mouse.click(point.x, point.y);

        await page.waitForFunction(
            () => window.musicGraph.selectedNode?.id === 'per:bass',
            { timeout: 10_000 }
        );
        await expect(page.locator('#info-title')).toHaveText('A Bassist');
    });

    test('the label goes away once you have arrived', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');

        const point = await edgeMidpoint(page, 'per:bass');
        await page.mouse.move(point.x, point.y);
        await page.mouse.click(point.x, point.y);

        await page.waitForFunction(() => window.musicGraph.selectedNode?.id === 'per:bass');
        await expect(page.locator('.edge-label-name')).toBeHidden();
    });

    test('a click on a node still selects the node', async ({ page }) => {
        // The edge handler runs in the capture phase ahead of JIT's. If it
        // swallows clicks it has no business in, node selection stops working
        // altogether — and clicking empty canvas would not notice, because
        // nothing was going to be selected there either.
        await boot(page);
        await select(page, 'grp:band');

        const at = await page.evaluate(() => {
            const g = window.musicGraph;
            const { x, y } = g._getNodeScreenPos(g.ht.graph.getNode('per:bass'));
            return { x, y };
        });
        await page.mouse.click(at.x, at.y);

        await page.waitForFunction(() => window.musicGraph.selectedNode?.id === 'per:bass', { timeout: 10_000 });
    });

    test('the node you are standing on is not stolen by its own edges', async ({ page }) => {
        // Every live edge touches the current node, so without node priority a
        // tap on it measures nearly zero to one of them and travels away.
        await boot(page);
        await select(page, 'grp:band');

        const at = await page.evaluate(() => {
            const g = window.musicGraph;
            const { x, y } = g._getNodeScreenPos(g.ht.graph.getNode('grp:band'));
            return { x, y };
        });

        await page.mouse.move(at.x, at.y);
        await expect(page.locator('.edge-label-name')).toBeHidden();

        await page.mouse.click(at.x, at.y);
        // Still here, not dragged off to a neighbour.
        expect(await page.evaluate(() => window.musicGraph.selectedNode.id)).toBe('grp:band');
    });

    test('a click on empty canvas is left alone', async ({ page }) => {
        // The edge handler runs in the capture phase ahead of JIT's; swallowing
        // clicks it has no business in would break node selection outright.
        await boot(page);
        await select(page, 'grp:band');

        const before = await page.evaluate(() => window.musicGraph.selectedNode.id);
        const box = await page.locator('#infovis canvas').boundingBox();
        // A corner of the canvas: outside the disk entirely.
        await page.mouse.click(box.x + 4, box.y + 4);

        await expect(page.locator('.edge-label-name')).toBeHidden();
        expect(await page.evaluate(() => window.musicGraph.selectedNode.id)).toBe(before);
    });
});

test.describe('without a hovering pointer', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

    test('the first tap reveals and the second travels', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');

        const point = await edgeMidpoint(page, 'per:drums');
        expect(point).not.toBeNull();

        await page.evaluate(({ x, y }) => {
            const nav = window.musicGraph.edgeNavigator;
            nav.handleClick(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
        }, point);

        // Revealed, not travelled.
        await expect(page.locator('.edge-label-name')).toHaveText('A Drummer');
        expect(await page.evaluate(() => window.musicGraph.selectedNode.id)).toBe('grp:band');

        await page.evaluate(({ x, y }) => {
            const nav = window.musicGraph.edgeNavigator;
            nav.handleClick(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
        }, point);

        await page.waitForFunction(
            () => window.musicGraph.selectedNode?.id === 'per:drums',
            { timeout: 10_000 }
        );
    });
});
