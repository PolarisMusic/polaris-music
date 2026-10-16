/**
 * Correcting a member to a guest, or a guest to a member.
 *
 * The one correction the per-field editors cannot make. An EDIT_CLAIM sets a
 * property, and membership is not a property of anybody — it is an edge, and
 * an edge has two ends. So this is a button rather than an input box, and it
 * submits EDIT_RELATIONSHIP (type 33) instead.
 *
 * The button is offered in three places because the mistake is visible in
 * three places: on a group, in its member list; on a person, in their list of
 * groups; and on a release, in its guest list. All three carry both ids, which
 * is the whole requirement — a row with no person_id or no group_id names
 * nobody the claim could be filed about, and offers nothing.
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

const GROUP = {
    group_id: 'grp:band',
    name: 'Test Band',
    members: [
        { person: 'Drummer', person_id: 'per:drums', role: 'drums' },
        { person: 'Unnamed Session Player', person_id: null, role: 'tambourine' },
    ],
};

const PERSON = {
    person_id: 'per:drums',
    name: 'Drummer',
    groups: [{ group: 'Test Band', group_id: 'grp:band', role: 'drums' }],
};

const RELEASE = {
    release_id: 'rel:ten',
    name: 'Ten',
    groups: [{ group_id: 'grp:band', name: 'Test Band' }],
    guests: [
        { person_id: 'per:organ', name: 'Organist', roles: ['organ'] },
        { person_id: null, name: 'Uncredited', roles: [] },
    ],
    tracks: [{ track_id: 'trk:1', track: 'Once', track_number: 1 }],
};

async function boot(page, { group = GROUP, person = PERSON, release = RELEASE } = {}) {
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
    // Registered after the catch-all on purpose: Playwright hands a request to
    // the most recently registered matching route, so a general pattern added
    // later silently swallows what a specific one was meant to answer.
    await page.route('**/api/group/**', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: group }) }));
    await page.route('**/api/person/**', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: person }) }));
    await page.route('**/api/release/**', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: release }) }));
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

async function select(page, nodeId) {
    await page.evaluate((id) => {
        const g = window.musicGraph;
        g.handleNodeClick(g.ht.graph.getNode(id));
    }, nodeId);
    await page.waitForFunction(
        (id) => window.musicGraph.selectedNode?.id === id && !window.musicGraph.ht.busy,
        nodeId, { timeout: 15_000 }
    );
}

/** Open a release the way the app does: read it, then show what came back. */
const openRelease = (page, releaseId) => page.evaluate(async (id) => {
    const resp = await window.musicGraph.api.fetchReleaseDetails(id);
    window.musicGraph.infoPanel.showReleaseDetailsInInfoPanel(resp.data);
}, releaseId);

/** Record what the correction pipeline is handed, without a chain. */
const stubPipeline = (page) => page.evaluate(() => {
    window.__corrections = [];
    window.musicGraph.claimManager.submitRelationshipEdit = async (args) => {
        window.__corrections.push(args);
        return { success: true };
    };
});

const relButtons = (page) => page.locator('.rel-btn');

test.describe('a member who was really a guest', () => {
    test('the group lists a correction against each member it can name', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');

        // One button, not two: the second member has no person_id, so there is
        // nothing to file a claim about.
        await expect(relButtons(page)).toHaveCount(1);
        await expect(relButtons(page)).toHaveText('Guest, not member');
        await expect(relButtons(page)).toHaveAttribute('data-person-id', 'per:drums');
        await expect(relButtons(page)).toHaveAttribute('data-group-id', 'grp:band');
    });

    test('the same correction is offered from the person', async ({ page }) => {
        await boot(page);
        await select(page, 'per:drums');

        await expect(relButtons(page)).toHaveCount(1);
        await expect(relButtons(page)).toHaveAttribute('data-person-id', 'per:drums');
        await expect(relButtons(page)).toHaveAttribute('data-group-id', 'grp:band');
        await expect(relButtons(page)).toHaveAttribute('data-rel-to', 'GUEST_ON');
    });

    test('clicking it submits both ends and the direction', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');
        await stubPipeline(page);

        await relButtons(page).click();

        await expect.poll(() => page.evaluate(() => window.__corrections.length)).toBe(1);
        expect(await page.evaluate(() => window.__corrections[0])).toEqual({
            personId: 'per:drums',
            groupId: 'grp:band',
            to: 'GUEST_ON',
            releaseId: null,
        });
    });

    test('a group with no members offers nothing', async ({ page }) => {
        await boot(page, { group: { group_id: 'grp:band', name: 'Test Band', members: [] } });
        await select(page, 'grp:band');

        await expect(relButtons(page)).toHaveCount(0);
    });
});

test.describe('a guest who was really a member', () => {
    test('the release lists a correction against each guest it can name', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');
        await openRelease(page, 'rel:ten');

        await expect(relButtons(page)).toHaveCount(1);
        await expect(relButtons(page)).toHaveText('Member, not guest');
        await expect(relButtons(page)).toHaveAttribute('data-person-id', 'per:organ');
        await expect(relButtons(page)).toHaveAttribute('data-rel-to', 'MEMBER_OF');
    });

    test('it carries the release, which narrows what gets swept', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');
        await openRelease(page, 'rel:ten');
        await stubPipeline(page);

        await relButtons(page).click();

        await expect.poll(() => page.evaluate(() => window.__corrections.length)).toBe(1);
        expect(await page.evaluate(() => window.__corrections[0])).toEqual({
            personId: 'per:organ',
            groupId: 'grp:band',
            to: 'MEMBER_OF',
            releaseId: 'rel:ten',
        });
    });

    test('two performing groups means one button each, named', async ({ page }) => {
        // A split or a collaboration. Only the submitter knows which band the
        // person was in, so the panel does not guess.
        await boot(page, {
            release: {
                ...RELEASE,
                groups: [
                    { group_id: 'grp:band', name: 'Test Band' },
                    { group_id: 'grp:other', name: 'Other Band' },
                ],
            },
        });
        await select(page, 'grp:band');
        await openRelease(page, 'rel:ten');

        await expect(relButtons(page)).toHaveCount(2);
        await expect(relButtons(page).nth(0)).toHaveText('Member of Test Band');
        await expect(relButtons(page).nth(1)).toHaveText('Member of Other Band');
    });

    test('a release whose performer is unknown offers nothing', async ({ page }) => {
        await boot(page, { release: { ...RELEASE, groups: [] } });
        await select(page, 'grp:band');
        await openRelease(page, 'rel:ten');

        await expect(relButtons(page)).toHaveCount(0);
    });
});

test.describe('what the reader sees afterwards', () => {
    test('the release is re-read, so the promoted guest leaves the list', async ({ page }) => {
        // The cache is the point. fetchReleaseDetails holds for five minutes,
        // so by the time anyone corrects a release the stale copy is already
        // in hand — and a refresh that hands it back shows the guest still
        // listed, which reads as the correction having failed.
        await boot(page);
        await select(page, 'grp:band');
        await openRelease(page, 'rel:ten');
        await stubPipeline(page);

        await page.route('**/api/release/**', (route) =>
            route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, data: { ...RELEASE, guests: [] } }),
            }));

        await relButtons(page).click();

        await expect.poll(() => page.locator('#info-content').textContent())
            .not.toContain('Organist');
        await expect(page.locator('#info-title')).toHaveText('Ten');
    });

    test('the group is re-read, so the demoted member leaves the list', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');
        await stubPipeline(page);

        await page.route('**/api/group/**', (route) =>
            route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, data: { ...GROUP, members: [] } }),
            }));

        await relButtons(page).click();

        await expect.poll(() => page.locator('#info-content').textContent())
            .not.toContain('Drummer');
    });

    test('the button is not also a field editor', async ({ page }) => {
        // It was, briefly. The button borrowed `.edit-btn` for its styling, and
        // InlineEditor attaches a click handler to every `.edit-btn` in the
        // panel — so one click submitted the correction and replaced the button
        // with a text input bound to no field, which on save would have filed an
        // EDIT_CLAIM against `undefined`.
        await boot(page);
        await select(page, 'grp:band');
        await stubPipeline(page);

        await relButtons(page).click();

        await expect(page.locator('.inline-edit-input')).toHaveCount(0);
    });

    test('a failure is reported rather than swallowed', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');
        await page.evaluate(() => {
            window.musicGraph.claimManager.submitRelationshipEdit = async () => {
                throw new Error('Wallet not connected');
            };
        });

        const dialog = new Promise((resolve) => page.once('dialog', async (d) => {
            const message = d.message();
            await d.dismiss();
            resolve(message);
        }));

        await relButtons(page).click();

        expect(await dialog).toContain('Wallet not connected');
        // And the button is usable again, since the panel was never replaced.
        await expect(relButtons(page)).toBeEnabled();
    });
});
