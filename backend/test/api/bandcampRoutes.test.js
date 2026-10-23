/**
 * Tests for the Bandcamp import endpoint.
 *
 * Server-side because it has to be: Bandcamp sends no CORS header, so a
 * browser cannot read one of their pages at all. The client is injected, so
 * nothing here touches the network.
 *
 * The failure reasons matter more here than anywhere else in this API, because
 * Bandcamp publishes no interface: "that page carries nothing I can read" is a
 * thing that will eventually happen on a page that loads perfectly well, and it
 * is neither the submitter's fault nor this server failing.
 */

import { describe, test, expect, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createBandcampRoutes, describeFailure } from '../../src/api/routes/bandcamp.js';

const RELEASE = {
    name: 'The Ark (Vol.1)', artist: 'Various Artists', label: 'Ark Records',
    release_date: '2014/11/11', credits: 'Recorded at Lost Ark Studio.', about: null,
    tags: ['post-rock'], art: null, url: 'https://ark.bandcamp.com/album/the-ark-vol-1',
    tracks: [{ title: 'Turns To Dust', position: 1, duration: 197, url: null }],
};

function appWith(overrides = {}) {
    const client = { isConfigured: () => true, fetchRelease: async () => RELEASE, ...overrides };
    const app = express();
    app.use(express.json());
    app.use('/api/bandcamp',
        createBandcampRoutes({ config: { env: 'test' }, bandcampClient: client }));
    return app;
}

const post = (app, body) => request(app).post('/api/bandcamp/album').send(body);

describe('POST /api/bandcamp/album', () => {
    test('returns the release the page describes', async () => {
        const res = await post(appWith(), { url: 'https://ark.bandcamp.com/album/the-ark-vol-1' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, album: { name: 'The Ark (Vol.1)' } });
        expect(res.body.album.tracks[0].duration).toBe(197);
    });

    test('the URL reaches the client as the submitter pasted it', async () => {
        const fetchRelease = jest.fn(async () => RELEASE);
        await post(appWith({ fetchRelease }),
            { url: '  https://ark.bandcamp.com/album/the-ark-vol-1?from=hp  ' });

        expect(fetchRelease).toHaveBeenCalledWith(
            'https://ark.bandcamp.com/album/the-ark-vol-1?from=hp');
    });

    test('no URL is a 400, not a fetch of nothing', async () => {
        const fetchRelease = jest.fn();
        const res = await post(appWith({ fetchRelease }), {});

        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('no_url');
        expect(fetchRelease).not.toHaveBeenCalled();
    });

    test('a missing body does not throw', async () => {
        expect((await request(appWith()).post('/api/bandcamp/album').send()).status).toBe(400);
    });

    test('a page with nothing readable says the markup may have moved', async () => {
        // The failure mode unique to a source with no published interface: the
        // page loads, and carries nothing. Neither the submitter's fault nor a
        // fault here, and the message names the script that diagnoses it.
        const res = await post(appWith({ fetchRelease: async () => null }),
            { url: 'https://ark.bandcamp.com/album/the-ark-vol-1' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: false, reason: 'unreadable' });
        expect(res.body.message).toMatch(/checkBandcamp/);
    });

    test('a link to something that is not Bandcamp explains itself', async () => {
        const res = await post(appWith({
            fetchRelease: async () => {
                throw Object.assign(new Error('Not a Bandcamp album or track URL'),
                    { reason: 'not_bandcamp' });
            },
        }), { url: 'https://example.com/album/x' });

        expect(res.body).toMatchObject({ success: false, reason: 'not_bandcamp' });
        // The custom-domain case is the one somebody will actually hit.
        expect(res.body.message).toMatch(/own domain/);
    });

    test('a release that is gone is reported as gone', async () => {
        const res = await post(appWith({
            fetchRelease: async () => { throw Object.assign(new Error('404'), { status: 404 }); },
        }), { url: 'https://ark.bandcamp.com/album/deleted' });

        expect(res.status).toBe(200);
        expect(res.body.reason).toBe('release_not_found');
        expect(res.body.message).toMatch(/taken down|private/);
    });

    test('a real fault is still a 502', async () => {
        // The classification must not swallow a bug in this server.
        const res = await post(appWith({
            fetchRelease: async () => { throw new TypeError('x.map is not a function'); },
        }), { url: 'https://ark.bandcamp.com/album/the-ark-vol-1' });

        expect(res.status).toBe(502);
        expect(res.body.success).toBe(false);
    });
});

describe('describeFailure', () => {
    test.each([
        ['a rate limit', { status: 429 }, 'rate_limited'],
        ['a gone release', { status: 410 }, 'release_not_found'],
        ['a refusal', { status: 403 }, 'refused'],
        ['an unreachable host', new TypeError('fetch failed'), 'unreachable'],
        ['a timeout', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'unreachable'],
    ])('%s is a reason', (_label, error, reason) => {
        expect(describeFailure(error)?.reason).toBe(reason);
    });

    test('anything else is not classified, so it stays a fault', () => {
        expect(describeFailure(new Error('Cannot read properties of undefined'))).toBeNull();
        expect(describeFailure(undefined)).toBeNull();
    });
});
