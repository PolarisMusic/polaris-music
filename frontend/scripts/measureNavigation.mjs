/**
 * What this navigation costs and what it buys, in numbers.
 *
 * Centring is a Mobius translation of the Poincare disk. Two things follow,
 * and both are worth having on record because they are the two halves of a
 * trade that cannot be engineered away:
 *
 *   RIGIDITY  A Mobius transformation of the disk is an isometry, so every
 *             hyperbolic distance between every pair of nodes survives a
 *             navigation exactly. Nothing moves relative to anything else.
 *             This is what makes the view followable and it is the reason
 *             rebuilding the tree on the selection was tried and abandoned.
 *
 *   REACH     Radial position encodes depth in the layout *tree*, which was
 *             built once from some other root. A translation preserves that,
 *             so the nodes next to the one you are looking at are wherever
 *             their tree depth puts them, which for a graph that is not a tree
 *             is not near the middle. This is the price.
 *
 * Reported per scene: the worst relative change in any pairwise distance
 * (an isometry scores 0), and the radius of nodes by their graph-hop distance
 * from the focus (a well-formed neighbourhood would be monotonic).
 *
 * Usage, from frontend/ with `npx vite preview` serving dist:
 *   node scripts/measureNavigation.mjs
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

/** One band, no shared members: graph distance and tree distance agree here. */
function soloBand(members) {
    const nodes = [{ id: 'grp:0', name: 'Band 0', type: 'group' }];
    const edges = [];
    for (let m = 0; m < members; m++) {
        nodes.push({ id: `per:0_${m}`, name: `Member ${m}`, type: 'person' });
        edges.push({ source: `per:0_${m}`, target: 'grp:0', type: 'MEMBER_OF', role: 'player' });
    }
    return { nodes, edges };
}

const SCENES = [
    { name: 'one band, 6 members', graph: soloBand(6), walk: ['grp:0', 'per:0_2'] },
    { name: '4 bands x 4, one shared player', graph: sharedScene(4, 4), walk: ['grp:0', 'per:0_1', 'per:hub', 'grp:2'] },
    { name: '8 bands x 5, one shared player', graph: sharedScene(8, 5), walk: ['grp:0', 'per:0_2', 'per:hub', 'grp:5'] },
];

const positions = (page) => page.evaluate(() => {
    const out = {};
    window.musicGraph.ht.graph.eachNode((node) => {
        if ((node.data?.type || '').toLowerCase() === 'root') return;
        const c = node.pos.getc(true);
        out[node.id] = { x: c.x, y: c.y };
    });
    return out;
});

/** Euclidean radius by graph-hop distance from the focus. */
const radiiByHops = (page, focusId) => page.evaluate((id) => {
    const graph = window.musicGraph.ht.graph;
    const hops = new Map([[id, 0]]);
    let frontier = [id];
    while (frontier.length > 0) {
        const next = [];
        for (const current of frontier) {
            graph.getNode(current).eachAdjacency((adj) => {
                if ((adj.data?.type || '') === 'ROOT') return;
                const other = adj.nodeFrom.id === current ? adj.nodeTo.id : adj.nodeFrom.id;
                if (hops.has(other)) return;
                hops.set(other, hops.get(current) + 1);
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
        const p = node.pos.getc(true);
        (out[h] = out[h] || []).push(Math.hypot(p.x, p.y));
    });
    return out;
}, focusId);

function hyperbolicDistance(u, v) {
    const du = u.x * u.x + u.y * u.y;
    const dv = v.x * v.x + v.y * v.y;
    const dx = u.x - v.x;
    const dy = u.y - v.y;
    return Math.acosh(1 + (2 * (dx * dx + dy * dy)) / ((1 - du) * (1 - dv)));
}

const radius = (p) => Math.hypot(p.x, p.y);

/**
 * Worst relative change in any pairwise distance, at a few rim cutoffs.
 *
 * The distance formula divides by (1 - |u|^2), so a node on the rim sends it to
 * infinity and takes its precision with it. Reporting several cutoffs rather
 * than one shows where that starts to bite instead of hiding it behind a
 * threshold chosen to make the number look good.
 */
function distortion(before, after, cutoff) {
    const ids = Object.keys(after).filter((id) => id in before
        && radius(before[id]) < cutoff && radius(after[id]) < cutoff);
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

const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

async function boot(page, graph) {
    await page.route('**/api/**', (route) =>
        route.fulfill({ contentType: 'application/json', body: '{}' }));
    await page.route('**/graph/initial*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(graph) }));
    await page.route('**/graph/sponsored*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, node: null }) }));
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root), { timeout: 20_000 });
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
        id, { timeout: 20_000 });
    await page.waitForTimeout(150);
}

const CUTOFFS = [0.9, 0.99, 0.999, 0.99999];

const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

for (const scene of SCENES) {
    await boot(page, scene.graph);
    console.log(`\n── ${scene.name}`);

    console.log('   RIGIDITY — worst relative change in a pairwise distance (0 = isometry)');
    console.log('   step                 ' + CUTOFFS.map((c) => `<${c}`.padStart(16)).join(''));
    let before = await positions(page);
    let from = '(start)';
    for (const target of scene.walk) {
        await select(page, target);
        const after = await positions(page);
        const cells = CUTOFFS.map((c) => {
            const { worst, pairs } = distortion(before, after, c);
            return (pairs === 0 ? '— (0 pairs)' : `${worst.toExponential(1)} (${pairs})`).padStart(16);
        });
        console.log(`   ${`${from} → ${target}`.padEnd(21)}${cells.join('')}`);
        before = after;
        from = target;
    }

    const focus = scene.walk[scene.walk.length - 1];
    const byHops = await radiiByHops(page, focus);
    console.log(`   REACH — radius by graph hops from ${focus}`);
    for (const h of Object.keys(byHops).map(Number).sort((a, b) => a - b)) {
        console.log(`     ${h} hop${h === 1 ? ' ' : 's'}  n=${String(byHops[h].length).padStart(3)}`
            + `   median ${median(byHops[h]).toFixed(4)}   max ${Math.max(...byHops[h]).toFixed(4)}`);
    }
}

await browser.close();
