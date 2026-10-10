/**
 * Before and after, side by side, for the re-rooting change.
 *
 * The two previous attempts at this problem were abandoned on "looks worse",
 * which is the right call made on an impression. This renders the same scene
 * and the same focus node under the old navigation and the new one and writes
 * both to disk, so the look is a comparison rather than a memory.
 *
 * Usage, from frontend/ with `npx vite preview` serving dist:
 *   node scripts/compareReachability.mjs
 */

import { chromium } from '@playwright/test';
import { mkdirSync } from 'fs';

const BASE = process.env.MEASURE_URL || 'http://127.0.0.1:4173/';
const OUT = process.env.OUT_DIR || 'reachability-shots';

/** Bands sharing one session player — the shape that exposed the problem. */
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

const SCENES = [
    { name: 'four-bands', graph: sharedScene(4, 4), focus: 'grp:0' },
    { name: 'eight-bands', graph: sharedScene(8, 5), focus: 'grp:0' },
];

async function shoot(page, scene, mode) {
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
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(scene.graph) }));
    await page.route('**/graph/sponsored*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, node: null }) }));

    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 20_000 }
    );

    if (mode === 'before') {
        // The old navigation: Möbius glide only, no re-rooting. Reproduced here
        // rather than kept behind a flag in the app, so the shipped code has one
        // path and this script carries the comparison.
        await page.evaluate((id) => {
            const g = window.musicGraph;
            const node = g.ht.graph.getNode(id);
            node.setData('isSelected', true);
            g.selectedNode = node;
            g.ht.onClick(id);
        }, scene.focus);
    } else {
        await page.evaluate((id) => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode(id));
        }, scene.focus);
    }

    await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 20_000 });
    await page.waitForTimeout(400);

    const path = `${OUT}/${scene.name}-${mode}.png`;
    await page.locator('#infovis').screenshot({ path });
    return path;
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH });

for (const scene of SCENES) {
    for (const mode of ['before', 'after']) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        console.log(await shoot(page, scene, mode));
        await context.close();
    }
}

await browser.close();
