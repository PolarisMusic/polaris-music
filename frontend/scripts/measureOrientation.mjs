/**
 * How much the map moves under you between one selection and the next.
 *
 * The re-rooting fix (see MusicGraph.centreOn) made each end state right and
 * introduced a complaint it did not have before: a shuffle on every click, and
 * a view that is still easy to get lost in. This measures the shuffle so the
 * next change is aimed at something rather than at an impression.
 *
 * Möbius navigation, the thing re-rooting replaced, is an isometry: nothing
 * moves relative to anything else, the whole scene glides, and you can follow
 * it. Re-rooting rebuilds the tree, and JIT's computePositions (jit.js:11961)
 * hands the new root's first child the angular slice starting at theta = 0 and
 * fans the rest round from there in adjacency order. Nothing ties that to where
 * anything was a moment ago, so the scene is free to spin arbitrarily and to
 * reorder every ring.
 *
 * Reported per navigation:
 *
 *   spin        the single best-fit rotation between the two layouts, in
 *               degrees. This is the correctable part: a rigid spin of the
 *               whole scene, which carries no information at all.
 *   residual    weighted mean angular displacement AFTER taking that spin out.
 *               This is the part a rotation cannot fix — rings genuinely
 *               reordering.
 *   homeward    where the node you came from ended up, against where walking
 *               along that edge would put it (the direction you travelled,
 *               reversed). 0 deg means the motion reads as "I went that way".
 *   rings       of the nodes with 3+ neighbours, how many had the cyclic order
 *               of their neighbours changed. The local map looking the same is
 *               what makes somewhere recognisable when you come back to it.
 *
 * Usage, from frontend/ with `npx vite preview` serving dist:
 *   node scripts/measureOrientation.mjs
 */

import { chromium } from '@playwright/test';

const BASE = process.env.MEASURE_URL || 'http://127.0.0.1:4173/';

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

/** A walk a visitor would actually take: band, one of its members, onward. */
const WALKS = [
    { name: '4 bands x 4, shared player', graph: sharedScene(4, 4),
      walk: ['grp:0', 'per:0_1', 'grp:0', 'per:hub', 'grp:2'] },
    { name: '8 bands x 5, shared player', graph: sharedScene(8, 5),
      walk: ['grp:0', 'per:0_2', 'grp:0', 'per:hub', 'grp:5'] },
];

/** theta/rho of every real node, plus each node's neighbour ring by angle. */
const snapshot = (page) => page.evaluate(() => {
    const graph = window.musicGraph.ht.graph;
    const pos = {};
    const rings = {};
    graph.eachNode((node) => {
        if ((node.data?.type || '').toLowerCase() === 'root') return;
        const p = node.pos.getp();
        const c = node.pos.getc(true);
        pos[node.id] = { theta: p.theta, rho: p.rho, x: c.x, y: c.y };
    });
    graph.eachNode((node) => {
        if (!(node.id in pos)) return;
        const here = pos[node.id];
        const around = [];
        node.eachAdjacency((adj) => {
            if ((adj.data?.type || '') === 'ROOT') return;
            const other = adj.nodeFrom.id === node.id ? adj.nodeTo : adj.nodeFrom;
            if (!(other.id in pos)) return;
            const there = pos[other.id];
            around.push({ id: other.id, a: Math.atan2(there.y - here.y, there.x - here.x) });
        });
        around.sort((u, v) => u.a - v.a);
        rings[node.id] = around.map((n) => n.id);
    });
    return { pos, rings };
});

const wrap = (a) => {
    const t = a % (2 * Math.PI);
    return t > Math.PI ? t - 2 * Math.PI : (t < -Math.PI ? t + 2 * Math.PI : t);
};
const deg = (r) => (r * 180) / Math.PI;

/*
 * The node at the origin has no angle — theta is whatever the layout last left
 * in the field, and a one-pixel wobble swings it by pi. The focused node is
 * always at the origin, and the node focused a moment ago is near it, so these
 * are exactly the nodes a naive (1 - rho) weighting trusts most. Excluded, or
 * every number below is noise dressed as signal.
 */
const ORIGIN_RADIUS = 0.15;

/** How much a node's angle counts: inner nodes are what the eye follows. */
function angleWeight(a, b) {
    if (a.rho < ORIGIN_RADIUS || b.rho < ORIGIN_RADIUS) return 0;
    return Math.max(0, (1 - a.rho) * (1 - b.rho));
}

/** The single rotation that best carries `from` onto `to`: circular mean. */
function bestFitSpin(from, to) {
    let re = 0;
    let im = 0;
    for (const id of Object.keys(to.pos)) {
        if (!(id in from.pos)) continue;
        const a = from.pos[id];
        const b = to.pos[id];
        const w = angleWeight(a, b);
        if (w === 0) continue;
        const d = a.theta - b.theta;
        re += w * Math.cos(d);
        im += w * Math.sin(d);
    }
    return Math.atan2(im, re);
}

/** Weighted mean |displacement| once `spin` is taken out. */
function residual(from, to, spin) {
    let sum = 0;
    let weight = 0;
    for (const id of Object.keys(to.pos)) {
        if (!(id in from.pos)) continue;
        const a = from.pos[id];
        const b = to.pos[id];
        const w = angleWeight(a, b);
        if (w === 0) continue;
        sum += w * Math.abs(wrap(b.theta + spin - a.theta));
        weight += w;
    }
    return weight === 0 ? 0 : sum / weight;
}

/** Two cyclic sequences are the same ring if one is a rotation of the other. */
function sameRing(a, b) {
    if (a.length !== b.length || a.length === 0) return a.length === b.length;
    const doubled = [...b, ...b].join('\u0000');
    return doubled.includes(a.join('\u0000'));
}

function ringChanges(from, to) {
    let changed = 0;
    let considered = 0;
    for (const id of Object.keys(to.rings)) {
        if (!(id in from.rings)) continue;
        if (to.rings[id].length < 3) continue;
        considered++;
        if (!sameRing(from.rings[id], to.rings[id])) changed++;
    }
    return { changed, considered };
}

async function boot(page, graph) {
    await page.route('**/api/**', (route) =>
        route.fulfill({ contentType: 'application/json', body: '{}' }));
    await page.route('**/graph/initial*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(graph) }));
    await page.route('**/graph/sponsored*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, node: null }) }));
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 20_000 }
    );
    // The initial load animates. Snapshotting a frame mid-flight compares the
    // first navigation against a layout that was still moving, which reads as a
    // spin the app never applied — it cost an hour and a wrong diagnosis once.
    await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 20_000 });
    await page.waitForTimeout(400);
}

async function select(page, id) {
    await page.evaluate((nodeId) => {
        const g = window.musicGraph;
        g.handleNodeClick(g.ht.graph.getNode(nodeId));
    }, id);
    await page.waitForFunction(
        (nodeId) => window.musicGraph.selectedNode?.id === nodeId && !window.musicGraph.ht.busy,
        id,
        { timeout: 20_000 }
    );
}

const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

console.log('Angular stability between consecutive selections.');
console.log('spin: rigid rotation of the whole scene. residual: what a rotation cannot fix.\n');

for (const scene of WALKS) {
    await boot(page, scene.graph);
    console.log(`── ${scene.name}`);
    console.log('   step                      spin   residual   home-res   homeward   rings changed   applied');

    let before = await snapshot(page);
    let previousFocus = null;

    for (const target of scene.walk) {
        // Where the target sits before we go there: walking along that edge
        // should leave the place we came from in the opposite direction.
        const departure = before.pos[target]?.theta;
        await select(page, target);
        const after = await snapshot(page);
        const applied = await page.evaluate(() => window.musicGraph._lastOrientationDelta);

        const spin = bestFitSpin(before, after);
        const res = residual(before, after, spin);
        const rings = ringChanges(before, after);

        let homeward = null;
        if (previousFocus && departure !== undefined && after.pos[previousFocus]) {
            homeward = Math.abs(wrap(after.pos[previousFocus].theta - (departure + Math.PI)));
        }

        // What each candidate anchor would cost in apparent motion. Best-fit
        // minimises it by construction; the homeward anchor buys a consistent
        // "back is behind you" at whatever that costs, and the question is how
        // much.
        let homewardResidual = null;
        if (previousFocus && departure !== undefined && after.pos[previousFocus]) {
            const delta = wrap((departure + Math.PI) - after.pos[previousFocus].theta);
            homewardResidual = residual(before, after, delta);
        }

        const label = previousFocus ? `${previousFocus} → ${target}` : `(start) → ${target}`;
        console.log(
            `   ${label.padEnd(24)}`
            + `${deg(Math.abs(spin)).toFixed(0).padStart(5)}°`
            + `${deg(res).toFixed(0).padStart(10)}°`
            + `${(homewardResidual === null ? '—' : `${deg(homewardResidual).toFixed(0)}°`).padStart(12)}`
            + `${(homeward === null ? '—' : `${deg(homeward).toFixed(0)}°`).padStart(11)}`
            + `${`${rings.changed}/${rings.considered}`.padStart(16)}`
            + `${(applied === undefined || applied === null ? '  —' : `${deg(applied).toFixed(0)}°`).padStart(10)}`
        );

        before = after;
        previousFocus = target;
    }
    console.log('');
}

await browser.close();
