/**
 * Unit tests for the frontend listen-link normalizer.
 *
 * Lives under backend/test because the frontend has no unit-test runner of its
 * own — its only harness is Playwright, and driving a browser to check string
 * parsing would be absurd. The module is plain ESM with no Vite-specific
 * imports, so it loads here directly.
 *
 * What is being protected: a link's stored form must depend on the recording
 * it points at and nothing else. Spotify's share button appends a `?si=`
 * session token and, for non-English users, an `/intl-de/` path segment. Both
 * describe whoever copied the link. Left in, the same track submitted by two
 * people produces two different strings, and the release-level cross-check
 * that compares track links reports mismatches that are not real.
 */

import { describe, test, expect } from '@jest/globals';
import {
    normalizeListenLink,
    canonicalizeListenLink,
    stripTrackingParams,
    sameTarget
} from '../../../frontend/src/utils/listenLinks.js';

const TRACK = '0Fl6Pl6w89IL1FWt8Uvg01';

describe('normalizeListenLink', () => {
    test('a plain track URL keeps its identity', () => {
        expect(normalizeListenLink(`https://open.spotify.com/track/${TRACK}`)).toEqual({
            service: 'spotify',
            type: 'track',
            id: TRACK,
            url: `https://open.spotify.com/track/${TRACK}`
        });
    });

    test('the locale segment is dropped', () => {
        // Spotify serves /intl-de/ to German users; the link is the same track.
        expect(normalizeListenLink(`https://open.spotify.com/intl-de/track/${TRACK}`).url)
            .toBe(`https://open.spotify.com/track/${TRACK}`);
    });

    test('the share token is dropped', () => {
        expect(normalizeListenLink(`https://open.spotify.com/track/${TRACK}?si=9f2c1`).url)
            .toBe(`https://open.spotify.com/track/${TRACK}`);
    });

    test('an embed URL resolves to the canonical one', () => {
        expect(normalizeListenLink(`https://open.spotify.com/embed/track/${TRACK}`).url)
            .toBe(`https://open.spotify.com/track/${TRACK}`);
    });

    test('a bare spotify: URI is accepted', () => {
        expect(normalizeListenLink('spotify:album:1DFixLWuPkv3KT3TnV35m3')).toEqual({
            service: 'spotify',
            type: 'album',
            id: '1DFixLWuPkv3KT3TnV35m3',
            url: 'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3'
        });
    });

    test('album and track are not conflated', () => {
        const album = normalizeListenLink(`https://open.spotify.com/album/${TRACK}`);
        const track = normalizeListenLink(`https://open.spotify.com/track/${TRACK}`);
        // Same id, different things. Collapsing these would attach an album to
        // a track, which is exactly the mismatch the report exists to catch.
        expect(album.type).toBe('album');
        expect(track.type).toBe('track');
        expect(album.url).not.toBe(track.url);
    });

    test('www. is tolerated', () => {
        expect(normalizeListenLink(`https://www.open.spotify.com/track/${TRACK}`)?.id).toBe(TRACK);
    });

    test.each([
        ['an unmodelled service', 'https://music.apple.com/us/album/foo/123'],
        ['a URL with no id', 'https://open.spotify.com/track'],
        ['an unknown path type', `https://open.spotify.com/nonsense/${TRACK}`],
        ['plain text', 'not a url'],
        ['an empty string', ''],
        ['a non-string', null]
    ])('returns null for %s', (_label, input) => {
        // Null rather than a guess: storing an unparsed URL as though we
        // understood it is worse than admitting we did not.
        expect(normalizeListenLink(input)).toBeNull();
    });
});

describe('stripTrackingParams', () => {
    test('campaign and session params go, real ones stay', () => {
        const cleaned = stripTrackingParams(
            'https://example.com/x?utm_source=news&si=abc&t=42');
        expect(cleaned).toContain('t=42');
        expect(cleaned).not.toContain('utm_source');
        expect(cleaned).not.toContain('si=');
    });

    test('an unparseable string is returned unchanged', () => {
        expect(stripTrackingParams('not a url')).toBe('not a url');
    });
});

describe('canonicalizeListenLink', () => {
    test('a known service is canonicalized', () => {
        expect(canonicalizeListenLink(`https://open.spotify.com/intl-fr/track/${TRACK}?si=x`))
            .toBe(`https://open.spotify.com/track/${TRACK}`);
    });

    test('an unmodelled service is kept but cleaned', () => {
        // The submitter took the trouble to add it; drop the tracking, not the link.
        expect(canonicalizeListenLink('https://music.apple.com/us/album/foo/123?utm_source=x'))
            .toBe('https://music.apple.com/us/album/foo/123');
    });

    test('something that is not a URL at all is rejected', () => {
        expect(canonicalizeListenLink('not a url')).toBeNull();
    });
});

describe('sameTarget', () => {
    test('a locale-prefixed link matches its plain twin', () => {
        // The reason normalization exists: without it these compare unequal
        // and the import report flags a mismatch that is not there.
        expect(sameTarget(
            `https://open.spotify.com/intl-de/track/${TRACK}?si=abc`,
            `https://open.spotify.com/track/${TRACK}`
        )).toBe(true);
    });

    test('a bare URI matches the equivalent URL', () => {
        expect(sameTarget(`spotify:track:${TRACK}`,
            `https://open.spotify.com/track/${TRACK}`)).toBe(true);
    });

    test('different ids do not match', () => {
        expect(sameTarget(`https://open.spotify.com/track/${TRACK}`,
            'https://open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
    });

    test('a track does not match the album of the same id', () => {
        expect(sameTarget(`https://open.spotify.com/track/${TRACK}`,
            `https://open.spotify.com/album/${TRACK}`)).toBe(false);
    });

    test('a known service never matches an unknown one', () => {
        expect(sameTarget(`https://open.spotify.com/track/${TRACK}`,
            'https://music.apple.com/us/album/foo/123')).toBe(false);
    });

    test('two unmodelled links match on their cleaned form', () => {
        expect(sameTarget(
            'https://music.apple.com/us/album/foo/123?utm_source=a',
            'https://music.apple.com/us/album/foo/123?si=b'
        )).toBe(true);
    });

    test('two unparseable strings do not match', () => {
        // Otherwise every pair of junk values would collapse into one link.
        expect(sameTarget('not a url', 'also not a url')).toBe(false);
    });
});
