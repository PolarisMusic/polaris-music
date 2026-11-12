/**
 * Somebody who played with a band without being in it.
 *
 * The statement already existed — `(Person)-[:PERFORMED_ON {via_group_id}]->
 * (Track)`, written from a line-up named under a track — and /api/graph now
 * draws it as a Person → Group edge typed PERFORMED_WITH. That is what makes
 * a friend who played guitar on one track of somebody else's album visible:
 * the playing is a fact the registry keeps, and it is not a membership.
 *
 * Member, guest and session player all run Person → Group, and MusicGraph's
 * styling rules otherwise key off the node types at each end — so without the
 * declared type reaching the palette, all three are painted as memberships.
 * That is the failure this guards, the same one showGuests.spec.mjs guards for
 * guests.
 */

import { test, expect } from '@playwright/test';

/** A band, its drummer, a guitarist on one track, and a saxophone guest. */
const SCENE = {
    nodes: [
        { id: 'grp:band', name: 'Test Band', type: 'group' },
        { id: 'per:drums', name: 'A Drummer', type: 'person', color: '#aabbcc' },
        { id: 'per:guitar', name: 'Joe Harrison', type: 'person', color: '#ff8800' },
    ],
    edges: [
        { source: 'per:drums', target: 'grp:band', type: 'MEMBER_OF', role: 'drums' },
        {
            source: 'per:guitar', target: 'grp:band', type: 'PERFORMED_WITH',
            trackCount: 1, role: 'guitar', roles: ['guitar'],
            lineup_source: 'track_explicit',
        },
    ],
};

const WITH_GUEST = {
    nodes: [
        ...SCENE.nodes,
        { id: 'per:sax', name: 'A Saxophonist', type: 'person', color: '#33cc99' },
    ],
    edges: [
        ...SCENE.edges,
        {
            source: 'per:sax', target: 'grp:band', type: 'GUEST_ON',
            trackCount: 2, scope: 'track', roles: ['saxophone'],
        },
    ],
};

async function boot(page) {
    // Catch-all first: Playwright matches the most recently added route, so a
    // broad one registered afterwards answers /graph/initial with {} and the
    // graph never boots.
    await page.route('**/api/**', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) }));
    await page.route('**/graph/initial*', (route) => {
        const body = route.request().url().includes('guests=true') ? WITH_GUEST : SCENE;
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.route('**/graph/sponsored*', (route) =>
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ success: true, node: null }),
        }));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 15_000 }
    );
}

/** The drawn style of each edge type currently in the scene. */
const edgeStyles = (page) => page.evaluate(() => {
    const out = {};
    window.musicGraph.ht.graph.eachNode((node) => {
        node.eachAdjacency((adj) => {
            const type = adj.data?.type;
            if (!type || type === 'ROOT') return;
            out[type] = {
                color: adj.getData('color'),
                lineWidth: adj.getData('lineWidth'),
            };
        });
    });
    return out;
});

/**
 * Select a node and wait for the layout to settle.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 */
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
 * Where on screen the edge to a given node runs through, so the pointer can be
 * put on it. Same approach as edgeNavigation.spec.mjs.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} otherId
 */
async function edgeMidpoint(page, otherId) {
    return page.evaluate((targetId) => {
        const nav = window.musicGraph.edgeNavigator;
        const edge = nav.candidates().find((c) => c.other.id === targetId);
        return edge ? nav.diskToViewport(nav.midpointOf(edge)) : null;
    }, otherId);
}

test.describe('a session player on the graph', () => {
    test('is there without asking for guests', async ({ page }) => {
        // Unlike a guest list, which roughly doubles the person count on a
        // well-credited release. A named line-up is a deliberate statement and
        // there are few of them.
        await boot(page);

        await expect(page.locator('#show-guests')).not.toBeChecked();
        expect(await page.evaluate(
            () => !!window.musicGraph.ht.graph.getNode('per:guitar'))).toBe(true);
    });

    test('their edge is not painted as a membership', async ({ page }) => {
        // An opaque colour here means the type-pair rules claimed it, and the
        // graph is telling the viewer Joe Harrison is in the band.
        await boot(page);

        const styles = await edgeStyles(page);
        expect(styles.PERFORMED_WITH).toBeDefined();
        expect(styles.MEMBER_OF).toBeDefined();
        expect(styles.PERFORMED_WITH.color).toMatch(/^rgba\(/);
        expect(styles.PERFORMED_WITH.color).not.toBe(styles.MEMBER_OF.color);
        expect(styles.PERFORMED_WITH.lineWidth)
            .toBeLessThan(styles.MEMBER_OF.lineWidth);
    });

    test('and reads as a stronger claim than a guest credit', async ({ page }) => {
        // The three say different things, in this order: in the band, played
        // with the band, on the record. The drawing has to agree.
        await boot(page);
        await page.locator('#show-guests').check();
        await page.waitForFunction(() => !!window.musicGraph.ht.graph.getNode('per:sax'));

        const styles = await edgeStyles(page);
        const alpha = (rgba) => Number(/,\s*([\d.]+)\)$/.exec(rgba)[1]);

        expect(alpha(styles.PERFORMED_WITH.color)).toBeGreaterThan(alpha(styles.GUEST_ON.color));
        expect(styles.PERFORMED_WITH.lineWidth).toBeGreaterThan(styles.GUEST_ON.lineWidth);
    });

    test('is reachable by walking the edges off the band', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');

        const targets = await page.evaluate(() =>
            window.musicGraph.edgeNavigator.candidates().map((c) => c.other.id).sort());
        expect(targets).toEqual(['per:drums', 'per:guitar']);
    });

    test('and the edge says what they did, not that they are a member', async ({ page }) => {
        // "played with · guitar" is the honest reading. "member · guitar"
        // beside it would be a claim nobody made.
        await boot(page);
        await select(page, 'grp:band');

        const point = await edgeMidpoint(page, 'per:guitar');
        expect(point).not.toBeNull();
        await page.mouse.move(point.x, point.y);

        await expect(page.locator('.edge-label-name')).toHaveText('Joe Harrison');
        await expect(page.locator('.edge-label-relation')).toHaveText('played with · guitar');
    });
});
