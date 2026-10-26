#!/usr/bin/env node
/**
 * @fileoverview Show what a Bandcamp page yields, today.
 *
 * Bandcamp publishes no API and no versioned markup. The importer reads two
 * structures off the page — schema.org JSON-LD and the embedded player data —
 * and either can change without notice, taking the import with it. The unit
 * tests prove the parser handles the shapes it claims to; only this proves the
 * shapes are still the ones Bandcamp serves.
 *
 * It was also the verification its author could not do: the container this was
 * written in cannot resolve bandcamp.com, so every fixture in
 * test/api/bandcampClient.test.js is built from the documented vocabulary
 * rather than from a live page. Run this against a real release before
 * trusting the import, and again whenever one stops working.
 *
 * Usage:
 *
 *   docker compose exec api node scripts/checkBandcamp.js <album-url>
 *   docker compose exec api node scripts/checkBandcamp.js <album-url> --raw
 *
 * `--raw` prints the structures as found, before any interpretation, which is
 * what to paste into a bug report when a field has moved.
 *
 * Needs no credentials and no environment: there are none to have.
 */

import {
    BandcampClient, parseBandcampUrl, extractJsonLd, musicAlbumFrom, extractTralbum,
    albumFromPage,
} from '../src/api/bandcampClient.js';

const RAW = process.argv.includes('--raw');

/** @param {string} label @param {boolean} ok @param {string} detail */
function say(label, ok, detail = '') {
    console.log(`   ${ok ? 'OK ' : '-- '} ${label}${detail ? `: ${detail}` : ''}`);
}

async function main() {
    const url = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
    if (!url) {
        console.error('Usage: node scripts/checkBandcamp.js <bandcamp album url> [--raw]');
        return 2;
    }

    console.log('1. The link');
    const target = parseBandcampUrl(url);
    if (!target) {
        say('a Bandcamp album or track URL', false,
            'not one — a label on its own domain cannot be read from the URL alone');
        return 1;
    }
    say(`${target.kind} page`, true, target.url);

    console.log('\n2. The page');
    const client = new BandcampClient();
    let html;
    try {
        const response = await fetch(target.url, {
            headers: { 'User-Agent': 'PolarisMusicRegistry/1.0 ( https://polaris.mu ) check', Accept: 'text/html' },
        });
        say(`HTTP ${response.status}`, response.ok);
        if (!response.ok) return 1;
        html = await response.text();
        say('bytes', true, String(html.length));
    } catch (error) {
        say('fetch', false, error.message);
        console.log('\n   No outbound access to bandcamp.com from this container.');
        return 1;
    }

    console.log('\n3. The structures the importer reads');
    const blocks = extractJsonLd(html);
    const album = musicAlbumFrom(blocks);
    say(`${blocks.length} JSON-LD block(s)`, blocks.length > 0,
        blocks.map((b) => [b?.['@type']].flat().join('/')).join(', '));
    say('a MusicAlbum among them', Boolean(album), album ? Object.keys(album).join(', ') : '');

    const tralbum = extractTralbum(html);
    say('embedded player data', Boolean(tralbum),
        tralbum ? Object.keys(tralbum).join(', ') : 'neither data-tralbum nor TralbumData');

    if (RAW) {
        console.log('\n   --- JSON-LD album, as found ---');
        console.log(JSON.stringify(album, null, 2));
        console.log('\n   --- player data, as found (trackinfo trimmed to 2) ---');
        console.log(JSON.stringify(
            tralbum ? { ...tralbum, trackinfo: (tralbum.trackinfo ?? []).slice(0, 2) } : null,
            null, 2));
    }

    console.log('\n4. What the import would fill in');
    const release = albumFromPage(html, target.url);
    if (!release) {
        say('a release', false, 'nothing readable — the markup has moved; run again with --raw');
        return 1;
    }

    say('name', Boolean(release.name), release.name);
    say('artist', Boolean(release.artist), release.artist ?? '');
    say('release date', Boolean(release.release_date), release.release_date);
    say('label', Boolean(release.label),
        release.label ?? 'none stated — self-released, or the page is the act\'s own');
    say('format', Boolean(release.format), release.format ?? '');
    say('other editions', release.other_editions.length > 0,
        release.other_editions.length
            ? `${release.other_editions.join(', ')} — each a Release of its own to submit`
            : 'none sold beside the digital album');
    say('upc', Boolean(release.upc), release.upc ?? 'none — Bandcamp rarely carries one');
    say('artist photo', Boolean(release.artist_photo),
        release.artist_photo ?? 'none on the band page');
    say(`${release.tracks.length} track(s)`, release.tracks.length > 0,
        release.tracks.slice(0, 3).map((t) =>
            `${t.position}. ${t.title}${t.duration ? ` (${t.duration}s)` : ' (no duration)'}`)
            .join(' | '));
    say('durations', release.tracks.every((t) => t.duration != null),
        `${release.tracks.filter((t) => t.duration != null).length} of ${release.tracks.length}`);
    say('tags', release.tags.length > 0, release.tags.join(', '));
    say('credits', Boolean(release.credits),
        release.credits ? `${release.credits.split('\n').length} line(s), free text` : 'none typed');
    const withPages = release.tracks.filter((t) => t.url);
    say('track pages', withPages.length > 0,
        `${withPages.length} of ${release.tracks.length}${withPages.length
            ? ` — e.g. ${withPages[0].url}` : ''}`);
    // Only a compilation states a per-track act, and the field names here are
    // the one thing in this importer never seen on a live compilation page.
    // Paste a label sampler through this and the next line settles it.
    const perTrack = release.tracks.filter((t) => t.artist);
    say('per-track acts', perTrack.length > 0,
        perTrack.length
            ? `${perTrack.length} of ${release.tracks.length} — e.g. ${perTrack[0].artist}`
            : 'none stated, so every track is the release act (right for a '
              + 'single-act record; run a compilation through to check)');

    const fragments = release.tracks.filter((t) => t.url && t.url.includes('#'));
    say('no album-page fragments as track links', fragments.length === 0,
        fragments.length ? `${fragments.length} slipped through: ${fragments[0].url}` : 'clean');

    console.log('\n   Credits are free text on Bandcamp — no roles, no per-person fields.');
    console.log('   They land in liner notes; people are not invented from them.');

    return 0;
}

// Only when run, not when imported.
if (process.argv[1] && process.argv[1].endsWith('checkBandcamp.js')) {
    main()
        .then((code) => process.exit(code))
        .catch((error) => {
            console.error('check failed:', error.message);
            process.exit(1);
        });
}
