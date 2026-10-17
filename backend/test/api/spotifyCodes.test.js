/**
 * The codes a Spotify album carries, and which is which.
 *
 * A UPC names the release; an ISRC names each recording on it. The registry
 * already treats the ISRC as a recording's primary identity —
 * `prov:track:isrc:{isrc}` is the first choice of provisional id, ahead of
 * anything derived from a title — so an import that drops the ISRCs throws away
 * the one field that lets the same recording be recognised anywhere else.
 *
 * It was dropping them, and not by oversight: both of Spotify's album endpoints
 * return *simplified* track objects, which carry no `external_ids` at all. The
 * ISRCs have to be asked for separately, from the full-track endpoint.
 */

import { describe, test, expect } from '@jest/globals';
import { SpotifyClient } from '../../src/api/spotifyClient.js';

/**
 * A client whose HTTP layer is a lookup table.
 *
 * `_get` is the single seam every request goes through, so stubbing it tests
 * the paging and batching above it without a network or a token.
 */
function clientServing(responses) {
    const client = new SpotifyClient({ clientId: 'id', clientSecret: 'secret' });
    const asked = [];
    client._get = async (path) => {
        asked.push(path);
        // Longest prefix wins: '/albums/long/tracks' and '/albums/long' both
        // match the paging call, and answering it with the album object would
        // look like an empty page and silently truncate the tracklist.
        const match = Object.keys(responses)
            .filter((prefix) => path.startsWith(prefix))
            .sort((a, b) => b.length - a.length)[0];
        if (!match) throw new Error(`unexpected request: ${path}`);
        return responses[match];
    };
    client.asked = asked;
    return client;
}

const simplified = (n) => Array.from({ length: n }, (_, i) => ({
    id: `t${i}`, name: `Track ${i + 1}`, track_number: i + 1, disc_number: 1, duration_ms: 1000,
}));

const full = (ids) => ({
    tracks: ids.map((id) => ({ id, external_ids: { isrc: `ISRC${id.toUpperCase()}` } })),
});

describe('getAlbumWithTracks', () => {
    test('carries the album UPC', async () => {
        const client = clientServing({
            '/albums/alb': {
                id: 'alb', name: 'Suicide Invoice', release_date: '2002-09-24',
                total_tracks: 2, external_ids: { upc: '724353967628' },
                tracks: { items: simplified(2) },
            },
            '/tracks?ids=': full(['t0', 't1']),
        });

        const album = await client.getAlbumWithTracks('alb');

        expect(album.upc).toBe('724353967628');
    });

    test('and an ISRC for every track', async () => {
        const client = clientServing({
            '/albums/alb': {
                id: 'alb', name: 'Album', total_tracks: 2, external_ids: { upc: '1' },
                tracks: { items: simplified(2) },
            },
            '/tracks?ids=': full(['t0', 't1']),
        });

        const album = await client.getAlbumWithTracks('alb');

        expect(album.tracks.map((t) => t.isrc)).toEqual(['ISRCT0', 'ISRCT1']);
    });

    test('a track Spotify has no ISRC for comes back null, not missing', async () => {
        // The field has to be present either way: a form that reads
        // `track.isrc` to decide whether to look the recording up elsewhere
        // cannot tell "no ISRC" from "we never asked".
        const client = clientServing({
            '/albums/alb': {
                id: 'alb', name: 'Album', total_tracks: 2, external_ids: {},
                tracks: { items: simplified(2) },
            },
            '/tracks?ids=': { tracks: [{ id: 't0', external_ids: {} }, null] },
        });

        const album = await client.getAlbumWithTracks('alb');

        expect(album.tracks[0].isrc).toBeNull();
        expect(album.tracks[1].isrc).toBeNull();
        expect(album.upc).toBeNull();
    });

    test('a long release pays one request per fifty tracks, not one per track', async () => {
        // The reason this is batched rather than per-track: a box set would
        // otherwise spend a hundred requests of somebody else's quota.
        const client = clientServing({
            '/albums/box': {
                id: 'box', name: 'Box', total_tracks: 60, external_ids: { upc: '9' },
                tracks: { items: simplified(60) },
            },
            '/tracks?ids=': full(simplified(60).map((t) => t.id)),
        });

        const album = await client.getAlbumWithTracks('box');

        const trackCalls = client.asked.filter((p) => p.startsWith('/tracks?ids='));
        expect(trackCalls).toHaveLength(2);
        expect(album.tracks).toHaveLength(60);
    });

    test('the ISRC lookup does not disturb the paging it reads from', async () => {
        // The album object carries only the first page. Asking for ISRCs after
        // paging must see the whole list, not the first fifty.
        const client = clientServing({
            '/albums/long': {
                id: 'long', name: 'Long', total_tracks: 55, external_ids: {},
                tracks: { items: simplified(50) },
            },
            '/albums/long/tracks': { items: simplified(55).slice(50) },
            '/tracks?ids=': full(simplified(55).map((t) => t.id)),
        });

        const album = await client.getAlbumWithTracks('long');

        expect(album.tracks).toHaveLength(55);
        expect(album.tracks.every((t) => t.isrc)).toBe(true);
    });
});

describe('isrcsForTracks', () => {
    test('is empty for no ids, and asks nothing', async () => {
        const client = clientServing({});
        expect(await client.isrcsForTracks([])).toEqual(new Map());
        expect(client.asked).toEqual([]);
    });

    test('ignores ids Spotify answers with null', async () => {
        const client = clientServing({ '/tracks?ids=': { tracks: [null, { id: 'b', external_ids: { isrc: 'X' } }] } });
        const found = await client.isrcsForTracks(['a', 'b']);
        expect([...found]).toEqual([['b', 'X']]);
    });
});
