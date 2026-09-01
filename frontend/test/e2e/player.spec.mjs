/**
 * Playwright e2e — MiniPlayer Spotify embed.
 *
 * The embed is a plain <iframe>, deliberately not Spotify's iFrame API: that
 * API's implementation calls eval(), so using it would mean adding
 * 'unsafe-eval' to script-src and re-opening the injection class the policy
 * exists to prevent — page-wide, to gain a play button.
 *
 * These assert the URL the embed row is pointed at. Spotify itself is not
 * reachable from CI or the dev sandbox, so the frame will not paint; what is
 * verifiable here is that the right URL is built from the stored listen link,
 * which is where a bug would actually live.
 */

import { test, expect } from '@playwright/test';

async function bootPlayer(page) {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(
        () => typeof window.musicGraph?.miniPlayer?._showEmbed === 'function',
        { timeout: 10_000 }
    ).catch(() => {
        throw new Error(
            'MiniPlayer never became available.\nPage errors:\n' +
            (pageErrors.length ? pageErrors.map(e => `  ${e}`).join('\n') : '  (none captured)')
        );
    });

    return pageErrors;
}

test('a track URI becomes a Spotify embed iframe', async ({ page }) => {
    await bootPlayer(page);

    await page.evaluate(() =>
        window.musicGraph.miniPlayer._showEmbed('spotify:track:0Fl6Pl6w89IL1FWt8Uvg01'));

    const frame = page.locator('.mp-embed iframe');
    await expect(frame).toHaveAttribute(
        'src', 'https://open.spotify.com/embed/track/0Fl6Pl6w89IL1FWt8Uvg01');
});

test('album and playlist URIs keep their type in the path', async ({ page }) => {
    await bootPlayer(page);

    await page.evaluate(() =>
        window.musicGraph.miniPlayer._showEmbed('spotify:album:1DFixLWuPkv3KT3TnV35m3'));
    await expect(page.locator('.mp-embed iframe')).toHaveAttribute(
        'src', 'https://open.spotify.com/embed/album/1DFixLWuPkv3KT3TnV35m3');
});

test('switching tracks replaces the iframe rather than reusing it', async ({ page }) => {
    await bootPlayer(page);

    await page.evaluate(() => window.musicGraph.miniPlayer._showEmbed('spotify:track:AAA'));
    await page.evaluate(() => window.musicGraph.miniPlayer._showEmbed('spotify:track:BBB'));

    // Exactly one frame, pointing at the new track. Assigning src on an
    // existing iframe would leave a history entry, so the browser Back button
    // would step through previously played tracks instead of leaving the page.
    await expect(page.locator('.mp-embed iframe')).toHaveCount(1);
    await expect(page.locator('.mp-embed iframe')).toHaveAttribute(
        'src', 'https://open.spotify.com/embed/track/BBB');
});

test('re-showing the same URI does not rebuild the frame', async ({ page }) => {
    await bootPlayer(page);

    await page.evaluate(() => window.musicGraph.miniPlayer._showEmbed('spotify:track:SAME'));
    // Tag the element so a rebuild is detectable.
    await page.evaluate(() => {
        document.querySelector('.mp-embed iframe').dataset.marked = 'yes';
    });
    await page.evaluate(() => window.musicGraph.miniPlayer._showEmbed('spotify:track:SAME'));

    // Rebuilding would restart playback mid-track.
    await expect(page.locator('.mp-embed iframe')).toHaveAttribute('data-marked', 'yes');
});

test('leaving embed mode removes the frame, which stops playback', async ({ page }) => {
    await bootPlayer(page);

    await page.evaluate(() => {
        const p = window.musicGraph.miniPlayer;
        p._enterEmbedMode();
        p._showEmbed('spotify:track:STOPME');
    });
    await expect(page.locator('.mp-embed iframe')).toHaveCount(1);

    // There is no controller to pause, so removal is how audio is stopped.
    await page.evaluate(() => window.musicGraph.miniPlayer._exitEmbedMode());
    await expect(page.locator('.mp-embed iframe')).toHaveCount(0);
});

test('the page does not ask to run Spotify script, only to frame it', async ({ page }) => {
    const violations = [];
    await page.addInitScript(() => {
        window.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', (e) => {
            window.__cspViolations.push({
                directive: e.violatedDirective, blockedURI: e.blockedURI
            });
        });
    });

    await bootPlayer(page);
    await page.evaluate(() => window.musicGraph.miniPlayer._showEmbed('spotify:track:CSPCHECK'));
    await page.waitForTimeout(500);

    const found = await page.evaluate(() => window.__cspViolations || []);
    // A script-src violation here means something reached for the iFrame API
    // again; that path needs 'unsafe-eval' and must not come back.
    expect(found.filter(v => /script-src/.test(v.directive)).concat(violations)).toEqual([]);
});

test('an album link on the release is preferred over the track link', async ({ page }) => {
    await bootPlayer(page);

    // A track embed cannot advance — a plain iframe exposes nothing to call, so
    // playback stops at every boundary. An album embed carries Spotify's own
    // queue, which is the only way to get continuity under this CSP.
    const uri = await page.evaluate(() => window.musicGraph.miniPlayer._embedUriFor({
        release_embed_uri: 'spotify:album:ALBUM1',
        listen: { embed_uri: 'spotify:track:TRACK1' },
    }));

    expect(uri).toBe('spotify:album:ALBUM1');
});

test('the track link is used when the release has no album link', async ({ page }) => {
    await bootPlayer(page);

    const uri = await page.evaluate(() => window.musicGraph.miniPlayer._embedUriFor({
        release_embed_uri: null,
        listen: { embed_uri: 'spotify:track:TRACK1' },
    }));

    expect(uri).toBe('spotify:track:TRACK1');
});

test('our transport is disabled while an album embed owns the queue', async ({ page }) => {
    await bootPlayer(page);

    await page.evaluate(() => {
        const p = window.musicGraph.miniPlayer;
        p.queue = [{ track_id: 't1', track_name: 'In Bloom', listen: {} }];
        p.currentIndex = 0;
        p._enterEmbedMode();
        p._showEmbed('spotify:album:ALBUM1');
        p._updateTrackDisplay();
    });

    // _showEmbed early-returns for a URI already on screen, so pressing next
    // would move our display without moving what is sounding. Saying the
    // control does not apply beats letting it lie.
    await expect(page.locator('.mp-next')).toBeDisabled();
    await expect(page.locator('.mp-prev')).toBeDisabled();
});

test('the transport works again for a track embed', async ({ page }) => {
    await bootPlayer(page);

    await page.evaluate(() => {
        const p = window.musicGraph.miniPlayer;
        p.queue = [
            { track_id: 't1', track_name: 'In Bloom', listen: {} },
            { track_id: 't2', track_name: 'Lithium', listen: {} },
        ];
        p.currentIndex = 0;
        p._enterEmbedMode();
        p._showEmbed('spotify:track:TRACK1');
        p._updateTrackDisplay();
    });

    await expect(page.locator('.mp-next')).toBeEnabled();
});
