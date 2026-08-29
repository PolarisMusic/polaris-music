/**
 * Playwright e2e — the release submission form.
 *
 * The form had no behavioural tests at all, which is how a schema mismatch
 * survived in it: extractTracks() emitted `track.song_id`, the canonical Track
 * definition did not allow it, and `additionalProperties: false` meant that
 * binding an existing Song — the whole point of the autocomplete — made the
 * submission fail validation.
 *
 * The central claim being protected here is that collapsing a track is
 * PRESENTATION ONLY. Content inside a closed <details> stays in the DOM,
 * still submits, and is still found by the extractors. If that ever stops
 * being true, tracks silently lose data on submit, and nothing else in the
 * suite would notice.
 *
 * The backend is stubbed: these exercise the form, not the API.
 */

import { test, expect } from '@playwright/test';

/** Search results the entity lookups will see. */
const GROUP_RESULT = {
    id: 'grp:qotsa',
    type: 'Group',
    display_name: 'Queens of the Stone Age',
    subtitle: 'Formed 1996',
    image: null,
    score: 10,
};

async function gotoForm(page, { searchResults = [] } = {}) {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

    // Catch-all first: Playwright uses the LAST matching route, so a catch-all
    // registered afterwards would shadow the specific stubs below.
    await page.route('**/api/**', (route) =>
        route.fulfill({ contentType: 'application/json', body: '{}' }));
    await page.route('**/search/nodes*', (route) =>
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ success: true, results: searchResults }),
        }));

    await page.goto('/submit', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.polarisApp?.buildReleaseData === 'function',
        { timeout: 10_000 })
        .catch(() => {
            throw new Error(
                'PolarisApp never became reachable on window.polarisApp.\nPage errors:\n' +
                (pageErrors.length ? pageErrors.map(e => `  ${e}`).join('\n') : '  (none captured)')
            );
        });

    return pageErrors;
}

/**
 * Add a track and expand it, the way a user does.
 *
 * Playwright will not fill a control inside a closed <details> — it is not
 * visible — so every spec that types into a track has to open it first. That
 * refusal is itself confirmation the collapse is real.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} index
 */
async function addOpenTrack(page, index = 0) {
    await page.click('#add-track');
    await page.locator('.track-item').nth(index).locator('.track-header').click();
    await expect(page.locator('.track-body').nth(index)).toHaveAttribute('open', '');
}

/**
 * Type into an entity field and pick the first suggestion.
 *
 * Waits for the lookup to be attached first. FormLookupManager binds new rows
 * from a MutationObserver on a 50ms debounce, and fill() dispatches exactly one
 * input event — type into a row that is still unbound and that single event is
 * lost, leaving a dropdown that never opens. Static fields in submit.html are
 * bound by the initial scan and do not show this.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} selector - The visible input.
 * @param {string} text
 */
async function pickSuggestion(page, selector, text) {
    const input = page.locator(selector);
    await expect(input.locator('xpath=ancestor::*[contains(@class,"entity-lookup-wrapper")]'))
        .toBeAttached();
    await input.fill(text);
    await page.locator('.entity-lookup-dropdown .entity-lookup-item').first().click();
}

/** Fill the minimum needed for buildReleaseData() to produce a bundle. */
async function fillMinimalRelease(page) {
    await page.fill('[name="release_name"]', 'Songs For The Deaf');
    await addOpenTrack(page, 0);
    await page.fill('[name="track-title-0"]', 'No One Knows');
}

test.describe('release submission form', () => {
    test('tracks start collapsed', async ({ page }) => {
        await gotoForm(page);
        await page.click('#add-track');

        // Collapsed by default is the entire point of the restructure: a
        // fourteen-track release was an unreadable wall.
        await expect(page.locator('.track-item .track-body')).not.toHaveAttribute('open', '');
    });

    test('a collapsed track still submits every field — the core claim', async ({ page }) => {
        await gotoForm(page);
        await fillMinimalRelease(page);
        await page.fill('[name="track-lyrics-0"]', 'We get some rules to follow');
        await page.fill('[name="track-trivia-0"]', 'Grohl on drums');

        // Read the bundle open, then closed. Identical, or the <details> is
        // eating data.
        const whileOpen = await page.evaluate(() => window.polarisApp.buildReleaseData());

        await page.evaluate(() => {
            document.querySelector('.track-body').open = false;
        });
        const whileClosed = await page.evaluate(() => window.polarisApp.buildReleaseData());

        expect(whileClosed).toEqual(whileOpen);
        expect(whileClosed.tracks[0].lyrics).toBe('We get some rules to follow');
        expect(whileClosed.tracks[0].trivia).toBe('Grohl on drums');
    });

    test('an invalid field inside a collapsed track opens it', async ({ page }) => {
        await gotoForm(page);
        await page.fill('[name="release_name"]', 'Untitled');
        await page.click('#add-track');
        // Leave the required track title empty and submit.

        await expect(page.locator('.track-body')).not.toHaveAttribute('open', '');
        await page.click('button[type="submit"]');

        // Without this, Chrome refuses to submit with "An invalid form control
        // is not focusable" and shows the user nothing at all.
        await expect(page.locator('.track-body')).toHaveAttribute('open', '');
    });
});

test.describe('same as release', () => {
    test('inheriting a group carries its bound node id onto the track', async ({ page }) => {
        await gotoForm(page, { searchResults: [GROUP_RESULT] });

        await page.fill('[name="release_name"]', 'Songs For The Deaf');

        // Bind a real registry group at the release level.
        await page.click('#add-release-group');
        await pickSuggestion(page, '[name="release-group-name-0"]', 'Queens of the Stone');
        await expect(page.locator('[name="release-group-id-0"]')).toHaveValue('grp:qotsa');

        await addOpenTrack(page, 0);
        await page.fill('[name="track-title-0"]', 'No One Knows');

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        const trackGroups = bundle.tracks[0].performed_by_groups;

        // The bug this replaces: addReleaseGroupToAllTracks() copied the name
        // string only, so every track pointed at a NEW provisional group rather
        // than the one the submitter had just picked out of the registry.
        expect(trackGroups).toHaveLength(1);
        expect(trackGroups[0].group_id).toBe('grp:qotsa');
    });

    test('unchecking it stops the track inheriting', async ({ page }) => {
        await gotoForm(page, { searchResults: [GROUP_RESULT] });

        await page.fill('[name="release_name"]', 'Songs For The Deaf');
        await page.click('#add-release-group');
        await page.fill('[name="release-group-name-0"]', 'Queens of the Stone Age');

        await addOpenTrack(page, 0);
        await page.fill('[name="track-title-0"]', 'No One Knows');
        await page.uncheck('[name="track-same-groups-0"]');

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        // The track now speaks for itself, and has no groups of its own yet.
        expect(bundle.tracks[0].performed_by_groups).toBeUndefined();
    });

    test('release songwriters reach the song through inheritance', async ({ page }) => {
        await gotoForm(page);

        await page.fill('[name="release_name"]', 'Songs For The Deaf');
        await page.click('#add-release-songwriter');
        await page.fill('[name="release-songwriter-name-0-0"]', 'Josh Homme');

        await addOpenTrack(page, 0);
        await page.fill('[name="track-title-0"]', 'No One Knows');

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        // Songwriters are canonically Song.writers, so a release-level default
        // has to land there rather than on the release.
        expect(bundle.songs?.[0]?.writers?.[0]?.name).toBe('Josh Homme');
    });
});

test.describe('listen links', () => {
    test('a link is stored stripped of share and locale cruft', async ({ page }) => {
        await gotoForm(page);
        await fillMinimalRelease(page);
        await page.fill('[name="track-listen-link-0"]',
            'https://open.spotify.com/intl-de/track/0Fl6Pl6w89IL1FWt8Uvg01?si=abc123');

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        expect(bundle.tracks[0].listen_links)
            .toEqual(['https://open.spotify.com/track/0Fl6Pl6w89IL1FWt8Uvg01']);
    });

    test('importing from tracks flags a link pointing at another album', async ({ page }) => {
        await gotoForm(page);
        await page.fill('[name="release_name"]', 'Songs For The Deaf');

        // Two tracks agreeing on one album, one dissenting — the shape of a
        // Discogs import that picked up a link from a different edition.
        for (const [i, album] of [['0', 'ALBUMAAA'], ['1', 'ALBUMAAA'], ['2', 'ALBUMBBB']]) {
            await addOpenTrack(page, Number(i));
            await page.fill(`[name="track-title-${i}"]`, `Track ${Number(i) + 1}`);
            await page.fill(`[name="track-listen-link-${i}"]`,
                `https://open.spotify.com/album/${album}`);
        }

        await page.click('#import-track-links');

        await expect(page.locator('.link-mismatch')).toHaveCount(1);
        await expect(page.locator('.link-mismatch')).toContainText('different album');
        // The dissenting link is reported, not silently merged in.
        await expect(page.locator('#release-listen-links')).toHaveValue(
            'https://open.spotify.com/album/ALBUMAAA');
    });
});

test.describe('navigating away', () => {
    test('an untouched form does not ask for confirmation', async ({ page }) => {
        await gotoForm(page);

        let asked = false;
        page.on('dialog', async (d) => { asked = true; await d.dismiss(); });

        await page.click('.tab[data-tab="browse"]');
        await page.waitForTimeout(300);

        // Landing on the page and leaving again warned about losing changes
        // that were never made.
        expect(asked).toBe(false);
    });

    test('one keystroke is enough to make it ask', async ({ page }) => {
        await gotoForm(page);
        await page.fill('[name="release_name"]', 'S');

        let asked = false;
        page.on('dialog', async (d) => { asked = true; await d.dismiss(); });

        await page.click('.tab[data-tab="browse"]');
        await page.waitForTimeout(300);

        expect(asked).toBe(true);
    });
});

test('the master release field searches the registry', async ({ page }) => {
    await gotoForm(page, {
        searchResults: [{
            id: 'rel:sftd', type: 'Release',
            display_name: 'Songs For The Deaf', subtitle: '2002', score: 9,
        }],
    });

    // The master field only appears for a reissue.
    await page.uncheck('#is-master');
    await pickSuggestion(page, '#master-release-name', 'Songs For');

    // It was a bare text input asking for a hash, which nobody can supply.
    await expect(page.locator('#master-release-id')).toHaveValue('rel:sftd');
});
