/**
 * The Deezer leg of cross-service link resolution.
 *
 * Deezer is the only provider that needs no credentials, which makes it the
 * one that works on every deployment — and the one whose failure modes have to
 * be handled rather than configured away.
 *
 * The miss shape below is not invented. Asked from the production host on
 * 2026-10-17 for an ISRC Deezer does not hold, `/track/isrc:…` answered HTTP
 * 200 with `{"error":{"type":"DataException","message":"no data","code":800}}`.
 * A client that trusted the status code would read that as a hit and then read
 * `undefined` as an id.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { DeezerClient } from '../../src/api/deezerClient.js';

const ISRC = 'USSM17900123';
const OTHER = 'GBAYE0601729';

/** A client whose HTTP layer is a lookup table of ISRC -> response body. */
function clientServing(bodies, { status = 200 } = {}) {
    const asked = [];
    const client = new DeezerClient({
        fetchImpl: async (url) => {
            asked.push(url);
            const isrc = url.split('isrc:')[1] ?? '';
            return {
                ok: status >= 200 && status < 300,
                status,
                json: async () => bodies[isrc] ?? { error: { code: 800, message: 'no data' } },
            };
        },
    });
    client.asked = asked;
    return client;
}

const MISS = { error: { type: 'DataException', message: 'no data', code: 800 } };

describe('trackByIsrc', () => {
    test('a recording Deezer has resolves to its track URL', async () => {
        const client = clientServing({ [ISRC]: { id: 3135556, title: 'Burnin’ For You' } });

        expect(await client.trackByIsrc(ISRC)).toBe('https://www.deezer.com/track/3135556');
    });

    test('the URL is built from the id, not taken from the response', async () => {
        // One predictable shape, canonical by construction. Nothing downstream
        // has to trust a URL this server did not write — and `link` is a field
        // whose exact contents were never verified against the live API.
        const client = clientServing({
            [ISRC]: { id: 3135556, link: 'https://www.deezer.com/fr/track/9999999?utm_source=x' },
        });

        expect(await client.trackByIsrc(ISRC)).toBe('https://www.deezer.com/track/3135556');
    });

    test('a miss is null, not an error', async () => {
        // The common case, not a fault: a B-side from 1981 is frequently not
        // on a streaming service at all.
        const client = clientServing({ [ISRC]: MISS });

        expect(await client.trackByIsrc(ISRC)).toBeNull();
    });

    test('an error body with HTTP 200 is still a miss', async () => {
        // The measured behaviour. A client reading the status alone would take
        // this for a hit.
        const client = clientServing({ [ISRC]: MISS });

        expect(await client.trackByIsrc(ISRC)).toBeNull();
        expect(client.asked).toHaveLength(1);
    });

    test('a body with no id is a miss however cheerful it looks', async () => {
        const client = clientServing({ [ISRC]: { title: 'Something', readable: true } });
        expect(await client.trackByIsrc(ISRC)).toBeNull();
    });

    test('a non-200 is a miss', async () => {
        const client = clientServing({ [ISRC]: { id: 1 } }, { status: 429 });
        expect(await client.trackByIsrc(ISRC)).toBeNull();
    });

    test('a thrown request is a miss, not a thrown submission', async () => {
        // A timeout must not fail the form. The link is a convenience, and the
        // ISRC that would let it be resolved later is already recorded.
        const client = new DeezerClient({
            fetchImpl: async () => { throw new Error('ETIMEDOUT'); },
        });

        await expect(client.trackByIsrc(ISRC)).resolves.toBeNull();
    });

    test('a body that is not JSON is a miss', async () => {
        const client = new DeezerClient({
            fetchImpl: async () => ({
                ok: true, status: 200, json: async () => { throw new Error('bad json'); },
            }),
        });

        await expect(client.trackByIsrc(ISRC)).resolves.toBeNull();
    });

    test.each([
        ['empty',          ''],
        ['null',           null],
        ['a title',        'Burnin For You'],
        ['too short',      'USSM1790012'],
        ['too long',       'USSM179001234'],
        ['wrong shape',    '12SM17900123'],
        ['an injection',   'US/../albums/1'],
    ])('%s is not asked about at all', async (_label, value) => {
        // An ISRC has one shape. Anything else is a bug upstream, and putting
        // it in a URL path would be a request for something else entirely.
        const client = clientServing({});

        expect(await client.trackByIsrc(value)).toBeNull();
        expect(client.asked).toEqual([]);
    });

    test('a lowercase ISRC is asked about in upper case', async () => {
        // ISRCs are canonically upper case and the registry stores them that
        // way; a form that was typed into by hand may not have.
        const client = clientServing({ [ISRC]: { id: 42 } });

        expect(await client.trackByIsrc(ISRC.toLowerCase()))
            .toBe('https://www.deezer.com/track/42');
    });
});

describe('tracksByIsrcs', () => {
    test('resolves what it can and omits the rest', async () => {
        const client = clientServing({ [ISRC]: { id: 1 }, [OTHER]: MISS });

        const found = await client.tracksByIsrcs([ISRC, OTHER]);

        expect([...found]).toEqual([[ISRC, 'https://www.deezer.com/track/1']]);
    });

    test('asks about a repeated ISRC once', async () => {
        // A reprise, or a radio edit of a track already on the release. Asking
        // twice spends someone else's quota to learn the same thing.
        const client = clientServing({ [ISRC]: { id: 1 } });

        await client.tracksByIsrcs([ISRC, ISRC, ISRC.toLowerCase()]);

        expect(client.asked).toHaveLength(1);
    });

    test('nothing to ask about asks nothing', async () => {
        const client = clientServing({});

        expect(await client.tracksByIsrcs([])).toEqual(new Map());
        expect(await client.tracksByIsrcs(undefined)).toEqual(new Map());
        expect(await client.tracksByIsrcs(['not an isrc', null])).toEqual(new Map());
        expect(client.asked).toEqual([]);
    });

    test('a long tracklist does not arrive as one burst', async () => {
        // Deezer's ceiling is per IP and this server has one for everybody, so
        // the concurrency is a courtesy to every other submitter as much as to
        // Deezer.
        let inFlight = 0;
        let peak = 0;
        const client = new DeezerClient({
            fetchImpl: async () => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await new Promise(resolve => setTimeout(resolve, 5));
                inFlight--;
                return { ok: true, status: 200, json: async () => ({ id: 1 }) };
            },
        });

        const many = Array.from({ length: 30 },
            (_, i) => `USSM179${String(i).padStart(5, '0')}`);
        await client.tracksByIsrcs(many);

        expect(peak).toBeLessThanOrEqual(4);
    });

    test('every ISRC gets answered, not just the first batch', async () => {
        const many = Array.from({ length: 30 },
            (_, i) => `USSM179${String(i).padStart(5, '0')}`);
        const client = new DeezerClient({
            fetchImpl: async (url) => ({
                ok: true, status: 200,
                json: async () => ({ id: url.split('isrc:')[1] }),
            }),
        });

        const found = await client.tracksByIsrcs(many);

        expect(found.size).toBe(30);
    });

    test('is always configured, because there is nothing to configure', () => {
        // The point of Deezer going first: no client id, no token, no account.
        expect(new DeezerClient().isConfigured()).toBe(true);
    });
});
