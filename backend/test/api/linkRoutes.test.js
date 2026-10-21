/**
 * Tests for the cross-service link endpoint.
 *
 * Providers are injected, so nothing here touches the network. The shape under
 * test is the provider *table*: Odesli answered for every service at once and
 * its retirement took every service with it, so what matters is that one
 * provider failing, or being unconfigured, costs only that provider.
 */

import { describe, test, expect, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createLinkRoutes } from '../../src/api/routes/links.js';

const ISRC = 'USSM17900123';
const OTHER = 'GBAYE0601729';

/**
 * A provider that answers from a plain object.
 *
 * Keyed by item id, valued with the services that provider found — the shape
 * every provider now answers in, so that one which resolves nine services from
 * a single request (Odesli) and one which resolves exactly one (Deezer) are
 * asked the same way.
 */
const provider = (found, { configured = true } = {}) => ({
    isConfigured: () => configured,
    resolveLinks: jest.fn(async () => new Map(Object.entries(found))),
});

/** The single-service shape a per-service provider returns. */
const oneService = (service, byId) => provider(
    Object.fromEntries(Object.entries(byId).map(([id, url]) => [id, { [service]: url }])));

function appWith(linkProviders) {
    const app = express();
    app.use(express.json());
    app.use('/api/links', createLinkRoutes({ config: { env: 'test' }, linkProviders }));
    return app;
}

describe('POST /api/links/resolve', () => {
    test('returns a link per recording, under its service', async () => {
        const res = await request(appWith({
            deezer: oneService('deezer', { [ISRC]: 'https://www.deezer.com/track/1' }),
        })).post('/api/links/resolve').send({ isrcs: [ISRC] });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            links: { [ISRC]: { deezer: 'https://www.deezer.com/track/1' } },
            services: ['deezer'],
        });
    });

    test('a recording no provider has is simply absent', async () => {
        // Rather than present-but-empty: the caller fills what it is given and
        // leaves the rest alone, and an empty object would read as an answer.
        const res = await request(appWith({ deezer: provider({}) }))
            .post('/api/links/resolve').send({ isrcs: [ISRC, OTHER] });

        expect(res.body.links).toEqual({});
        expect(res.body.success).toBe(true);
    });

    test('several services land side by side on one recording', async () => {
        const res = await request(appWith({
            deezer: oneService('deezer', { [ISRC]: 'https://www.deezer.com/track/1' }),
            tidal: oneService('tidal', { [ISRC]: 'https://tidal.com/track/2' }),
        })).post('/api/links/resolve').send({ isrcs: [ISRC] });

        expect(res.body.links[ISRC]).toEqual({
            deezer: 'https://www.deezer.com/track/1',
            tidal: 'https://tidal.com/track/2',
        });
    });

    test('an unconfigured provider is not asked and not named', async () => {
        // This is how a provider that needs credentials behaves on a
        // deployment without them, and the caller has to be able to tell that
        // apart from "it was asked and had nothing".
        const apple = oneService('apple', { [ISRC]: 'https://music.apple.com/x' });
        apple.isConfigured = () => false;
        const res = await request(appWith({
            deezer: oneService('deezer', { [ISRC]: 'https://www.deezer.com/track/1' }),
            apple,
        })).post('/api/links/resolve').send({ isrcs: [ISRC] });

        expect(apple.resolveLinks).not.toHaveBeenCalled();
        expect(res.body.providers).toEqual(['deezer']);
        expect(res.body.services).toEqual(['deezer']);
        expect(res.body.links[ISRC]).toEqual({ deezer: 'https://www.deezer.com/track/1' });
    });

    test('no providers at all is a reason, not a fault', async () => {
        const res = await request(appWith({
            apple: provider({}, { configured: false }),
        })).post('/api/links/resolve').send({ isrcs: [ISRC] });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: false, reason: 'not_configured', services: [],
        });
    });

    test('one provider failing does not lose the others', async () => {
        // The whole reason this is a table rather than an aggregator.
        const res = await request(appWith({
            broken: {
                isConfigured: () => true,
                resolveLinks: async () => { throw new Error('upstream exploded'); },
            },
            deezer: oneService('deezer', { [ISRC]: 'https://www.deezer.com/track/1' }),
        })).post('/api/links/resolve').send({ isrcs: [ISRC] });

        expect(res.status).toBe(200);
        expect(res.body.links[ISRC]).toEqual({ deezer: 'https://www.deezer.com/track/1' });
    });

    test('every provider is asked about every item', async () => {
        const deezer = provider({});
        await request(appWith({ deezer }))
            .post('/api/links/resolve').send({ isrcs: [ISRC, OTHER] });

        // The ISRC doubles as the id when that is all the caller sent, which is
        // what keeps the pre-Odesli request shape answering identically.
        expect(deezer.resolveLinks).toHaveBeenCalledWith([
            { id: ISRC, isrc: ISRC },
            { id: OTHER, isrc: OTHER },
        ]);
    });

    test('an empty list is a 400', async () => {
        const res = await request(appWith({ deezer: provider({}) }))
            .post('/api/links/resolve').send({ isrcs: [] });

        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('no_isrcs');
    });

    test('a missing body is a 400, not a throw', async () => {
        const res = await request(appWith({ deezer: provider({}) }))
            .post('/api/links/resolve').send();

        expect(res.status).toBe(400);
    });

    test('a catalogue-sized request is refused', async () => {
        // Past a box set it is somebody using this as a bulk resolver, which
        // would spend a rate limit shared with every submitter.
        const many = Array.from({ length: 61 }, (_, i) => `USSM179${String(i).padStart(5, '0')}`);
        const deezer = provider({});
        const res = await request(appWith({ deezer }))
            .post('/api/links/resolve').send({ isrcs: many });

        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('too_many_isrcs');
        expect(deezer.resolveLinks).not.toHaveBeenCalled();
    });

    test('a box set is not refused', async () => {
        const many = Array.from({ length: 60 }, (_, i) => `USSM179${String(i).padStart(5, '0')}`);
        const res = await request(appWith({ deezer: provider({}) }))
            .post('/api/links/resolve').send({ isrcs: many });

        expect(res.status).toBe(200);
    });
});

describe('resolving by link, which is the only way into Odesli', () => {
    /**
     * Odesli answers for every service in one request, and it resolves by
     * platform URL rather than by code. That is why the request shape carries
     * both: an ISRC is the key a per-service catalogue is asked by, a URL is
     * the key Odesli is asked by, and a row usually has both.
     *
     * The identity question is settled before Odesli is asked — the Spotify URL
     * in a submission was itself matched by barcode or by title under the rules
     * in tracklistDiff.js — so resolving from it inherits that match rather
     * than making a new guess.
     */
    const SPOTIFY = 'https://open.spotify.com/track/trk1';

    const everyService = provider({
        [ISRC]: {
            apple: 'https://music.apple.com/us/album/x/1?i=2',
            tidal: 'https://tidal.com/browse/track/99',
            deezer: 'https://www.deezer.com/track/1',
        },
    });

    test('a track list with URLs reaches the providers', async () => {
        const odesli = provider({});
        await request(appWith({ odesli })).post('/api/links/resolve')
            .send({ tracks: [{ isrc: ISRC, url: SPOTIFY }] });

        expect(odesli.resolveLinks).toHaveBeenCalledWith([
            { id: ISRC, isrc: ISRC, url: SPOTIFY },
        ]);
    });

    test('one provider can answer for nine services', async () => {
        const res = await request(appWith({ odesli: everyService }))
            .post('/api/links/resolve').send({ tracks: [{ isrc: ISRC, url: SPOTIFY }] });

        expect(res.body.links[ISRC]).toEqual({
            apple: 'https://music.apple.com/us/album/x/1?i=2',
            tidal: 'https://tidal.com/browse/track/99',
            deezer: 'https://www.deezer.com/track/1',
        });
    });

    test('services names what is in the answer, providers names who was asked', async () => {
        // A submitter being told what was added means the services. "odesli" is
        // not a place anybody listens to music.
        const res = await request(appWith({
            odesli: everyService,
            deezer: oneService('deezer', {}),
        })).post('/api/links/resolve').send({ tracks: [{ isrc: ISRC, url: SPOTIFY }] });

        expect(res.body.services).toEqual(['apple', 'deezer', 'tidal']);
        expect(res.body.providers).toEqual(['odesli', 'deezer']);
    });

    test('a per-service provider only fills a gap the first left', async () => {
        // Odesli runs first and resolved Deezer already; the keyless Deezer
        // client must not overwrite it with its own answer for the same track.
        const res = await request(appWith({
            odesli: everyService,
            deezer: oneService('deezer', { [ISRC]: 'https://www.deezer.com/track/SECOND' }),
        })).post('/api/links/resolve').send({ tracks: [{ isrc: ISRC, url: SPOTIFY }] });

        expect(res.body.links[ISRC].deezer).toBe('https://www.deezer.com/track/1');
    });

    test('a later provider does add a service the first did not have', async () => {
        const res = await request(appWith({
            odesli: provider({ [ISRC]: { apple: 'https://music.apple.com/x' } }),
            deezer: oneService('deezer', { [ISRC]: 'https://www.deezer.com/track/1' }),
        })).post('/api/links/resolve').send({ tracks: [{ isrc: ISRC, url: SPOTIFY }] });

        expect(res.body.links[ISRC]).toEqual({
            apple: 'https://music.apple.com/x',
            deezer: 'https://www.deezer.com/track/1',
        });
    });

    test('a row with a URL and no ISRC is still resolvable', async () => {
        // The Spotify match can succeed where the ISRC lookup failed; Odesli
        // needs only the link.
        const odesli = provider({ [SPOTIFY]: { apple: 'https://music.apple.com/x' } });
        const res = await request(appWith({ odesli })).post('/api/links/resolve')
            .send({ tracks: [{ url: SPOTIFY }] });

        expect(odesli.resolveLinks).toHaveBeenCalledWith([{ id: SPOTIFY, url: SPOTIFY }]);
        expect(res.body.links[SPOTIFY].apple).toBe('https://music.apple.com/x');
    });

    test('a caller-supplied id is used in preference to either', async () => {
        const odesli = provider({});
        await request(appWith({ odesli })).post('/api/links/resolve')
            .send({ tracks: [{ id: 'row-3', isrc: ISRC, url: SPOTIFY }] });

        expect(odesli.resolveLinks).toHaveBeenCalledWith([
            { id: 'row-3', isrc: ISRC, url: SPOTIFY },
        ]);
    });

    test('a row with neither is dropped rather than asked about', async () => {
        const res = await request(appWith({ odesli: provider({}) }))
            .post('/api/links/resolve').send({ tracks: [{ isrc: '  ' }, {}] });

        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('no_isrcs');
    });

    test('the old request shape still answers identically', async () => {
        // The form sent {isrcs: [...]} before Odesli, and a deployment mid-roll
        // may still be serving it.
        const res = await request(appWith({
            deezer: oneService('deezer', { [ISRC]: 'https://www.deezer.com/track/1' }),
        })).post('/api/links/resolve').send({ isrcs: [ISRC] });

        expect(res.body.links).toEqual({ [ISRC]: { deezer: 'https://www.deezer.com/track/1' } });
    });
});
