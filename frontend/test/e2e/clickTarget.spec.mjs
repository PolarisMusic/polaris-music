/**
 * Which node a click belongs to.
 *
 * The Poincare disk draws nodes smaller the further they are from the centre —
 * a person two hops out is a third of a pixel. JIT's hit test did not follow:
 * it compared the pointer against the node's untransformed dim (jit.js:18358),
 * so every one of those specks carried a ten-pixel target and every group a
 * thirty-pixel one, invisible discs piled on top of each other all around the
 * rim. The winner was whichever came first in `graph.nodes` key order
 * (jit.js:2099) — the order the API returned them in.
 *
 * The symptom is the one that was reported: click a node out at the edge,
 * arrive somewhere else. Not somewhere adjacent, not somewhere predictable.
 *
 * So these are about the correspondence between what is drawn and what can be
 * hit: the ink you can see is the target, the specks keep a small reach so
 * they stay reachable at all, nearest wins, and nothing claims a click from
 * further away than that.
 */

import { test, expect } from '@playwright/test';

/**
 * A scene that crowds the rim.
 *
 * Eight bands of thirty, which puts two hundred and forty people on one ring
 * about seven pixels apart — tighter than the ten-pixel target JIT gave each
 * of them, which is the condition the old hit test needed to go wrong, and
 * the ordinary condition around any well-connected producer in the registry.
 */
function crowdedScene(groups = 8, members = 30) {
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

const SCENE = crowdedScene();

async function boot(page, graph = SCENE) {
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
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(graph) }));
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

/**
 * Where each node is drawn, in canvas coordinates, and how big.
 *
 * Worked out here from dim, position and scale rather than asked of the
 * visualiser, so that what the hit test claims can be checked against the
 * geometry the renderers actually use (MusicGraph.js, 'circle-hover' and
 * 'group-donut' render) rather than against the hit test's own idea of it.
 * `shrunk` is the size the hyperbolic transform alone would give — before the
 * two-pixel floor that keeps a node visible however far out it sits. Tests
 * pick their specks by that, because it is what says "this node would be
 * invisible without the floor" and so names the nodes at the rim that the
 * floor exists for.
 */
const drawn = (page) => page.evaluate(() => {
    const ht = window.musicGraph.ht;
    const out = {};
    ht.graph.eachNode((node) => {
        const p = node.pos.getc();
        const shrunk = node.getData('dim') * (1 - p.squaredNorm());
        const dim = Math.max(shrunk, 2);
        const centre = p.$scale(node.scale);
        const slices = node.getData('donutSlices');
        let radius = dim;
        if (slices && slices.length > 0) {
            radius += Math.max(2, dim * 0.20) + Math.max(3, dim * 0.45);
        }
        out[node.id] = { x: centre.x, y: centre.y, radius, shrunk };
    });
    return out;
});

/**
 * What the visualisation itself says is at a canvas point.
 *
 * JIT's own lookup, reproduced exactly (jit.js:2099): walk the nodes in key
 * order, ask each node type's `contains`, take the first yes. Everything the
 * page does with a pointer — click, hover, right-click, tooltip — comes
 * through this, so it is the thing worth asserting about.
 */
const nodeAt = (page, point) => page.evaluate((p) => {
    const ht = window.musicGraph.ht;
    const types = ht.fx.nodeTypes;
    for (const id in ht.graph.nodes) {
        const node = ht.graph.nodes[id];
        const geom = node && types[node.getData('type')];
        if (geom && geom.contains && geom.contains.call(ht.fx, node, p)) return node.id;
    }
    return null;
}, point);

/**
 * The viewport point that lands on a canvas coordinate.
 *
 * The inverse of the conversion JIT's own event object does (jit.js:2082), so
 * a click placed here arrives there.
 */
const viewportPoint = (page, point) => page.evaluate((p) => {
    const canvas = window.musicGraph.ht.canvas;
    const pos = canvas.getPos(true);
    const size = canvas.getSize();
    return {
        x: pos.x - window.scrollX + size.width / 2 + p.x * canvas.scaleOffsetX + canvas.translateOffsetX,
        y: pos.y - window.scrollY + size.height / 2 + p.y * canvas.scaleOffsetY + canvas.translateOffsetY,
    };
}, point);

const selectedId = (page) => page.evaluate(() => window.musicGraph.selectedNode?.id ?? null);

test.describe('a click belongs to the node under it', () => {
    test('every drawn node answers for its own centre', async ({ page }) => {
        // The whole bug in one assertion. Under the old rule a speck at the
        // rim would be answered for by whichever invisible neighbour's
        // oversized disc happened to be enumerated first.
        await boot(page);
        const positions = await drawn(page);

        const stolen = [];
        for (const [id, p] of Object.entries(positions)) {
            if (p.radius <= 0) continue;
            const hit = await nodeAt(page, { x: p.x, y: p.y });
            if (hit !== id) stolen.push({ id, hit, radius: p.radius });
        }

        expect(stolen).toEqual([]);
    });

    test('and there are specks in this scene for it to be about', async ({ page }) => {
        // Guards the test above from passing because the scene is roomy. If
        // the hyperbolic shrink is not taking nodes under a pixel somewhere,
        // nothing here is being tested.
        await boot(page);
        const positions = Object.values(await drawn(page));

        const specks = positions.filter((p) => p.shrunk < 1);
        expect(specks.length).toBeGreaterThan(50);
    });

    test('nothing is drawn too small to see or aim at', async ({ page }) => {
        // The floor, read off the canvas rather than recomputed — the helper
        // above applies the same floor, so asking it would only prove the test
        // agrees with itself.
        //
        // The first attempt measured the ink in a box around each speck and
        // passed with the floor removed: at the rim a node's own edges run
        // through any box drawn around it, and they are most of what is in it.
        // So this samples one pixel, on the outward side, where the node's
        // single edge is not. The median rather than the minimum because a
        // node at the very edge of the canvas falls outside it.
        await boot(page);
        const positions = await drawn(page);
        const specks = Object.entries(positions)
            .filter(([, p]) => p.shrunk < 1)
            .map(([, p]) => ({ x: p.x, y: p.y }));
        expect(specks.length).toBeGreaterThan(50);

        const alphas = await page.evaluate((points) => {
            const canvas = window.musicGraph.ht.canvas;
            const ctx = canvas.getCtx();
            const size = canvas.getSize();
            return points.map((p) => {
                // Sampled a pixel and a half out along the node's own bearing
                // from the centre of the disk. That is inside the ink of a
                // node drawn at the floor and outside the ink of one drawn at
                // a third of a pixel — and it is away from the node's edge,
                // which leaves on the inward side towards its group and would
                // otherwise be what the measurement found.
                const away = Math.hypot(p.x, p.y) || 1;
                const cx = Math.round(p.x + size.width / 2 + 1.5 * p.x / away);
                const cy = Math.round(p.y + size.height / 2 + 1.5 * p.y / away);
                if (cx < 1 || cy < 1 || cx > size.width - 2 || cy > size.height - 2) return null;
                return ctx.getImageData(cx, cy, 1, 1).data[3];
            }).filter((v) => v !== null);
        }, specks);

        // Measured: 216 with the floor, 0 without it.
        const median = alphas.sort((a, b) => a - b)[Math.floor(alphas.length / 2)];
        expect(median).toBeGreaterThan(150);
    });

    test('the nearest speck wins, and it is the nearest that moves', async ({ page }) => {
        await boot(page);
        const positions = await drawn(page);

        // Two people on the same ring, as close together as the layout puts
        // them, and a point on the line between them.
        const people = Object.entries(positions)
            .filter(([id, p]) => id.startsWith('per:') && p.shrunk < 1)
            .sort((a, b) => Math.atan2(a[1].y, a[1].x) - Math.atan2(b[1].y, b[1].x));

        const [idA, a] = people[0];
        const [idB, b] = people[1];

        const near = (t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        expect(await nodeAt(page, near(0.2))).toBe(idA);
        expect(await nodeAt(page, near(0.8))).toBe(idB);
    });

    test('ink beats proximity: a point inside a group is the group', async ({ page }) => {
        // A group is drawn large near the centre. A point well inside it is
        // its own, even with people scattered closer to that point than its
        // centre is — you clicked on the thing you can see.
        await boot(page);
        await page.evaluate(() => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode('grp:0'));
        });
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });

        const positions = await drawn(page);
        const group = positions['grp:0'];
        expect(group.radius).toBeGreaterThan(8);

        // Just inside the edge of its ink, on four sides.
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const point = {
                x: group.x + dx * (group.radius - 1),
                y: group.y + dy * (group.radius - 1),
            };
            expect(await nodeAt(page, point)).toBe('grp:0');
        }
    });

    test('a group drawn small claims no more than it draws', async ({ page }) => {
        // A band pushed out towards the rim is drawn three pixels across and
        // used to hold an eighteen-pixel target there anyway. That is the
        // largest invisible claim in the scene, so it is the one most likely
        // to swallow a click aimed at something real — or, as here, at
        // nothing at all. Selecting a person at the edge is what pushes the
        // other bands out that far.
        await boot(page);
        await page.evaluate(() => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode('per:4_9'));
        });
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });

        const positions = await drawn(page);
        const small = Object.entries(positions)
            .filter(([id, p]) => id.startsWith('grp:') && p.radius > 0 && p.radius < 5)
            .map(([, p]) => p);
        expect(small.length).toBeGreaterThan(0);

        // Beyond every node's ink and beyond the reach the specks are given,
        // so under the rule here it is empty canvas — while still inside the
        // old eighteen-pixel claim of one of those bands.
        const empty = (point) => Object.values(positions).every((q) =>
            Math.hypot(q.x - point.x, q.y - point.y) > Math.max(q.radius, 13));

        let point = null;
        for (const centre of small) {
            const away = Math.hypot(centre.x, centre.y) || 1;
            for (const r of [14, 15, 16, 17]) {
                // Inward along the node's own bearing: the next ring in is
                // the sparsest direction to step.
                const candidate = {
                    x: centre.x * (away - r) / away,
                    y: centre.y * (away - r) / away,
                };
                if (empty(candidate)) { point = candidate; break; }
            }
            if (point) break;
        }
        expect(point).not.toBeNull();
        expect(await nodeAt(page, point)).toBeNull();
    });
});

test.describe('the pointer and the click agree', () => {
    test('clicking specks at the rim selects those specks', async ({ page }) => {
        // The wiring, end to end: a real mouse click at the drawn centre of a
        // node too small to see properly arrives at that node. Three of them,
        // re-measured each time, because a single speck can be right by luck
        // — the old rule answered correctly for whichever node happened to be
        // enumerated first, and sometimes that was the right one.
        await boot(page);

        for (const nth of [0, 7, 15]) {
            const positions = await drawn(page);
            const specks = Object.entries(positions)
                .filter(([id, q]) => id.startsWith('per:') && q.shrunk < 1);
            const [id, p] = specks[nth % specks.length];

            const point = await viewportPoint(page, p);
            await page.mouse.click(point.x, point.y);

            await expect.poll(() => selectedId(page)).toBe(id);
            await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
        }
    });

    test('the answer follows the graph, not the pointer', async ({ page }) => {
        // The lookup is memoised per pointer position, because JIT asks it
        // once per node per event and a scan each time would make a mousemove
        // quadratic in the size of the graph. The cache therefore has to be
        // thrown away when the graph is redrawn under a pointer that has not
        // moved — which is the ordinary case, since every navigation moves
        // several hundred nodes past a stationary cursor.
        await boot(page);
        const positions = await drawn(page);
        const [speckId, speck] = Object.entries(positions)
            .find(([id, q]) => id.startsWith('per:') && q.shrunk < 1);

        const point = await viewportPoint(page, speck);
        await page.mouse.move(point.x, point.y);
        await expect.poll(() => page.evaluate(
            () => window.musicGraph.hoveredNode?.id ?? null)).toBe(speckId);

        // Somewhere else entirely, and not with the mouse.
        await page.evaluate(() => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode('grp:2'));
        });
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });

        // Asked of the resolver rather than through `contains`, which would
        // consult the very cache under test and agree with itself.
        const nowThere = await page.evaluate(
            (p) => window.musicGraph._nodeAt(p)?.id ?? null, speck);
        expect(nowThere).not.toBe(speckId);

        await page.mouse.click(point.x, point.y);

        // Whatever is under that pixel now — including nothing, which leaves
        // the selection where the navigation put it.
        await expect.poll(() => selectedId(page)).toBe(nowThere ?? 'grp:2');
    });

    test('what the hover names is what the click selects', async ({ page }) => {
        // The hover is the only preview of an ambiguous click there is. If it
        // highlighted one speck and the click took another, the crowd at the
        // rim would be unusable however the tie was broken.
        await boot(page);
        const positions = await drawn(page);
        const [, p] = Object.entries(positions)
            .find(([nodeId, q]) => nodeId.startsWith('per:') && q.shrunk < 1);

        const point = await viewportPoint(page, p);
        await page.mouse.move(point.x, point.y);
        await expect.poll(() => page.evaluate(
            () => window.musicGraph.hoveredNode?.id ?? null)).not.toBeNull();
        const hovered = await page.evaluate(() => window.musicGraph.hoveredNode.id);

        await page.mouse.click(point.x, point.y);
        await expect.poll(() => selectedId(page)).toBe(hovered);
    });
});
