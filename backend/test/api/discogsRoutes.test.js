/**
 * Tests for the Discogs artist endpoint.
 *
 * Server-side for one reason only: the token. Discogs serves no `images` to an
 * unauthenticated request and a browser cannot hold a credential, so pictures
 * are out of reach from the page — while everything else about Discogs works
 * fine there, which is why the tracklist import still runs in the browser.
 *
 * The `configured` flag in the answer carries its weight: it is the difference
 * between "Discogs has no picture of this band" and "this server cannot see
 * pictures at all", and a submitter staring at an empty photo field cannot
 * tell those apart without being told.
 */

import { describe, test, expect, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createDiscogsRoutes, describeFailure } from '../../src/api/routes/discogs.js';

const ARTIST = {
    id: 7,
    name: 'Dum Dum Girls',
    photo: 'https://img/band',
    members: [{ id: 11, name: 'Kristen Gundred', photo: 'https://img/kg', active: true }],
};

function appWith(overrides = {}) {
    const client = {
        isConfigured: () => true,
        artistWithMembers: async () => ARTIST,
        ...overrides,
    };
    const app = express();
    app.use(express.json());
    app.use('/api/discogs', createDiscogsRoutes({ discogsClient: client, config: { env: 'test' } }));
    return { app, client };
}

const refusal = (status) => Object.assign(new Error('refused'), { status });

describe('POST /api/discogs/artist', () => {
    test('answers with the act and its members', async () => {
        const { app } = appWith();

        const res = await request(app).post('/api/discogs/artist').send({ id: 7 });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, configured: true, artist: ARTIST });
    });

    test('a numeric id arrives as a string or a number', async () => {
        const seen = [];
        const { app } = appWith({
            artistWithMembers: async (id) => { seen.push(id); return ARTIST; },
        });

        await request(app).post('/api/discogs/artist').send({ id: 7 });
        await request(app).post('/api/discogs/artist').send({ id: '7' });

        expect(seen).toEqual(['7', '7']);
    });

    test.each([
        ['nothing', {}],
        ['an empty string', { id: '' }],
        ['a slug', { id: 'dum-dum-girls' }],
        ['a path traversal', { id: '../releases/1' }],
        ['a negative number', { id: -7 }],
    ])('%s is refused before any request is made', async (_label, body) => {
        // The id goes into a URL path, so it is checked rather than passed
        // through and hoped about.
        let called = false;
        const { app } = appWith({
            artistWithMembers: async () => { called = true; return ARTIST; },
        });

        const res = await request(app).post('/api/discogs/artist').send(body);

        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('bad_id');
        expect(called).toBe(false);
    });

    test('says when there is no token, so an empty photo can be explained', async () => {
        const { app } = appWith({
            isConfigured: () => false,
            artistWithMembers: async () => ({ ...ARTIST, photo: null, members: [] }),
        });

        const res = await request(app).post('/api/discogs/artist').send({ id: 7 });

        expect(res.body).toMatchObject({ success: true, configured: false });
    });
});

describe('what the submitter is told when it fails', () => {
    test.each([
        ['an artist that does not exist', 404, 'artist_not_found'],
        ['a rejected token', 401, 'refused'],
        ['a forbidden request', 403, 'refused'],
        ['rate limiting', 429, 'rate_limited'],
    ])('%s is named', async (_label, status, reason) => {
        const { app } = appWith({ artistWithMembers: async () => { throw refusal(status); } });

        const res = await request(app).post('/api/discogs/artist').send({ id: 7 });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: false, reason });
    });

    test('a refusal names the setting and where the token comes from', async () => {
        // "Forbidden" on its own has sent enough people to the wrong place.
        const { app } = appWith({ artistWithMembers: async () => { throw refusal(403); } });

        const res = await request(app).post('/api/discogs/artist').send({ id: 7 });

        expect(res.body.message).toContain('DISCOGS_TOKEN');
        expect(res.body.message).toContain('discogs.com/settings/developers');
    });

    test('rate limiting states both ceilings', async () => {
        const { app } = appWith({ artistWithMembers: async () => { throw refusal(429); } });

        const res = await request(app).post('/api/discogs/artist').send({ id: 7 });

        expect(res.body.message).toContain('60');
        expect(res.body.message).toContain('25');
    });

    test('an unreachable Discogs is not reported as a bug here', async () => {
        const { app } = appWith({
            artistWithMembers: async () => { throw new TypeError('fetch failed'); },
        });

        const res = await request(app).post('/api/discogs/artist').send({ id: 7 });

        expect(res.body).toMatchObject({ success: false, reason: 'unreachable' });
    });

    test('anything else is a fault here and says so with a 502', async () => {
        const { app } = appWith({
            artistWithMembers: async () => { throw new Error('something broke'); },
        });

        const res = await request(app).post('/api/discogs/artist').send({ id: 7 });

        expect(res.status).toBe(502);
        expect(res.body.success).toBe(false);
    });
});

describe('describeFailure', () => {
    test.each([
        [404, 'artist_not_found'],
        [401, 'refused'],
        [403, 'refused'],
        [429, 'rate_limited'],
    ])('a %s is described', (status, reason) => {
        expect(describeFailure(refusal(status))).toMatchObject({ reason });
    });

    test.each([
        ['a 500', refusal(500)],
        ['an error with no status', new Error('boom')],
    ])('%s is not described, because it is a fault here', (_label, error) => {
        expect(describeFailure(error)).toBeNull();
    });

    test.each([
        ['a TypeError from fetch', new TypeError('fetch failed')],
        ['a DNS failure', new Error('getaddrinfo ENOTFOUND api.discogs.com')],
        ['a temporary DNS failure', new Error('getaddrinfo EAI_AGAIN api.discogs.com')],
    ])('%s reads as unreachable', (_label, error) => {
        expect(describeFailure(error)).toMatchObject({ reason: 'unreachable' });
    });
});
