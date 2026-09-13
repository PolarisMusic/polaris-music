/**
 * The collapsed info sheet on a phone.
 *
 * Selecting a node used to open the full sheet, which on a phone is most of
 * what is left of the screen after a square canvas. The first tap on a node
 * therefore ended browsing: you got one node's details and a graph you could
 * no longer see. Collapsed, the sheet shows the node's name and a control that
 * opens the rest, and the graph gives up a single row.
 *
 * The load-bearing assertions here are the geometric ones. A class-only test
 * would pass on a build where the collapsed sheet still covered the graph,
 * which is the entire failure being fixed.
 */

import { test, expect } from '@playwright/test';

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

/** Minimal {nodes, edges} in the shape graphApi.transformToJIT() consumes. */
const GRAPH = {
    nodes: [
        { id: 'grp:band', name: 'Test Band', type: 'group' },
        { id: 'per:drums', name: 'A Drummer With An Extremely Long Name That Will Not Fit On One Phone Row', type: 'person' },
    ],
    edges: [
        { source: 'grp:band', target: 'per:drums', type: 'MEMBER_OF', role: 'drums' },
    ],
};

/**
 * Detail payloads by node id.
 *
 * Two things about the shape matter. fetchNodeDetails() GETs
 * `/{type}/{id}` (graphApi.js:164) and hands the body back; the caller then
 * takes `response.data || response` (MusicGraph.js:1185) and passes it
 * straight to renderPersonDetails(person, ...) — so the body *is* the person,
 * not a wrapper around one.
 *
 * And it has to carry a name. Selecting a node writes the graph's name into
 * the title, then the detail fetch lands and overwrites it;
 * InfoPanelRenderer.js:304 falls back to 'Unknown Person' when the payload has
 * no name, so a bare `{}` leaves the sheet — and the collapsed row that
 * mirrors it — reading "Unknown Person". That is the panel behaving correctly
 * on an empty response, not the row failing to track it.
 */
const DETAILS = {
    'per:drums': { person_id: 'per:drums', name: 'A Drummer With An Extremely Long Name That Will Not Fit On One Phone Row' },
    'grp:band': { group_id: 'grp:band', name: 'Test Band' },
};

/**
 * Boot with graph data stubbed in, so a node can actually be selected.
 *
 * One handler inspects the URL rather than a glob per id: the ids contain a
 * colon and reach the network percent-encoded, which a path glob does not
 * reliably match.
 */
async function bootedGraph(page) {
    await page.route('**/api/**', (route) => {
        const url = decodeURIComponent(route.request().url());
        const match = Object.keys(DETAILS).find((id) => url.endsWith(`/${id}`));
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(match ? DETAILS[match] : {}),
        });
    });
    await page.route('**/graph/initial*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(GRAPH) }));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 15_000 }
    );
}

/**
 * Select a node the way a tap does, then wait for the sheet to actually be in
 * one of its shown states.
 *
 * handleNodeClick() centres the node first and only runs updateInfoPanel() in
 * the animation's onComplete — 700ms later, with no promise to await, as
 * navigation.spec.mjs documents. A flat 500ms wait therefore measured a sheet
 * that had not been touched yet: the first version of this helper read
 * "Select a node" off an unclassed panel and the geometry assertions all
 * collected zeros. Waiting on the state rather than the clock also survives a
 * slower machine.
 */
async function selectNode(page, id) {
    await page.evaluate((nodeId) => {
        const graph = window.musicGraph;
        graph.handleNodeClick(graph.ht.graph.getNode(nodeId));
    }, id);

    // Wait for the name the detail fetch produces, not for a duration. The
    // title is written twice — the graph's name when the panel opens, then
    // whatever the fetch returns — so waiting on the final value covers the
    // animation, the fetch and the re-render in one condition, and works the
    // same for the second selection as for the first.
    const expected = DETAILS[id].name;
    await page.waitForFunction(
        (name) => {
            const sheet = document.getElementById('info-viewer');
            const shown = sheet.classList.contains('peek') || sheet.classList.contains('open');
            return shown && document.getElementById('info-peek-title').textContent === name;
        },
        expected,
        { timeout: 10_000 }
    );

    // The sheet's own 0.28s transition, so a one-shot geometry read is stable.
    await page.waitForTimeout(350);
}

const vizHeight = (page) => page.evaluate(() =>
    document.getElementById('viz-container').getBoundingClientRect().height);

/** Wait out the sheet's 0.28s peek -> open transition. */
async function expandSettled(page) {
    await page.waitForFunction(
        () => document.getElementById('info-viewer').classList.contains('open'),
        { timeout: 5_000 }
    );
    await page.waitForTimeout(400);
}

test.describe('the collapsed sheet on a phone', () => {
    test.use({ viewport: PHONE });

    test('selecting a node collapses the sheet rather than opening it', async ({ page }) => {
        await bootedGraph(page);
        await selectNode(page, 'per:drums');

        const sheet = page.locator('#info-viewer');
        await expect(sheet).toHaveClass(/\bpeek\b/);
        await expect(sheet).not.toHaveClass(/\bopen\b/);
    });

    test('the collapsed row names the selected node', async ({ page }) => {
        await bootedGraph(page);
        await selectNode(page, 'per:drums');

        await expect(page.locator('#info-peek')).toBeVisible();
        await expect(page.locator('#info-peek-title'))
            .toHaveText('A Drummer With An Extremely Long Name That Will Not Fit On One Phone Row');
    });

    test('the graph keeps nearly all its height while collapsed', async ({ page }) => {
        // The claim the feature exists for, in pixels. The full sheet takes
        // whatever is left after a square canvas; the collapsed row takes 44px.
        await bootedGraph(page);
        const before = await vizHeight(page);

        await selectNode(page, 'per:drums');
        const collapsed = await vizHeight(page);

        await page.locator('#info-peek').click();
        await expandSettled(page);
        const expanded = await vizHeight(page);

        expect(before - collapsed).toBeLessThanOrEqual(44);
        expect(expanded).toBeLessThan(collapsed);
    });

    test('the collapsed sheet does not cover the graph', async ({ page }) => {
        // Meeting, not overlapping: the row is laid out below the canvas, not
        // floated over its last 44px.
        await bootedGraph(page);
        await selectNode(page, 'per:drums');

        const { vizBottom, sheetTop } = await page.evaluate(() => ({
            vizBottom: document.getElementById('viz-container').getBoundingClientRect().bottom,
            sheetTop: document.getElementById('info-viewer').getBoundingClientRect().top,
        }));

        expect(sheetTop).toBeGreaterThanOrEqual(vizBottom - 1);
    });

    test('tapping the row opens the full sheet', async ({ page }) => {
        await bootedGraph(page);
        await selectNode(page, 'per:drums');

        await page.locator('#info-peek').click();
        await expandSettled(page);

        const sheet = page.locator('#info-viewer');
        await expect(sheet).toHaveClass(/\bopen\b/);
        await expect(sheet).not.toHaveClass(/\bpeek\b/);
        await expect(page.locator('#info-peek')).toBeHidden();
    });

    test('closing an expanded sheet returns to the row, not to nothing', async ({ page }) => {
        // The node is still selected and still centred, so dropping its name
        // entirely would leave the sheet disagreeing with the graph.
        await bootedGraph(page);
        await selectNode(page, 'per:drums');
        await page.locator('#info-peek').click();
        await expandSettled(page);

        await page.locator('#info-close').click();
        await page.waitForTimeout(400);

        const sheet = page.locator('#info-viewer');
        await expect(sheet).toHaveClass(/\bpeek\b/);
        await expect(sheet).not.toHaveClass(/\bopen\b/);
        await expect(page.locator('#info-peek')).toBeVisible();
    });

    test('the row survives selecting a second node, and renames', async ({ page }) => {
        await bootedGraph(page);
        await selectNode(page, 'per:drums');
        await selectNode(page, 'grp:band');

        await expect(page.locator('#info-viewer')).toHaveClass(/\bpeek\b/);
        await expect(page.locator('#info-peek-title')).toHaveText('Test Band');
    });

    test('a long name is clipped rather than wrapping the row taller', async ({ page }) => {
        await bootedGraph(page);
        await selectNode(page, 'per:drums');

        const { rowHeight, scrollW, clientW } = await page.evaluate(() => {
            const row = document.getElementById('info-peek');
            const title = document.getElementById('info-peek-title');
            return {
                rowHeight: row.getBoundingClientRect().height,
                scrollW: title.scrollWidth,
                clientW: title.clientWidth,
            };
        });

        expect(rowHeight).toBeLessThanOrEqual(45);

        // The name has to genuinely overrun the row, or the ellipsis is never
        // exercised and the height assertion above passes on any short name.
        // Measured: the title box is 312px on a 390px phone.
        expect(scrollW).toBeGreaterThan(clientW);
    });
});

test.describe('the desktop panel is unaffected', () => {
    test.use({ viewport: DESKTOP });

    test('selecting a node opens the panel outright, with no collapsed row', async ({ page }) => {
        // There is nothing to collapse beside a permanent column: it takes no
        // height from the graph, so a peek state would only hide detail for
        // no gain.
        await bootedGraph(page);
        await selectNode(page, 'per:drums');

        const sheet = page.locator('#info-viewer');
        await expect(sheet).toHaveClass(/\bopen\b/);
        await expect(sheet).not.toHaveClass(/\bpeek\b/);
        await expect(page.locator('#info-peek')).toBeHidden();
    });

    test('dismissing closes outright rather than collapsing', async ({ page }) => {
        // Driven through collapseInfoPanel() rather than the ✕, because the ✕
        // does not exist here: visualization.css:1553 hides the sheet's chrome
        // on desktop, where the panel is a fixed column. Clicking it waits 30s
        // for an element that is display:none — which is how the first version
        // of this test failed.
        await bootedGraph(page);
        await selectNode(page, 'per:drums');

        await page.evaluate(() => window.musicGraph.collapseInfoPanel());

        const sheet = page.locator('#info-viewer');
        await expect(sheet).not.toHaveClass(/\bopen\b/);
        await expect(sheet).not.toHaveClass(/\bpeek\b/);
    });
});
