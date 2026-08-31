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
