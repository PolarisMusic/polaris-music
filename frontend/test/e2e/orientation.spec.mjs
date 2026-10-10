/**
 * Whether the map keeps pointing the same way between one selection and the
 * next.
 *
 * Re-rooting the hypertree on the selection (see MusicGraph.centreOn) made each
 * end state right and introduced a complaint: a shuffle on every click. The
 * cause was not the re-rooting itself. JIT's computePositions (jit.js:11971)
 * starts the root's angular fan at theta = 0 and allocates from there in
 * adjacency order, so the absolute direction the whole scene faces is an
 * accident of which neighbour happens to come first. Measured with
 * scripts/measureOrientation.mjs: 21 to 135 degrees of rigid rotation per
 * click, carrying no information at all.
 *
 * A rotation about the origin is an isometry of the disk, so taking it back out
 * costs nothing — no radius moves, no ring reorders. What remains after it is
 * the motion that means something.
 *
 * The second half of this file is the bug that hid behind the first: the canvas
 * resize was rebuilding the layout from scratch underneath the animation.
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
    // The initial load animates. Reading a frame of it as "where the scene was"
    // compares the first navigation against a layout that was still moving, and
    // reports a spin nothing applied.
    await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
    await page.waitForTimeout(300);
}

/** theta and rho of every real node, in the hypertree's own coordinates. */
const positions = (page) => page.evaluate(() => {
    const out = {};
    window.musicGraph.ht.graph.eachNode((node) => {
        if ((node.data?.type || '').toLowerCase() === 'root') return;
        const p = node.pos.getp();
        out[node.id] = { theta: p.theta, rho: p.rho };
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
 * The single rotation that best carries `before` onto `after`, in degrees.
 *
 * Deliberately recomputed here rather than imported from the app: a spec that
 * asks the implementation what the answer is cannot tell whether the answer is
 * right. Nodes at the origin are excluded because theta is meaningless there.
 */
function spinDegrees(before, after) {
    let re = 0;
    let im = 0;
    for (const id of Object.keys(after)) {
        if (!(id in before)) continue;
        const a = before[id];
        const b = after[id];
        if (a.rho < 0.15 || b.rho < 0.15) continue;
        const w = (1 - a.rho) * (1 - b.rho);
        const d = a.theta - b.theta;
        re += w * Math.cos(d);
        im += w * Math.sin(d);
    }
    return (Math.atan2(im, re) * 180) / Math.PI;
}

/* Measured before the fix: 21 to 135 degrees. After: under a hundredth of one. */
const NO_SPIN_DEGREES = 2;

test.describe('the scene does not spin when the selection moves', () => {
    test('stepping to a neighbour leaves the scene facing the same way', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');

        const before = await positions(page);
        await select(page, 'per:0_1');
        const after = await positions(page);

        expect(Math.abs(spinDegrees(before, after))).toBeLessThan(NO_SPIN_DEGREES);
    });

    test('the first selection after load does not spin either', async ({ page }) => {
        // The one that opens the info panel, and so the one that changes a
        // canvas dimension. It spun 135 degrees while every later click spun
        // none, because the resize rebuilt the layout from scratch.
        await boot(page);

        const before = await positions(page);
        await select(page, 'grp:0');
        const after = await positions(page);

        expect(Math.abs(spinDegrees(before, after))).toBeLessThan(NO_SPIN_DEGREES);
    });

    test('it holds across a walk, not just one step', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');

        for (const id of ['per:0_1', 'grp:0', 'per:hub', 'grp:2']) {
            const before = await positions(page);
            await select(page, id);
            const after = await positions(page);
            expect(Math.abs(spinDegrees(before, after)), `step to ${id}`)
                .toBeLessThan(NO_SPIN_DEGREES);
        }
    });

    test('taking the spin out moves no node nearer or further', async ({ page }) => {
        // The whole argument for doing this is that a rotation about the origin
        // is an isometry: it cannot undo the radial structure centreOn exists to
        // fix. Worth asserting rather than asserting about.
        await boot(page);
        await select(page, 'grp:0');

        const radii = await page.evaluate(() => {
            const g = window.musicGraph;
            g.ht.root = 'per:0_1';
            g.ht.compute('end');
            const before = {};
            g.ht.graph.eachNode((n) => { before[n.id] = n.endPos.rho; });
            g._orientEndPositions();
            const after = {};
            g.ht.graph.eachNode((n) => { after[n.id] = n.endPos.rho; });
            return { before, after };
        });

        expect(radii.after).toEqual(radii.before);
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

        // A third of the way into a 700ms animation the target must be on its
        // way to the centre and not yet at it.
        const rho = await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('grp:0').pos.rho);
        expect(rho).toBeGreaterThan(0.02);
        expect(rho).toBeLessThan(0.61);

        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
        expect(await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('grp:0').pos.rho)).toBeLessThan(0.01);
    });

    test('a resize with nothing animating still leaves the focus centred', async ({ page }) => {
        await boot(page);
        await select(page, 'per:0_1');

        await page.setViewportSize({ width: 1100, height: 700 });
        await page.waitForTimeout(400);

        expect(await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('per:0_1').pos.rho)).toBeLessThan(0.01);
    });

    test('a resize part-way through a glide does not hijack it', async ({ page }) => {
        // Dragging a window edge or turning a phone while the graph is moving.
        // The resize restores the focus when it runs, and part-way through a
        // navigation the node sitting at the origin is the one being left
        // behind — so without a guard the resize grabs the view back to where
        // the click started.
        await boot(page);
        await select(page, 'grp:0');

        const before = await positions(page);
        await page.evaluate(() => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode('per:0_1'));
        });
        await page.waitForTimeout(150);
        await page.setViewportSize({ width: 1150, height: 760 });

        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
        await page.waitForTimeout(300);

        expect(await page.evaluate(
            () => window.musicGraph.ht.graph.getNode('per:0_1').pos.rho)).toBeLessThan(0.01);
        expect(Math.abs(spinDegrees(before, await positions(page))))
            .toBeLessThan(NO_SPIN_DEGREES);
    });

    test('a resize does not spin the scene either', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');

        const before = await positions(page);
        await page.setViewportSize({ width: 1100, height: 700 });
        await page.waitForTimeout(400);
        const after = await positions(page);

        expect(Math.abs(spinDegrees(before, after))).toBeLessThan(NO_SPIN_DEGREES);
    });
});

test.describe('arriving from a release link', () => {
    /*
     * Clicking a release in the info panel navigates to its group through
     * _navigateToGroupAndSelectRelease, which was left behind on ht.onClick
     * when node clicks moved to centreOn — so this one path still crushed the
     * neighbourhood against the rim and still spun the scene. Nothing failed
     * when it was reverted, which is the whole reason this exists.
     */
    const arrive = async (page) => {
        await page.evaluate((release) => window.musicGraph._navigateToGroupAndSelectRelease(
            'grp:2', release.release_id, { ...release, tracks: [] }), RELEASE);
        await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
        await page.waitForTimeout(200);
    };

    test('the group lands at the centre with its own members around it', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');
        await arrive(page);

        const { focus, neighbours } = await page.evaluate(() => {
            const graph = window.musicGraph.ht.graph;
            const node = graph.getNode('grp:2');
            const around = [];
            node.eachAdjacency((adj) => {
                if ((adj.data?.type || '') === 'ROOT') return;
                const other = adj.nodeFrom.id === 'grp:2' ? adj.nodeTo : adj.nodeFrom;
                around.push(other.pos.rho);
            });
            return { focus: node.pos.rho, neighbours: around };
        });

        expect(focus).toBeLessThan(0.01);
        expect(Math.max(...neighbours)).toBeLessThan(0.7);
    });

    test('and the scene does not spin on the way', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:0');

        const before = await positions(page);
        await arrive(page);
        const after = await positions(page);

        expect(Math.abs(spinDegrees(before, after))).toBeLessThan(NO_SPIN_DEGREES);
    });
});
