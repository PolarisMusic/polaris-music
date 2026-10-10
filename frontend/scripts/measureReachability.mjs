/**
 * How far from the centre a focused node's own neighbours actually land.
 *
 * The complaint item 9 addresses is that focusing a node leaves its useful
 * context crushed against the rim of the disk. Two prior attempts at a cure
 * were abandoned on "looks worse", which is the right call made on no evidence.
 * This produces the evidence: for each focus node, the Euclidean radius of
 * every other node, grouped by how many graph hops away it is.
 *
 * The distinction that matters is graph hops versus tree depth. The Hypertree
 * lays out a BFS tree and re-centres with a Möbius transform, which is an
 * isometry — so a node's radius after centring is fixed by its *tree* distance
 * from the focus, not its graph distance. Two groups sharing one member are one
 * hop apart in the graph and two levels apart in the tree, and the hyperbolic
 * metric charges exponentially for the difference.
 *
 * Synthetic graphs, stated plainly: api.polaris.mu is not reachable from the
 * sandbox this runs in. The shapes below are modelled on the dense cases named
 * in the report — a band with many members, session players shared across many
 * bands — so the ratios should carry even if the absolute counts do not.
 *
 * Usage, from frontend/ with `npx vite preview` already serving dist:
 *   node scripts/measureReachability.mjs
 */

import { chromium } from '@playwright/test';

const BASE = process.env.MEASURE_URL || 'http://127.0.0.1:4173/';

/** A band with `members` members, none shared. */
function soloBand(members) {
    return {
        name: `one band, ${members} members`,
        focus: 'grp:0',
        nodes: [
            { id: 'grp:0', name: 'The Band', type: 'group' },
            ...Array.from({ length: members }, (_, i) => ({
                id: `per:${i}`, name: `Member ${i}`, type: 'person',
            })),
        ],
        edges: Array.from({ length: members }, (_, i) => ({
            source: `per:${i}`, target: 'grp:0', type: 'MEMBER_OF', role: 'player',
        })),
    };
}

/**
 * `groups` bands, each with `members` members, where every band also shares one
 * session player with every other. This is the RHCP/QOTSA shape: the thing that
 * makes the graph interesting is also what puts a band's peers several tree
 * levels away.
 */
function sharedScene(groups, members) {
    const nodes = [{ id: 'per:hub', name: 'Session Player', type: 'person' }];
    const edges = [];

    for (let g = 0; g < groups; g++) {
        nodes.push({ id: `grp:${g}`, name: `Band ${g}`, type: 'group' });
        edges.push({ source: 'per:hub', target: `grp:${g}`, type: 'MEMBER_OF', role: 'guest' });
        for (let m = 0; m < members; m++) {
            nodes.push({ id: `per:${g}_${m}`, name: `Member ${g}-${m}`, type: 'person' });
            edges.push({
                source: `per:${g}_${m}`, target: `grp:${g}`, type: 'MEMBER_OF', role: 'player',
            });
        }
    }

    return { name: `${groups} bands × ${members} members, one shared player`, focus: 'grp:0', nodes, edges };
}

/** A chain of bands linked by shared members, three deep. */
function chain(length, members) {
    const nodes = [];
    const edges = [];
    for (let g = 0; g < length; g++) {
        nodes.push({ id: `grp:${g}`, name: `Band ${g}`, type: 'group' });
        for (let m = 0; m < members; m++) {
            nodes.push({ id: `per:${g}_${m}`, name: `Member ${g}-${m}`, type: 'person' });
            edges.push({ source: `per:${g}_${m}`, target: `grp:${g}`, type: 'MEMBER_OF', role: 'player' });
        }
        if (g > 0) {
            // The last member of the previous band is also in this one.
            edges.push({
                source: `per:${g - 1}_${members - 1}`, target: `grp:${g}`,
                type: 'MEMBER_OF', role: 'player',
            });
        }
    }
    return { name: `chain of ${length} bands × ${members}`, focus: `grp:${Math.floor(length / 2)}`, nodes, edges };
}

const SCENES = [
    soloBand(6),
    soloBand(14),
    sharedScene(4, 4),
    sharedScene(8, 5),
    chain(5, 4),
];

const quantile = (sorted, q) => {
    if (sorted.length === 0) return NaN;
    const i = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
    return sorted[i];
};

async function measureScene(page, scene) {
    await page.route('**/api/**', (route) => {
        const url = decodeURIComponent(route.request().url());
        if (url.includes('/stake/')) {
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, units: '0', formatted: '0.0000 MUS', stakerCount: 0 }),
            });
        }
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) });
    });
    await page.route('**/graph/initial*', (route) =>
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ nodes: scene.nodes, edges: scene.edges }),
        }));
    await page.route('**/graph/sponsored*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, node: null }) }));

    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 20_000 }
    );

    // Focus the node, then wait for the recentring to finish.
    await page.evaluate((id) => {
        const g = window.musicGraph;
        g.handleNodeClick(g.ht.graph.getNode(id));
    }, scene.focus);
    await page.waitForFunction(
        (id) => window.musicGraph.selectedNode?.id === id && !window.musicGraph.ht.busy,
        scene.focus,
        { timeout: 20_000 }
    );

    // Variant: rebuild the layout tree with the focus as its root, which is
    // the hypothesis this measurement exists to test. Möbius re-centring is an
    // isometry and so preserves *tree* distance; if a node's graph neighbours
    // are several tree levels away, no amount of re-centring brings them in.
    if (process.env.REROOT === '1') {
        await page.evaluate((id) => {
            window.musicGraph.ht.root = id;
            window.musicGraph.ht.refresh();
        }, scene.focus);
        await page.waitForTimeout(300);
    }

    return page.evaluate((focusId) => {
        const graph = window.musicGraph.ht.graph;

        // Graph-hop distance from the focus, by BFS over real adjacencies.
        const hops = new Map([[focusId, 0]]);
        let frontier = [focusId];
        while (frontier.length > 0) {
            const next = [];
            for (const id of frontier) {
                const node = graph.getNode(id);
                node.eachAdjacency((adj) => {
                    if ((adj.data?.type || '') === 'ROOT') return;
                    const other = adj.nodeFrom.id === id ? adj.nodeTo.id : adj.nodeFrom.id;
                    if (hops.has(other)) return;
                    hops.set(other, hops.get(id) + 1);
                    next.push(other);
                });
            }
            frontier = next;
        }

        const rows = [];
        graph.eachNode((node) => {
            if ((node.data?.type || '').toLowerCase() === 'root') return;
            const p = node.pos.getc();
            rows.push({
                id: node.id,
                radius: Math.hypot(p.x, p.y),
                depth: node._depth,
                hops: hops.has(node.id) ? hops.get(node.id) : -1,
            });
        });

        return { rows, focusRadius: (() => {
            const p = graph.getNode(focusId).pos.getc();
            return Math.hypot(p.x, p.y);
        })() };
    }, scene.focus);
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH });

console.log('Euclidean radius in the Poincaré disk, by graph hops from the focused node.');
console.log('Synthetic graphs: the live API is not reachable from this sandbox.\n');

for (const scene of SCENES) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const { rows, focusRadius } = await measureScene(page, scene);
    await context.close();

    console.log(`── ${scene.name}  (focus ${scene.focus}, at radius ${focusRadius.toFixed(4)})`);
    console.log('   hops   n   median     p90      max   tree depths');

    const byHops = new Map();
    for (const row of rows) {
        if (!byHops.has(row.hops)) byHops.set(row.hops, []);
        byHops.get(row.hops).push(row);
    }

    for (const hops of [...byHops.keys()].sort((a, b) => a - b)) {
        const group = byHops.get(hops);
        const radii = group.map((r) => r.radius).sort((a, b) => a - b);
        const depths = [...new Set(group.map((r) => r.depth))].sort((a, b) => a - b);
        console.log(
            `   ${String(hops).padStart(4)} ${String(group.length).padStart(3)}` +
            `  ${quantile(radii, 0.5).toFixed(4)}  ${quantile(radii, 0.9).toFixed(4)}` +
            `  ${radii[radii.length - 1].toFixed(4)}   ${depths.join(',')}`
        );
    }
    console.log('');
}

await browser.close();
