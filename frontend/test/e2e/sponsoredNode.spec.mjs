/**
 * Opening the visualization on the drawn node.
 *
 * The draw itself is tested in the backend; what matters here is that the
 * front page actually lands on what it was given, and — the part worth
 * guarding — that it still works when it is given nothing. A visitor who never
 * asked for a sponsored node should not be able to tell the chain is down.
 */

import { test, expect } from '@playwright/test';

const GRAPH = {
    nodes: [
        { id: 'grp:band', name: 'Test Band', type: 'group' },
        { id: 'grp:other', name: 'Other Band', type: 'group' },
        { id: 'per:drums', name: 'A Drummer', type: 'person' },
    ],
    edges: [
        { source: 'grp:band', target: 'per:drums', type: 'MEMBER_OF', role: 'drums' },
        { source: 'grp:other', target: 'per:drums', type: 'MEMBER_OF', role: 'drums' },
    ],
};

const DETAILS = {
    'grp:band': { group_id: 'grp:band', name: 'Test Band' },
    'grp:other': { group_id: 'grp:other', name: 'Other Band' },
    'per:drums': { person_id: 'per:drums', name: 'A Drummer' },
};

/**
 * Boot with the graph stubbed and a chosen answer from /graph/sponsored.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object|null} sponsored - the body the endpoint should return
 */
async function boot(page, sponsored) {
    await page.route('**/api/**', (route) => {
        const url = decodeURIComponent(route.request().url());
        const match = Object.keys(DETAILS).find((id) => url.endsWith(`/${id}`));
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(match ? DETAILS[match] : {}),
        });
    });
    await page.route('**/graph/initial*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(GRAPH) }));
    await page.route('**/graph/sponsored*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(sponsored) }));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 15_000 }
    );
}

/** The node currently at the origin of the disk — i.e. the one opened on. */
const centredNode = (page) => page.evaluate(() => {
    let closest = null;
    let best = Infinity;
    window.musicGraph.ht.graph.eachNode((n) => {
        const p = n.pos.getc(true);
        const d = Math.hypot(p.x, p.y);
        if (d < best) { best = d; closest = n.id; }
    });
    return closest;
});

const drawn = (id) => ({
    success: true,
    node: { id, name: 'Whatever', type: 'group' },
    draw: { period: 5, seed: 'a'.repeat(64), total_weight: '3', offset: '1' },
});

test.describe('opening on the drawn node', () => {
    test('the graph centres on the node the draw named', async ({ page }) => {
        await boot(page, drawn('grp:other'));
        await page.waitForTimeout(1500);

        expect(await centredNode(page)).toBe('grp:other');
    });

    test('a different draw opens on a different node', async ({ page }) => {
        // Guards against the view simply sitting on whatever the hypertree
        // rooted itself at, which would look correct for one fixture.
        await boot(page, drawn('per:drums'));
        await page.waitForTimeout(1500);

        expect(await centredNode(page)).toBe('per:drums');
    });

    test('the drawn node is selected, not merely centred', async ({ page }) => {
        // It goes through the app's own click path, so the details panel is
        // populated and — on a phone — the collapsed row names it.
        await boot(page, drawn('grp:other'));
        await page.waitForTimeout(1500);

        const selected = await page.evaluate(() => window.musicGraph.selectedNode?.id);
        expect(selected).toBe('grp:other');
    });
});

test.describe('when there is no draw', () => {
    test('an empty answer leaves a working graph', async ({ page }) => {
        await boot(page, { success: true, node: null, reason: 'no_draw' });
        await page.waitForTimeout(1000);

        const count = await page.evaluate(() => {
            let n = 0;
            window.musicGraph.ht.graph.eachNode(() => n++);
            return n;
        });
        expect(count).toBe(3);
    });

    test('a failing endpoint leaves a working graph', async ({ page }) => {
        await page.route('**/api/**', (route) =>
            route.fulfill({ contentType: 'application/json', body: '{}' }));
        await page.route('**/graph/initial*', (route) =>
            route.fulfill({ contentType: 'application/json', body: JSON.stringify(GRAPH) }));
        await page.route('**/graph/sponsored*', (route) => route.fulfill({ status: 500, body: 'nope' }));

        await page.goto('/', { waitUntil: 'load' });
        await page.waitForFunction(
            () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
            { timeout: 15_000 }
        );
        await page.waitForTimeout(1000);

        expect(await centredNode(page)).toBeTruthy();
    });

    test('a node that is not in the loaded graph is ignored', async ({ page }) => {
        // A draw taken against a newer graph than this client fetched.
        await boot(page, drawn('grp:does-not-exist'));
        await page.waitForTimeout(1500);

        expect(await centredNode(page)).toBeTruthy();
        expect(await page.evaluate(() => window.musicGraph.selectedNode)).toBeFalsy();
    });
});
