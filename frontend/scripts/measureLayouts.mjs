/**
 * Three ways to arrive at a node, measured on what each one costs the eye.
 *
 * REACH      radius by graph-hop distance from the selection. A view is useful
 *            when the nodes next to the one you are looking at are near it, and
 *            monotonic in hops. A plain translation is not: it leaves a band's
 *            own members at 0.937 and strangers two hops out at 0.809.
 *
 * ANGULAR    how far nodes swing *around* the disk. This is the cost. Radial
 *            motion is a node sliding along a ray, which reads as the
 *            neighbourhood opening up; angular motion is nodes going past each
 *            other, which is what makes a rebuild impossible to follow.
 *
 * CROSSINGS  how many nodes have the cyclic order of their neighbours changed.
 *            Zero means the map is the same map, redrawn at new distances.
 *
 * Compared: a plain Mobius translation, JIT's own re-root, and the
 * angle-preserving re-root in stableRadialLayout.js.
 *
 * Usage, from frontend/ with `npx vite preview` serving dist:
 *   node scripts/measureLayouts.mjs
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

function chain(bands, members) {
    const nodes = [];
    const edges = [];
    for (let g = 0; g < bands; g++) {
        nodes.push({ id: `grp:${g}`, name: `Band ${g}`, type: 'group' });
        for (let m = 0; m < members; m++) {
            nodes.push({ id: `per:${g}_${m}`, name: `Member ${g}-${m}`, type: 'person' });
            edges.push({ source: `per:${g}_${m}`, target: `grp:${g}`, type: 'MEMBER_OF', role: 'player' });
        }
        if (g > 0) edges.push({ source: `per:${g - 1}_0`, target: `grp:${g}`, type: 'MEMBER_OF', role: 'guest' });
    }
    return { nodes, edges };
}

const SCENES = [
    { name: '4 bands x 4, shared player', graph: sharedScene(4, 4),
      walk: ['grp:0', 'per:0_1', 'per:hub', 'grp:2', 'per:2_3'] },
    { name: '8 bands x 5, shared player', graph: sharedScene(8, 5),
      walk: ['grp:0', 'per:0_2', 'per:hub', 'grp:5', 'per:5_1'] },
    { name: 'chain of 5 bands x 4', graph: chain(5, 4),
      walk: ['grp:0', 'per:0_0', 'grp:1', 'per:1_0', 'grp:2'] },
];

async function boot(page, graph) {
    await page.route('**/api/**', (r) => r.fulfill({ contentType: 'application/json', body: '{}' }));
    await page.route('**/graph/initial*', (r) =>
        r.fulfill({ contentType: 'application/json', body: JSON.stringify(graph) }));
    await page.route('**/graph/sponsored*', (r) =>
        r.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, node: null }) }));
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root), { timeout: 20_000 });
    await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 20_000 });
    await page.waitForTimeout(350);
}

/**
 * Evaluate one step under each strategy, from the same starting layout.
 *
 * Everything runs inside the page and is undone afterwards, so the three are
 * measured against identical conditions rather than against each other's
 * leftovers.
 */
const compare = (page, targetId) => page.evaluate(async ({ id }) => {
    const { computeStablePositions } = await import('/src/visualization/stableRadialLayout.js');
    const ht = window.musicGraph.ht;
    const graph = ht.graph;
    const Graph = window.$jit.Graph;
    const real = (n) => (n.data?.type || '').toLowerCase() !== 'root';

    const snapshot = (which) => {
        const out = {};
        graph.eachNode((n) => {
            if (!real(n)) return;
            const p = which === 'pos' ? n.pos : n.endPos;
            const c = p.getc(true);
            out[n.id] = { x: c.x, y: c.y, rho: p.rho, theta: p.theta };
        });
        return out;
    };

    const before = snapshot('pos');
    const savedRoot = ht.root;
    const savedEnd = {};
    graph.eachNode((n) => { savedEnd[n.id] = [n.endPos.theta, n.endPos.rho]; });
    const restore = () => {
        ht.root = savedRoot;
        graph.eachNode((n) => n.endPos.setp(savedEnd[n.id][0], savedEnd[n.id][1]));
        graph.computeLevels(savedRoot, 0, 'ignore');
    };

    // 1. Mobius translation: what the current build does.
    const b = graph.getNode(id).pos.getc(true);
    const translated = {};
    for (const [nid, z] of Object.entries(before)) {
        const nx = z.x - b.x, ny = z.y - b.y;
        const dx = 1 - (b.x * z.x + b.y * z.y), dy = -(b.x * z.y - b.y * z.x);
        const den = dx * dx + dy * dy;
        const x = (nx * dx + ny * dy) / den, y = (ny * dx - nx * dy) / den;
        translated[nid] = { x, y, rho: Math.hypot(x, y), theta: Math.atan2(y, x) };
    }

    // 2. JIT's own re-root.
    ht.root = id;
    ht.compute('end');
    const naive = snapshot('end');
    restore();

    // 3. Angle-preserving re-root.
    ht.root = id;
    computeStablePositions(ht, Graph.Util);
    const stable = snapshot('end');
    restore();

    // Hops from the selection, for REACH.
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

    // Neighbour ring order, for CROSSINGS.
    const rings = (layout) => {
        const out = {};
        graph.eachNode((n) => {
            if (!real(n) || !(n.id in layout)) return;
            const here = layout[n.id];
            const around = [];
            n.eachAdjacency((adj) => {
                if ((adj.data?.type || '') === 'ROOT') return;
                const o = adj.nodeFrom.id === n.id ? adj.nodeTo : adj.nodeFrom;
                if (!(o.id in layout)) return;
                around.push({ id: o.id, a: Math.atan2(layout[o.id].y - here.y, layout[o.id].x - here.x) });
            });
            if (around.length >= 3) {
                around.sort((u, v) => u.a - v.a);
                out[n.id] = around.map((x) => x.id);
            }
        });
        return out;
    };

    return { before, translated, naive, stable, hops: Object.fromEntries(hops), rings: {
        before: rings(before), translated: rings(translated), naive: rings(naive), stable: rings(stable)
    } };
}, { id: targetId });

const wrap = (a) => { const t = a % (2 * Math.PI); return t > Math.PI ? t - 2 * Math.PI : (t < -Math.PI ? t + 2 * Math.PI : t); };
const deg = (r) => (r * 180) / Math.PI;
const median = (v) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : 0);

/** Angular swing, after removing any whole-scene rotation (which is free). */
function angularCost(before, after) {
    let re = 0, im = 0;
    const usable = Object.keys(after).filter((id) =>
        id in before && before[id].rho > 0.15 && after[id].rho > 0.15);
    for (const id of usable) {
        const d = before[id].theta - after[id].theta;
        re += Math.cos(d); im += Math.sin(d);
    }
    const spin = Math.atan2(im, re);
    const swings = usable.map((id) => Math.abs(wrap(after[id].theta + spin - before[id].theta)));
    return { median: median(swings), max: swings.length ? Math.max(...swings) : 0 };
}

function sameRing(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    return [...b, ...b].join('\u0000').includes(a.join('\u0000'));
}

function crossings(ringsBefore, ringsAfter) {
    let changed = 0, considered = 0;
    for (const id of Object.keys(ringsAfter)) {
        if (!(id in ringsBefore)) continue;
        considered++;
        if (!sameRing(ringsBefore[id], ringsAfter[id])) changed++;
    }
    return `${changed}/${considered}`;
}

function reach(layout, hops) {
    const byHop = {};
    for (const [id, h] of Object.entries(hops)) {
        if (!(id in layout)) continue;
        (byHop[h] = byHop[h] || []).push(layout[id].rho);
    }
    const keys = Object.keys(byHop).map(Number).sort((a, b) => a - b).filter((h) => h > 0);
    const meds = keys.map((h) => median(byHop[h]));
    const monotonic = meds.every((v, i) => i === 0 || v > meds[i - 1]);
    return { oneHop: meds[0] ?? NaN, monotonic };
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

for (const scene of SCENES) {
    await boot(page, scene.graph);
    console.log(`\n── ${scene.name}`);
    console.log('   step          strategy      1-hop   monotonic   angular med/max    crossings');

    for (const target of scene.walk) {
        const r = await compare(page, target);
        for (const [label, layout] of [
            ['translate', r.translated], ['re-root', r.naive], ['stable', r.stable]
        ]) {
            const a = angularCost(r.before, layout);
            const re = reach(layout, r.hops);
            const key = label === 'translate' ? 'translated' : (label === 're-root' ? 'naive' : 'stable');
            console.log(
                `   ${target.padEnd(12)}  ${label.padEnd(12)}`
                + `${re.oneHop.toFixed(3).padStart(7)}`
                + `${(re.monotonic ? 'yes' : 'NO').padStart(12)}`
                + `${`${deg(a.median).toFixed(0)}/${deg(a.max).toFixed(0)}`.padStart(17)}°`
                + `${crossings(r.rings.before, r.rings[key]).padStart(13)}`
            );
        }
        // Actually take the step, so the next one starts where a visitor would be.
        await page.evaluate((n) => window.musicGraph.handleNodeClick(window.musicGraph.ht.graph.getNode(n)), target);
        await page.waitForFunction((n) => window.musicGraph.selectedNode?.id === n && !window.musicGraph.ht.busy, target, { timeout: 20_000 });
        await page.waitForTimeout(150);
    }
}

await browser.close();
