/**
 * Unit tests for playerService link normalization.
 *
 * Focus: Spotify URI extraction. A Spotify URL is a web page, not an audio
 * stream, so it can never be inline-playable — but it can be handed to
 * Spotify's embed player, and the MiniPlayer needs a `spotify:{type}:{id}`
 * URI to do that.
 */

import { describe, test, expect } from '@jest/globals';
import { extractSpotifyUri, normalizeListenLinks } from '../../src/api/playerService.js';

describe('extractSpotifyUri', () => {
    test('extracts a track id from a plain open.spotify.com URL', () => {
        expect(extractSpotifyUri('https://open.spotify.com/track/3hoUASQwAAUwpQGXH8VioM'))
            .toBe('spotify:track:3hoUASQwAAUwpQGXH8VioM');
    });

    test('ignores tracking query parameters', () => {
        expect(extractSpotifyUri(
            'https://open.spotify.com/track/3hoUASQwAAUwpQGXH8VioM?utm_source=generator&si=b026f13'
        )).toBe('spotify:track:3hoUASQwAAUwpQGXH8VioM');
    });

    test('strips a locale prefix', () => {
        expect(extractSpotifyUri('https://open.spotify.com/intl-de/track/3hoUASQwAAUwpQGXH8VioM'))
            .toBe('spotify:track:3hoUASQwAAUwpQGXH8VioM');
        expect(extractSpotifyUri('https://open.spotify.com/intl-pt-br/track/3hoUASQwAAUwpQGXH8VioM'))
            .toBe('spotify:track:3hoUASQwAAUwpQGXH8VioM');
    });

    test('unwraps an already-embed URL', () => {
        expect(extractSpotifyUri('https://open.spotify.com/embed/track/3hoUASQwAAUwpQGXH8VioM'))
            .toBe('spotify:track:3hoUASQwAAUwpQGXH8VioM');
    });

    test('accepts a bare spotify: URI', () => {
        expect(extractSpotifyUri('spotify:album:1DFixLWuPkv3KT3TnV35m3'))
            .toBe('spotify:album:1DFixLWuPkv3KT3TnV35m3');
    });

    test('handles albums and playlists', () => {
        expect(extractSpotifyUri('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3'))
            .toBe('spotify:album:1DFixLWuPkv3KT3TnV35m3');
        expect(extractSpotifyUri('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'))
            .toBe('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
    });

    test('rejects non-embeddable Spotify paths', () => {
        expect(extractSpotifyUri('https://open.spotify.com/user/someone')).toBeNull();
        expect(extractSpotifyUri('https://open.spotify.com/')).toBeNull();
    });

    test('rejects non-Spotify and malformed input', () => {
        expect(extractSpotifyUri('https://example.com/song.mp3')).toBeNull();
        expect(extractSpotifyUri('https://bandcamp.com/track/foo')).toBeNull();
        expect(extractSpotifyUri('not a url')).toBeNull();
        expect(extractSpotifyUri(null)).toBeNull();
        expect(extractSpotifyUri(undefined)).toBeNull();
    });

    test('rejects an id with path traversal characters', () => {
        expect(extractSpotifyUri('https://open.spotify.com/track/../../evil')).toBeNull();
    });
});

describe('normalizeListenLinks embed fields', () => {
    test('exposes embed_uri for a Spotify link', () => {
        const result = normalizeListenLinks(['https://open.spotify.com/track/ABC123']);
        expect(result.embed_uri).toBe('spotify:track:ABC123');
        expect(result.embed_service).toBe('spotify');
        // A Spotify page is not an audio stream.
        expect(result.can_inline_play).toBe(false);
    });

    test('a direct audio file stays inline-playable with no embed', () => {
        const result = normalizeListenLinks(['https://cdn.example.com/a.mp3']);
        expect(result.can_inline_play).toBe(true);
        expect(result.playable_url).toBe('https://cdn.example.com/a.mp3');
        expect(result.embed_uri).toBeNull();
        expect(result.embed_service).toBeNull();
    });

    test('both modes are reported when both link kinds are present', () => {
        const result = normalizeListenLinks([
            'https://open.spotify.com/track/ABC123',
            'https://cdn.example.com/a.mp3'
        ]);
        expect(result.can_inline_play).toBe(true);
        expect(result.embed_uri).toBe('spotify:track:ABC123');
    });

    test('empty input yields null embed fields', () => {
        const result = normalizeListenLinks([]);
        expect(result.embed_uri).toBeNull();
        expect(result.embed_service).toBeNull();
    });

    test('a non-Spotify external link has no embed uri', () => {
        const result = normalizeListenLinks(['https://music.apple.com/us/album/x/1']);
        expect(result.can_inline_play).toBe(false);
        expect(result.embed_uri).toBeNull();
        expect(result.preferred_link).toBe('https://music.apple.com/us/album/x/1');
    });
});
