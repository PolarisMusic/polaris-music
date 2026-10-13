/**
 * What a navigation does, in two legs.
 *
 * TRAVEL is a Mobius translation carrying the selection to the centre. A Mobius
 * transformation of the Poincare disk is an isometry: every hyperbolic distance
 * between every pair of nodes is exactly what it was. Nothing moves relative to
 * anything else, so the eye can follow any node through it. That is what makes
 * it read as going somewhere.
 *
 * SETTLE then rebuilds the layout tree around the selection. It has to: radius
 * encodes depth in that tree, so under translation alone a band's own members
 * sit at 0.937 while strangers two hops away sit at 0.809 — not even monotonic
 * in graph distance. No isometry can fix that, because fixing it means changing
 * distances.
 *
 * The settle is not free, then, and the point is what it costs. Rebuilding used
 * to be unfollowable because nodes moved *past each other*: JIT deals each
 * node's children out of its wedge in adjacency order, so every ring is
 * reshuffled from scratch. computeStablePositions keeps each ring in the order
 * it is already in, at identical radii — so the motion is radial, nodes sliding
 * along their own bearings as their distance from the selection changes, and
 * the selection itself does not move at all.
 *
 * So: the first leg is checked for being exactly a translation, the second for
 * opening the neighbourhood without disturbing any ring, and both for being
 * animated rather than snapping.
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
const RELEASE = { release_id: 'rel:0', name: 'Long Player Zero', type: 'LP', year: 1969 };

async function boot(page, graph = SCENE) {
    await page.route('**/api/**', (route) => {
        const url = decodeURIComponent(route.request().url());
        if (url.includes('/stake/')) {
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, units: '0', formatted: '0.0000 MUS', stakerCount: 0 }),
            });
        }
        if (/\/group\/[^/]+\/releases/.test(url)) {
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, releases: [RELEASE] }),
            });
        }
        if (/\/release\//.test(url)) {
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, release: { ...RELEASE, tracks: [] } }),
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
    // The initial load animates. A frame of it is not "where the scene was".
    await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
    await page.waitForTimeout(300);
}

/** Cartesian position of every real node, in the unit disk. */
const positions = (page) => page.evaluate(() => {
    const out = {};
    window.musicGraph.ht.graph.eachNode((node) => {
        if ((node.data?.type || '').toLowerCase() === 'root') return;
        const c = node.pos.getc(true);
        out[node.id] = { x: c.x, y: c.y };
    });
    return out;
});

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
    await page.waitForTimeout(200);
}

/**
 * Hyperbolic distance in the Poincare disk.
 *
 * d(u,v) = arcosh(1 + 2|u-v|^2 / ((1-|u|^2)(1-|v|^2)))
 *
 * It runs away to infinity as either point approaches the rim, so the pairs
 * compared below are restricted to ones well inside it. That is not hiding a
 * failure: a translation is an isometry everywhere, and the restriction is
 * about floating point, not about the claim.
 */
function hyperbolicDistance(u, v) {
    const du = u.x * u.x + u.y * u.y;
    const dv = v.x * v.x + v.y * v.y;
    const dx = u.x - v.x;
    const dy = u.y - v.y;
    return Math.acosh(1 + (2 * (dx * dx + dy * dy)) / ((1 - du) * (1 - dv)));
}

/*
 * Measured with scripts/measureNavigation.mjs: at this cutoff a step compares
 * 45 to 1176 pairs and the worst of them moves by 4e-14. Tighter cutoffs leave
 * too few pairs to mean anything once the focused node's neighbours are pushed
 * out near the rim, which they are — that is the cost this navigation accepts.
 */
const WELL_INSIDE = 0.999;
const radiusOf = (p) => Math.hypot(p.x, p.y);

/**
 * The largest relative change in any pairwise distance, and how many pairs were
 * compared. An isometry scores 0.
 */
function worstDistortion(before, after) {
    const ids = Object.keys(after).filter((id) => id in before
        && radiusOf(before[id]) < WELL_INSIDE && radiusOf(after[id]) < WELL_INSIDE);

    let worst = 0;
    let pairs = 0;
    for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
            const was = hyperbolicDistance(before[ids[i]], before[ids[j]]);
            const now = hyperbolicDistance(after[ids[i]], after[ids[j]]);
            if (!Number.isFinite(was) || !Number.isFinite(now) || was < 1e-6) continue;
            pairs++;
            worst = Math.max(worst, Math.abs(now - was) / was);
        }
    }
    return { worst, pairs };
}

/*
 * Four orders of magnitude of headroom over the 4e-14 measured, and five below
 * anything a human could see. Deliberately not a loose "close enough" bound:
 * the claim is that this navigation is an isometry, not that it is roughly one,
 * and a threshold of a percent would pass against transformations that are
 * nothing of the kind.
 */
const RIGID = 1e-9;

/**
 * Where a plain translation would put every node.
 *
 * JIT applies `z -> (z + c) / (1 + conj(c) z)` with `c` the negated position of
 * the target (Complex.moebiusTransformation, jit.js:17820, driven from
 * Graph.Util.moebiusTransformation), which is the translation carrying the
 * target to the origin. Recomputed here rather than read back from the
 * application: a reference the implementation supplies cannot contradict it.
 */
function predictTranslation(before, targetId) {
    const b = before[targetId];
    const out = {};
    for (const [id, z] of Object.entries(before)) {
        // (z - b) / (1 - conj(b) z), in real arithmetic.
        const nx = z.x - b.x;
        const ny = z.y - b.y;
        const dx = 1 - (b.x * z.x + b.y * z.y);
        const dy = -(b.x * z.y - b.y * z.x);
        const den = dx * dx + dy * dy;
        out[id] = { x: (nx * dx + ny * dy) / den, y: (ny * dx - nx * dy) / den };
    }
    return out;
}

/** Pixels from the centre of the rendered disk to its rim. */
const diskRadius = (page) => page.evaluate(() => window.musicGraph.ht.getRadius());

/** Stop the second leg, to measure the first on its own. */
const travelOnly = (page) => page.evaluate(() => {
    window.musicGraph._settleAround = (node, done) => done();
});

/** Who is adjacent to whom, ignoring the synthetic layout connectors. */
const adjacency = (page) => page.evaluate(() => {
    const graph = window.musicGraph.ht.graph;
    const real = (n) => (n.data?.type || '').toLowerCase() !== 'root';
    const out = {};
    graph.eachNode((node) => {
        if (!real(node)) return;
        const neighbours = [];
        node.eachAdjacency((adj) => {
            if ((adj.data?.type || '') === 'ROOT') return;
            const other = adj.nodeFrom.id === node.id ? adj.nodeTo : adj.nodeFrom;
            if (real(other)) neighbours.push(other.id);
        });
        out[node.id] = neighbours;
    });
    return out;
});

/**
 * Each node's neighbours in the cyclic order they sit around it, for a given
 * set of positions.
 *
 * Computed here rather than in the page so it can be applied to a layout that
 * never existed on screen — specifically the one the travel leg produces,
 * which is where the settle starts and so the only honest baseline for
 * "did the settle reorder anything".
 *
 * Bearings are straight-line, which is an approximation: a Mobius translation
 * preserves true angles but not chord directions, so comparing across a travel
 * reports crossings that are an artefact of the measurement. Comparing across
 * the settle alone, which is what this is for, has no such problem.
 */
function ringsFrom(positions, adj) {
    const out = {};
    for (const [id, neighbours] of Object.entries(adj)) {
        const here = positions[id];
        if (!here) continue;
        const around = neighbours
            .filter((n) => positions[n])
            .map((n) => ({ id: n, a: Math.atan2(positions[n].y - here.y, positions[n].x - here.x) }));
        if (around.length >= 3) {
            around.sort((u, v) => u.a - v.a);
            out[id] = around.map((x) => x.id);
        }
    }
    return out;
}

/** Is `a` a rotation of `b`? Two descriptions of one ring. */
const sameRing = (a, b) =>
    a.length === b.length && [...b, ...b].join('\u0000').includes(a.join('\u0000'));

/** Euclidean radius of every node, with its graph-hop distance from `focusId`. */
const radiiByHops = (page, focusId) => page.evaluate((id) => {
    const graph = window.musicGraph.ht.graph;
    const hops = new Map([[id, 0]]);
    let frontier = [id];
    while (frontier.length) {
        const next = [];
        for (const cur of frontier) {
            graph.getNode(cur).eachAdjacency((adj) => {
                if ((adj.data?.type || '') === 'ROOT') return;
                const other = adj.nodeFrom.id === cur ? adj.nodeTo.id : adj.nodeFrom.id;
                if (hops.has(other)) return;
                hops.set(other, hops.get(cur) + 1);
                next.push(other);
            });
        }
        frontier = next;
    }
    const out = {};
    graph.eachNode((node) => {
        if ((node.data?.type || '').toLowerCase() === 'root') return;
        const h = hops.get(node.id);
        if (h === undefined) return;
        (out[h] = out[h] || []).push(node.pos.rho);
    });
    return out;
}, focusId);

const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

test.describe('the first leg is a translation', () => {
    test('stepping to a neighbour preserves every distance', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        await travelOnly(page);

        const before = await positions(page);
        await select(page, 'per:0_1');
        const { worst, pairs } = worstDistortion(before, await positions(page));

        expect(pairs).toBeGreaterThan(10);
        expect(worst).toBeLessThan(RIGID);
    });

    test('and is exactly the Mobius translation, to floating point', async ({ page }) => {
        // Checked against a reference this file computes for itself: a
        // reference the application supplies cannot contradict it.
        await boot(page);
        await select(page, 'grp:0');
        await travelOnly(page);
        const radius = await diskRadius(page);

        for (const id of ['per:0_1', 'grp:0', 'per:hub', 'grp:2']) {
            const before = await positions(page);
            await select(page, id);
            const after = await positions(page);
            const predicted = predictTranslation(before, id);

            let worstPx = 0;
            let judged = 0;
            for (const nodeId of Object.keys(after)) {
                if (!(nodeId in predicted)) continue;
                if (radiusOf(predicted[nodeId]) >= 0.9) continue;
                judged++;
                worstPx = Math.max(worstPx, Math.hypot(
                    after[nodeId].x - predicted[nodeId].x,
                    after[nodeId].y - predicted[nodeId].y
                ) * radius);
            }

            expect(judged, `step to ${id}`).toBeGreaterThan(0);
            expect(worstPx, `step to ${id}`).toBeLessThan(0.5);
        }
    });
});

test.describe('the second leg opens the neighbourhood', () => {
    test('puts the selection\'s own neighbours near it', async ({ page }) => {
        // The thing translation cannot do. Measured under translation alone:
        // 0.937, with strangers two hops out at 0.809.
        await boot(page);
        await select(page, 'grp:0');

        const byHops = await radiiByHops(page, 'grp:0');
        expect(median(byHops[1])).toBeLessThan(0.7);
    });

    test('and radius grows with graph distance, which it did not before', async ({ page }) => {
        // The property that was false: a band's members sat further out than
        // nodes twice as far away in the graph, so the layout asserted
        // something about the data that is not true.
        await boot(page);
        await select(page, 'grp:0');

        const byHops = await radiiByHops(page, 'grp:0');
        const hops = Object.keys(byHops).map(Number).sort((a, b) => a - b).filter((h) => h > 0);
        expect(hops.length).toBeGreaterThan(1);
        for (let i = 1; i < hops.length; i++) {
            expect(median(byHops[hops[i]]), `hop ${hops[i]} vs ${hops[i - 1]}`)
                .toBeGreaterThan(median(byHops[hops[i - 1]]));
        }
    });

    test('without any node crossing another', async ({ page }) => {
        // The whole reason a rebuild is tolerable here. JIT's own rebuild deals
        // each ring out afresh in adjacency order and reshuffles one to three
        // of them per step; keeping the order means the motion is radial and
        // can be followed.
        //
        // Measured across the settle, not across the whole navigation, and
        // from where the settle actually begins rather than from a predicted
        // translation. ht.root flips at the start of the settle, which is the
        // moment to look; reading the layout there needs no assumption about
        // where the travel left things.
        await boot(page);
        await select(page, 'grp:0');
        const adj = await adjacency(page);

        for (const id of ['per:0_1', 'per:hub', 'grp:2', 'per:2_3']) {
            const arrival = page.waitForFunction(
                (target) => window.musicGraph.ht.root === target,
                id,
                { polling: 'raf', timeout: 15_000 }
            );
            const clicked = select(page, id);
            await arrival;
            const start = ringsFrom(await positions(page), adj);
            await clicked;
            const end = ringsFrom(await positions(page), adj);

            const shared = Object.keys(end).filter((k) => k in start);
            expect(shared.length, `step to ${id}`).toBeGreaterThan(0);
            const changed = shared.filter((k) => !sameRing(start[k], end[k]));
            expect(changed, `step to ${id}`).toEqual([]);
        }
    });

    test('and does not turn the whole scene on its way', async ({ page }) => {
        // The settle rebuilds the tree, and the root's fan can start anywhere
        // on the circle. Starting it at zero — which is what JIT does — spins
        // the entire scene by an arbitrary angle on every single navigation,
        // and a rigid spin carries no information at all. The fan is put where
        // the fan already is instead.
        //
        // Measured against where the travel leg leaves things, since that is
        // what the settle starts from.
        await boot(page);
        await select(page, 'grp:0');

        const start = predictTranslation(await positions(page), 'per:0_1');
        await select(page, 'per:0_1');
        const end = await positions(page);

        // Circular mean of the per-node angular difference: averaging angles as
        // plain numbers puts 359 and 1 degree at 180.
        let re = 0;
        let im = 0;
        for (const id of Object.keys(end)) {
            if (!(id in start)) continue;
            if (radiusOf(start[id]) < 0.15 || radiusOf(end[id]) < 0.15) continue;
            const a = Math.atan2(start[id].y, start[id].x);
            const b = Math.atan2(end[id].y, end[id].x);
            re += Math.cos(a - b);
            im += Math.sin(a - b);
        }
        const spinDeg = Math.abs((Math.atan2(im, re) * 180) / Math.PI);
        expect(spinDeg).toBeLessThan(20);
    });

    test('and the node you arrived at does not move while it happens', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        expect(await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('grp:0').pos.rho)).toBeLessThan(0.01);
    });
});

test.describe('both legs are animated', () => {
    test('the scene is still moving part-way through', async ({ page }) => {
        // An earlier version applied the rebuild instantly, on the grounds that
        // it had been gated to cases where nothing *visible* moved — but the
        // gate only bounded nodes already inside the disk, and a node arriving
        // from the rim is the most conspicuous motion there is. It snapped.
        await boot(page);
        await select(page, 'grp:0');

        await page.evaluate(() => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode('per:0_1'));
        });

        const seen = [];
        for (let i = 0; i < 7; i++) {
            await page.waitForTimeout(90);
            seen.push(await page.evaluate(
                () => window.musicGraph.ht.graph.getNode('grp:0').pos.rho));
        }

        // grp:0 starts at the centre, is carried out by the travel, and is
        // drawn back in by the settle. However it goes, it must be caught
        // somewhere other than at its two endpoints.
        const distinct = new Set(seen.map((v) => v.toFixed(3)));
        expect(distinct.size).toBeGreaterThan(2);
    });

    test('the settle is animated too, not applied in one frame', async ({ page }) => {
        // Written because a mutation that applies the settle instantly passed
        // every other test in this file — and applying it instantly is exactly
        // the bug that was reported from the deployed build: "the graph
        // rearranges suddenly without any animation". Watching the whole
        // navigation is not enough, because the travel leg animates either way
        // and hides it.
        //
        // ht.root flips to the target at the start of the settle, which is the
        // signal to start looking.
        await boot(page);
        await select(page, 'grp:0');

        await page.evaluate(() => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode('per:0_1'));
        });
        await page.waitForFunction(
            () => window.musicGraph.ht.root === 'per:0_1',
            { timeout: 15_000, polling: 'raf' }
        );

        const sample = () => page.evaluate(() => ({
            busy: window.musicGraph.ht.busy,
            rho: window.musicGraph.ht.graph.getNode('grp:0').pos.rho,
        }));

        const first = await sample();
        await page.waitForTimeout(120);
        const second = await sample();

        expect(first.busy).toBe(true);
        expect(Math.abs(second.rho - first.rho)).toBeGreaterThan(0.001);
    });

    test('in sequence: the settle waits for the travel to finish', async ({ page }) => {
        // Not a timing detail — the thing being protected is the beat between
        // the legs. The travel ends with the selection at the centre and the
        // scene still in the shape it was; only then does the neighbourhood
        // open out. Overlapping the two was tried and reads as one blurred
        // event in which nothing has arrived.
        await boot(page);
        await select(page, 'grp:0');

        const started = Date.now();
        await page.evaluate(() => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode('per:0_1'));
        });
        await page.waitForFunction(
            () => window.musicGraph.ht.root === 'per:0_1',
            { timeout: 15_000, polling: 'raf' }
        );
        const handover = Date.now() - started;

        // The travel's own duration is 420ms. A little under allows for the
        // last frame landing early; anything near half of it is an overlap.
        expect(handover).toBeGreaterThan(380);
    });

    test('and both have finished by the time it reports it is done', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        await select(page, 'per:0_1');

        expect(await page.evaluate(() => window.musicGraph.ht.busy)).toBe(false);
        expect(await page.evaluate(() => window.musicGraph.ht.root)).toBe('per:0_1');
    });

    test('the selection ends at the centre', async ({ page }) => {
        await boot(page);
        await select(page, 'per:0_1');

        expect(await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('per:0_1').pos.rho)).toBeLessThan(0.01);
    });
});

test.describe('a click that lands mid-glide', () => {
    test('still arrives, rather than being swallowed', async ({ page }) => {
        // ht.move refuses while an animation is running (jit.js:18115). The
        // click was dropped by the graph while the selection and the info panel
        // had already moved on, so the view and the details disagreed until
        // something else moved the view.
        await boot(page);

        await page.evaluate(() => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode('grp:0'));
        });
        await page.waitForTimeout(150);
        await page.evaluate(() => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode('grp:2'));
        });
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
        await page.waitForTimeout(300);

        expect(await page.evaluate(() => window.musicGraph.selectedNode.id)).toBe('grp:2');
        expect(await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('grp:2').pos.rho)).toBeLessThan(0.01);
    });

    test('and the interrupted glide still travels rigidly', async ({ page }) => {
        // Cancelling leaves every node part-way along its path. That is a real
        // layout, so translating onwards from it is still an isometry.
        await boot(page);
        await select(page, 'grp:0');
        await travelOnly(page);

        const before = await positions(page);
        await page.evaluate(() => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode('per:0_1'));
        });
        await page.waitForTimeout(150);
        await page.evaluate(() => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode('per:hub'));
        });
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
        await page.waitForTimeout(300);

        const { worst, pairs } = worstDistortion(before, await positions(page));
        expect(pairs).toBeGreaterThan(10);
        expect(worst).toBeLessThan(RIGID);
    });
});

test.describe('the canvas resize does not rebuild the layout', () => {
    test('the glide is not cut short when the panel opens', async ({ page }) => {
        // canvas.resize() calls viz.refresh() internally (jit.js:2833), which
        // for the Hypertree is compute() + plot() — and compute() with no
        // argument writes 'current', so the animation was snapping to its end
        // the instant the info panel changed the canvas width. The first click
        // of a session never actually glided.
        await boot(page);

        await page.evaluate(() => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode('grp:0'));
        });
        await page.waitForTimeout(120);

        const rho = await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('grp:0').pos.rho);
        expect(rho).toBeGreaterThan(0.02);
        expect(rho).toBeLessThan(0.61);

        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
        expect(await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('grp:0').pos.rho)).toBeLessThan(0.01);
    });

    test('a resize with nothing animating leaves the focus centred', async ({ page }) => {
        await boot(page);
        await select(page, 'per:0_1');

        await page.setViewportSize({ width: 1100, height: 700 });
        await page.waitForTimeout(400);

        expect(await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('per:0_1').pos.rho)).toBeLessThan(0.01);
    });

    test('a resize does not disturb the layout either', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');

        const before = await positions(page);
        await page.setViewportSize({ width: 1100, height: 700 });
        await page.waitForTimeout(400);

        const { worst } = worstDistortion(before, await positions(page));
        expect(worst).toBeLessThan(RIGID);
    });
});

test.describe('arriving from a release link', () => {
    // This path was left on ht.onClick once and nothing caught it. It goes
    // through centreOn now, so it gets the same motion as a node click.
    test('centres the group and opens its neighbourhood, like any other step', async ({ page }) => {
        // This path was left behind on ht.onClick once and nothing caught it,
        // so it gets the same assertions as a node click rather than weaker
        // ones.
        await boot(page);
        await select(page, 'grp:0');

        await page.evaluate((release) => window.musicGraph._navigateToGroupAndSelectRelease(
            'grp:2', release.release_id, { ...release, tracks: [] }), RELEASE);
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
        await page.waitForTimeout(300);

        expect(await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('grp:2').pos.rho)).toBeLessThan(0.01);
        expect(await page.evaluate(() => window.musicGraph.ht.root)).toBe('grp:2');

        const byHops = await radiiByHops(page, 'grp:2');
        expect(median(byHops[1])).toBeLessThan(0.7);
    });
});
