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

async function gotoForm(page,
    { searchResults = [], spotifyAlbum = null, crossServiceLinks = null } = {}) {
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
    await page.route('**/links/resolve', (route) =>
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(crossServiceLinks
                ?? { success: false, reason: 'not_configured', services: [] }),
        }));
    await page.route('**/spotify/album', (route) =>
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(spotifyAlbum
                ?? { success: false, reason: 'not_configured', message: 'Not configured.' }),
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
    // Wait for the lookup to have claimed the title input before touching it.
    // EntityLookupField._build() RE-PARENTS the input into a wrapper div, and
    // FormLookupManager only does that from a MutationObserver on a 50ms
    // debounce. A fill that is in flight when the node moves is silently lost —
    // Playwright inserts text into whatever is focused, and re-parenting blurs
    // it. That is the whole cause of the flakiness here, and it is an app
    // behaviour, not a test artefact.
    await expect(
        page.locator(`[name="track-title-${index}"]`)
            .locator('xpath=ancestor::*[contains(@class,"entity-lookup-wrapper")]')
    ).toBeAttached();
    // Set `open` rather than clicking the summary. A click TOGGLES, so it is
    // only correct if the disclosure is currently closed — and the form's
    // `invalid` handler opens tracks on its own, which made this helper
    // intermittently close the track it was meant to open. Two specs went
    // flaky that way. The summary's own click behaviour is covered
    // separately by 'the summary toggles the track' below.
    await page.locator('.track-body').nth(index).evaluate((el) => { el.open = true; });
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

/**
 * Add a track and fill it, asserting the values actually landed.
 *
 * The listen-link specs went flaky because they filled a track and then
 * immediately clicked the button that reads it back. FormLookupManager attaches
 * an EntityLookupField to the title input from a MutationObserver on a 50ms
 * debounce, which re-parents the input; under full-suite load a fill could race
 * that and the extractor would skip the track as untitled. Asserting the value
 * makes the precondition explicit and lets Playwright retry it, rather than
 * silently testing a two-track release when three were intended.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} index
 * @param {{title: string, link?: string}} fields
 */
async function fillTrack(page, index, { title, link }) {
    await addOpenTrack(page, index);

    await page.fill(`[name="track-title-${index}"]`, title);
    await expect(page.locator(`[name="track-title-${index}"]`)).toHaveValue(title);

    if (link) {
        await page.fill(`[name="track-listen-link-${index}"]`, link);
        await expect(page.locator(`[name="track-listen-link-${index}"]`)).toHaveValue(link);
    }
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

    test('the summary toggles the track', async ({ page }) => {
        await gotoForm(page);
        await page.click('#add-track');

        const body = page.locator('.track-body').first();
        await expect(body).not.toHaveAttribute('open', '');

        await page.locator('.track-item').first().locator('.track-header').click();
        await expect(body).toHaveAttribute('open', '');

        await page.locator('.track-item').first().locator('.track-header').click();
        await expect(body).not.toHaveAttribute('open', '');
    });

    test('removing a track does not toggle the disclosure', async ({ page }) => {
        await gotoForm(page);
        await page.click('#add-track');
        page.once('dialog', (d) => d.accept());

        // The Remove button lives inside the <summary>, so without
        // stopPropagation the click would also open the track it just deleted.
        await page.locator('.remove-track').first().click();
        await expect(page.locator('.track-item')).toHaveCount(0);
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

test.describe('the collapsed header', () => {
    test('shows the position and title once a track is filled in', async ({ page }) => {
        await gotoForm(page);
        await addOpenTrack(page, 0);
        await page.fill('[name="track-position-0"]', 'A1');
        await page.fill('[name="track-title-0"]', 'Smells Like Teen Spirit');

        await expect(page.locator('.track-summary-title'))
            .toHaveText('A1. Smells Like Teen Spirit');
    });

    test('updates when a value is set programmatically, as the import does', async ({ page }) => {
        await gotoForm(page);
        await page.click('#add-track');

        // The Discogs import assigns .value, which fires no input event. Binding
        // the summary to `input` alone left every imported track reading
        // "Track 7" until the user typed in the field.
        await page.evaluate(() => {
            const app = window.polarisApp;
            const item = document.querySelector('.track-item');
            app.setFieldValue(item.querySelector('[name="track-position-0"]'), 'B3');
            app.setFieldValue(item.querySelector('[name="track-title-0"]'), 'Lounge Act');
        });

        await expect(page.locator('.track-summary-title')).toHaveText('B3. Lounge Act');
    });

    test('setFieldValue does not open an autocomplete dropdown', async ({ page }) => {
        await gotoForm(page, { searchResults: [GROUP_RESULT] });
        await page.click('#add-release-group');

        await page.evaluate(() => {
            const input = document.querySelector('[name="release-group-name-0"]');
            window.polarisApp.setFieldValue(input, 'Queens of the Stone Age');
        });
        await page.waitForTimeout(400);

        // It dispatches `change`, not `input`, precisely so an import does not
        // pop a suggestion list open on every field it touches.
        await expect(page.locator('.entity-lookup-dropdown .entity-lookup-item')).toHaveCount(0);
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

    test('the check reports a track Spotify does not have', async ({ page }) => {
        await gotoForm(page, {
            spotifyAlbum: {
                success: true,
                album: {
                    id: 'alb1', name: 'Nevermind', total_tracks: 2,
                    tracks: [
                        { name: 'Smells Like Teen Spirit', track_number: 1 },
                        { name: 'In Bloom', track_number: 2 },
                    ],
                },
            },
        });
        await page.fill('[name="release_name"]', 'Nevermind');

        // Three tracks here, two on Spotify — the shape of a Discogs import
        // carrying a hidden track the streaming release omits.
        for (const [i, title] of [[0, 'Smells Like Teen Spirit'], [1, 'In Bloom'],
                                  [2, 'Endless, Nameless']]) {
            await fillTrack(page, i, {
                title, link: `https://open.spotify.com/track/T${i}`,
            });
        }

        await page.click('#import-track-links');

        await expect(page.locator('.link-mismatch').first()).toBeVisible();
        const text = await page.locator('#listen-link-report').innerText();
        expect(text).toContain('Endless, Nameless');
        expect(text).toMatch(/3.*2|2.*3/);          // the count difference
    });

    test('a matching tracklist says so rather than staying blank', async ({ page }) => {
        await gotoForm(page, {
            spotifyAlbum: {
                success: true,
                album: {
                    id: 'alb1', name: 'Nevermind', total_tracks: 1,
                    // A remaster suffix must not read as a difference, or the
                    // report cries wolf on almost every album.
                    tracks: [{ name: 'In Bloom - Remastered 2011', track_number: 1 }],
                },
            },
        });
        await page.fill('[name="release_name"]', 'Nevermind');
        await fillTrack(page, 0, {
            title: 'In Bloom', link: 'https://open.spotify.com/track/T0',
        });

        await page.click('#import-track-links');

        // "Nothing to report" and "the check did not run" must not look alike.
        await expect(page.locator('.link-check-ok')).toHaveText('The tracklist matches.');
    });

    test('links are still imported when the check is unconfigured', async ({ page }) => {
        await gotoForm(page, {
            spotifyAlbum: { success: false, reason: 'not_configured',
                message: 'Spotify lookup is not configured on this server.' },
        });
        await page.fill('[name="release_name"]', 'Nevermind');
        await fillTrack(page, 0, {
            title: 'In Bloom',
            link: 'https://open.spotify.com/intl-de/track/T0?si=abc',
        });

        await page.click('#import-track-links');

        // Pulling the links up is useful on its own, so it must not depend on
        // an optional integration being switched on.
        await expect(page.locator('#release-listen-links'))
            .toHaveValue('https://open.spotify.com/track/T0');
        await expect(page.locator('#listen-link-report')).toContainText('not configured');
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

test.describe('filling track links from the release album link', () => {
    /**
     * The Listen Links block only ever read upward — it gathered links from
     * individual tracks into the release field, so an album link alone produced
     * "No track links to import" and never reached the API. Entering a Spotify
     * URL per track by hand is exactly the work worth removing.
     *
     * The backend already resolved an album link and returned its full
     * tracklist; only the form declined to send it.
     */
    const ALBUM = {
        success: true,
        album: {
            id: '2OMdsA2I4RxrHCyogwKGvF',
            name: 'Songs For The Deaf',
            total_tracks: 3,
            tracks: [
                { id: 'trk1', name: 'You Think I Ain\'t Worth a Dollar', track_number: 1 },
                { id: 'trk2', name: 'No One Knows - Remastered', track_number: 2 },
                { id: 'trk3', name: 'A Song Only Spotify Has', track_number: 3 },
            ],
        },
    };

    /** Fill a track's title, which is what matching keys on. */
    async function addTitledTrack(page, index, title) {
        await addOpenTrack(page, index);
        await page.fill(`[name="track-title-${index}"]`, title);
    }

    test('an album link alone fills every matching track', async ({ page }) => {
        await gotoForm(page, { spotifyAlbum: ALBUM });

        await addTitledTrack(page, 0, 'You Think I Ain\'t Worth a Dollar');
        await addTitledTrack(page, 1, 'No One Knows');
        await page.fill('#release-listen-links',
            'https://open.spotify.com/album/2OMdsA2I4RxrHCyogwKGvF');

        await page.click('#import-track-links');

        // Matched despite the "- Remastered" suffix, which is why matching runs
        // through normalizeTitle rather than comparing strings.
        await expect(page.locator('[name="track-listen-link-0"]'))
            .toHaveValue('https://open.spotify.com/track/trk1');
        await expect(page.locator('[name="track-listen-link-1"]'))
            .toHaveValue('https://open.spotify.com/track/trk2');
    });

    test('a link typed by hand is never overwritten', async ({ page }) => {
        // The submitter's own entry is the more considered one — it may point at
        // a particular pressing, or another service entirely.
        await gotoForm(page, { spotifyAlbum: ALBUM });

        await addTitledTrack(page, 0, 'You Think I Ain\'t Worth a Dollar');
        await page.fill('[name="track-listen-link-0"]', 'https://tidal.com/track/999');
        await page.fill('#release-listen-links',
            'https://open.spotify.com/album/2OMdsA2I4RxrHCyogwKGvF');

        await page.click('#import-track-links');

        await expect(page.locator('[name="track-listen-link-0"]'))
            .toHaveValue('https://tidal.com/track/999');
    });

    test('a track Spotify does not have is left blank and reported', async ({ page }) => {
        await gotoForm(page, { spotifyAlbum: ALBUM });

        await addTitledTrack(page, 0, 'You Think I Ain\'t Worth a Dollar');
        await addTitledTrack(page, 1, 'A Vinyl-Only Bonus');
        await page.fill('#release-listen-links',
            'https://open.spotify.com/album/2OMdsA2I4RxrHCyogwKGvF');

        await page.click('#import-track-links');

        await expect(page.locator('[name="track-listen-link-1"]')).toHaveValue('');
        await expect(page.locator('#listen-link-report')).toContainText('no confident match');
    });

    test('with neither an album nor a track link it says so', async ({ page }) => {
        await gotoForm(page, { spotifyAlbum: ALBUM });

        await addTitledTrack(page, 0, 'You Think I Ain\'t Worth a Dollar');
        await page.click('#import-track-links');

        await expect(page.locator('#listen-link-report')).toContainText('No links to work from');
    });
});

test.describe('codes and other spellings, from the same check', () => {
    /**
     * The Spotify check resolves two things that have no visible field on the
     * form: the ISRC, which is the recording's own identifier and the key other
     * services can be asked about it with, and Spotify's spelling of the title
     * when it differs from the pressing's. Both used to be discarded — the ISRC
     * was never read off the album response at all, and a title that did not
     * match exactly lost its link too.
     *
     * Driven through the real form because the failure mode is invisible to
     * unit tests: FormBuilder writes `track-isrc-${index}`, PolarisApp reads it
     * back by the same string, and nothing checks that those two agree.
     */
    const ALBUM = {
        success: true,
        album: {
            id: '1Fv2tUhCRhY3YE1Iqp1oBo',
            name: 'Fire of Unknown Origin',
            total_tracks: 2,
            tracks: [
                {
                    id: 'trk1', name: 'Burnin\u2019 For You', track_number: 1,
                    isrc: 'USSM17900123',
                },
                {
                    // One character from the form's "Veteran Of The Psychic
                    // Wars" — the disagreement this is all about.
                    id: 'trk2', name: 'Veteran Of The Psychic War', track_number: 2,
                    isrc: 'USSM17900124',
                },
            ],
        },
    };

    async function importWith(page, titles, crossServiceLinks = null) {
        await gotoForm(page, { spotifyAlbum: ALBUM, crossServiceLinks });

        for (const [index, title] of titles.entries()) {
            await addOpenTrack(page, index);
            await page.fill(`[name="track-title-${index}"]`, title);
            await expect(page.locator(`[name="track-title-${index}"]`)).toHaveValue(title);
        }

        await page.fill('#release-listen-links',
            'https://open.spotify.com/album/1Fv2tUhCRhY3YE1Iqp1oBo');
        await page.click('#import-track-links');

        // The click returns before the check does. Every test below reads form
        // state the fill leaves behind — a bundle read does not retry, so
        // without this the assertions race the fetch and a test expecting a
        // field to be ABSENT would pass whether the code works or not.
        await expect(page.locator('#listen-link-report'))
            .toContainText('Compared against Spotify');
    }

    test('the ISRC reaches the bundle', async ({ page }) => {
        await importWith(page, ['Burnin\u2019 For You']);

        await expect(page.locator('[name="track-isrc-0"]')).toHaveValue('USSM17900123');

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        expect(bundle.tracks[0].isrc).toBe('USSM17900123');
    });

    test('a near-identical title still gets its link', async ({ page }) => {
        // Previously this row came back empty: exact-match-or-nothing threw
        // away the link and the other spelling together.
        await importWith(page, ['Veteran Of The Psychic Wars']);

        await expect(page.locator('[name="track-listen-link-0"]'))
            .toHaveValue('https://open.spotify.com/track/trk2');
    });

    test('and the other spelling is kept as an alternate title', async ({ page }) => {
        await importWith(page, ['Veteran Of The Psychic Wars']);

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        expect(bundle.tracks[0].alt_titles).toEqual(['Veteran Of The Psychic War']);
    });

    test('an exact match records no alternate title', async ({ page }) => {
        // Edition noise is not a spelling. If every "- Remastered" match wrote
        // an alternate title, the registry would fill with catalogue cruft.
        await importWith(page, ['Burnin\u2019 For You']);

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        expect(bundle.tracks[0]).not.toHaveProperty('alt_titles');
    });

    test('the report says what it attached', async ({ page }) => {
        // Neither value has a field on screen, so this is the only place a
        // submitter can see that anything was added on their behalf.
        await importWith(page, ['Burnin\u2019 For You', 'Veteran Of The Psychic Wars']);

        const report = page.locator('#listen-link-report');
        await expect(report).toContainText('2 ISRC(s)');
        await expect(report).toContainText('1 alternate title(s)');
    });

    test('the ISRC is attached even to a track whose link was typed', async ({ page }) => {
        await gotoForm(page, { spotifyAlbum: ALBUM });

        await addOpenTrack(page, 0);
        await page.fill('[name="track-title-0"]', 'Burnin\u2019 For You');
        await page.fill('[name="track-listen-link-0"]', 'https://tidal.com/track/999');
        await page.fill('#release-listen-links',
            'https://open.spotify.com/album/1Fv2tUhCRhY3YE1Iqp1oBo');

        await page.click('#import-track-links');
        await expect(page.locator('#listen-link-report'))
            .toContainText('Compared against Spotify');

        // The hand-typed link stands — it may be a different pressing — but the
        // ISRC names the recording either way.
        await expect(page.locator('[name="track-listen-link-0"]'))
            .toHaveValue('https://tidal.com/track/999');
        await expect(page.locator('[name="track-isrc-0"]')).toHaveValue('USSM17900123');
    });

    test('the ISRC is what other services get looked up by', async ({ page }) => {
        // The reason the ISRC is collected at all: a Spotify URL is one
        // service's address for a recording, and a visitor who does not use
        // Spotify gets a dead end.
        const sent = [];
        await gotoForm(page, {
            spotifyAlbum: ALBUM,
            crossServiceLinks: {
                success: true,
                services: ['deezer'],
                links: { USSM17900123: { deezer: 'https://www.deezer.com/track/3135556' } },
            },
        });
        page.on('request', (req) => {
            if (req.url().includes('/links/resolve')) sent.push(JSON.parse(req.postData() ?? '{}'));
        });

        await addOpenTrack(page, 0);
        await page.fill('[name="track-title-0"]', 'Burnin\u2019 For You');
        await expect(page.locator('[name="track-title-0"]')).toHaveValue('Burnin\u2019 For You');
        await page.fill('#release-listen-links',
            'https://open.spotify.com/album/1Fv2tUhCRhY3YE1Iqp1oBo');
        await page.click('#import-track-links');

        // The Deezer link lands beside the Spotify one rather than replacing it.
        await expect(page.locator('[name="track-listen-link-0"]')).toHaveValue(
            'https://open.spotify.com/track/trk1, https://www.deezer.com/track/3135556');
        // Both identifiers per row, because the providers disagree about which
        // they take — a catalogue by code, Odesli by link — plus the release
        // itself, since one more request returns the album on every service.
        //
        // The release goes first: a rate-limited provider resolves what fits a
        // time budget and leaves the rest, so the batch is ordered by value and
        // the album on nine services is the most useful single answer.
        expect(sent).toEqual([{
            tracks: [
                { id: 'release', url: 'https://open.spotify.com/album/1Fv2tUhCRhY3YE1Iqp1oBo' },
                { id: 'USSM17900123', isrc: 'USSM17900123',
                    url: 'https://open.spotify.com/track/trk1' },
            ],
        }]);
    });

    test('a track with no ISRC is not asked about', async ({ page }) => {
        // Nothing to ask by: the row did not match Spotify, so no ISRC was
        // written. Sending an empty string would spend a request on it.
        const sent = [];
        await gotoForm(page, {
            spotifyAlbum: ALBUM,
            crossServiceLinks: {
                success: true,
                services: ['deezer'],
                links: { USSM17900123: { deezer: 'https://www.deezer.com/track/3135556' } },
            },
        });
        page.on('request', (req) => {
            if (req.url().includes('/links/resolve')) sent.push(JSON.parse(req.postData() ?? '{}'));
        });

        for (const [index, title] of [[0, 'Burnin\u2019 For You'],
                                      [1, 'A Vinyl-Only Bonus']]) {
            await addOpenTrack(page, index);
            await page.fill(`[name="track-title-${index}"]`, title);
            await expect(page.locator(`[name="track-title-${index}"]`)).toHaveValue(title);
        }
        await page.fill('#release-listen-links',
            'https://open.spotify.com/album/1Fv2tUhCRhY3YE1Iqp1oBo');
        await page.click('#import-track-links');
        // Wait for the resolution itself, not the report: the report is
        // rendered before the lookup runs, so asserting on it would race.
        await expect(page.locator('[name="track-listen-link-0"]'))
            .toHaveValue(/deezer\.com/);

        await expect(page.locator('#listen-link-report')).toContainText('no confident match');
        // The unmatched row has neither identifier — no ISRC was written and no
        // Spotify link was filled — so it is dropped rather than asked about.
        expect(sent).toEqual([{
            tracks: [
                { id: 'release', url: 'https://open.spotify.com/album/1Fv2tUhCRhY3YE1Iqp1oBo' },
                { id: 'USSM17900123', isrc: 'USSM17900123',
                    url: 'https://open.spotify.com/track/trk1' },
            ],
        }]);
        await expect(page.locator('[name="track-listen-link-1"]')).toHaveValue('');
    });

    test('each row gets its own recording\u2019s link', async ({ page }) => {
        // Keyed by ISRC, not by position: the answer comes back as a map and
        // reading the first entry for every row would put one recording's link
        // on another's — silently, and on a release where both are plausible.
        await importWith(page, ['Burnin\u2019 For You', 'Veteran Of The Psychic Wars'], {
            success: true,
            services: ['deezer'],
            links: {
                USSM17900123: { deezer: 'https://www.deezer.com/track/111' },
                USSM17900124: { deezer: 'https://www.deezer.com/track/222' },
            },
        });

        await expect(page.locator('[name="track-listen-link-0"]'))
            .toHaveValue(/track\/111$/);
        await expect(page.locator('[name="track-listen-link-1"]'))
            .toHaveValue(/track\/222$/);
    });

    test('every service Odesli answers for lands on the track', async ({ page }) => {
        // The point of the key: one request returns the lot, where the
        // per-service clients needed a credential and a rate limit each.
        await importWith(page, ['Burnin\u2019 For You'], {
            success: true,
            services: ['apple', 'deezer', 'tidal', 'youtubeMusic'],
            links: {
                USSM17900123: {
                    apple: 'https://music.apple.com/us/album/x/1443000516?i=1443000890',
                    deezer: 'https://www.deezer.com/track/3135556',
                    tidal: 'https://tidal.com/browse/track/99',
                    youtubeMusic: 'https://music.youtube.com/watch?v=abc',
                },
            },
        });

        // The report's "Added" line is appended after the resolution, so it is
        // the barrier: inputValue() reads once and would otherwise race it.
        await expect(page.locator('#listen-link-report')).toContainText('Added ');

        const value = await page.locator('[name="track-listen-link-0"]').inputValue();
        for (const fragment of ['open.spotify.com/track/trk1', 'music.apple.com',
            'deezer.com/track/3135556', 'tidal.com/browse/track/99',
            'music.youtube.com/watch?v=abc']) {
            expect(value).toContain(fragment);
        }
    });

    test('an Apple link is stored canonically, not as it arrived', async ({ page }) => {
        // Otherwise a second import appends a near-duplicate: the slug changes
        // when a title is edited, and the identity must not move with it.
        await importWith(page, ['Burnin\u2019 For You'], {
            success: true,
            services: ['apple'],
            links: {
                USSM17900123: {
                    apple: 'https://music.apple.com/us/album/fire-of-unknown-origin/1443000516?i=1443000890&uo=4',
                },
            },
        });

        await expect(page.locator('[name="track-listen-link-0"]')).toHaveValue(
            'https://open.spotify.com/track/trk1, '
            + 'https://music.apple.com/us/album/1443000516?i=1443000890');
        // The tracking parameter and the slug are both gone.
        await expect(page.locator('[name="track-listen-link-0"]')).not.toHaveValue(/uo=4/);
    });

    test('the release gets the album on every service too', async ({ page }) => {
        // One more request, and it is what the player reads for its embed —
        // nothing else would ever put an Apple album link there.
        await importWith(page, ['Burnin\u2019 For You'], {
            success: true,
            services: ['apple'],
            links: { release: { apple: 'https://music.apple.com/us/album/1443000516' } },
        });

        await expect(page.locator('#release-listen-links'))
            .toHaveValue(/music\.apple\.com\/us\/album\/1443000516/);
        await expect(page.locator('#release-listen-links'))
            .toHaveValue(/open\.spotify\.com\/album\/1Fv2tUhCRhY3YE1Iqp1oBo/);
    });

    test('the resolved links reach the bundle that gets anchored', async ({ page }) => {
        // The form field is not the deliverable: listen_links on the Track is
        // what gets hashed and anchored, and extractTracks canonicalizes on the
        // way in — so what the registry stores is the identity, not whatever
        // query string the link arrived with.
        await importWith(page, ['Burnin\u2019 For You'], {
            success: true,
            services: ['apple', 'tidal'],
            links: {
                USSM17900123: {
                    apple: 'https://music.apple.com/us/album/fire/1443000516?i=1443000890&uo=4',
                    tidal: 'https://listen.tidal.com/track/99',
                },
                release: { apple: 'https://music.apple.com/us/album/1443000516' },
            },
        });
        await expect(page.locator('#listen-link-report')).toContainText('Added ');

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());

        expect(bundle.tracks[0].listen_links).toEqual([
            'https://open.spotify.com/track/trk1',
            'https://music.apple.com/us/album/1443000516?i=1443000890',
            'https://tidal.com/browse/track/99',
        ]);
        expect(bundle.release.listen_links).toContain(
            'https://music.apple.com/us/album/1443000516');
    });

    test('the report names the services, not the provider', async ({ page }) => {
        // "odesli" is not a place anybody listens to music.
        await importWith(page, ['Burnin\u2019 For You'], {
            success: true,
            services: ['apple', 'tidal'],
            providers: ['odesli'],
            links: {
                USSM17900123: {
                    apple: 'https://music.apple.com/us/album/x/1?i=2',
                    tidal: 'https://tidal.com/browse/track/99',
                },
            },
        });

        const report = page.locator('#listen-link-report');
        await expect(report).toContainText('Added 2 link(s) on apple, tidal');
        await expect(report).not.toContainText('odesli');
    });

    test('the report names the service and the count', async ({ page }) => {
        await importWith(page, ['Burnin\u2019 For You'], {
            success: true,
            services: ['deezer'],
            links: { USSM17900123: { deezer: 'https://www.deezer.com/track/3135556' } },
        });

        await expect(page.locator('#listen-link-report'))
            .toContainText('Added 1 link(s) on deezer');
    });

    test('a recording another service does not have keeps what it had', async ({ page }) => {
        // A B-side from 1981 is frequently absent from a streaming catalogue
        // entirely, which is ordinary, not a failure.
        await importWith(page, ['Burnin\u2019 For You'], {
            success: true, services: ['deezer'], links: {},
        });

        await expect(page.locator('[name="track-listen-link-0"]'))
            .toHaveValue('https://open.spotify.com/track/trk1');
        await expect(page.locator('#listen-link-report')).not.toContainText('Added ');
    });

    test('a link the field already holds is not added twice', async ({ page }) => {
        // Deduplication is on normalized identity, so a locale-prefixed link
        // with a share token matches its plain twin.
        await gotoForm(page, {
            spotifyAlbum: ALBUM,
            crossServiceLinks: {
                success: true,
                services: ['deezer'],
                links: { USSM17900123: { deezer: 'https://www.deezer.com/track/3135556' } },
            },
        });

        await addOpenTrack(page, 0);
        await page.fill('[name="track-title-0"]', 'Burnin\u2019 For You');
        await page.fill('[name="track-listen-link-0"]',
            'https://www.deezer.com/en/track/3135556?utm_source=share');
        await page.fill('#release-listen-links',
            'https://open.spotify.com/album/1Fv2tUhCRhY3YE1Iqp1oBo');
        await page.click('#import-track-links');
        await expect(page.locator('#listen-link-report'))
            .toContainText('Compared against Spotify');

        // Nothing added, and nothing rewritten either: what a submitter typed
        // stays as they typed it, and extractTracks canonicalizes on the way
        // into the bundle — so the registry gets one link, not two spellings.
        await expect(page.locator('[name="track-listen-link-0"]'))
            .toHaveValue('https://www.deezer.com/en/track/3135556?utm_source=share');

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        expect(bundle.tracks[0].listen_links).toEqual(['https://www.deezer.com/track/3135556']);
    });

    test('no providers configured adds nothing and says nothing', async ({ page }) => {
        await importWith(page, ['Burnin\u2019 For You'], {
            success: false, reason: 'not_configured', services: [],
        });

        await expect(page.locator('[name="track-listen-link-0"]'))
            .toHaveValue('https://open.spotify.com/track/trk1');
        await expect(page.locator('#listen-link-report')).not.toContainText('Added ');
    });

    test('editing the title afterwards drops both', async ({ page }) => {
        // They were resolved for the title that was in the box. An ISRC
        // pointing at the wrong recording is worse than none: it is the key
        // everything else gets matched by.
        await importWith(page, ['Veteran Of The Psychic Wars']);
        await expect(page.locator('[name="track-isrc-0"]')).toHaveValue('USSM17900124');

        await page.fill('[name="track-title-0"]', 'Something Else Entirely');

        await expect(page.locator('[name="track-isrc-0"]')).toHaveValue('');
        await expect(page.locator('[name="track-alt-title-0"]')).toHaveValue('');

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        expect(bundle.tracks[0]).not.toHaveProperty('isrc');
        expect(bundle.tracks[0]).not.toHaveProperty('alt_titles');
    });

    test('a row that already has another service is not asked about again', async ({ page }) => {
        // The key grants two requests a minute, so the batch resolves what fits
        // a budget and leaves the rest. Re-asking about a row whose answer is
        // already in the form spends that budget on nothing — and is why a
        // second press used to make no progress past the release.
        const sent = [];
        await gotoForm(page, {
            spotifyAlbum: ALBUM,
            crossServiceLinks: {
                success: true,
                services: ['deezer'],
                links: {
                    USSM17900123: { deezer: 'https://www.deezer.com/track/3135556' },
                    release: { deezer: 'https://www.deezer.com/album/123' },
                },
            },
        });
        page.on('request', (req) => {
            if (req.url().includes('/links/resolve')) sent.push(JSON.parse(req.postData() ?? '{}'));
        });

        await addOpenTrack(page, 0);
        await page.fill('[name="track-title-0"]', 'Burnin\u2019 For You');
        await page.fill('#release-listen-links',
            'https://open.spotify.com/album/1Fv2tUhCRhY3YE1Iqp1oBo');

        await page.click('#import-track-links');
        await expect(page.locator('[name="track-listen-link-0"]')).toHaveValue(/deezer\.com/);
        await expect(page.locator('#release-listen-links')).toHaveValue(/deezer\.com\/album/);

        await page.click('#import-track-links');
        await expect(page.locator('#listen-link-report'))
            .toContainText('Compared against Spotify');

        // Second press: the track holds a Deezer link and the release holds a
        // Deezer album, so there is nothing left worth a request and none is
        // made. Everything was resolved in the first, release first.
        expect(sent).toHaveLength(1);
        expect(sent[0].tracks.map((t) => t.id)).toEqual(['release', 'USSM17900123']);
    });

    test('the report says how many tracks have nothing yet', async ({ page }) => {
        // Not "those services do not have it": a rate-limited key answers a few
        // at a time, and the difference decides whether pressing again is worth
        // anything.
        await importWith(page, ['Burnin\u2019 For You', 'Veteran Of The Psychic Wars'], {
            success: true,
            services: ['deezer'],
            links: { USSM17900123: { deezer: 'https://www.deezer.com/track/111' } },
        });

        await expect(page.locator('#listen-link-report'))
            .toContainText('1 track(s) have no other service yet');
        await expect(page.locator('#listen-link-report')).toContainText('again');
    });
});

test.describe('importing from Discogs, end to end', () => {
    /**
     * One click should do the whole chain: the Discogs release, then the
     * streaming release it corresponds to, then every track's link, ISRC and
     * alternate spelling. Discogs carries no streaming ids at all, so the
     * bridge is the barcode where there is one — and where there is not, the
     * artist and title, with the imported tracklist as the thing that decides
     * whether the album those found is the right one.
     *
     * That second route exists because the first one silently did nothing
     * rather often: a record pressed before the mid-80s has no barcode printed
     * on it, and plenty of Discogs entries for ones that do have left the field
     * blank. The chain then stopped with no request, no report and no message,
     * which from the form is indistinguishable from the feature being broken.
     *
     * Both APIs are stubbed. The Discogs client calls api.discogs.com from the
     * browser directly (it is in the page's CSP), so that route is intercepted
     * by its real URL rather than through our own API.
     */
    const DISCOGS_RELEASE = {
        id: 249504,
        title: 'Fire of Unknown Origin',
        year: 1981,
        released: '1981-06-01',
        formats: [{ name: 'Vinyl' }],
        labels: [{ name: 'Columbia', catno: 'FC 37389' }],
        artists: [{ name: 'Blue Öyster Cult', id: 12345 }],
        identifiers: [
            { type: 'Matrix / Runout', value: 'AL-37389-1A' },
            { type: 'Barcode', value: '0 7464-37389-1' },
        ],
        tracklist: [
            { position: 'A1', type_: 'track', title: 'Fire Of Unknown Origin' },
            // One character from Spotify's spelling, below.
            { position: 'A2', type_: 'track', title: 'Burnin For You' },
        ],
    };

    const SPOTIFY_ALBUM = {
        success: true,
        matched_by: 'upc',
        album: {
            id: 'AL1', name: 'Fire of Unknown Origin', total_tracks: 2, upc: '07464373891',
            tracks: [
                {
                    id: 'trk1', name: 'Fire Of Unknown Origin', track_number: 1,
                    isrc: 'USSM19810001',
                },
                {
                    // Discogs drops the g; Spotify keeps it. A real spelling
                    // difference, unlike an apostrophe — that normalizes away
                    // and is not worth recording as another title.
                    id: 'trk2', name: 'Burning For You', track_number: 2,
                    isrc: 'USSM19810002',
                },
            ],
        },
    };

    /**
     * The same album, offered the way a name search has to offer it: as
     * candidates with their tracklists and no verdict. A title and an artist
     * cannot identify a release, so nothing is filled in until the imported
     * tracklist agrees with one of these — see chooseAlbumByTracklist.
     */
    const SPOTIFY_CANDIDATES = {
        success: true,
        matched_by: 'name',
        candidates: [SPOTIFY_ALBUM.album],
    };

    /**
     * Drive the import, returning what the form sent to the Spotify endpoint.
     *
     * @param {import('@playwright/test').Page} page
     * @param {Object} [options]
     * @param {Object} [options.release] - The Discogs payload to serve.
     * @param {Object} [options.album] - The Spotify answer to serve.
     */
    async function importFromDiscogs(page, { release = DISCOGS_RELEASE, album = SPOTIFY_ALBUM } = {}) {
        const sent = [];

        await gotoForm(page);
        await page.route('https://api.discogs.com/releases/*', (route) =>
            route.fulfill({ contentType: 'application/json', body: JSON.stringify(release) }));
        // The import also asks Discogs for the band's roster, to tell members
        // from session players. Stubbed so these tests do not wait on a real
        // request failing, which fetchDiscogsRoster swallows by design.
        await page.route('https://api.discogs.com/artists/*', (route) =>
            route.fulfill({ contentType: 'application/json', body: JSON.stringify({ members: [] }) }));
        await page.route('**/spotify/album', (route) => {
            sent.push(JSON.parse(route.request().postData() ?? '{}'));
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify(album) });
        });

        // The panel is a collapsed <details>, so the input is not visible until
        // it is opened — Playwright will not type into it otherwise, which is
        // confirmation the collapse is real rather than cosmetic.
        await page.locator('.discogs-import details').evaluate((el) => { el.open = true; });
        await page.fill('#discogs-input', 'https://www.discogs.com/release/249504');
        await page.click('#fetch-discogs-btn');
        await expect(page.locator('#discogs-status')).toContainText('Successfully imported');

        return sent;
    }

    test('the barcode off the sleeve is what gets sent', async ({ page }) => {
        const sent = await importFromDiscogs(page);

        await expect(page.locator('#listen-link-report'))
            .toContainText('Compared against Spotify');
        // Digits only: the grouping Discogs prints is typography, and the
        // matrix number in the same array is not a barcode.
        expect(sent).toHaveLength(1);
        expect(sent[0].upc).toBe('07464373891');
    });

    test('every track comes back with its link, without a second click', async ({ page }) => {
        await importFromDiscogs(page);
        await expect(page.locator('#listen-link-report'))
            .toContainText('Compared against Spotify');

        await expect(page.locator('[name="track-listen-link-0"]'))
            .toHaveValue('https://open.spotify.com/track/trk1');
        await expect(page.locator('[name="track-listen-link-1"]'))
            .toHaveValue('https://open.spotify.com/track/trk2');
    });

    test('and with its ISRC and the other spelling', async ({ page }) => {
        await importFromDiscogs(page);
        await expect(page.locator('#listen-link-report'))
            .toContainText('Compared against Spotify');

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        expect(bundle.tracks.map(t => t.isrc)).toEqual(['USSM19810001', 'USSM19810002']);
        // Two catalogues, two spellings, one recording: the link is filled
        // anyway and the other spelling is kept rather than discarded with it.
        expect(bundle.tracks[1].alt_titles).toEqual(['Burning For You']);
        expect(bundle.tracks[0]).not.toHaveProperty('alt_titles');
    });

    test('the matched album lands on the release, for the player', async ({ page }) => {
        // After a barcode match nothing else would ever put it there, and the
        // player's album embed reads the release's links, not the tracks'.
        await importFromDiscogs(page);
        await expect(page.locator('#listen-link-report'))
            .toContainText('Compared against Spotify');

        await expect(page.locator('#release-listen-links'))
            .toHaveValue('https://open.spotify.com/album/AL1');
    });

    test('the barcode reaches the bundle, not just the lookup', async ({ page }) => {
        // It identifies this pressing rather than describing it, which is what
        // a Release node is for — and stored, it is also the key MusicBrainz
        // can be asked about the same edition with. Until now it was read,
        // used for the Spotify match, and dropped.
        await importFromDiscogs(page);

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        expect(bundle.release.barcode).toBe('07464373891');
    });

    test('a release with no barcode sends no barcode', async ({ page }) => {
        await importFromDiscogs(page, {
            release: { ...DISCOGS_RELEASE, identifiers: [{ type: 'Barcode', value: 'none' }] },
        });

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        expect(bundle.release).not.toHaveProperty('barcode');
    });

    test('the report says the barcode is what found it', async ({ page }) => {
        // Nothing the submitter typed points at this release, so "compared
        // against" would otherwise be a claim with no visible basis.
        await importFromDiscogs(page);

        await expect(page.locator('#listen-link-report')).toContainText('found by barcode');
    });

    test('a release with no barcode is looked up by name instead', async ({ page }) => {
        // This is the case that used to do nothing at all. The name is not
        // trusted — the server answers it with candidates and the imported
        // tracklist decides — but it is asked.
        const sent = await importFromDiscogs(page, {
            release: { ...DISCOGS_RELEASE, identifiers: [{ type: 'Barcode', value: 'none' }] },
            album: SPOTIFY_CANDIDATES,
        });

        expect(sent).toHaveLength(1);
        expect(sent[0].upc).toBeUndefined();
        expect(sent[0]).toMatchObject({
            album: 'Fire of Unknown Origin', artist: 'Blue Öyster Cult',
        });
    });

    test('and the tracklist it finds that way is filled in', async ({ page }) => {
        await importFromDiscogs(page, {
            release: { ...DISCOGS_RELEASE, identifiers: [{ type: 'Barcode', value: 'none' }] },
            album: SPOTIFY_CANDIDATES,
        });

        await expect(page.locator('[name="track-listen-link-0"]'))
            .toHaveValue('https://open.spotify.com/track/trk1');
        await expect(page.locator('[name="track-listen-link-1"]'))
            .toHaveValue('https://open.spotify.com/track/trk2');
        await expect(page.locator('#listen-link-report')).toContainText('found by name');
    });

    test('and the report says why the barcode was not used', async ({ page }) => {
        // Otherwise the barcode's fate is invisible: a submitter cannot tell
        // whether it was missing, wrong, or never looked at.
        await importFromDiscogs(page, {
            release: { ...DISCOGS_RELEASE, identifiers: [{ type: 'Barcode', value: 'none' }] },
            album: SPOTIFY_CANDIDATES,
        });

        await expect(page.locator('#listen-link-report'))
            .toContainText('Discogs lists no barcode');
    });

    test('a barcode Spotify does not carry falls through to the name', async ({ page }) => {
        // The usual state of a reissued record: the sleeve's barcode belongs to
        // a pressing and the streaming release is filed under a digital one. The
        // report says so, because that is the diagnosis.
        await importFromDiscogs(page, { album: SPOTIFY_CANDIDATES });

        await expect(page.locator('#listen-link-report'))
            .toContainText('no release under the barcode');
        await expect(page.locator('[name="track-listen-link-0"]'))
            .toHaveValue('https://open.spotify.com/track/trk1');
    });

    test('a name match the tracklist does not support fills nothing', async ({ page }) => {
        // The whole safeguard. A compilation carrying one of these titles ranks
        // perfectly well for the artist, and accepting it would attach a
        // tracklist of links and ISRCs to the wrong record, silently.
        await importFromDiscogs(page, {
            release: { ...DISCOGS_RELEASE, identifiers: [{ type: 'Barcode', value: 'none' }] },
            album: {
                success: true,
                matched_by: 'name',
                candidates: [{
                    id: 'HITS', name: 'Workshop of the Telescopes', total_tracks: 3,
                    tracks: [
                        { id: 'h1', name: '(Don\'t Fear) The Reaper', track_number: 1 },
                        { id: 'h2', name: 'Godzilla', track_number: 2 },
                        { id: 'h3', name: 'Burnin For You', track_number: 3 },
                    ],
                }],
            },
        });

        await expect(page.locator('[name="track-listen-link-0"]')).toHaveValue('');
        await expect(page.locator('[name="track-listen-link-1"]')).toHaveValue('');
        await expect(page.locator('#listen-link-report')).toContainText('too few');
        // Named and linked: "no match" leaves a submitter nothing to do.
        await expect(page.locator('#listen-link-report'))
            .toContainText('Workshop of the Telescopes');
    });

    test('the title is sent without its edition decoration', async ({ page }) => {
        // "(Deluxe Edition)" in the search string is two words Spotify matches
        // against the title, and the standard edition is what a Discogs
        // tracklist usually describes.
        const sent = await importFromDiscogs(page, {
            release: {
                ...DISCOGS_RELEASE,
                title: 'Fire of Unknown Origin (Deluxe Edition)',
                identifiers: [],
            },
            album: SPOTIFY_CANDIDATES,
        });

        expect(sent[0].album).toBe('Fire of Unknown Origin');
    });

    test('a barcode Spotify cannot place leaves the form alone', async ({ page }) => {
        await importFromDiscogs(page, {
            album: { success: false, reason: 'upc_not_found', message: 'No release under that barcode.' },
        });

        await expect(page.locator('#listen-link-report')).toContainText('that barcode');
        await expect(page.locator('[name="track-listen-link-0"]')).toHaveValue('');
        // And the import itself still counts as a success.
        await expect(page.locator('#discogs-status')).toContainText('Successfully imported');
    });

    test('a compilation credits each track, not a band called Various', async ({ page }) => {
        /**
         * discogs.com/release/6380913 — "Various — Lost Ark Studio Compilation
         * Vol. 4". Discogs credits the release to its "Various" placeholder
         * (artist id 194) and names the real act on each track. The import
         * read only the release-level credit, so the registry got a band
         * called Various that played everything and lost the acts that did.
         */
        await importFromDiscogs(page, {
            release: {
                ...DISCOGS_RELEASE,
                title: 'Lost Ark Studio Compilation Vol. 4',
                artists: [{ name: 'Various', id: 194 }],
                formats: [{ name: 'CD', descriptions: ['Compilation'] }],
                tracklist: [
                    { position: '1', type_: 'track', title: 'First Song',
                        artists: [{ name: 'Nocturnal Rites', id: 12345 }],
                        extraartists: [
                            { name: 'Andrew Ware', id: 21, role: 'Drums' },
                            { name: 'Aaron Dennis', id: 22, role: 'Guitar' },
                            { name: 'Max Greenhalgh', id: 23, role: 'Vocals, Bass' },
                        ] },
                    { position: '2', type_: 'track', title: 'Second Song',
                        artists: [{ name: 'Bob Dylan', id: 7, anv: 'Blind Boy Grunt' }] },
                    { position: '3', type_: 'track', title: 'Third Song' },
                ],
            },
            album: { success: false, reason: 'not_configured', message: 'Not configured.' },
        });

        // No band called Various, at the release or anywhere else.
        await expect(page.locator('[data-type="release-group"]')).toHaveCount(0);

        // Each track credited to the act that played it, with inheritance off.
        await expect(page.locator('[name="group-name-0-0"]')).toHaveValue('Nocturnal Rites');
        await expect(page.locator('[name="group-name-1-0"]')).toHaveValue('Bob Dylan');
        await expect(page.locator('[name="track-same-groups-0"]')).not.toBeChecked();

        // How the act was billed on this release, kept rather than discarded.
        await expect(page.locator('[name="group-altnames-1-0"]')).toHaveValue('Blind Boy Grunt');

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        expect(bundle.groups ?? []).toEqual([]);
        expect(bundle.tracks.map(t => t.performed_by_groups?.[0]?.name))
            .toEqual(['Nocturnal Rites', 'Bob Dylan', undefined]);
        expect(JSON.stringify(bundle)).not.toContain('Various');
    });

    test('and fills in the line-up printed under each track', async ({ page }) => {
        // The people are in the payload — "Drums – Andrew Ware, Guitar – Aaron
        // Dennis, Vocals, Bass – Max Greenhalgh" — and every group the import
        // created was empty.
        await importFromDiscogs(page, {
            release: {
                ...DISCOGS_RELEASE,
                artists: [{ name: 'Various', id: 194 }],
                tracklist: [
                    { position: '1', type_: 'track', title: 'Leap Year',
                        artists: [{ name: 'Tan Sister Radio', id: 1 }],
                        extraartists: [
                            { name: 'Andrew Ware', id: 21, role: 'Drums' },
                            { name: 'Aaron Dennis', id: 22, role: 'Guitar' },
                            { name: 'Max Greenhalgh', id: 23, role: 'Vocals, Bass' },
                            // Not a bandmate: a production credit beside them.
                            { name: 'A Producer', id: 24, role: 'Producer' },
                        ] },
                ],
            },
            album: { success: false, reason: 'not_configured', message: 'Not configured.' },
        });

        await expect(page.locator('[name="member-name-0-0-0"]')).toHaveValue('Andrew Ware');
        await expect(page.locator('[name="member-roles-0-0-0"]')).toHaveValue('Drums');
        await expect(page.locator('[name="member-name-0-0-2"]')).toHaveValue('Max Greenhalgh');
        // Two instruments on one credit line, which the roles field also
        // comma-separates, so the string survives unchanged.
        await expect(page.locator('[name="member-roles-0-0-2"]')).toHaveValue('Vocals, Bass');
        await expect(page.locator('[name="member-name-0-0-3"]')).toHaveCount(0);

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        const [group] = bundle.tracks[0].performed_by_groups;
        expect(group.name).toBe('Tan Sister Radio');
        expect(group.members.map(m => m.name))
            .toEqual(['Andrew Ware', 'Aaron Dennis', 'Max Greenhalgh']);
        expect(group.members[2].roles).toEqual(['Vocals', 'Bass']);
        expect(JSON.stringify(bundle.tracks[0].performed_by_groups))
            .not.toContain('A Producer');
    });

    test('a performer who is also one of the acts gets their own group', async ({ page }) => {
        // Track 6 of that release: "The Paragraphs, Tori Rogg", with Tori Rogg
        // on organ. A group of one beside the band, not a member of it.
        await importFromDiscogs(page, {
            release: {
                ...DISCOGS_RELEASE,
                artists: [{ name: 'Various', id: 194 }],
                tracklist: [
                    { position: '1', type_: 'track', title: 'Gone Away Bluebird',
                        artists: [{ name: 'The Paragraphs', id: 10 },
                            { name: 'Tori Rogg', id: 11 }],
                        extraartists: [
                            { name: 'Mike Butler', id: 31, role: 'Lap Steel Guitar' },
                            { name: 'Jesse Hofbauer', id: 32, role: 'Vocals, Guitar' },
                            { name: 'Tori Rogg', id: 11, role: 'Vocals, Organ' },
                        ] },
                ],
            },
            album: { success: false, reason: 'not_configured', message: 'Not configured.' },
        });

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        const groups = bundle.tracks[0].performed_by_groups;

        expect(groups.map(g => g.name)).toEqual(['The Paragraphs', 'Tori Rogg']);
        expect(groups[0].members.map(m => m.name))
            .toEqual(['Mike Butler', 'Jesse Hofbauer']);
        expect(groups[1].members.map(m => m.name)).toEqual(['Tori Rogg']);
    });

    test('and says which tracks still need an act', async ({ page }) => {
        // A compilation track Discogs credits to nobody needs one typed in,
        // and a collapsed track row shows none of that.
        await importFromDiscogs(page, {
            release: {
                ...DISCOGS_RELEASE,
                artists: [{ name: 'Various', id: 194 }],
                tracklist: [
                    { position: '1', type_: 'track', title: 'First Song',
                        artists: [{ name: 'Nocturnal Rites', id: 12345 }] },
                    { position: '2', type_: 'track', title: 'Second Song' },
                ],
            },
            album: { success: false, reason: 'not_configured', message: 'Not configured.' },
        });

        await expect(page.locator('#discogs-status')).toContainText('Compilation');
        await expect(page.locator('#discogs-status')).toContainText('1 track(s) name no act');
    });

    test('an ordinary album still inherits its act from the release', async ({ page }) => {
        // The default is worth keeping: an inherited group carries the node id
        // bound at the top, where a re-typed name mints a new provisional one.
        await importFromDiscogs(page, {
            release: {
                ...DISCOGS_RELEASE,
                tracklist: [
                    { position: 'A1', type_: 'track', title: 'Fire Of Unknown Origin',
                        artists: [{ name: 'Blue \u00d6yster Cult', id: 12345 }] },
                ],
            },
        });

        await expect(page.locator('[name="track-same-groups-0"]')).toBeChecked();
        await expect(page.locator('[name="group-name-0-0"]')).toHaveCount(0);
        await expect(page.locator('#discogs-status')).not.toContainText('Compilation');

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        expect(bundle.tracks[0].performed_by_groups[0].name).toBe('Blue \u00d6yster Cult');
    });

    test('a failed cross-check does not make the import look failed', async ({ page }) => {
        // The Discogs half succeeded, and that is most of the work. Reporting
        // it as an error would send the submitter back to re-import.
        await importFromDiscogs(page, {
            album: { success: false, reason: 'search_unavailable',
                message: 'Spotify refused the barcode search for this app.' },
        });

        await expect(page.locator('#discogs-status')).toHaveClass(/success/);
        await expect(page.locator('#listen-link-report')).toContainText('refused');
    });
});

test.describe('importing from Spotify', () => {
    /**
     * For the releases Discogs has never heard of. Spotify answers with the
     * release, its label, its barcode, every track with its number and ISRC,
     * and the act per track — and with no credits at all, because its Web API
     * has none. So an import from here is complete in structure and empty of
     * people, which the status line says out loud.
     *
     * Same box as the Discogs import: it is the same act, pasting the link to
     * a record.
     */
    const SPOTIFY_ALBUM = {
        success: true,
        matched_by: 'link',
        album: {
            id: 'ALB1',
            name: 'Lost Ark Studio Compilation Vol. 4',
            release_date: '2014-11-11',
            total_tracks: 2,
            album_type: 'compilation',
            label: 'Randm Records',
            copyrights: ['\u2117 2014 Randm Records'],
            upc: '888295974028',
            artists: [{ id: '0LyfQWJT6nXafLPZqxe9Of', name: 'Various Artists' }],
            tracks: [
                { id: 'trk1', name: 'Turns To Dust', track_number: 1, disc_number: 1,
                    duration_ms: 197000, isrc: 'USX9P1400001',
                    artists: [{ id: 'a1', name: 'The Paragraphs' }] },
                { id: 'trk2', name: 'Out To Sea', track_number: 2, disc_number: 1,
                    duration_ms: 248000, isrc: 'USX9P1400002',
                    artists: [{ id: 'a2', name: '22 Kings' }] },
            ],
        },
    };

    /** Paste a Spotify album link into the import box and wait for the fill. */
    async function importFromSpotify(page, { album = SPOTIFY_ALBUM } = {}) {
        const sent = [];
        await gotoForm(page);
        await page.route('**/spotify/album', (route) => {
            sent.push(JSON.parse(route.request().postData() ?? '{}'));
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify(album) });
        });

        await page.locator('.discogs-import details').evaluate((el) => { el.open = true; });
        await page.fill('#discogs-input', 'https://open.spotify.com/album/ALB1');
        await page.click('#fetch-discogs-btn');

        return sent;
    }

    test('a Spotify link in the same box imports the release', async ({ page }) => {
        const sent = await importFromSpotify(page);

        await expect(page.locator('#discogs-status')).toContainText('Imported from Spotify');
        // Asked by link, which names one release — no barcode guessing needed.
        expect(sent[0].links).toEqual(['https://open.spotify.com/album/ALB1']);

        await expect(page.locator('#release-name'))
            .toHaveValue('Lost Ark Studio Compilation Vol. 4');
        await expect(page.locator('#release-date')).toHaveValue('2014/11/11');
        await expect(page.locator('#release-format')).toHaveValue('Digital');
        await expect(page.locator('[name="label-name-0"]')).toHaveValue('Randm Records');
        await expect(page.locator('#source-links'))
            .toHaveValue('https://open.spotify.com/album/ALB1');
    });

    test('the tracks arrive with their numbers, ISRCs and links', async ({ page }) => {
        await importFromSpotify(page);

        await expect(page.locator('[name="track-title-0"]')).toHaveValue('Turns To Dust');
        await expect(page.locator('[name="track-position-1"]')).toHaveValue('2');
        await expect(page.locator('[name="track-listen-link-0"]'))
            .toHaveValue('https://open.spotify.com/track/trk1');

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        expect(bundle.tracks.map(t => t.isrc)).toEqual(['USX9P1400001', 'USX9P1400002']);
        // The barcode Spotify filed it under reaches the bundle, so MusicBrainz
        // can be asked about the same release later.
        expect(bundle.release.barcode).toBe('888295974028');
    });

    test('a compilation is credited per track here too', async ({ page }) => {
        await importFromSpotify(page);

        await expect(page.locator('[data-type="release-group"]')).toHaveCount(0);
        await expect(page.locator('[name="group-name-0-0"]')).toHaveValue('The Paragraphs');
        await expect(page.locator('[name="group-name-1-0"]')).toHaveValue('22 Kings');

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        expect(JSON.stringify(bundle)).not.toContain('Various Artists');
    });

    test('an ordinary album keeps its release-level act', async ({ page }) => {
        await importFromSpotify(page, {
            album: {
                ...SPOTIFY_ALBUM,
                album: {
                    ...SPOTIFY_ALBUM.album,
                    album_type: 'album',
                    artists: [{ id: 'a9', name: 'Ocelot' }],
                    tracks: SPOTIFY_ALBUM.album.tracks.map(t => ({
                        ...t, artists: [{ id: 'a9', name: 'Ocelot' }],
                    })),
                },
            },
        });

        await expect(page.locator('[name="release-group-name-0"]')).toHaveValue('Ocelot');
        await expect(page.locator('[name="track-same-groups-0"]')).toBeChecked();
    });

    test('it says that Spotify carries no credits', async ({ page }) => {
        // The one thing this import cannot do, said where somebody will read it
        // rather than discovered as an empty Performing Groups section.
        await importFromSpotify(page);

        await expect(page.locator('#discogs-status')).toContainText('no credits');
    });

    test('a refused lookup reports the reason, not a bad link', async ({ page }) => {
        await importFromSpotify(page, {
            album: { success: false, reason: 'not_configured',
                message: 'Spotify lookup is not configured on this server.' },
        });

        await expect(page.locator('#discogs-status')).toContainText('not configured');
        await expect(page.locator('#discogs-status')).toHaveClass(/error/);
    });

    test('something that is neither link is still a Discogs error', async ({ page }) => {
        await gotoForm(page);
        await page.locator('.discogs-import details').evaluate((el) => { el.open = true; });
        await page.fill('#discogs-input', 'https://example.com/not-a-release');
        await page.click('#fetch-discogs-btn');

        await expect(page.locator('#discogs-status')).toContainText('Spotify album link');
    });
});

test.describe('labels and their catalogue numbers', () => {
    /**
     * A release is issued by one or more labels, and each issuer stamps its own
     * catalogue number on it. The number therefore belongs to the label-release
     * pairing, and the form collects it per label.
     *
     * These drive the real form and read the real bundle, because the failure
     * this guards against is invisible to unit tests: FormBuilder writes the
     * input as `label-catalog-${index}` and PolarisApp reads it back by the
     * same name. Nothing checks that those two strings agree, so a rename on
     * either side silently drops the field — which is precisely how the release
     * date came to be missing from every fingerprint (written as `date`, read
     * as `release_date`).
     */
    async function addLabel(page, index, { name, catalog }) {
        await page.click('#add-label');
        await page.fill(`[name="label-name-${index}"]`, name);
        if (catalog !== undefined) {
            await page.fill(`[name="label-catalog-${index}"]`, catalog);
        }
    }

    test('a catalogue number typed against a label reaches the bundle', async ({ page }) => {
        await gotoForm(page);
        await fillMinimalRelease(page);
        await addLabel(page, 0, { name: 'Sub Pop', catalog: 'SP 34' });

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        expect(bundle.release.labels).toHaveLength(1);
        expect(bundle.release.labels[0]).toMatchObject({
            name: 'Sub Pop',
            catalog_number: 'SP 34',
        });
    });

    test('a co-issue keeps both labels and both numbers, each with its own', async ({ page }) => {
        await gotoForm(page);
        await fillMinimalRelease(page);
        await addLabel(page, 0, { name: 'Sub Pop', catalog: 'SP 34' });
        await addLabel(page, 1, { name: 'Tupelo', catalog: 'TUP 8' });

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        expect(bundle.release.labels).toHaveLength(2);
        // Pairwise: the numbers must not be swapped or shared between issuers.
        expect(bundle.release.labels.map(l => [l.name, l.catalog_number])).toEqual([
            ['Sub Pop', 'SP 34'],
            ['Tupelo', 'TUP 8'],
        ]);
    });

    test('a label with no catalogue number omits the field rather than sending empty', async ({ page }) => {
        // An empty string would be a claim that the catalogue number is "",
        // and it would enter the release fingerprint as one.
        await gotoForm(page);
        await fillMinimalRelease(page);
        await addLabel(page, 0, { name: 'Unknown Label', catalog: '   ' });

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        expect(bundle.release.labels[0]).not.toHaveProperty('catalog_number');
    });

    test('the release-level catalogue number stays separate from the label ones', async ({ page }) => {
        await gotoForm(page);
        await fillMinimalRelease(page);
        await page.fill('[name="release_catalog_number"]', 'RELEASE-WIDE');
        await addLabel(page, 0, { name: 'Sub Pop', catalog: 'SP 34' });

        const bundle = await page.evaluate(() => window.polarisApp.buildReleaseData());
        expect(bundle.release.catalog_number).toBe('RELEASE-WIDE');
        expect(bundle.release.labels[0].catalog_number).toBe('SP 34');
    });
});

test.describe('importing from Bandcamp', () => {
    /**
     * For the records that are on neither of the others: self-released albums,
     * small-label albums, anything a band put up themselves. Bandcamp publishes
     * no catalogue API at all, so the server reads the public page — which a
     * browser cannot do, since those pages send no CORS header.
     *
     * The fixture is a real page's answer, trimmed: a preorder on the band's
     * own page that a label released, which is the shape that caught two bugs
     * in the parser. Note the label is NOT the band, several tracks have no
     * page of their own, and the record is also sold on vinyl and CD as
     * separate releases.
     */
    const BANDCAMP_ALBUM = {
        success: true,
        album: {
            name: 'Watermelon',
            artist: 'Howlin Rain',
            label: 'Silver Current Records',
            format: 'Digital',
            other_editions: ['Vinyl LP', 'Compact Disc (CD)'],
            upc: null,
            release_date: '2026/11/13',
            credits: 'The Players:\nEthan Miller: vocals, electric and acoustic guitar\n'
                + 'Justin Smith: drums, percussion and backing vocals',
            about: 'In celebration of 20 years riding the bus to never-ever land.',
            tags: ['70s rock', 'Oakland'],
            url: 'https://howlinrain.bandcamp.com/album/watermelon',
            tracks: [
                { title: 'Silver Paper (with Chris Robinson)', position: 1, duration: 297,
                    url: 'https://howlinrain.bandcamp.com/track/silver-paper-with-chris-robinson',
                    artist: null },
                { title: 'Jesus Was A Cross Maker', position: 2, duration: null,
                    url: null, artist: null },
            ],
        },
    };

    /** Paste a Bandcamp album page into the import box and wait for the fill. */
    async function importFromBandcamp(page, { album = BANDCAMP_ALBUM } = {}) {
        const sent = [];
        await gotoForm(page);
        await page.route('**/bandcamp/album', (route) => {
            sent.push(JSON.parse(route.request().postData() ?? '{}'));
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify(album) });
        });

        await page.locator('.discogs-import details').evaluate((el) => { el.open = true; });
        await page.fill('#discogs-input', 'https://howlinrain.bandcamp.com/album/watermelon');
        await page.click('#fetch-discogs-btn');

        return sent;
    }

    test('a Bandcamp link in the same box imports the release', async ({ page }) => {
        const sent = await importFromBandcamp(page);

        await expect(page.locator('#discogs-status')).toContainText('Imported from Bandcamp');
        expect(sent[0]).toEqual({ url: 'https://howlinrain.bandcamp.com/album/watermelon' });

        await expect(page.locator('#release-name')).toHaveValue('Watermelon');
        await expect(page.locator('#release-date')).toHaveValue('2026/11/13');
        // Digital: the page's own release. The vinyl and the CD are separate
        // Releases, and format is part of the fingerprint that keeps them apart.
        await expect(page.locator('#release-format')).toHaveValue('Digital');
        await expect(page.locator('[name="release-group-name-0"]')).toHaveValue('Howlin Rain');
    });

    test('the label is the label, not the band whose page it is', async ({ page }) => {
        await importFromBandcamp(page);

        await expect(page.locator('[name="label-name-0"]')).toHaveValue('Silver Current Records');
    });

    test('the page is kept as both a source and a place to listen', async ({ page }) => {
        await importFromBandcamp(page);

        const url = 'https://howlinrain.bandcamp.com/album/watermelon';
        await expect(page.locator('#source-links')).toHaveValue(url);
        await expect(page.locator('#release-listen-links')).toHaveValue(url);
    });

    test('a track gets a link only where a track page exists', async ({ page }) => {
        await importFromBandcamp(page);

        await expect(page.locator('[name="track-title-0"]'))
            .toHaveValue('Silver Paper (with Chris Robinson)');
        await expect(page.locator('[name="track-position-1"]')).toHaveValue('2');
        await expect(page.locator('[name="track-listen-link-0"]'))
            .toHaveValue('https://howlinrain.bandcamp.com/track/silver-paper-with-chris-robinson');
        // Not the album page under a fragment, which is where this one used to
        // point. Nothing is better than the wrong thing.
        await expect(page.locator('[name="track-listen-link-1"]')).toHaveValue('');
    });

    test('the credits arrive as liner notes, because that is all they are', async ({ page }) => {
        await importFromBandcamp(page);

        const notes = page.locator('#liner-notes');
        await expect(notes).toHaveValue(/Ethan Miller: vocals, electric and acoustic guitar/);
        await expect(notes).toHaveValue(/In celebration of 20 years/);
        // Nobody is invented from that text: it has no roles and no per-track
        // attachment, and guessing MEMBER_OF out of prose is not available here.
        await expect(page.locator('#release-guests-container')).toBeEmpty();
    });

    test('the status says the credits are not people, and names the other editions',
        async ({ page }) => {
            await importFromBandcamp(page);

            const status = page.locator('#discogs-status');
            await expect(status).toContainText('Bandcamp has no structured credits');
            await expect(status).toContainText('Vinyl LP and Compact Disc (CD)');
            await expect(status).toContainText('each a separate release to submit');
        });

    test('a page with no credits at all says so instead', async ({ page }) => {
        await importFromBandcamp(page, {
            album: {
                success: true,
                album: { ...BANDCAMP_ALBUM.album, credits: null, other_editions: [] },
            },
        });

        await expect(page.locator('#discogs-status'))
            .toContainText('carries no credits at all');
    });

    test('a compilation credits each track to its own act', async ({ page }) => {
        await importFromBandcamp(page, {
            album: {
                success: true,
                album: {
                    ...BANDCAMP_ALBUM.album,
                    name: 'Lost Ark Studio Compilation Vol. 4',
                    artist: 'Various Artists',
                    tracks: [
                        { title: 'Turns To Dust', position: 1, duration: 197,
                            url: null, artist: 'The Paragraphs' },
                        { title: 'Out To Sea', position: 2, duration: 248,
                            url: null, artist: '22 Kings' },
                    ],
                },
            },
        });

        // Nothing at the release level: a compilation is credited to its tracks.
        await expect(page.locator('[name="release-group-name-0"]')).toHaveCount(0);
        await expect(page.locator('[name="group-name-0-0"]')).toHaveValue('The Paragraphs');
        await expect(page.locator('[name="group-name-1-0"]')).toHaveValue('22 Kings');
        await expect(page.locator('#discogs-status')).toContainText('Compilation');
    });

    test('a compilation track naming no act is reported, not papered over',
        async ({ page }) => {
            await importFromBandcamp(page, {
                album: {
                    success: true,
                    album: {
                        ...BANDCAMP_ALBUM.album,
                        artist: 'Various Artists',
                        tracks: [
                            { title: 'Turns To Dust', position: 1, duration: 197,
                                url: null, artist: 'The Paragraphs' },
                            { title: 'Out To Sea', position: 2, duration: 248,
                                url: null, artist: null },
                        ],
                    },
                },
            });

            await expect(page.locator('#discogs-status'))
                .toContainText('1 track(s) name no act');
        });

    test('a page the server could not read reports the server’s own reason', async ({ page }) => {
        // Bandcamp's markup is not a published interface. When it moves, the
        // submitter needs to know that is what happened — not "not found".
        await importFromBandcamp(page, {
            album: {
                success: false,
                reason: 'unreadable',
                message: 'That page carries no release data this server can read. '
                    + 'Run scripts/checkBandcamp.js against it.',
            },
        });

        const status = page.locator('#discogs-status');
        await expect(status).toHaveClass(/error/);
        await expect(status).toContainText('checkBandcamp.js');
        await expect(page.locator('#release-name')).toHaveValue('');
    });

    test('a link that is none of the three says so', async ({ page }) => {
        await gotoForm(page);
        await page.locator('.discogs-import details').evaluate((el) => { el.open = true; });
        await page.fill('#discogs-input', 'https://example.com/some/record');
        await page.click('#fetch-discogs-btn');

        await expect(page.locator('#discogs-status'))
            .toContainText('or a Bandcamp album page');
    });
});

test.describe('importing a Various Artists page from Bandcamp', () => {
    /**
     * A Bandcamp page carries no compilation flag of any kind — no
     * `album_type`, no format descriptions, nothing. So the only signals are
     * the act being a placeholder and the tracks disagreeing with it, and the
     * placeholder has to count on its own: a Various Artists page whose tracks
     * name nobody would otherwise put "Various Artists" in the form as though
     * it were a band.
     */
    async function importVariousArtists(page, tracks) {
        await gotoForm(page);
        await page.route('**/bandcamp/album', (route) => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                album: {
                    name: 'Label Sampler 2026',
                    artist: 'Various Artists',
                    label: 'Silver Current Records',
                    format: 'Digital',
                    other_editions: [],
                    upc: null,
                    release_date: '2026/01/01',
                    credits: null,
                    about: null,
                    tags: [],
                    url: 'https://silvercurrent.bandcamp.com/album/label-sampler-2026',
                    tracks,
                },
            }),
        }));

        await page.locator('.discogs-import details').evaluate((el) => { el.open = true; });
        await page.fill('#discogs-input',
            'https://silvercurrent.bandcamp.com/album/label-sampler-2026');
        await page.click('#fetch-discogs-btn');
    }

    test('the placeholder is never written in as a band', async ({ page }) => {
        // Even with no per-track act to go on, which is the case that used to
        // produce a Group node called "Various Artists".
        await importVariousArtists(page, [
            { title: 'Turns To Dust', position: 1, duration: 197, url: null, artist: null },
        ]);

        await expect(page.locator('#discogs-status')).toContainText('Imported from Bandcamp');
        await expect(page.locator('[name="release-group-name-0"]')).toHaveCount(0);
        await expect(page.locator('#discogs-status')).toContainText('1 track(s) name no act');
    });

    test('a track credited to the placeholder names no act either', async ({ page }) => {
        await importVariousArtists(page, [
            { title: 'Turns To Dust', position: 1, duration: 197, url: null,
                artist: 'The Paragraphs' },
            { title: 'Out To Sea', position: 2, duration: 248, url: null, artist: 'V/A' },
        ]);

        await expect(page.locator('[name="group-name-0-0"]')).toHaveValue('The Paragraphs');
        await expect(page.locator('[name="group-name-1-0"]')).toHaveCount(0);
        await expect(page.locator('#discogs-status')).toContainText('1 track(s) name no act');
    });
});

test.describe('a barcode that Spotify files under a different record', () => {
    /**
     * A verified barcode match is still not a match on the music. Barcodes get
     * reused, mis-entered in community catalogues, and shared between an album
     * and a promo EP cut from it — and the server's check only proves the
     * album Spotify returned really carries that barcode.
     *
     * What used to happen: a 15-track release's Discogs barcode found a
     * 4-track Spotify release, the comparison reported sixteen differences,
     * and then the wrong album's link went into the release field and five
     * other services were asked for the same wrong record. The report said so
     * underneath links that had already been written.
     */
    const FIFTEEN = [
        'The End Of Love', 'Tropics Of Love', 'Broken World', 'Why I Stay',
        'The Invitation', 'Did You Wonder', 'A Sign On The Road', 'Sympathy Crime',
        'The Visitor', 'The Waiter #4', 'A Cry For Love', 'Before The People',
        'Only One Way', 'Fingerprints', 'The One Who Has Disappeared',
    ];

    const DISCOGS_RELEASE = {
        id: 909090,
        title: 'Amore del Tropico',
        year: 2002,
        artists: [{ id: 1, name: 'The Black Heart Procession' }],
        labels: [{ name: 'Touch and Go', catno: 'TG250' }],
        formats: [{ name: 'CD' }],
        identifiers: [{ type: 'Barcode', value: '036172095025' }],
        tracklist: FIFTEEN.map((title, i) => ({
            position: String(i + 1), type_: 'track', title,
        })),
    };

    /** What Spotify really returns for that barcode: a different record. */
    const WRONG_ALBUM = {
        success: true,
        matched_by: 'upc',
        album: {
            id: 'WRONG', name: 'Smoke and Scissors', total_tracks: 4,
            upc: '036172095025',
            tracks: [
                { id: 'w1', name: 'Yoker Swan', track_number: 1 },
                { id: 'w2', name: 'The Streaker', track_number: 2 },
                { id: 'w3', name: 'Moonlighting', track_number: 3 },
                { id: 'w4', name: 'Smoke and Scissors', track_number: 4 },
            ],
        },
    };

    async function importWithWrongBarcodeMatch(page, { album = WRONG_ALBUM } = {}) {
        const crossServiceCalls = [];

        await gotoForm(page);
        await page.route('https://api.discogs.com/releases/*', (route) => route.fulfill({
            contentType: 'application/json', body: JSON.stringify(DISCOGS_RELEASE),
        }));
        await page.route('https://api.discogs.com/artists/*', (route) => route.fulfill({
            contentType: 'application/json', body: JSON.stringify({ members: [] }),
        }));
        await page.route('**/spotify/album', (route) => route.fulfill({
            contentType: 'application/json', body: JSON.stringify(album),
        }));
        await page.route('**/links/resolve', (route) => {
            crossServiceCalls.push(JSON.parse(route.request().postData() ?? '{}'));
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, links: {}, services: [] }),
            });
        });

        await page.locator('.discogs-import details').evaluate((el) => { el.open = true; });
        await page.fill('#discogs-input', 'https://www.discogs.com/release/909090');
        await page.click('#fetch-discogs-btn');

        return crossServiceCalls;
    }

    test('its link is not written into the release field', async ({ page }) => {
        await importWithWrongBarcodeMatch(page);

        await expect(page.locator('#listen-link-report'))
            .toContainText('does not look like this release');
        await expect(page.locator('#release-listen-links')).toHaveValue('');
    });

    test('no track gets a link from it either', async ({ page }) => {
        await importWithWrongBarcodeMatch(page);

        await expect(page.locator('#listen-link-report')).toContainText('Nothing was filled in');
        await expect(page.locator('[name="track-listen-link-0"]')).toHaveValue('');
        await expect(page.locator('[name="track-listen-link-14"]')).toHaveValue('');
    });

    test('the other services are never asked about the wrong record', async ({ page }) => {
        // The worst of it: five services' links for a record this is not.
        const crossServiceCalls = await importWithWrongBarcodeMatch(page);

        await expect(page.locator('#listen-link-report'))
            .toContainText('does not look like this release');
        expect(crossServiceCalls).toEqual([]);
    });

    test('it says which barcode, what it found, and what to do', async ({ page }) => {
        await importWithWrongBarcodeMatch(page);

        const report = page.locator('#listen-link-report');
        await expect(report).toContainText('036172095025');
        await expect(report).toContainText('"Smoke and Scissors" (4 track(s))');
        await expect(report).toContainText('0 of 15 track(s) line up');
        await expect(report).toContainText('paste the Spotify album link above');
    });

    test('the differences are still listed, as the evidence for refusing it',
        async ({ page }) => {
            await importWithWrongBarcodeMatch(page);

            await expect(page.locator('#listen-link-report'))
                .toContainText('this form has 15, Spotify has 4');
        });

    test('a barcode match that does agree is still used', async ({ page }) => {
        // The guard must not cost the ordinary case, which is the whole reason
        // the barcode route exists.
        const crossServiceCalls = await importWithWrongBarcodeMatch(page, {
            album: {
                success: true,
                matched_by: 'upc',
                album: {
                    id: 'RIGHT', name: 'Amore del Tropico', total_tracks: 15,
                    upc: '036172095025',
                    tracks: FIFTEEN.map((name, i) => ({
                        id: `t${i}`, name, track_number: i + 1,
                    })),
                },
            },
        });

        await expect(page.locator('#listen-link-report')).toContainText('found by barcode');
        await expect(page.locator('#release-listen-links'))
            .toHaveValue('https://open.spotify.com/album/RIGHT');
        expect(crossServiceCalls.length).toBeGreaterThan(0);
    });
});

test.describe('naming someone who is already in the registry by another name', () => {
    /**
     * The submitter's case: Kristen Gundred is in the registry, this record
     * credits Dee Dee, and typing "Dee Dee" afterwards should find her. The
     * alias goes on the Person node — which is what the search index and the
     * substring fallback both read — rather than on the relationship, where
     * `credited_as` already records how one release billed somebody.
     */
    async function fillOneMember(page, { altNames }) {
        await gotoForm(page);
        await page.fill('#release-name', 'Dum Dum Girls EP');
        await page.fill('#release-date', '2010');
        await page.selectOption('#release-format', 'EP');

        await page.click('#add-release-group');
        await page.fill('[name="release-group-name-0"]', 'Dum Dum Girls');
        await page.click('.add-release-member');
        // The member's name input is a lookup field and gets re-parented into
        // a wrapper on a 50ms observer, same as a track title — see
        // addOpenTrack. Filling it before that lands loses the text.
        await expect(
            page.locator('[name="release-member-name-0-0"]')
                .locator('xpath=ancestor::*[contains(@class,"entity-lookup-wrapper")]')
        ).toBeAttached();
        await page.fill('[name="release-member-name-0-0"]', 'Kristen Gundred');
        await page.fill('[name="release-member-roles-0-0"]', 'Vocals');
        if (altNames !== null) {
            await page.fill('[name="release-member-altnames-0-0"]', altNames);
        }

        await addOpenTrack(page, 0);
        await page.fill('[name="track-title-0"]', 'Rest Of Our Lives');

        return page.evaluate(() => window.polarisApp.buildReleaseData());
    }

    test('the alias is sent with the person', async ({ page }) => {
        const bundle = await fillOneMember(page, { altNames: 'Dee Dee' });

        expect(bundle.groups[0].members[0]).toMatchObject({
            name: 'Kristen Gundred',
            alt_names: ['Dee Dee'],
        });
    });

    test('several aliases, comma-separated, all travel', async ({ page }) => {
        const bundle = await fillOneMember(page, { altNames: 'Dee Dee, Kristin Welchez' });

        expect(bundle.groups[0].members[0].alt_names)
            .toEqual(['Dee Dee', 'Kristin Welchez']);
    });

    test('an empty box sends no aliases at all', async ({ page }) => {
        // Not an empty list: that would read as "this person has no other
        // names", which is a claim nobody made.
        const bundle = await fillOneMember(page, { altNames: '' });

        expect(bundle.groups[0].members[0]).not.toHaveProperty('alt_names');
    });
});
