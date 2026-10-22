/**
 * Odesli: one recording, every service, one request.
 *
 * The three things worth pinning are the ones a key changes. A 401 means the
 * key is not being accepted, not that the service is down — keyless access is
 * retired, so with a key configured there is no other reading. The rate is set
 * by the grant rather than by the code, so it has to be configurable and the
 * limiter has to hold to whatever it is set to. And a failure half way through
 * an album must leave the links already found in place.
 *
 * No network: fetch and sleep are both injected.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { OdesliClient, PLATFORMS } from '../../src/api/odesliClient.js';

const SPOTIFY = 'https://open.spotify.com/track/trk1';

const FULL_RESPONSE = {
    entityUniqueId: 'SPOTIFY_SONG::trk1',
    linksByPlatform: {
        spotify: { url: 'https://open.spotify.com/track/trk1' },
        appleMusic: { url: 'https://music.apple.com/us/album/x/1?i=2' },
        deezer: { url: 'https://www.deezer.com/track/3135556' },
        tidal: { url: 'https://tidal.com/browse/track/99' },
        youtubeMusic: { url: 'https://music.youtube.com/watch?v=abc' },
        youtube: { url: 'https://www.youtube.com/watch?v=abc' },
        amazonMusic: { url: 'https://music.amazon.com/albums/B01?trackAsin=B02' },
        soundcloud: { url: 'https://soundcloud.com/artist/track' },
        pandora: { url: 'https://pandora.com/artist/album/track' },
        // Purchase pages, deliberately not stored: the field is listen_links.
        itunes: { url: 'https://itunes.apple.com/us/album/x/1?i=2&uo=4' },
        amazonStore: { url: 'https://amazon.com/dp/B01' },
        googleStore: { url: 'https://play.google.com/store/music/x' },
        // A service the allowlist does not carry yet.
        anghami: { url: 'https://play.anghami.com/song/1' },
    },
};

/** A client whose HTTP layer is a table and whose clock is fake. */
function clientServing(body, { status = 200, apiKey = 'test-key', ...options } = {}) {
    const asked = [];
    const waits = [];
    const client = new OdesliClient({
        apiKey,
        sleep: async (ms) => { waits.push(ms); },
        fetchImpl: async (url) => {
            asked.push(url);
            return {
                ok: status >= 200 && status < 300,
                status,
                json: async () => (typeof body === 'function' ? body(url) : body),
            };
        },
        ...options,
    });
    client.asked = asked;
    client.waits = waits;
    return client;
}

describe('linksFor', () => {
    test('returns every allowlisted service under our own name for it', async () => {
        const client = clientServing(FULL_RESPONSE);

        expect(await client.linksFor(SPOTIFY)).toEqual({
            spotify: 'https://open.spotify.com/track/trk1',
            apple: 'https://music.apple.com/us/album/x/1?i=2',
            deezer: 'https://www.deezer.com/track/3135556',
            tidal: 'https://tidal.com/browse/track/99',
            youtubeMusic: 'https://music.youtube.com/watch?v=abc',
            youtube: 'https://www.youtube.com/watch?v=abc',
            amazonMusic: 'https://music.amazon.com/albums/B01?trackAsin=B02',
            soundcloud: 'https://soundcloud.com/artist/track',
            pandora: 'https://pandora.com/artist/album/track',
        });
    });

    test('store pages are not listen links', async () => {
        // iTunes, Amazon's store and Google's are purchases. Storing them in a
        // field called listen_links makes a different claim about a recording.
        const found = await clientServing(FULL_RESPONSE).linksFor(SPOTIFY);

        expect(Object.values(found).join(' ')).not.toMatch(/itunes|amazon\.com\/dp|play\.google/);
    });

    test('a service outside the allowlist is left out', async () => {
        // Not a judgement about Anghami: a stored link should be one
        // listenLinks.js can reduce to its identity, or it goes in raw.
        const found = await clientServing(FULL_RESPONSE).linksFor(SPOTIFY);
        expect(found).not.toHaveProperty('anghami');
    });

    test('the key and country go on the request', async () => {
        const client = clientServing(FULL_RESPONSE, { apiKey: 'abc123', userCountry: 'GB' });
        await client.linksFor(SPOTIFY);

        expect(client.asked[0]).toContain('key=abc123');
        expect(client.asked[0]).toContain('userCountry=GB');
    });

    test('a single is not silently turned into a song', async () => {
        // Odesli answers a single's album URL with the song unless told not to,
        // which would quietly file a release link as a track link.
        const client = clientServing(FULL_RESPONSE);
        await client.linksFor(SPOTIFY);

        expect(client.asked[0]).toContain('songIfSingle=false');
    });

    test('a recording Odesli does not know is empty, not an error', async () => {
        expect(await clientServing({ linksByPlatform: {} }).linksFor(SPOTIFY)).toEqual({});
        expect(await clientServing({}).linksFor(SPOTIFY)).toEqual({});
    });

    test('a platform entry with no url is skipped', async () => {
        const client = clientServing({ linksByPlatform: { tidal: { entityUniqueId: 'x' } } });
        expect(await client.linksFor(SPOTIFY)).toEqual({});
    });

    test('something that is not a URL is not asked about', async () => {
        const client = clientServing(FULL_RESPONSE);

        expect(await client.linksFor('USSM17900123')).toEqual({});
        expect(await client.linksFor('')).toEqual({});
        expect(client.asked).toEqual([]);
    });
});

describe('the key', () => {
    test('without one, nothing is asked and the failure says why', async () => {
        const client = clientServing(FULL_RESPONSE, { apiKey: '' });

        expect(client.isConfigured()).toBe(false);
        await expect(client.linksFor(SPOTIFY)).rejects.toMatchObject({ status: 401 });
        expect(client.asked).toEqual([]);
    });

    test('a 401 is reported as the key, not as an outage', async () => {
        // Keyless access is retired, so with a key configured there is no other
        // reading of a 401 — and "service unavailable" would send an operator
        // to check the wrong thing.
        const client = clientServing(FULL_RESPONSE, { status: 401 });

        await expect(client.linksFor(SPOTIFY))
            .rejects.toThrow(/ODESLI_API_KEY is missing, wrong, or not yet active/);
    });

    test('a 410 names the namespace, which they have announced retiring', async () => {
        const client = clientServing(FULL_RESPONSE, { status: 410 });

        await expect(client.linksFor(SPOTIFY)).rejects.toThrow(/ODESLI_API_BASE/);
    });

    test('a 429 says it is the key being limited', async () => {
        const client = clientServing(FULL_RESPONSE, { status: 429 });
        await expect(client.linksFor(SPOTIFY)).rejects.toThrow(/rate-limiting this key/);
    });

    test('the namespace is configurable, because theirs is not forever', async () => {
        const client = clientServing(FULL_RESPONSE, { apiBase: 'https://api.song.link/v2' });
        await client.linksFor(SPOTIFY);

        expect(client.asked[0]).toContain('https://api.song.link/v2/links?');
    });
});

describe('the rate the grant sets', () => {
    test('defaults above the keyless tier, since a key is required at all', async () => {
        expect(new OdesliClient({ apiKey: 'k' }).perMinute).toBe(60);
    });

    test('is configurable, and the interval follows it', async () => {
        const client = clientServing(FULL_RESPONSE, { perMinute: 10 });

        await client.linksFor(SPOTIFY);
        await client.linksFor(SPOTIFY);

        // Ten a minute is a six-second gap; sixty is one.
        expect(client.waits.some((ms) => ms > 5000)).toBe(true);
    });

    test('concurrent callers queue rather than fire together', async () => {
        const client = clientServing(FULL_RESPONSE, { perMinute: 60 });

        await Promise.all([
            client.linksFor(SPOTIFY),
            client.linksFor(SPOTIFY),
            client.linksFor(SPOTIFY),
        ]);

        expect(client.asked).toHaveLength(3);
        expect(client.waits.filter((ms) => ms > 500).length).toBeGreaterThanOrEqual(2);
    });

    test('a failed request does not stop every later one', async () => {
        const client = clientServing(FULL_RESPONSE, { status: 500 });

        await expect(client.linksFor(SPOTIFY)).rejects.toThrow(/status 500/);
        await expect(client.linksFor(SPOTIFY)).rejects.toThrow(/status 500/);
        expect(client.asked).toHaveLength(2);
    });
});

describe('resolveLinks, as the provider table calls it', () => {
    test('keys the answer by the id the caller assigned', async () => {
        const client = clientServing(FULL_RESPONSE);

        const found = await client.resolveLinks([{ id: 'USSM17900123', url: SPOTIFY }]);

        expect([...found.keys()]).toEqual(['USSM17900123']);
        expect(found.get('USSM17900123').apple).toBe('https://music.apple.com/us/album/x/1?i=2');
    });

    test('an item with no URL is skipped, not failed', async () => {
        // Odesli has no other way in, and another provider in the table may
        // resolve that item by ISRC.
        const client = clientServing(FULL_RESPONSE);

        const found = await client.resolveLinks([
            { id: 'a', isrc: 'USSM17900123' },
            { id: 'b', url: SPOTIFY },
        ]);

        expect([...found.keys()]).toEqual(['b']);
        expect(client.asked).toHaveLength(1);
    });

    test('a failure part way through keeps what came before it', async () => {
        // A timeout on track nine must not discard tracks one to eight.
        let seen = 0;
        const client = new OdesliClient({
            apiKey: 'test-key',
            sleep: async () => {},
            fetchImpl: async () => {
                seen += 1;
                if (seen === 2) throw new Error('ETIMEDOUT');
                return { ok: true, status: 200, json: async () => FULL_RESPONSE };
            },
        });

        const found = await client.resolveLinks([
            { id: 'a', url: SPOTIFY },
            { id: 'b', url: SPOTIFY },
            { id: 'c', url: SPOTIFY },
        ]);

        // The second item is lost; the first and third are not, because a
        // timeout is about one request rather than about the key.
        expect([...found.keys()]).toEqual(['a', 'c']);
        expect(seen).toBe(3);
    });

    test('a rejected key stops the batch rather than repeating the error', async () => {
        // Every subsequent request would fail identically and spend the rate
        // limit proving it.
        const client = clientServing(FULL_RESPONSE, { status: 401 });

        const found = await client.resolveLinks([
            { id: 'a', url: SPOTIFY },
            { id: 'b', url: SPOTIFY },
            { id: 'c', url: SPOTIFY },
        ]);

        expect(found.size).toBe(0);
        expect(client.asked).toHaveLength(1);
    });

    test('an unconfigured client resolves nothing and asks nothing', async () => {
        const client = clientServing(FULL_RESPONSE, { apiKey: '' });

        expect((await client.resolveLinks([{ id: 'a', url: SPOTIFY }])).size).toBe(0);
        expect(client.asked).toEqual([]);
    });

    test('nothing in, nothing out', async () => {
        const client = clientServing(FULL_RESPONSE);
        expect((await client.resolveLinks([])).size).toBe(0);
        expect((await client.resolveLinks(undefined)).size).toBe(0);
    });
});

describe('the platform allowlist', () => {
    test('maps Odesli names onto ours', () => {
        expect(PLATFORMS.appleMusic).toBe('apple');
        expect(PLATFORMS.youtubeMusic).toBe('youtubeMusic');
    });

    test('carries no store pages', () => {
        expect(Object.keys(PLATFORMS)).not.toContain('itunes');
        expect(Object.keys(PLATFORMS)).not.toContain('amazonStore');
        expect(Object.keys(PLATFORMS)).not.toContain('googleStore');
    });
});

describe('settings that arrive blank from compose', () => {
    /**
     * docker-compose.yml passes each optional setting as `- FOO=${FOO:-}`, so
     * one nobody set lands in the container as an empty string. `??` took that
     * for a configured value, which left apiBase empty and every lookup
     * throwing "Failed to parse URL from /links?…" — a key correctly installed
     * in .env would still have resolved nothing, and the error names neither
     * the setting nor the cause. See utils/envSetting.js.
     *
     * Reproduced here rather than inferred: these set the variables the way the
     * container does and construct the client the way routes/links.js does,
     * with no options at all.
     */
    const withEnv = async (vars, run) => {
        const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
        Object.assign(process.env, vars);
        try {
            return await run();
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    };

    /** A client built from the environment alone, as the route builds it. */
    const fromEnv = () => {
        const asked = [];
        const client = new OdesliClient({
            sleep: async () => {},
            fetchImpl: async (url) => {
                asked.push(url);
                return { ok: true, status: 200, json: async () => FULL_RESPONSE };
            },
        });
        client.asked = asked;
        return client;
    };

    test('a blank API base still reaches song.link', async () => {
        await withEnv({ ODESLI_API_KEY: 'k', ODESLI_API_BASE: '' }, async () => {
            const client = fromEnv();
            await client.linksFor(SPOTIFY);

            expect(client.asked[0]).toMatch(/^https:\/\/api\.song\.link\/v1-alpha\.1\/links\?/);
        });
    });

    test('a blank user country is still a country', async () => {
        await withEnv({ ODESLI_API_KEY: 'k', ODESLI_USER_COUNTRY: '' }, async () => {
            const client = fromEnv();
            await client.linksFor(SPOTIFY);

            // `userCountry=` would ask Odesli about no catalogue at all.
            expect(client.asked[0]).toContain('userCountry=US');
        });
    });

    test('a blank key is not configured, and does not pretend to be', async () => {
        await withEnv({ ODESLI_API_KEY: '   ' }, async () => {
            expect(fromEnv().isConfigured()).toBe(false);
        });
    });

    test('a key pasted with whitespace is still the key', async () => {
        // What a copy out of an email looks like. Sent as-is it is a 401, and a
        // 401 reads as "the key is wrong" rather than "the key has a newline".
        await withEnv({ ODESLI_API_KEY: '  real-key\n' }, async () => {
            const client = fromEnv();
            await client.linksFor(SPOTIFY);

            expect(client.isConfigured()).toBe(true);
            expect(client.asked[0]).toContain('key=real-key');
        });
    });

    test('a trailing slash on the base does not double up', async () => {
        await withEnv({
            ODESLI_API_KEY: 'k',
            ODESLI_API_BASE: 'https://api.song.link/v1-alpha.1/',
        }, async () => {
            const client = fromEnv();
            await client.linksFor(SPOTIFY);

            expect(client.asked[0]).toContain('/v1-alpha.1/links?');
            expect(client.asked[0]).not.toContain('//links');
        });
    });

    test('a base that is actually set is still honoured', async () => {
        // The setting exists because they announced v1-alpha.1's retirement.
        await withEnv({
            ODESLI_API_KEY: 'k',
            ODESLI_API_BASE: 'https://api.song.link/v2',
        }, async () => {
            const client = fromEnv();
            await client.linksFor(SPOTIFY);

            expect(client.asked[0]).toMatch(/^https:\/\/api\.song\.link\/v2\/links\?/);
        });
    });
});
