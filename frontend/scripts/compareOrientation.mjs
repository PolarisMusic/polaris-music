/**
 * The shuffle, before and after, as frames rather than as an impression.
 *
 * Re-rooting the hypertree on the selection fixed each end state and spun the
 * whole scene on the way there — 21 to 135 degrees per click, measured with
 * scripts/measureOrientation.mjs. A single rotation is invisible in a still
 * photograph of either end state, which is why this renders the *same two
 * selections* with and without the correction and labels which is which.
 *
 * Shot A: a band selected. Shot B: one of its members, one click later. Compare
 * A to B within a row: the question is whether the scene you had learned in A
 * is still recognisable in B.
 *
 * Usage, from frontend/ with `npx vite preview` serving dist:
 *   node scripts/compareOrientation.mjs
 */

import { chromium } from '@playwright/test';
import { mkdirSync } from 'fs';

const BASE = process.env.MEASURE_URL || 'http://127.0.0.1:4173/';
const OUT = process.env.OUT_DIR || 'orientation-shots';

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

const SCENE = sharedScene(5, 4);
const WALK = ['grp:0', 'per:0_1'];

async function boot(page) {
    await page.route('**/api/**', (route) =>
        route.fulfill({ contentType: 'application/json', body: '{}' }));
    await page.route('**/graph/initial*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(SCENE) }));
    await page.route('**/graph/sponsored*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, node: null }) }));
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 20_000 }
    );
    await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 20_000 });
    await page.waitForTimeout(400);
}

/**
 * `oriented: false` reproduces the previous behaviour by stubbing out the
 * correction, so both rows come from one build and differ in exactly one thing.
 */
async function shoot(page, oriented) {
    await boot(page);
    if (!oriented) {
        await page.evaluate(() => { window.musicGraph._orientEndPositions = () => {}; });
    }

    const suffix = oriented ? 'after' : 'before';
    for (let i = 0; i < WALK.length; i++) {
        const id = WALK[i];
        await page.evaluate((nodeId) => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode(nodeId));
        }, id);
        await page.waitForFunction(
            (nodeId) => window.musicGraph.selectedNode?.id === nodeId && !window.musicGraph.ht.busy,
            id,
            { timeout: 20_000 }
        );
        await page.waitForTimeout(400);

        const path = `${OUT}/step${i + 1}-${id.replace(':', '-')}-${suffix}.png`;
        await page.screenshot({ path });
        console.log(path);
    }
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await shoot(page, false);
await shoot(page, true);
await browser.close();
