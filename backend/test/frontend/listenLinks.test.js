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
    isBandcampLink,
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
        ['an unmodelled service', 'https://artist.bandcamp.com/track/foo'],
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
        // The submitter took the trouble to add it; drop the tracking, not the
        // link. Bandcamp rather than Apple Music, which is now modelled — the
        // services Odesli answers for are each parsed properly.
        expect(canonicalizeListenLink('https://artist.bandcamp.com/track/foo?utm_source=x'))
            .toBe('https://artist.bandcamp.com/track/foo');
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

describe('Deezer', () => {
    /**
     * Recognized because the backend resolves Deezer links from a track's
     * ISRC. An unrecognized link is only tracking-stripped, so two spellings
     * of the same track compare unequal and the field ends up holding both.
     */
    test('a track link canonicalizes', () => {
        expect(normalizeListenLink('https://www.deezer.com/track/3135556')).toEqual({
            service: 'deezer', type: 'track', id: '3135556',
            url: 'https://www.deezer.com/track/3135556',
        });
    });

    test('a bare locale segment is not the type', () => {
        // Deezer writes /en/track/123 where Spotify writes /intl-de/track/123.
        expect(normalizeListenLink('https://www.deezer.com/en/track/3135556')?.url)
            .toBe('https://www.deezer.com/track/3135556');
    });

    test('the www is optional', () => {
        expect(normalizeListenLink('https://deezer.com/track/3135556')?.url)
            .toBe('https://www.deezer.com/track/3135556');
    });

    test('a share token is dropped', () => {
        expect(normalizeListenLink('https://www.deezer.com/en/track/3135556?utm_source=share')?.url)
            .toBe('https://www.deezer.com/track/3135556');
    });

    test('an album link is kept as an album link', () => {
        expect(normalizeListenLink('https://www.deezer.com/album/302127')).toMatchObject({
            service: 'deezer', type: 'album', id: '302127',
        });
    });

    test('two spellings of the same track are the same target', () => {
        // The reason any of this matters: without it, resolving a Deezer link
        // for a track that already has one appends a near-duplicate.
        expect(sameTarget(
            'https://www.deezer.com/en/track/3135556?utm_source=share',
            'https://deezer.com/track/3135556',
        )).toBe(true);
    });

    test('a Deezer track and a Spotify track are not the same target', () => {
        expect(sameTarget(
            'https://www.deezer.com/track/3135556',
            'https://open.spotify.com/track/3135556',
        )).toBe(false);
    });

    test('a short link is not parsed into an id', () => {
        // deezer.page.link/xyz is an opaque token only a redirect resolves.
        // It is kept, tracking-stripped, rather than turned into a guess.
        expect(normalizeListenLink('https://deezer.page.link/abc123')).toBeNull();
        expect(canonicalizeListenLink('https://deezer.page.link/abc123?utm_source=x'))
            .toBe('https://deezer.page.link/abc123');
    });

    test('a lookalike host is not Deezer', () => {
        expect(normalizeListenLink('https://deezer.com.evil.test/track/1')).toBeNull();
    });

    test('a page with no type and id is not a link to anything', () => {
        expect(normalizeListenLink('https://www.deezer.com/en')).toBeNull();
        expect(normalizeListenLink('https://www.deezer.com/')).toBeNull();
    });

    test('Spotify still refuses a bare locale, which it does not use', () => {
        // The locale rule is per service on purpose. Widening it for everyone
        // would make /us/album/foo parse as an album on a host that means
        // something else by that path.
        expect(normalizeListenLink('https://open.spotify.com/en/track/abc')).toBeNull();
    });
});

describe('the services Odesli answers for', () => {
    /**
     * Each of these is stored because Odesli resolves it, and each is parsed
     * because an unparsed link is only tracking-stripped — which means two
     * spellings of one track compare unequal and a second import appends a
     * near-duplicate beside the first.
     *
     * Apple, Amazon and both YouTubes keep the thing being linked to in a query
     * parameter, which is the whole reason the table grew a per-service parser:
     * a path-only read turns every Apple track link into its album, collapsing
     * every song on a record into one identity.
     */
    describe('Apple Music', () => {
        const TRACK = 'https://music.apple.com/us/album/fire-of-unknown-origin/1443000516?i=1443000890';

        test('a track is the song, not the album it sits in', () => {
            expect(normalizeListenLink(TRACK)).toEqual({
                service: 'apple',
                type: 'track',
                id: '1443000890',
                url: 'https://music.apple.com/us/album/1443000516?i=1443000890',
            });
        });

        test('two songs from one album are two identities', () => {
            // The failure a path-only parser causes, stated as a test.
            const other = TRACK.replace('i=1443000890', 'i=1443000891');
            expect(sameTarget(TRACK, other)).toBe(false);
        });

        test('an album link stays an album link', () => {
            expect(normalizeListenLink('https://music.apple.com/gb/album/x/1443000516'))
                .toMatchObject({ type: 'album', id: '1443000516' });
        });

        test('the slug is decoration and does not fork the identity', () => {
            // Apple ignores it, and it changes when a title is edited.
            expect(sameTarget(TRACK, TRACK.replace('fire-of-unknown-origin', 'anything-else')))
                .toBe(true);
        });

        test('the same song in two storefronts is one song', () => {
            // The storefront is part of a working link and no part of what the
            // link points at.
            expect(sameTarget(TRACK, TRACK.replace('/us/', '/gb/'))).toBe(true);
        });

        test('a storefront is kept in the canonical url, since a link needs one', () => {
            expect(normalizeListenLink(TRACK.replace('/us/', '/gb/')).url)
                .toContain('/gb/album/');
        });
    });

    describe('Tidal', () => {
        test('browse and bare paths are the same track', () => {
            expect(sameTarget('https://tidal.com/browse/track/12345',
                'https://tidal.com/track/12345')).toBe(true);
        });

        test('canonicalizes to the share form', () => {
            expect(normalizeListenLink('https://listen.tidal.com/track/12345').url)
                .toBe('https://tidal.com/browse/track/12345');
        });
    });

    describe('YouTube Music', () => {
        test('the id comes out of the query, not the path', () => {
            expect(normalizeListenLink('https://music.youtube.com/watch?v=dQw4w9WgXcQ'))
                .toMatchObject({ service: 'youtubeMusic', type: 'track', id: 'dQw4w9WgXcQ' });
        });

        test('a tracking parameter does not change the identity', () => {
            expect(sameTarget(
                'https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=abc&t=42',
                'https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
        });

        test('a track inside a playlist is the track', () => {
            // A link can carry both; what it points at is the song.
            expect(normalizeListenLink('https://music.youtube.com/watch?v=abc&list=PL123'))
                .toMatchObject({ type: 'track', id: 'abc' });
        });

        test('a playlist on its own is a playlist', () => {
            expect(normalizeListenLink('https://music.youtube.com/playlist?list=PL123'))
                .toMatchObject({ type: 'playlist', id: 'PL123' });
        });

        test('YouTube proper is a different service from YouTube Music', () => {
            // Same id, different place to listen; the registry stores both.
            expect(sameTarget('https://music.youtube.com/watch?v=abc',
                'https://www.youtube.com/watch?v=abc')).toBe(false);
        });

        test('a youtu.be short link carries the id as its path', () => {
            expect(normalizeListenLink('https://youtu.be/dQw4w9WgXcQ'))
                .toMatchObject({ service: 'youtube', type: 'track', id: 'dQw4w9WgXcQ' });
        });
    });

    describe('Amazon Music', () => {
        test('a track is the trackAsin, not the album', () => {
            expect(normalizeListenLink(
                'https://music.amazon.com/albums/B01N4OBGK4?trackAsin=B01N2V1OTO'))
                .toMatchObject({ type: 'track', id: 'B01N2V1OTO' });
        });

        test('an album without one is the album', () => {
            expect(normalizeListenLink('https://music.amazon.com/albums/B01N4OBGK4'))
                .toMatchObject({ type: 'album', id: 'B01N4OBGK4' });
        });

        test('a regional host is the same service', () => {
            expect(normalizeListenLink('https://music.amazon.co.uk/albums/B01N4OBGK4')?.service)
                .toBe('amazonMusic');
        });
    });

    describe('SoundCloud', () => {
        test('the path is the identity', () => {
            expect(normalizeListenLink('https://soundcloud.com/artist/some-track'))
                .toEqual({
                    service: 'soundcloud', type: 'track', id: 'artist/some-track',
                    url: 'https://soundcloud.com/artist/some-track',
                });
        });

        test('a set is a playlist', () => {
            expect(normalizeListenLink('https://soundcloud.com/artist/sets/an-ep'))
                .toMatchObject({ type: 'playlist', id: 'artist/sets/an-ep' });
        });

        test('an artist page is not a track', () => {
            expect(normalizeListenLink('https://soundcloud.com/artist'))
                .toMatchObject({ type: 'artist', id: 'artist' });
        });
    });

    describe('Pandora', () => {
        /**
         * Added after the live answer contradicted the assumption this table
         * was built on. Odesli returned `https://www.pandora.com/TR:5661544`
         * for a Spotify track on 2026-10-22 — a prefixed id, not the slug soup
         * the omission was justified by.
         */
        test('a prefixed id is the identity, which is what their API hands out', () => {
            expect(normalizeListenLink('https://www.pandora.com/TR:5661544')).toEqual({
                service: 'pandora',
                type: 'track',
                id: 'TR:5661544',
                url: 'https://www.pandora.com/TR:5661544',
            });
        });

        test.each([
            ['an album', 'https://www.pandora.com/AL:123', 'album', 'AL:123'],
            ['an artist', 'https://www.pandora.com/AR:9', 'artist', 'AR:9'],
            ['a playlist', 'https://www.pandora.com/PL:7', 'playlist', 'PL:7'],
        ])('%s keeps its own kind', (_label, url, type, id) => {
            expect(normalizeListenLink(url)).toMatchObject({ type, id });
        });

        test('the same track under two hosts is one link', () => {
            // The point of parsing it at all: an unparsed link is only
            // tracking-stripped, so a second import appends a near-duplicate.
            expect(sameTarget('https://www.pandora.com/TR:5661544',
                'https://pandora.com/TR:5661544?utm_source=x')).toBe(true);
        });

        test('the readable path is read by depth', () => {
            const artist = 'https://www.pandora.com/artist/queens-of-the-stone-age';
            expect(normalizeListenLink(artist)).toMatchObject({ type: 'artist' });
            expect(normalizeListenLink(`${artist}/songs-for-the-deaf`))
                .toMatchObject({ type: 'album' });
            expect(normalizeListenLink(`${artist}/songs-for-the-deaf/no-one-knows`))
                .toMatchObject({ type: 'track', id: 'artist/queens-of-the-stone-age/'
                    + 'songs-for-the-deaf/no-one-knows' });
        });

        test('a slug and an id are not assumed to be the same recording', () => {
            // Nothing here can map one onto the other without asking Pandora,
            // and claiming they are the same recording would be a wrong link
            // rather than a duplicate one.
            expect(sameTarget('https://www.pandora.com/TR:5661544',
                'https://www.pandora.com/artist/qotsa/songs-for-the-deaf/no-one-knows'))
                .toBe(false);
        });

        test.each([
            ['a dynamic short link', 'https://pandora.app.link/abc123'],
            ['a station', 'https://www.pandora.com/station/play/12345'],
        ])('%s is left unparsed rather than guessed at', (_label, url) => {
            // An opaque token only a redirect resolves; parsing it would mean
            // inventing an id. Still stored, just not deduplicated.
            expect(normalizeListenLink(url)).toBeNull();
        });
    });

    test('every service Odesli answers for is recognized', () => {
        const resolved = {
            spotify: 'https://open.spotify.com/track/abc',
            apple: 'https://music.apple.com/us/album/x/1?i=2',
            deezer: 'https://www.deezer.com/track/1',
            tidal: 'https://tidal.com/browse/track/1',
            youtubeMusic: 'https://music.youtube.com/watch?v=a',
            youtube: 'https://www.youtube.com/watch?v=a',
            amazonMusic: 'https://music.amazon.com/albums/B01?trackAsin=B02',
            soundcloud: 'https://soundcloud.com/a/b',
            pandora: 'https://www.pandora.com/TR:5661544',
        };

        for (const [service, url] of Object.entries(resolved)) {
            expect(normalizeListenLink(url)?.service).toBe(service);
        }
    });
});

describe('spotting a Bandcamp page, which is only a routing question', () => {
    // A Bandcamp URL names no id: the slug is the title and the numeric ids
    // live in the page, not the address. So this is not normalizeListenLink's
    // job — the import box only needs to know where to send it, and the server
    // decides whether it is really a release.
    test.each([
        ['an album page', 'https://howlinrain.bandcamp.com/album/watermelon'],
        ['a track page', 'https://howlinrain.bandcamp.com/track/fall-away'],
        ['the bare subdomain', 'https://howlinrain.bandcamp.com'],
        ['bandcamp.com itself', 'https://bandcamp.com/discover'],
        ['http rather than https', 'http://howlinrain.bandcamp.com/album/watermelon'],
        ['a host cased oddly', 'https://HowlinRain.Bandcamp.COM/album/watermelon'],
        ['padding around it', '  https://howlinrain.bandcamp.com/album/watermelon  '],
    ])('%s is one', (_label, url) => {
        expect(isBandcampLink(url)).toBe(true);
    });

    test.each([
        ['a Spotify album', 'https://open.spotify.com/album/ALB1'],
        ['a Discogs release', 'https://www.discogs.com/release/249504'],
        // The suffix trap: a host ending in the string is not a subdomain of it.
        ['a lookalike host', 'https://notbandcamp.com/album/x'],
        ['the name in the path only', 'https://example.com/bandcamp.com/album/x'],
        ['the name in a query', 'https://example.com/?to=howlinrain.bandcamp.com'],
        ['not a URL at all', '249504'],
        ['nothing', ''],
        ['not a string', null],
    ])('%s is not', (_label, url) => {
        expect(isBandcampLink(url)).toBe(false);
    });

    test('a label on its own domain cannot be spotted, and is not guessed at', () => {
        // Bandcamp lets a label point its own domain at a store. Nothing in the
        // URL distinguishes that from any other website, so it routes to the
        // Discogs parser and reports what it is: an unrecognised link. Pasting
        // the bandcamp.com address of the same record works.
        expect(isBandcampLink('https://silvercurrent.com/album/watermelon')).toBe(false);
    });
});
