/**
 * Whether the view moves as one rigid thing when the selection changes.
 *
 * Navigation is a Mobius translation of the Poincare disk. The defining
 * property of a Mobius transformation of the disk is that it is an *isometry*
 * of the hyperbolic metric: every distance between every pair of nodes is
 * exactly what it was before. Nothing moves relative to anything else, the
 * scene glides, and a visitor can follow it.
 *
 * That property is the whole argument for this navigation over rebuilding the
 * tree on the selection, which produces better-formed end states and does not
 * preserve a single distance. So it is worth asserting directly rather than
 * asserting about some consequence of it: measure the distances, navigate,
 * measure them again.
 *
 * With one exception, which is deliberate and gated. On arrival the layout may
 * be rebuilt around the new selection — but only when doing so would move no
 * node the viewer can resolve by more than a few pixels (see
 * MusicGraph._rebuildLayoutIfFree). So the contract has two branches, and both
 * are checked here against a reference this file computes for itself rather
 * than asks the application for:
 *
 *   no rebuild  the step is exactly the Mobius translation taking the target
 *               to the origin, to within floating point.
 *   rebuild     every node that was legible beforehand is within the gate of
 *               where that same translation would have put it. Nothing a
 *               visitor could see has moved; the gain is nodes arriving from
 *               the rim, which were not visible to begin with.
 *
 * The third section is the canvas resize, which was quietly rebuilding the
 * layout underneath the animation, and is nothing to do with either.
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

/* Must match MusicGraph.REBUILD_GATE_PX. */
const REBUILD_GATE_PX = 4;

/** Pixels from the centre of the rendered disk to its rim. */
const diskRadius = (page) => page.evaluate(() => window.musicGraph.ht.getRadius());

test.describe('the view moves rigidly', () => {
    test('stepping to a neighbour preserves every distance', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');

        // Deliberately with the rebuild stubbed out, so this measures the
        // navigation itself. The gated rebuild has its own tests, and the walk
        // below covers the two together.
        await page.evaluate(() => { window.musicGraph._rebuildLayoutIfFree = () => false; });

        const before = await positions(page);
        await select(page, 'per:0_1');
        const { worst, pairs } = worstDistortion(before, await positions(page));

        expect(pairs).toBeGreaterThan(10);
        expect(worst).toBeLessThan(RIGID);
    });

    test('every step is that translation, or invisibly close to it', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        const radius = await diskRadius(page);

        for (const id of ['per:0_1', 'grp:0', 'per:hub', 'grp:2', 'per:2_3']) {
            const before = await positions(page);
            const rootBefore = await page.evaluate(() => window.musicGraph.ht.root);

            await select(page, id);

            const after = await positions(page);
            const rootAfter = await page.evaluate(() => window.musicGraph.ht.root);
            const predicted = predictTranslation(before, id);

            let worstPx = 0;
            let judged = 0;
            for (const nodeId of Object.keys(after)) {
                if (!(nodeId in predicted)) continue;
                // Legible where the translation leaves it, not where it
                // started. The glide happens first and the rebuild second, so
                // the view a rebuild can disturb is the one the translation
                // produced — and the two sets barely overlap, since centring
                // on a node throws most of what was near the middle outwards.
                // Filtering on the starting radius instead reported a 488px
                // violation against a build that was behaving correctly.
                if (radiusOf(predicted[nodeId]) >= 0.9) continue;
                judged++;
                worstPx = Math.max(worstPx, Math.hypot(
                    after[nodeId].x - predicted[nodeId].x,
                    after[nodeId].y - predicted[nodeId].y
                ) * radius);
            }

            expect(judged, `step to ${id}`).toBeGreaterThan(0);
            if (rootAfter === rootBefore) {
                // No rebuild: the step is the translation and nothing else.
                expect(worstPx, `step to ${id}, no rebuild`).toBeLessThan(0.5);
            } else {
                expect(worstPx, `step to ${id}, rebuilt`).toBeLessThan(REBUILD_GATE_PX);
            }
        }
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

    test('and the interrupted glide is still rigid', async ({ page }) => {
        // Cancelling leaves every node part-way along its path. That is a real
        // layout, so translating onwards from it is still an isometry.
        await boot(page);
        await select(page, 'grp:0');

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
    test('centres the group and keeps the scene rigid', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');

        const before = await positions(page);
        await page.evaluate((release) => window.musicGraph._navigateToGroupAndSelectRelease(
            'grp:2', release.release_id, { ...release, tracks: [] }), RELEASE);
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
        await page.waitForTimeout(300);

        expect(await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('grp:2').pos.rho)).toBeLessThan(0.01);
        const { worst, pairs } = worstDistortion(before, await positions(page));
        expect(pairs).toBeGreaterThan(10);
        expect(worst).toBeLessThan(RIGID);
    });
});
