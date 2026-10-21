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

describe('albumIdsByUpc', () => {
    test('asks Spotify for the barcode, filtered', async () => {
        const client = clientServing({ '/search': { albums: { items: [{ id: 'alb1' }] } } });

        expect(await client.albumIdsByUpc('075992733625')).toEqual(['alb1']);
        // The upc: filter is the only identifier-based way into the catalogue;
        // a plain query would match on title and defeat the point.
        expect(client.asked[0]).toContain('q=upc%3A075992733625');
        expect(client.asked[0]).toContain('type=album');
    });

    test('a printed barcode is reduced to digits first', async () => {
        const client = clientServing({ '/search': { albums: { items: [] } } });

        await client.albumIdsByUpc('0 7599-27336-2');

        expect(client.asked[0]).toContain('q=upc%3A07599273362');
    });

    test('asks nothing when there is no barcode', async () => {
        const client = clientServing({});

        expect(await client.albumIdsByUpc('')).toEqual([]);
        expect(await client.albumIdsByUpc(null)).toEqual([]);
        expect(client.asked).toEqual([]);
    });

    test('returns every candidate, in Spotify’s order', async () => {
        const client = clientServing({
            '/search': { albums: { items: [{ id: 'a' }, { id: 'b' }] } },
        });

        expect(await client.albumIdsByUpc('075992733625')).toEqual(['a', 'b']);
    });

    test('tolerates a response with no albums at all', async () => {
        const client = clientServing({ '/search': {} });
        expect(await client.albumIdsByUpc('075992733625')).toEqual([]);
    });

    test('drops items with no id rather than passing undefined along', async () => {
        const client = clientServing({
            '/search': { albums: { items: [null, { name: 'no id' }, { id: 'c' }] } },
        });

        expect(await client.albumIdsByUpc('075992733625')).toEqual(['c']);
    });
});

describe('albumIdsByName', () => {
    /**
     * The last resort, and the only route into the catalogue a release with no
     * printed barcode has. It is guesswork by construction — two databases
     * spell the same release differently — which is why it returns candidates
     * and the caller decides on evidence it has and this client does not.
     *
     * What these tests protect is the query itself: a title put into the query
     * language unescaped silently searches for something else.
     */
    test('searches by title and artist as fields, not as words', async () => {
        const client = clientServing({ '/search': { albums: { items: [{ id: 'alb1' }] } } });

        expect(await client.albumIdsByName('Jimmy Eat World', 'Bleed American'))
            .toEqual(['alb1']);

        const [asked] = client.asked;
        expect(decodeURIComponent(asked)).toContain('album:"Bleed American"');
        expect(decodeURIComponent(asked)).toContain('artist:"Jimmy Eat World"');
        expect(asked).toContain('type=album');
    });

    test('a title alone is a search; an artist alone is not', async () => {
        const client = clientServing({ '/search': { albums: { items: [{ id: 'alb1' }] } } });

        expect(await client.albumIdsByName('', 'Patent Pending')).toEqual(['alb1']);
        expect(decodeURIComponent(client.asked[0])).not.toContain('artist:');

        // An artist with no title is a discography, not a proposal about one
        // release, and ranking it would spend a request to learn nothing.
        expect(await client.albumIdsByName('Heaven', '')).toEqual([]);
        expect(client.asked).toHaveLength(1);
    });

    test('a quote in a title cannot close the filter', async () => {
        // `album:"Live at the "Fillmore""` is a filter that ends mid-title
        // followed by words Spotify matches against everything. The title that
        // produced it is a real one; the search it would run is not.
        const client = clientServing({ '/search': { albums: { items: [] } } });

        await client.albumIdsByName('', 'Live at the "Fillmore"');

        const query = decodeURIComponent(client.asked[0]);
        expect(query).toContain('album:"Live at the Fillmore"');
        // Exactly the two the filter itself needs: anything else is a second
        // filter Spotify would read as part of the query.
        expect(query.match(/"/g)).toHaveLength(2);
    });

    test('a colon in a title cannot open another filter', async () => {
        const client = clientServing({ '/search': { albums: { items: [] } } });

        await client.albumIdsByName('', 'Nevermind: Live');

        expect(decodeURIComponent(client.asked[0])).toContain('album:"Nevermind Live"');
    });

    test('an apostrophe is left alone — it is how the title is spelled', async () => {
        const client = clientServing({ '/search': { albums: { items: [] } } });

        await client.albumIdsByName('', "Don't Look Back");

        expect(decodeURIComponent(client.asked[0])).toContain('album:"Don\'t Look Back"');
    });

    test('asks for few enough candidates to be worth fetching in full', async () => {
        // Each hit costs an album request and an ISRC page to judge, and all of
        // them may be the wrong record.
        const client = clientServing({ '/search': { albums: { items: [] } } });

        await client.albumIdsByName('A Band', 'An Album');

        expect(client.asked[0]).toContain('limit=3');
    });

    test('drops items with no id rather than passing undefined along', async () => {
        const client = clientServing({
            '/search': { albums: { items: [null, { name: 'no id' }, { id: 'c' }] } },
        });

        expect(await client.albumIdsByName('A Band', 'An Album')).toEqual(['c']);
    });
});

describe('a failed request carries its status', () => {
    /**
     * The caller has to tell a refusal apart from a fault. Spotify answers 403
     * to /search from an app still in development mode — a property of the
     * credentials, not of the request — and reporting that as a server error
     * sends somebody debugging the wrong machine.
     */
    const clientWithStatus = (status) => {
        const client = new SpotifyClient({ clientId: 'id', clientSecret: 'secret' });
        client.getAccessToken = async () => 'token';
        client.fetch = async () => ({
            ok: false,
            status,
            json: async () => ({}),
        });
        return client;
    };

    test('a 403 is reported as a 403', async () => {
        await expect(clientWithStatus(403).albumIdsByUpc('075992733625'))
            .rejects.toMatchObject({ status: 403 });
    });

    test('so is anything else', async () => {
        await expect(clientWithStatus(503).albumIdsByUpc('075992733625'))
            .rejects.toMatchObject({ status: 503 });
    });

    test('the message still names the status, as it always did', async () => {
        await expect(clientWithStatus(500).albumIdsByUpc('075992733625'))
            .rejects.toThrow(/status 500/);
    });
});

describe('which half of the exchange refused', () => {
    /**
     * The route reports a token refusal as a credentials problem an operator
     * fixes, and a request refusal as being about what was asked for with
     * credentials Spotify has already accepted. That distinction is only as
     * good as the tag the client puts on the error, and nothing else connects
     * the two halves.
     */
    const refusing = (status) => {
        const client = new SpotifyClient({ clientId: 'id', clientSecret: 'secret' });
        client.fetch = async () => ({ ok: false, status, json: async () => ({}) });
        return client;
    };

    test('a refused token is tagged as the token request', async () => {
        await expect(refusing(400).getAccessToken())
            .rejects.toMatchObject({ status: 400, phase: 'token request' });
    });

    test('credentials that are not there at all are too', async () => {
        const client = new SpotifyClient({ clientId: '', clientSecret: '' });

        await expect(client.getAccessToken())
            .rejects.toMatchObject({ phase: 'token request' });
    });

    test('a refused request is not tagged as a token problem', async () => {
        // Otherwise a 403 on /search would send an operator to re-check
        // credentials Spotify had already accepted.
        const client = refusing(403);
        client.getAccessToken = async () => 'token';

        await expect(client.albumIdsByUpc('075992733625'))
            .rejects.toMatchObject({ status: 403, phase: 'request' });
    });
});

describe('the codes cannot sink the comparison', () => {
    /**
     * The ISRCs are a bonus on top of the tracklist. They come from a second,
     * different endpoint, so they can be refused on their own — and before
     * this, a submitter asking "does this tracklist match" would then get
     * nothing at all, having previously got an answer. A feature that takes a
     * working one down with it is a bad trade.
     */
    const albumServing = (trackResponse) => {
        const client = new SpotifyClient({ clientId: 'id', clientSecret: 'secret' });
        client._get = async (path) => {
            if (path.startsWith('/tracks')) return trackResponse();
            return {
                id: 'alb', name: 'Album', release_date: '1981', total_tracks: 2,
                external_ids: { upc: '075992733625' },
                tracks: { items: simplified(2) },
            };
        };
        return client;
    };

    test('a refused ISRC lookup still returns the tracklist', async () => {
        const album = await albumServing(() => {
            throw Object.assign(new Error('Spotify request failed with status 403'),
                { status: 403 });
        }).getAlbumWithTracks('alb');

        expect(album.tracks).toHaveLength(2);
        expect(album.tracks.every(t => t.isrc === null)).toBe(true);
    });

    test('and still returns the album UPC, which came with the album', async () => {
        const album = await albumServing(() => { throw new Error('nope'); })
            .getAlbumWithTracks('alb');

        expect(album.upc).toBe('075992733625');
    });

    test('a working ISRC lookup is still used', async () => {
        // The degradation must not be the normal path.
        const album = await albumServing(() => full(['t0', 't1'])).getAlbumWithTracks('alb');

        expect(album.tracks.map(t => t.isrc)).toEqual(['ISRCT0', 'ISRCT1']);
    });
});
