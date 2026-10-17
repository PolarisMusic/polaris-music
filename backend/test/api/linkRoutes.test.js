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

/** A provider that answers from a plain object. */
const provider = (found, { configured = true } = {}) => ({
    isConfigured: () => configured,
    tracksByIsrcs: jest.fn(async () => new Map(Object.entries(found))),
});

function appWith(linkProviders) {
    const app = express();
    app.use(express.json());
    app.use('/api/links', createLinkRoutes({ config: { env: 'test' }, linkProviders }));
    return app;
}

describe('POST /api/links/resolve', () => {
    test('returns a link per recording, under its service', async () => {
        const res = await request(appWith({
            deezer: provider({ [ISRC]: 'https://www.deezer.com/track/1' }),
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
            deezer: provider({ [ISRC]: 'https://www.deezer.com/track/1' }),
            tidal: provider({ [ISRC]: 'https://tidal.com/track/2' }),
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
        const apple = provider({ [ISRC]: 'https://music.apple.com/x' }, { configured: false });
        const res = await request(appWith({
            deezer: provider({ [ISRC]: 'https://www.deezer.com/track/1' }),
            apple,
        })).post('/api/links/resolve').send({ isrcs: [ISRC] });

        expect(apple.tracksByIsrcs).not.toHaveBeenCalled();
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
                tracksByIsrcs: async () => { throw new Error('upstream exploded'); },
            },
            deezer: provider({ [ISRC]: 'https://www.deezer.com/track/1' }),
        })).post('/api/links/resolve').send({ isrcs: [ISRC] });

        expect(res.status).toBe(200);
        expect(res.body.links[ISRC]).toEqual({ deezer: 'https://www.deezer.com/track/1' });
    });

    test('the ISRCs are passed through as given', async () => {
        const deezer = provider({});
        await request(appWith({ deezer }))
            .post('/api/links/resolve').send({ isrcs: [ISRC, OTHER] });

        expect(deezer.tracksByIsrcs).toHaveBeenCalledWith([ISRC, OTHER]);
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
        expect(deezer.tracksByIsrcs).not.toHaveBeenCalled();
    });

    test('a box set is not refused', async () => {
        const many = Array.from({ length: 60 }, (_, i) => `USSM179${String(i).padStart(5, '0')}`);
        const res = await request(appWith({ deezer: provider({}) }))
            .post('/api/links/resolve').send({ isrcs: many });

        expect(res.status).toBe(200);
    });
});
