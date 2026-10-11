/**
 * Rebuilding the layout tree only when nobody would see it happen.
 *
 * Navigating is a Mobius translation, which is rigid and followable and leaves
 * the selection's own neighbours at whatever radius their depth in a tree built
 * from somewhere else dictates — measured, a band's members at 0.937 while
 * strangers two hops away sit at 0.809. Rebuilding the tree on the selection
 * fixes that and rearranges the scene, which is worse than the problem.
 *
 * But the cost of a rebuild is paid only by the nodes the viewer can resolve,
 * and after a step somewhere sparse there may be none. So the rule is not
 * "rebuild at the extremes" — being stuck fires on 58% of steps and costs 22 to
 * 214 pixels of median movement when it does — but "rebuild when it is free".
 *
 * Measured across three walks: the rebuild fires on 4 of 25 steps, moves no
 * legible node at all when it does, and lifts the share of a selection's
 * neighbours that are legible from 38% to 51%. Most of that gain is on steps
 * where nothing was rebuilt: re-rooting anchors the tree where the visitor is,
 * so the plain translations that follow land better too.
 */

import { test, expect } from '@playwright/test';

function sharedScene(groups, members) {
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

const SCENE = sharedScene(4, 4);
const LEGIBLE = 0.9;
/* Must match MusicGraph.REBUILD_GATE_PX. */
const GATE_PX = 4;

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

async function select(page, id) {
    await page.evaluate((nodeId) => {
        const g = window.musicGraph;
        g.handleNodeClick(g.ht.graph.getNode(nodeId));
    }, id);
    await page.waitForFunction(
        (nodeId) => window.musicGraph.selectedNode?.id === nodeId && !window.musicGraph.ht.busy,
        id,
        { timeout: 15_000 }
    );
    await page.waitForTimeout(250);
}

const root = (page) => page.evaluate(() => window.musicGraph.ht.root);

/** How many of a node's graph neighbours are close enough to read. */
const legibleNeighbours = (page, id) => page.evaluate(({ nodeId, limit }) => {
    const graph = window.musicGraph.ht.graph;
    let legible = 0;
    let total = 0;
    graph.getNode(nodeId).eachAdjacency((adj) => {
        if ((adj.data?.type || '') === 'ROOT') return;
        const other = adj.nodeFrom.id === nodeId ? adj.nodeTo : adj.nodeFrom;
        total++;
        if (other.pos.rho < limit) legible++;
    });
    return { legible, total };
}, { nodeId: id, limit: LEGIBLE });

test.describe('the gated rebuild', () => {
    test('fires on a step into a sparse view', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        const before = await root(page);

        await select(page, 'per:0_1');

        expect(await root(page)).toBe('per:0_1');
        expect(await root(page)).not.toBe(before);
    });

    test('and brings the node you are standing on into view', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        await select(page, 'per:0_1');

        // Measured: 0.937 under a plain translation, 0.51 once rebuilt.
        const { legible, total } = await legibleNeighbours(page, 'per:0_1');
        expect(total).toBe(1);
        expect(legible).toBe(1);
    });

    test('declines when a legible node would have to move', async ({ page }) => {
        // Selecting a band from the shared player: four other bands and the
        // player itself are on screen, and the rebuild would swing them by up
        // to 156px. It must not happen.
        await boot(page);
        await select(page, 'per:hub');
        const before = await root(page);

        await select(page, 'grp:2');

        expect(await root(page)).toBe(before);
    });

    test('moves nothing visible when it does fire', async ({ page }) => {
        // The entry condition, checked against the outcome: everything legible
        // after the glide must still be where the glide left it.
        await boot(page);
        await select(page, 'grp:0');

        // Freeze the view the translation produces, before the rebuild runs,
        // by taking the glide out of the equation. A zero-duration animation
        // is still an animation: it sets ht.busy and lands on the next timer
        // tick, so the positions are not there yet when onClick returns.
        await page.evaluate(() => window.musicGraph.ht.onClick('per:0_1', { duration: 0 }));
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });

        const { positions: mid, radius } = await page.evaluate(() => {
            const ht = window.musicGraph.ht;
            const out = {};
            ht.graph.eachNode((n) => {
                if ((n.data?.type || '').toLowerCase() === 'root') return;
                const c = n.pos.getc(true);
                out[n.id] = { x: c.x, y: c.y, rho: n.pos.rho };
            });
            return { positions: out, radius: ht.getRadius() };
        });

        const applied = await page.evaluate(
            () => window.musicGraph._rebuildLayoutIfFree(
                window.musicGraph.ht.graph.getNode('per:0_1')));
        expect(applied).toBe(true);

        const after = await page.evaluate(() => {
            const out = {};
            window.musicGraph.ht.graph.eachNode((n) => {
                if ((n.data?.type || '').toLowerCase() === 'root') return;
                const c = n.pos.getc(true);
                out[n.id] = { x: c.x, y: c.y };
            });
            return out;
        });

        let worstPx = 0;
        for (const [id, p] of Object.entries(mid)) {
            if (p.rho >= LEGIBLE) continue;
            if (!(id in after)) continue;
            worstPx = Math.max(worstPx,
                Math.hypot(after[id].x - p.x, after[id].y - p.y) * radius);
        }
        expect(worstPx).toBeLessThan(GATE_PX);
    });

    test('leaves the view exactly alone when it declines', async ({ page }) => {
        // Declining has to be free too. The decision computes a whole layout
        // into the end positions and must put them back, or the next
        // animation glides towards a layout nobody chose.
        await boot(page);
        await select(page, 'per:hub');

        const snapshot = () => page.evaluate(() => {
            const out = {};
            window.musicGraph.ht.graph.eachNode((n) => {
                out[n.id] = {
                    pos: [n.pos.theta, n.pos.rho],
                    end: [n.endPos.theta, n.endPos.rho],
                };
            });
            return { root: window.musicGraph.ht.root, nodes: out };
        });

        const before = await snapshot();
        const applied = await page.evaluate(
            () => window.musicGraph._rebuildLayoutIfFree(
                window.musicGraph.ht.graph.getNode('grp:2')));

        expect(applied).toBe(false);
        expect(await snapshot()).toEqual(before);
    });

    test('pays forward: later translations land better', async ({ page }) => {
        // The larger half of the gain. Re-rooting where the visitor is leaves
        // the tree anchored nearby, so steps that rebuild nothing at all still
        // arrive somewhere more useful. Measured over three walks, the share of
        // a selection's neighbours that are legible goes from 38% to 51%.
        await boot(page);
        await select(page, 'grp:0');
        const cold = await legibleNeighbours(page, 'grp:0');

        // A hop out and back. The hop out rebuilds; coming back does not.
        await select(page, 'per:0_1');
        const rootAfterHop = await root(page);
        await select(page, 'grp:0');

        expect(await root(page)).toBe(rootAfterHop);
        const warm = await legibleNeighbours(page, 'grp:0');

        expect(cold.legible).toBeLessThan(warm.legible);
    });
});
