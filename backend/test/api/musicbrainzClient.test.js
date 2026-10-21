/**
 * Reaching MusicBrainz by identifier, one request per second.
 *
 * Two things are under test and both are load-bearing. The rate limit is
 * enforced at their end and an impatient client gets its address blocked, so
 * the queue is not a courtesy. And nothing here may match on a name: a release
 * is found by barcode and names its artists by MBID, because a wrong match
 * attaches a whole vocabulary to the wrong band, silently.
 *
 * No network: fetch and sleep are both injected, so the limiter can be asserted
 * without a suite that takes a second per call.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { MusicBrainzClient } from '../../src/api/musicbrainzClient.js';

const MBID = 'c8da2e40-bd28-4d4e-813a-bd2f51958ba8';
const OTHER_MBID = '5b11f4ce-a62d-471e-81fc-a69a8278c7da';

/** A client whose HTTP layer is a lookup table, and whose clock is fake. */
function clientServing(responses, { status = 200 } = {}) {
    const asked = [];
    const waits = [];
    const client = new MusicBrainzClient({
        userAgent: 'TestAgent/1.0 ( mailto:test@example.com )',
        sleep: async (ms) => { waits.push(ms); },
        fetchImpl: async (url, options) => {
            asked.push({ url, headers: options?.headers ?? {} });
            const key = Object.keys(responses).find((prefix) => url.includes(prefix));
            return {
                ok: status >= 200 && status < 300,
                status,
                json: async () => (key ? responses[key] : {}),
            };
        },
    });
    client.asked = asked;
    client.waits = waits;
    return client;
}

describe('releasesByBarcode', () => {
    const FOUND = {
        releases: [{
            id: MBID,
            title: 'Fire of Unknown Origin',
            'release-group': { id: OTHER_MBID },
            'artist-credit': [{ artist: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } }],
        }],
    };

    test('asks by barcode and reads the release-group and artists', async () => {
        // The whole chain hangs off this: the barcode identifies the release,
        // and the release names its artists, so no name is ever compared.
        const client = clientServing({ '/release?query=': FOUND });

        expect(await client.releasesByBarcode('0 7464-37389-1')).toEqual([{
            id: MBID,
            title: 'Fire of Unknown Origin',
            releaseGroupId: OTHER_MBID,
            artistIds: ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
        }]);
        expect(client.asked[0].url).toContain('barcode%3A07464373891');
    });

    test('a printed barcode is reduced to digits first', async () => {
        const client = clientServing({ '/release?query=': { releases: [] } });
        await client.releasesByBarcode('0 7464-37389-1');
        expect(client.asked[0].url).toContain('07464373891');
    });

    test('nothing usable asks nothing', async () => {
        const client = clientServing({});
        expect(await client.releasesByBarcode('none')).toEqual([]);
        expect(await client.releasesByBarcode('')).toEqual([]);
        expect(client.asked).toEqual([]);
    });

    test('a release with no artist credit still comes back', async () => {
        const client = clientServing({
            '/release?query=': { releases: [{ id: MBID, title: 'Untitled' }] },
        });

        const [release] = await client.releasesByBarcode('07464373891');
        expect(release).toMatchObject({ releaseGroupId: null, artistIds: [] });
    });

    test('a response with no releases is empty, not a throw', async () => {
        const client = clientServing({ '/release?query=': {} });
        expect(await client.releasesByBarcode('07464373891')).toEqual([]);
    });
});

describe('vocabularyFor', () => {
    test('genres and tags come back separately', async () => {
        // They are not the same thing: one is a controlled list MusicBrainz
        // votes on, the other is what a stranger typed. Keeping them apart is
        // what lets a reader ask for one without the other.
        const client = clientServing({
            '/artist/': {
                genres: [{ name: 'hard rock', count: 7 }],
                tags: [{ name: 'melancholy', count: 2 }, { name: 'seen live', count: 400 }],
            },
        });

        expect(await client.vocabularyFor('artist', MBID)).toEqual({
            genres: [{ name: 'hard rock', count: 7 }],
            tags: [{ name: 'melancholy', count: 2 }, { name: 'seen live', count: 400 }],
        });
    });

    test('asks for both lists in one request', async () => {
        const client = clientServing({ '/release-group/': {} });
        await client.vocabularyFor('release-group', MBID);

        expect(client.asked[0].url).toContain('inc=genres+tags');
        expect(client.asked).toHaveLength(1);
    });

    test('a missing count is zero, not NaN', async () => {
        const client = clientServing({ '/artist/': { genres: [{ name: 'ambient' }] } });

        expect(await client.vocabularyFor('artist', MBID))
            .toMatchObject({ genres: [{ name: 'ambient', count: 0 }] });
    });

    test('an entity kind outside the table never reaches a URL', async () => {
        const client = clientServing({});
        await expect(client.vocabularyFor('recording; DROP', MBID))
            .rejects.toThrow(/Not a taggable entity/);
        expect(client.asked).toEqual([]);
    });

    test('something that is not an MBID is not asked about', async () => {
        // A UUID or it is a bug upstream, not a lookup to attempt.
        const client = clientServing({});

        expect(await client.vocabularyFor('artist', 'Blue Oyster Cult'))
            .toEqual({ genres: [], tags: [] });
        expect(client.asked).toEqual([]);
    });
});

describe('the rate limit they enforce', () => {
    test('a second request waits about a second', async () => {
        const client = clientServing({ '/artist/': {} });

        await client.vocabularyFor('artist', MBID);
        await client.vocabularyFor('artist', OTHER_MBID);

        expect(client.waits.filter((ms) => ms > 900)).toHaveLength(1);
    });

    test('concurrent callers queue rather than fire together', async () => {
        // The failure this prevents: two callers both read a stale
        // last-request time and send at once, which is exactly what the limit
        // forbids and what gets an address blocked.
        const client = clientServing({ '/artist/': {} });

        await Promise.all([
            client.vocabularyFor('artist', MBID),
            client.vocabularyFor('artist', OTHER_MBID),
            client.vocabularyFor('artist', MBID),
        ]);

        expect(client.asked).toHaveLength(3);
        expect(client.waits.filter((ms) => ms > 900).length).toBeGreaterThanOrEqual(2);
    });

    test('a failed request does not stop every later one', async () => {
        const client = clientServing({ '/artist/': {} }, { status: 500 });

        await expect(client.vocabularyFor('artist', MBID)).rejects.toThrow(/status 500/);
        // The queue is a promise chain; a rejection left unhandled there would
        // take down every call after it in the process.
        await expect(client.vocabularyFor('artist', OTHER_MBID)).rejects.toThrow(/status 500/);
        expect(client.asked).toHaveLength(2);
    });

    test('a 503 says it is rate limiting rather than looking like an outage', async () => {
        const client = clientServing({ '/artist/': {} }, { status: 503 });

        await expect(client.vocabularyFor('artist', MBID))
            .rejects.toMatchObject({ status: 503, message: /rate-limiting/ });
    });
});

describe('identifying this client', () => {
    test('every request carries a User-Agent naming the application', async () => {
        // MusicBrainz blocks anonymous clients, and the contact detail is how
        // they reach an operator instead of banning the address.
        const client = clientServing({ '/artist/': {} });
        await client.vocabularyFor('artist', MBID);

        expect(client.asked[0].headers['User-Agent']).toMatch(/TestAgent/);
    });

    test('the default names Polaris and where to find it', () => {
        const client = new MusicBrainzClient({ userAgent: undefined });
        expect(client.userAgent).toMatch(/Polaris/);
        expect(client.userAgent).toMatch(/polaris\.mu/);
    });

    test('needs no credentials', () => {
        expect(new MusicBrainzClient().isConfigured()).toBe(true);
    });
});
