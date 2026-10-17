/**
 * Tests for the Spotify cross-check endpoint.
 *
 * The client is injected, so nothing here touches the network — which matters
 * because this integration is optional and CI has no credentials. The
 * unconfigured path is the first case tested for exactly that reason: an
 * optional integration that 500s when it is switched off makes every
 * deployment without credentials look broken.
 */

import { describe, test, expect, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createSpotifyRoutes, parseSpotifyRef } from '../../src/api/routes/spotify.js';

/**
 * @param {Object} overrides - Partial SpotifyClient behaviour.
 * @returns {express.Express}
 */
function appWith(overrides = {}) {
    const client = {
        isConfigured: () => true,
        getTracks: async () => [],
        getAlbumWithTracks: async () => ({ id: 'alb', name: 'Album', tracks: [] }),
        albumIdsByUpc: async () => [],
        ...overrides,
    };
    const app = express();
    app.use(express.json());
    app.use('/api/spotify', createSpotifyRoutes({ config: { env: 'test' }, spotifyClient: client }));
    return app;
}

const NEVERMIND = {
    id: 'alb1', name: 'Nevermind', release_date: '1991-09-24', total_tracks: 2,
    tracks: [
        { id: 't1', name: 'Smells Like Teen Spirit', track_number: 1 },
        { id: 't2', name: 'In Bloom', track_number: 2 },
    ],
};

describe('POST /api/spotify/album', () => {
    test('reports itself unconfigured rather than failing', async () => {
        const res = await request(appWith({ isConfigured: () => false }))
            .post('/api/spotify/album').send({ links: ['https://open.spotify.com/album/x'] });

        // 200 with a reason, not a 500: no credentials is a configuration
        // state, not a server fault.
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: false, reason: 'not_configured' });
    });

    test('returns the album for an album link without looking up tracks', async () => {
        const getTracks = jest.fn(async () => []);
        const res = await request(appWith({ getTracks, getAlbumWithTracks: async () => NEVERMIND }))
            .post('/api/spotify/album').send({ links: ['https://open.spotify.com/album/alb1'] });

        expect(res.body).toMatchObject({ success: true, album: { name: 'Nevermind' } });
        // An album link already names the album; spending a second call on it
        // would waste someone else's quota.
        expect(getTracks).not.toHaveBeenCalled();
    });

    test('resolves the album from track links by majority', async () => {
        const res = await request(appWith({
            getTracks: async () => ([
                { album: { id: 'alb1' } }, { album: { id: 'alb1' } }, { album: { id: 'other' } },
            ]),
            getAlbumWithTracks: async (id) => ({ ...NEVERMIND, id }),
        })).post('/api/spotify/album').send({
            links: [
                'https://open.spotify.com/track/a',
                'https://open.spotify.com/track/b',
                'https://open.spotify.com/track/c',
            ],
        });

        // One track pointing elsewhere is the mistake this check exists to
        // surface, so it must not be allowed to redirect the comparison.
        expect(res.body.album.id).toBe('alb1');
    });

    test('rejects an empty link list', async () => {
        const res = await request(appWith()).post('/api/spotify/album').send({ links: [] });
        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('no_links');
    });

    test('refuses an unreasonable number of links', async () => {
        const links = Array.from({ length: 61 }, (_, i) => `https://open.spotify.com/track/${i}`);
        const res = await request(appWith()).post('/api/spotify/album').send({ links });
        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('too_many_links');
    });

    test('says so when none of the links are Spotify', async () => {
        const res = await request(appWith()).post('/api/spotify/album')
            .send({ links: ['https://music.apple.com/us/album/foo/1'] });
        expect(res.body).toMatchObject({ success: false, reason: 'no_spotify_links' });
    });

    test('says so when the album cannot be worked out', async () => {
        const res = await request(appWith({ getTracks: async () => [] }))
            .post('/api/spotify/album').send({ links: ['https://open.spotify.com/track/a'] });
        expect(res.body).toMatchObject({ success: false, reason: 'album_not_found' });
    });

    test('a Spotify outage is a 502, not a 500', async () => {
        const res = await request(appWith({
            getAlbumWithTracks: async () => { throw new Error('upstream exploded'); },
        })).post('/api/spotify/album').send({ links: ['https://open.spotify.com/album/alb1'] });

        // The fault is upstream; reporting it as ours would send someone
        // debugging the wrong server.
        expect(res.status).toBe(502);
        expect(res.body.success).toBe(false);
    });

    test('a missing body does not throw', async () => {
        const res = await request(appWith()).post('/api/spotify/album').send();
        expect(res.status).toBe(400);
    });
});

describe('POST /api/spotify/album, by barcode', () => {
    /**
     * The barcode is how a Discogs import reaches the streaming release
     * without guessing. Discogs carries no streaming ids, so the alternative
     * is matching on artist and title — two strings two community databases
     * spell differently, which is the very comparison this endpoint exists to
     * referee.
     *
     * The cost of a wrong answer is high and silent: a whole tracklist of
     * links, ISRCs and alternate titles attached to the wrong edition. So a
     * barcode match is only accepted when the album Spotify returns says the
     * same barcode itself.
     */
    const UPC = '075992733625';
    const WITH_UPC = { ...NEVERMIND, upc: UPC };

    test('a barcode alone finds the album', async () => {
        const res = await request(appWith({
            albumIdsByUpc: async () => ['alb1'],
            getAlbumWithTracks: async () => WITH_UPC,
        })).post('/api/spotify/album').send({ upc: UPC });

        expect(res.body).toMatchObject({
            success: true, matched_by: 'upc', album: { name: 'Nevermind' },
        });
    });

    test('a printed barcode works as printed', async () => {
        const asked = [];
        const res = await request(appWith({
            albumIdsByUpc: async (upc) => { asked.push(upc); return ['alb1']; },
            getAlbumWithTracks: async () => WITH_UPC,
        })).post('/api/spotify/album').send({ upc: '0 7599-27336-25' });

        expect(asked[0]).toBe(UPC);
        expect(res.body.success).toBe(true);
    });

    test('an album that does not carry that barcode is refused', async () => {
        // Spotify falls back to loose matching, so a hit is a candidate rather
        // than an answer. Accepting it unverified is the silent-wrong-edition
        // failure this guards.
        const res = await request(appWith({
            albumIdsByUpc: async () => ['other'],
            getAlbumWithTracks: async () => ({ ...NEVERMIND, upc: '999999999999' }),
        })).post('/api/spotify/album').send({ upc: UPC });

        expect(res.body).toMatchObject({ success: false, reason: 'upc_not_found' });
        expect(res.body.album).toBeUndefined();
    });

    test('an album with no barcode of its own is refused too', async () => {
        const res = await request(appWith({
            albumIdsByUpc: async () => ['alb1'],
            getAlbumWithTracks: async () => ({ ...NEVERMIND, upc: null }),
        })).post('/api/spotify/album').send({ upc: UPC });

        expect(res.body).toMatchObject({ success: false, reason: 'upc_not_found' });
    });

    test('a second candidate gets its turn', async () => {
        const res = await request(appWith({
            albumIdsByUpc: async () => ['wrong', 'right'],
            getAlbumWithTracks: async (id) => (id === 'right'
                ? { ...WITH_UPC, id }
                : { ...NEVERMIND, id, upc: '000000000000' }),
        })).post('/api/spotify/album').send({ upc: UPC });

        expect(res.body.album.id).toBe('right');
    });

    test('the EAN-13 spelling is tried when the UPC-A misses', async () => {
        // Which of the two a catalogue stores is a coin toss, and the upc:
        // filter matches the string it is given.
        const asked = [];
        const res = await request(appWith({
            albumIdsByUpc: async (upc) => {
                asked.push(upc);
                return upc === '0075992733625' ? ['alb1'] : [];
            },
            getAlbumWithTracks: async () => WITH_UPC,
        })).post('/api/spotify/album').send({ upc: UPC });

        expect(asked).toEqual([UPC, '0075992733625']);
        expect(res.body.success).toBe(true);
    });

    test('a link the submitter supplied outranks the barcode', async () => {
        // The link is a statement about which release they mean; the barcode is
        // only ever a way of guessing it.
        const byUpc = jest.fn(async () => ['alb1']);
        const res = await request(appWith({
            albumIdsByUpc: byUpc,
            getAlbumWithTracks: async (id) => ({ ...WITH_UPC, id }),
        })).post('/api/spotify/album')
            .send({ links: ['https://open.spotify.com/album/linked'], upc: UPC });

        expect(res.body).toMatchObject({ matched_by: 'link', album: { id: 'linked' } });
        expect(byUpc).not.toHaveBeenCalled();
    });

    test('a barcode is enough on its own — no link needed', async () => {
        const res = await request(appWith({
            albumIdsByUpc: async () => ['alb1'],
            getAlbumWithTracks: async () => WITH_UPC,
        })).post('/api/spotify/album').send({ upc: UPC, links: [] });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('neither a link nor a barcode is a 400', async () => {
        const res = await request(appWith()).post('/api/spotify/album').send({ links: [] });
        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('no_links');
    });

    test('a refused search is a reason, not a fault', async () => {
        // 403 is the documented answer to /search from an app still in
        // development mode. A 502 here reads as "the server is broken" when
        // the truth is "this deployment's Spotify app cannot search".
        const refused = Object.assign(new Error('Spotify request failed with status 403'),
            { status: 403 });
        const res = await request(appWith({
            albumIdsByUpc: async () => { throw refused; },
        })).post('/api/spotify/album').send({ upc: UPC });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: false, reason: 'search_unavailable' });
    });

    test('any other failure is still a 502', async () => {
        const res = await request(appWith({
            albumIdsByUpc: async () => { throw Object.assign(new Error('boom'), { status: 503 }); },
        })).post('/api/spotify/album').send({ upc: UPC });

        expect(res.status).toBe(502);
    });

    test.each([
        ['the word submitters type for no barcode', 'none'],
        ['a catalogue number', 'SP 34'],
        ['a price code', '7.98'],
    ])('%s asks Spotify nothing', async (_label, value) => {
        // Discogs identifiers are free text and submitters put all of these in
        // the barcode field. A digit run too short to be an article number is
        // not one, and searching for it would return somebody else's release.
        const byUpc = jest.fn(async () => []);
        const res = await request(appWith({ albumIdsByUpc: byUpc }))
            .post('/api/spotify/album').send({ upc: value });

        expect(byUpc).not.toHaveBeenCalled();
        expect(res.body).toMatchObject({ success: false, reason: 'upc_not_found' });
    });

    test('a non-string barcode is ignored rather than coerced', async () => {
        const res = await request(appWith()).post('/api/spotify/album').send({ upc: 75992733625 });
        expect(res.status).toBe(400);
    });
});

describe('a failure the submitter can act on', () => {
    /**
     * What this replaces: a 502 whose sanitized body carries no message, which
     * the form renders as "The Spotify check is unavailable" — true,
     * unactionable, and identical whether the credentials are wrong, the app
     * is restricted, the quota is spent, or the host has no outbound access.
     * Each has a different fix and only one of them is a fault.
     *
     * That is not hypothetical: it is exactly what polaris.mu showed on
     * 2026-10-17, and finding out which of the four it was meant reading the
     * container logs.
     */
    const failing = (error) => appWith({
        getAlbumWithTracks: async () => { throw error; },
        getTracks: async () => { throw error; },
    });

    const ask = (app) => request(app).post('/api/spotify/album')
        .send({ links: ['https://open.spotify.com/album/alb1'] });

    test('rejected credentials name the credentials', async () => {
        const res = await ask(failing(Object.assign(
            new Error('Spotify token request failed with status 400'),
            { status: 400, phase: 'token request' })));

        expect(res.status).toBe(200);
        expect(res.body.reason).toBe('credentials_rejected');
        expect(res.body.message).toMatch(/SPOTIFY_CLIENT_ID/);
        expect(res.body.message).toMatch(/400/);
    });

    test('missing credentials say so without inventing a status', async () => {
        const res = await ask(failing(Object.assign(
            new Error('Spotify credentials are not configured'),
            { phase: 'token request' })));

        expect(res.body.reason).toBe('credentials_rejected');
        expect(res.body.message).not.toMatch(/HTTP/);
    });

    test('a 403 is reported as a refusal for this app', async () => {
        const res = await ask(failing(Object.assign(
            new Error('Spotify request failed with status 403'), { status: 403 })));

        expect(res.body).toMatchObject({ success: false, reason: 'request_refused' });
    });

    test('a 429 is reported as rate limiting', async () => {
        const res = await ask(failing(Object.assign(
            new Error('Spotify request failed with status 429'), { status: 429 })));

        expect(res.body.reason).toBe('rate_limited');
    });

    test('an unreachable host is not the registry failing', async () => {
        // What a blocked egress or a bad DNS answer looks like from undici.
        const res = await ask(failing(new TypeError('fetch failed')));

        expect(res.status).toBe(200);
        expect(res.body.reason).toBe('unreachable');
        expect(res.body.message).toMatch(/outbound/);
    });

    test('a timeout is the same', async () => {
        const res = await ask(failing(Object.assign(
            new Error('This operation was aborted'), { name: 'AbortError' })));

        expect(res.body.reason).toBe('unreachable');
    });

    test('anything else is still a 502', async () => {
        // The classification must not swallow real faults — a bug in this
        // server should look like one.
        const res = await ask(failing(new Error('Cannot read properties of undefined')));

        expect(res.status).toBe(502);
        expect(res.body.success).toBe(false);
    });

    test('a 502 still carries something to grep for', async () => {
        // The sanitized body has no `message`, so the form falls back to
        // `error` plus the errorId, which is what matches the response to a
        // line in the container log.
        const res = await ask(failing(new Error('boom')));

        expect(res.body.error).toBeTruthy();
    });
});

describe('parseSpotifyRef', () => {
    test.each([
        ['a plain track URL',   'https://open.spotify.com/track/abc', { type: 'track', id: 'abc' }],
        ['a locale prefix',     'https://open.spotify.com/intl-de/track/abc', { type: 'track', id: 'abc' }],
        ['an embed URL',        'https://open.spotify.com/embed/album/xyz', { type: 'album', id: 'xyz' }],
        ['a bare URI',          'spotify:album:xyz', { type: 'album', id: 'xyz' }],
    ])('%s', (_label, input, expected) => {
        expect(parseSpotifyRef(input)).toEqual(expected);
    });

    test.each([
        ['another service', 'https://music.apple.com/us/album/foo/1'],
        ['a lookalike host', 'https://open.spotify.com.evil.test/track/abc'],
        ['plain text', 'not a url'],
        ['a non-string', null],
    ])('rejects %s', (_label, input) => {
        expect(parseSpotifyRef(input)).toBeNull();
    });
});
