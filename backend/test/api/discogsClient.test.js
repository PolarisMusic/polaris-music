/**
 * Reading a Discogs artist with its pictures attached.
 *
 * The reason this is server-side at all: Discogs serves no `images` to an
 * unauthenticated request, and a browser cannot hold a token because the
 * bundle is public. Everything else about Discogs works fine from the page,
 * which is why the tracklist import still runs there.
 *
 * It is also the only source that photographs individual people. Spotify has
 * artist images and a session drummer has no artist page; a Bandcamp page has
 * one image, of the band. Discogs files a person and a band as the same kind
 * of thing, so a band's members each have an artist page with a photograph of
 * a human on it — which is why this makes more than one request.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { DiscogsClient, primaryImage } from '../../src/api/discogsClient.js';

/** A client answering from a fixture, with no clock to wait on. */
function clientServing(byPath, { token = 'tok' } = {}) {
    const asked = [];
    const client = new DiscogsClient({
        token,
        fetchImpl: async (url) => {
            const path = url.replace('https://api.discogs.com', '');
            asked.push(path);
            const body = byPath[path];
            if (body === undefined) {
                return { ok: false, status: 404, json: async () => ({}) };
            }
            if (body instanceof Error) {
                return { ok: false, status: body.status ?? 500, json: async () => ({}) };
            }
            return { ok: true, status: 200, json: async () => body };
        },
        sleep: async () => {},
    });
    client.asked = asked;
    return client;
}

const refusal = (status) => Object.assign(new Error('refused'), { status });

describe('which picture of an artist is used', () => {
    test('the primary one', () => {
        expect(primaryImage([
            { type: 'secondary', uri: 'https://img/live' },
            { type: 'primary', uri: 'https://img/promo' },
        ])).toBe('https://img/promo');
    });

    test('a secondary will do when there is no primary', () => {
        // A live shot or a different line-up: fine as a fallback, wrong as a
        // first choice.
        expect(primaryImage([{ type: 'secondary', uri: 'https://img/live' }]))
            .toBe('https://img/live');
    });

    test.each([
        ['no images', []],
        ['not a list', null],
        ['an entry with no url', [{ type: 'primary' }]],
        ['a blank url', [{ type: 'primary', uri: '   ' }]],
    ])('%s gives null rather than a broken img src', (_label, images) => {
        expect(primaryImage(images)).toBeNull();
    });
});

describe('an artist and its members', () => {
    const BAND = {
        '/artists/7': {
            id: 7,
            name: 'Dum Dum Girls',
            images: [{ type: 'primary', uri: 'https://img/band' }],
            members: [
                { id: 11, name: 'Kristen Gundred', active: true },
                { id: 12, name: 'Jules Medeiros', active: false },
            ],
        },
        '/artists/11': { id: 11, images: [{ type: 'primary', uri: 'https://img/kg' }] },
        '/artists/12': { id: 12, images: [{ type: 'primary', uri: 'https://img/jm' }] },
    };

    test('the band’s own photograph comes back', async () => {
        const artist = await clientServing(BAND).artistWithMembers(7);

        expect(artist).toMatchObject({ id: 7, name: 'Dum Dum Girls', photo: 'https://img/band' });
    });

    test('and one for each member, which costs a request each', async () => {
        // A member entry carries an id and no images, so a photograph of that
        // person is another artist page. There is no batch form.
        const client = clientServing(BAND);
        const artist = await client.artistWithMembers(7);

        expect(artist.members).toEqual([
            { id: 11, name: 'Kristen Gundred', photo: 'https://img/kg', active: true },
            { id: 12, name: 'Jules Medeiros', photo: 'https://img/jm', active: false },
        ]);
        expect(client.asked).toEqual(['/artists/7', '/artists/11', '/artists/12']);
    });

    test('a member whose page is gone keeps their place in the roster', async () => {
        // A missing picture is cosmetic; one dead artist page must not cost
        // the membership list, which is what tells a member from a session
        // player.
        const artist = await clientServing({
            ...BAND, '/artists/12': refusal(404),
        }).artistWithMembers(7);

        expect(artist.members.map((m) => m.name))
            .toEqual(['Kristen Gundred', 'Jules Medeiros']);
        expect(artist.members[1].photo).toBeNull();
    });

    test('a solo artist has no roster and that is not an error', async () => {
        const artist = await clientServing({
            '/artists/9': { id: 9, name: 'Somebody', images: [] },
        }).artistWithMembers(9);

        expect(artist.members).toEqual([]);
        expect(artist.photo).toBeNull();
    });

    test('a nameless roster entry is dropped', async () => {
        const artist = await clientServing({
            '/artists/7': { id: 7, name: 'B', members: [{ id: 1, name: '  ' }, { id: 2, name: 'Real' }] },
            '/artists/2': { id: 2, images: [] },
        }).artistWithMembers(7);

        expect(artist.members.map((m) => m.name)).toEqual(['Real']);
    });

    test('an artist that does not exist is reported, not swallowed', async () => {
        // The roster matters enough that a failure has to reach the caller.
        await expect(clientServing({}).artistWithMembers(404404))
            .rejects.toMatchObject({ status: 404 });
    });
});

describe('an orchestra, where a photo each is too many requests', () => {
    const huge = (count) => {
        const members = Array.from({ length: count }, (_, i) => ({ id: 100 + i, name: `P${i}` }));
        const byPath = { '/artists/7': { id: 7, name: 'Orchestra', members } };
        members.forEach((m) => { byPath[`/artists/${m.id}`] = { id: m.id, images: [] }; });
        return byPath;
    };

    test('only the first two dozen get one', async () => {
        const client = clientServing(huge(40));
        const artist = await client.artistWithMembers(7);

        // The band's page plus 24 member pages, not 41.
        expect(client.asked).toHaveLength(25);
        expect(artist.members).toHaveLength(40);
    });

    test('the rest still belong to the band', async () => {
        // They arrive without a picture, which is what they would have had
        // anyway — being 30th in a roster is not a reason to be left out.
        const artist = await clientServing(huge(40)).artistWithMembers(7);

        expect(artist.members[39]).toMatchObject({ name: 'P39', photo: null });
    });
});

describe('without a token', () => {
    test('the roster still comes back', async () => {
        // It is only `images` Discogs withholds, and the roster is the half
        // that drives member-vs-guest classification.
        const artist = await clientServing({
            '/artists/7': { id: 7, name: 'Band', members: [{ id: 11, name: 'K' }] },
        }, { token: '' }).artistWithMembers(7);

        expect(artist.members.map((m) => m.name)).toEqual(['K']);
    });

    test('no member pages are fetched, because they would carry nothing', async () => {
        const client = clientServing({
            '/artists/7': { id: 7, name: 'Band', members: [{ id: 11, name: 'K' }] },
        }, { token: '' });
        await client.artistWithMembers(7);

        expect(client.asked).toEqual(['/artists/7']);
    });

    test('isConfigured says which it is', async () => {
        expect(clientServing({}, { token: '' }).isConfigured()).toBe(false);
        expect(clientServing({}, { token: 'tok' }).isConfigured()).toBe(true);
    });

    test('the rate ceiling drops to the one Discogs actually allows', () => {
        // 60 a minute with a token, 25 without. Defaulting to the lower one is
        // not caution, it is the limit.
        expect(new DiscogsClient({ token: 'tok' }).perMinute).toBe(60);
        expect(new DiscogsClient({ token: '' }).perMinute).toBe(25);
    });

    test('an explicit rate overrides both', () => {
        expect(new DiscogsClient({ token: 'tok', perMinute: 10 }).perMinute).toBe(10);
    });
});

describe('the request itself', () => {
    test('carries the token in Discogs’ own scheme, not as a Bearer', async () => {
        let headers;
        const client = new DiscogsClient({
            token: 'secret',
            fetchImpl: async (_url, init) => {
                headers = init.headers;
                return { ok: true, status: 200, json: async () => ({ id: 1, name: 'A' }) };
            },
            sleep: async () => {},
        });
        await client.artistWithMembers(1);

        expect(headers.Authorization).toBe('Discogs token=secret');
    });

    test('always carries a User-Agent, which Discogs requires', async () => {
        let headers;
        const client = new DiscogsClient({
            token: '',
            fetchImpl: async (_url, init) => {
                headers = init.headers;
                return { ok: true, status: 200, json: async () => ({ id: 1, name: 'A' }) };
            },
            sleep: async () => {},
        });
        await client.artistWithMembers(1);

        // A request without one is refused outright.
        expect(headers['User-Agent']).toContain('PolarisMusicRegistry');
        expect(headers.Authorization).toBeUndefined();
    });

    test('waits between requests rather than firing them together', async () => {
        const waits = [];
        let clock = 0;
        const client = new DiscogsClient({
            token: 'tok',
            perMinute: 60,
            fetchImpl: async (url) => ({
                ok: true,
                status: 200,
                json: async () => (url.endsWith('/artists/7')
                    ? { id: 7, name: 'B', members: [{ id: 11, name: 'K' }] }
                    : { id: 11, images: [] }),
            }),
            sleep: async (ms) => { waits.push(ms); clock += ms; },
        });
        client.now = () => clock;

        await client.artistWithMembers(7);

        // One second apart at 60/min: the second request waited.
        expect(waits.filter((ms) => ms > 0)).toEqual([1000]);
    });
});
