/**
 * @fileoverview Minimal MusicBrainz client: genres, reached by identifier.
 *
 * MusicBrainz is where this registry gets a vocabulary for what a record
 * sounds like. Two lists come back and they are not the same thing:
 *
 *   genres — a controlled list, edited and voted on at MusicBrainz, with a
 *            count per genre. Clean, conservative, and short.
 *   tags   — free folksonomy, which is where the words a person would actually
 *            use live: "melancholy", "dreamy", "driving". Also where the noise
 *            lives, which genreVocabulary.js is for.
 *
 * Both are fetched and they are kept apart, under separate origins, because a
 * catalogue's editorial judgement and a stranger's adjective deserve different
 * trust and a reader should be able to ask for one without the other.
 *
 * **Nothing here matches on a name.** A release is found by its barcode, and
 * the release names its artists by MBID in the same response — so an artist's
 * genres are reached through an identifier rather than through "is this
 * 'Nirvana' the same 'Nirvana'". That is the same rule the Spotify album match
 * follows, for the same reason: a wrong match here attaches a whole vocabulary
 * to the wrong band, silently.
 *
 * No credentials. MusicBrainz asks for two things instead, and enforces the
 * first: at most one request per second from an application, and a User-Agent
 * naming the application and a way to contact whoever runs it. An anonymous or
 * impatient client gets blocked, so the queue below is not a courtesy.
 *
 * @module api/musicbrainzClient
 */

import { envSetting } from '../utils/envSetting.js';

const API_BASE = 'https://musicbrainz.org/ws/2';

/**
 * MusicBrainz permits one request per second averaged over time.
 *
 * Spaced slightly above a second rather than exactly on it: the limit is
 * enforced at their end against arrival times, and a client that aims exactly
 * at the boundary lands the wrong side of it often enough to matter.
 */
const MIN_INTERVAL_MS = 1100;

/** Their docs ask for an unreachable client to give up rather than retry hard. */
const REQUEST_TIMEOUT_MS = 10_000;

/** A barcode search can match several pressings; this many are considered. */
const BARCODE_LIMIT = 5;

export class MusicBrainzClient {
    /**
     * @param {Object} [options]
     * @param {string} [options.userAgent] - Overrides MUSICBRAINZ_USER_AGENT.
     * @param {Function} [options.fetchImpl] - Injectable for tests; no network in CI.
     * @param {Function} [options.sleep] - Injectable for tests, so the rate
     *   limiter can be asserted on without a suite that takes a second a call.
     */
    constructor({ userAgent, fetchImpl, sleep } = {}) {
        // Contact details matter to them: it is how they reach an operator
        // whose client is misbehaving instead of simply banning the address.
        // envSetting, not ??: compose passes MUSICBRAINZ_USER_AGENT as an
        // empty string when nobody set it, and a blank User-Agent is the one
        // thing MusicBrainz refuses outright — so the default has to survive
        // a value that is present but empty. See utils/envSetting.js.
        this.userAgent = envSetting(userAgent, process.env.MUSICBRAINZ_USER_AGENT,
            'PolarisMusicRegistry/1.0 ( https://polaris.mu )');
        this.fetch = fetchImpl ?? fetch;
        this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

        /** Tail of the request chain, so concurrent callers still queue. */
        this._queue = Promise.resolve();
        this._lastRequestAt = 0;
    }

    /**
     * Always configured: MusicBrainz needs no credentials.
     *
     * Present so a caller can treat every provider the same way.
     *
     * @returns {boolean}
     */
    isConfigured() {
        return true;
    }

    /**
     * GET a MusicBrainz path, one request per second, in order.
     *
     * Serialized through a promise chain rather than rate-limited per call:
     * two callers asking at once would otherwise both see a stale
     * `_lastRequestAt` and fire together, which is the exact thing the limit
     * forbids.
     *
     * @param {string} path - After /ws/2, e.g. "/artist/<mbid>?inc=genres".
     * @returns {Promise<Object>}
     * @private
     */
    async _get(path) {
        const run = this._queue.then(async () => {
            const since = Date.now() - this._lastRequestAt;
            if (since < MIN_INTERVAL_MS) await this.sleep(MIN_INTERVAL_MS - since);
            this._lastRequestAt = Date.now();

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            try {
                const response = await this.fetch(`${API_BASE}${path}`, {
                    headers: {
                        'User-Agent': this.userAgent,
                        Accept: 'application/json',
                    },
                    signal: controller.signal,
                });

                if (response.status === 503) {
                    // Their documented answer to too many requests. Reported
                    // rather than retried: a client that retries into a rate
                    // limit is the behaviour that gets an address blocked.
                    const error = new Error('MusicBrainz is rate-limiting this client');
                    error.status = 503;
                    throw error;
                }
                if (!response.ok) {
                    const error = new Error(`MusicBrainz request failed with status ${response.status}`);
                    error.status = response.status;
                    throw error;
                }
                return await response.json();
            } finally {
                clearTimeout(timer);
            }
        });

        // The chain must survive a failed request, or one error stops every
        // later call in the process.
        this._queue = run.then(() => undefined, () => undefined);
        return run;
    }

    /**
     * Releases MusicBrainz files under a barcode.
     *
     * The entry point for everything else: the registry stores a barcode on a
     * Release, and the answer here carries the release-group and the
     * artist-credit, which are what the genre lookups key on.
     *
     * @param {string} barcode - Digits.
     * @returns {Promise<Array<{id: string, title: string, releaseGroupId: string|null,
     *                          artistIds: string[]}>>}
     */
    async releasesByBarcode(barcode) {
        const digits = String(barcode ?? '').replace(/\D/g, '');
        if (!digits) return [];

        const query = encodeURIComponent(`barcode:${digits}`);
        const data = await this._get(
            `/release?query=${query}&fmt=json&limit=${BARCODE_LIMIT}`);

        return (data.releases ?? []).map((release) => ({
            id: release.id,
            title: release.title,
            releaseGroupId: release['release-group']?.id ?? null,
            artistIds: (release['artist-credit'] ?? [])
                .map((credit) => credit?.artist?.id)
                .filter(Boolean),
        })).filter((release) => release.id);
    }

    /**
     * The genres and tags on one entity.
     *
     * @param {'artist'|'release-group'|'release'} kind
     * @param {string} mbid
     * @returns {Promise<{genres: Array<{name: string, count: number}>,
     *                    tags: Array<{name: string, count: number}>}>}
     */
    async vocabularyFor(kind, mbid) {
        if (!ENTITY_KINDS.has(kind)) throw new Error(`Not a taggable entity: ${kind}`);
        if (!MBID.test(String(mbid ?? ''))) return { genres: [], tags: [] };

        const data = await this._get(`/${kind}/${mbid}?inc=genres+tags&fmt=json`);

        return {
            genres: asCounted(data.genres),
            tags: asCounted(data.tags),
        };
    }
}

/** What the ws/2 paths above accept, so `kind` never reaches a URL unchecked. */
const ENTITY_KINDS = new Set(['artist', 'release-group', 'release']);

/** A MusicBrainz id is a UUID; anything else is a bug upstream, not a lookup. */
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalize the two shapes MusicBrainz returns into one.
 *
 * @param {Array<{name?: string, count?: number}>} list
 * @returns {Array<{name: string, count: number}>}
 */
function asCounted(list) {
    return (Array.isArray(list) ? list : [])
        .filter((entry) => typeof entry?.name === 'string')
        .map((entry) => ({ name: entry.name, count: Number(entry.count) || 0 }));
}

export default MusicBrainzClient;
