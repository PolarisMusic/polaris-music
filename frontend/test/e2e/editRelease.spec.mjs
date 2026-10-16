/**
 * Correcting a release that is already in the registry.
 *
 * Groups and people have had per-field edit buttons for a long time; releases
 * never did, which is the odd one out — a release is the thing with the most
 * to get wrong (a date, a format, a catalogue number, a country) and the only
 * one of the three a submitter files in bulk.
 *
 * Nothing new is needed underneath. EDIT_CLAIM already accepts `release` as a
 * node type and guards the identity and audit fields, so this is the
 * affordance arriving at a pipeline that was waiting for it.
 *
 * What a release cannot be edited this way is its tracklist, its performers
 * and its guests. Those are edges rather than properties, and an EDIT_CLAIM
 * sets one property on one node — it has nowhere to put an edge. Changing them
 * means resubmitting the bundle.
 */

import { test, expect } from '@playwright/test';

const GRAPH = {
    nodes: [
        { id: 'grp:band', name: 'Test Band', type: 'group' },
        { id: 'per:drums', name: 'Drummer', type: 'person' },
    ],
    edges: [
        { source: 'per:drums', target: 'grp:band', type: 'MEMBER_OF', role: 'drums' },
    ],
};

const RELEASE = {
    release_id: 'rel:ten',
    name: 'Ten',
    release_date: '1991-08-27',
    format: 'LP',
    country: 'US',
    catalog_number: 'ZK 47857',
    liner_notes: 'Recorded at London Bridge Studios.',
    tracks: [{ track_id: 'trk:1', track: 'Once', track_number: 1 }],
};

async function boot(page, { release = RELEASE } = {}) {
    await page.route('**/api/**', (route) => {
        const url = decodeURIComponent(route.request().url());
        if (url.includes('/stake/')) {
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, units: '0', formatted: '0.0000 MUS', stakerCount: 0 }),
            });
        }
        route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    // After the catch-all, not before it: Playwright gives the request to the
    // most recently registered matching route, so a general pattern added
    // later silently takes everything a specific one was meant to answer.
    await page.route('**/api/release/**', (route) =>
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: release }),
        }));
    await page.route('**/graph/initial*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(GRAPH) }));
    await page.route('**/graph/sponsored*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, node: null }) }));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 15_000 }
    );
    await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
}

/** Select a node, so there is a selection for a release panel to sit over. */
async function selectBand(page) {
    await page.evaluate(() => {
        const g = window.musicGraph;
        g.handleNodeClick(g.ht.graph.getNode('grp:band'));
    });
    await page.waitForFunction(
        () => window.musicGraph.selectedNode?.id === 'grp:band' && !window.musicGraph.ht.busy,
        { timeout: 15_000 }
    );
}

/** Put a release in the panel directly, for the tests that only read it. */
const showRelease = (page, release = RELEASE) => page.evaluate(
    (r) => window.musicGraph.infoPanel.showReleaseDetailsInInfoPanel(r), release);

/**
 * Open a release the way the app does: read it, then show what came back.
 *
 * The reading matters as much as the showing. fetchReleaseDetails caches for
 * minutes, so by the time anybody edits a release the old copy is already
 * held — which is exactly the condition under which a refresh can hand back
 * the value the correction was meant to replace. A test that skips the fetch
 * cannot see that, and an earlier version of this file did skip it and
 * reported a cache bug as fixed when nothing had been cached.
 */
const openRelease = (page, releaseId) => page.evaluate(async (id) => {
    const resp = await window.musicGraph.api.fetchReleaseDetails(id);
    window.musicGraph.infoPanel.showReleaseDetailsInInfoPanel(resp.data);
}, releaseId);

const editButton = (page, field) => page.locator(`.edit-btn[data-field="${field}"]`);

test.describe('a release offers its own fields for correction', () => {
    test('every property a release holds has a button', async ({ page }) => {
        await boot(page);
        await selectBand(page);
        await showRelease(page);

        for (const field of ['name', 'release_date', 'format', 'country',
            'catalog_number', 'album_art', 'liner_notes', 'trivia']) {
            await expect(editButton(page, field), field).toBeVisible();
        }
    });

    test('including the ones that are empty', async ({ page }) => {
        // Half of what a correction is for is a field nobody filled in. A row
        // that only appears once there is a value cannot be used to put the
        // first value there.
        await boot(page);
        await selectBand(page);
        await showRelease(page, { release_id: 'rel:bare', name: 'Bare' });

        await expect(editButton(page, 'release_date')).toBeVisible();
        await expect(editButton(page, 'catalog_number')).toBeVisible();
    });

    test('and none at all for a release with no id to claim against', async ({ page }) => {
        // A claim names the node it is about. Without an id there is nothing
        // to name, so the honest thing is to offer nothing.
        await boot(page);
        await selectBand(page);
        await showRelease(page, { name: 'Anonymous', release_date: '1970-01-01' });

        await expect(page.locator('.edit-btn')).toHaveCount(0);
    });

    test('the button opens an editor holding what is there now', async ({ page }) => {
        await boot(page);
        await selectBand(page);
        await showRelease(page);

        await editButton(page, 'release_date').click();

        const input = page.locator('.inline-edit-input');
        await expect(input).toBeVisible();
        await expect(input).toHaveValue('1991-08-27');
    });

    test('and cancelling puts the button back', async ({ page }) => {
        await boot(page);
        await selectBand(page);
        await showRelease(page);

        await editButton(page, 'format').click();
        await page.locator('.inline-edit-cancel').click();

        await expect(page.locator('.inline-edit-input')).toHaveCount(0);
        await expect(editButton(page, 'format')).toBeVisible();
    });
});

test.describe('a misspelled name', () => {
    test('is correctable on a person, which a resubmission could not manage', async ({ page }) => {
        // The fix people reach for first, and until now there was no way to
        // make it. An EDIT_CLAIM renames the node that is already there, so
        // every edge it sits on survives. A corrected bundle would instead
        // mint a second person — identity is a hash of the name — and leave
        // the misspelled one holding all the relationships.
        await boot(page);
        await page.evaluate(() => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode('per:drums'));
        });
        await page.waitForFunction(
            () => window.musicGraph.selectedNode?.id === 'per:drums' && !window.musicGraph.ht.busy,
            { timeout: 15_000 }
        );

        await expect(editButton(page, 'name')).toBeVisible();
    });

    test('and on a group', async ({ page }) => {
        await boot(page);
        await selectBand(page);

        await expect(editButton(page, 'name')).toBeVisible();
    });
});

test.describe('saving a correction', () => {
    /**
     * Stub the claim pipeline and the re-read.
     *
     * Submitting for real needs a wallet and a chain. What is under test is
     * what the panel does with the answer, so the answer is supplied: the edit
     * resolves, and the next read of the release returns the corrected value
     * the way the graph would once the claim had been processed.
     */
    async function stubPipeline(page, corrected) {
        await page.route('**/api/release/**', (route) =>
            route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, data: corrected }),
            }));
        await page.evaluate(() => {
            window.__edits = [];
            window.musicGraph.claimManager.submitEdit = async (...args) => {
                window.__edits.push(args);
                return { success: true };
            };
        });
    }

    test('sends the field, the value and the release it belongs to', async ({ page }) => {
        await boot(page);
        await selectBand(page);
        await openRelease(page, 'rel:ten');
        await stubPipeline(page, { ...RELEASE, format: 'CD' });

        await editButton(page, 'format').click();
        await page.locator('.inline-edit-input').fill('CD');
        await page.locator('.inline-edit-save').click();

        await expect.poll(() => page.evaluate(() => window.__edits.length)).toBe(1);
        expect(await page.evaluate(() => window.__edits[0]))
            .toEqual(['release', 'rel:ten', 'format', 'CD']);
    });

    test('leaves the reader looking at the release, not the band', async ({ page }) => {
        // The bug this exists for. A release panel is opened by the orbit
        // overlay while the selection stays on the group it orbits, so
        // refreshing "the selected node" after a release edit replaced the
        // album with the band — and the correction, which had saved perfectly
        // well, looked lost.
        await boot(page);
        await selectBand(page);
        await openRelease(page, 'rel:ten');
        await stubPipeline(page, { ...RELEASE, format: 'CD' });

        await editButton(page, 'format').click();
        await page.locator('.inline-edit-input').fill('CD');
        await page.locator('.inline-edit-save').click();

        await expect.poll(() => page.locator('#info-title').textContent()).toBe('Ten');
        await expect(page.locator('#info-content')).toContainText('CD');
    });

    test('shows what was stored, not what was typed', async ({ page }) => {
        // The claim pipeline normalises on the way through, so the panel is
        // re-read rather than patched. A release whose cached copy is handed
        // back instead would show the old value and read as a failed save.
        await boot(page);
        await selectBand(page);
        await openRelease(page, 'rel:ten');
        await stubPipeline(page, { ...RELEASE, format: 'Compact Disc' });

        await editButton(page, 'format').click();
        await page.locator('.inline-edit-input').fill('cd');
        await page.locator('.inline-edit-save').click();

        await expect(page.locator('#info-content')).toContainText('Compact Disc');
    });
});
