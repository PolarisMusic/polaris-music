/**
 * @fileoverview Reading an artist from Discogs, with the images attached.
 *
 * The submission form has always read Discogs straight from the browser, and
 * for a tracklist that is fine. It cannot work for pictures: **Discogs serves
 * no `images` to an unauthenticated request**, and a browser cannot be given a
 * token because everything in that bundle is public. So this is the same move
 * `/api/spotify` and `/api/bandcamp` already made — the credential lives on the
 * server and the browser asks the server.
 *
 * It is the only source that photographs individual *people*. Spotify has
 * artist images and a session drummer has no artist page; a Bandcamp page has
 * one image, of the band. Discogs treats a person and a band as the same kind
 * of thing — an "artist" — so a band's page carries its members' ids, and each
 * of those is an artist page with a photograph of a human on it.
 *
 * That shape is why this fetches more than one thing: the band, then each
 * member. A five-piece costs six requests. The alternative is no photographs
 * of people at all, anywhere in the registry.
 *
 * **Without a token this still works and still has its uses.** The roster comes
 * back unauthenticated — it is only `images` that is withheld — and the roster
 * is what tells a member from a session player. So an unconfigured deployment
 * loses the pictures and keeps the classification.
 *
 * @module api/discogsClient
 */

import { envSetting } from '../utils/envSetting.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('api.discogs');

const DEFAULT_API_BASE = 'https://api.discogs.com';

/**
 * Discogs' own published ceilings: 60 requests a minute authenticated, 25
 * without. Defaulting to the lower one when there is no token is not caution,
 * it is the actual limit.
 */
const PER_MINUTE_WITH_TOKEN = 60;
const PER_MINUTE_ANONYMOUS = 25;

/**
 * How many of a band's members get a picture fetched.
 *
 * One request each, so an orchestra would otherwise spend a minute's entire
 * budget on one import. Twenty-four covers every rock band and most jazz
 * ensembles; beyond that the first two dozen are still better than none.
 */
const MEMBER_PHOTO_LIMIT = 24;

/** Discogs refuses a request with no User-Agent outright, so this is required. */
const USER_AGENT = 'PolarisMusicRegistry/1.0 (+https://polaris.mu)';

/**
 * The picture to use out of a Discogs images array.
 *
 * `primary` is the one chosen to represent the artist. A `secondary` is a live
 * shot, a different line-up, a record sleeve — fine as a fallback and wrong as
 * a first choice.
 *
 * @param {Array} images
 * @returns {string|null}
 */
export function primaryImage(images) {
    const list = Array.isArray(images) ? images : [];
    const chosen = list.find((image) => image?.type === 'primary') ?? list[0];
    const url = chosen?.uri || chosen?.resource_url;
    return typeof url === 'string' && url.trim() ? url.trim() : null;
}

export class DiscogsClient {
    /**
     * @param {Object} [options]
     * @param {string} [options.token] - Defaults to DISCOGS_TOKEN.
     * @param {string} [options.apiBase] - Defaults to DISCOGS_API_BASE.
     * @param {number} [options.perMinute] - Defaults to DISCOGS_REQUESTS_PER_MINUTE,
     *   else Discogs' own ceiling for the credential in hand.
     * @param {Function} [options.fetchImpl] - Injectable for tests; no network in CI.
     * @param {Function} [options.sleep] - Injectable for tests, so the rate
     *   limiter is assertable without a suite that waits a second a call.
     */
    constructor({ token, apiBase, perMinute, fetchImpl, sleep } = {}) {
        // envSetting rather than ??: compose passes every optional setting as
        // an empty string, which ?? accepts as configured. See
        // utils/envSetting.js — a blank API base reaching `${base}/artists/1`
        // is a relative URL and fetch throws on it.
        this.token = envSetting(token, process.env.DISCOGS_TOKEN);
        this.apiBase = envSetting(apiBase, process.env.DISCOGS_API_BASE, DEFAULT_API_BASE)
            .replace(/\/+$/, '');

        const configured = Number(perMinute ?? process.env.DISCOGS_REQUESTS_PER_MINUTE);
        this.perMinute = Number.isFinite(configured) && configured > 0
            ? configured
            : (this.token ? PER_MINUTE_WITH_TOKEN : PER_MINUTE_ANONYMOUS);

        this.fetch = fetchImpl ?? fetch;
        this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.now = () => Date.now();

        /** Tail of the request chain, so concurrent callers still queue. */
        this._queue = Promise.resolve();
        this._lastRequestAt = -Infinity;
    }

    /**
     * Whether a token is present.
     *
     * Not a precondition for using this: the roster is public and the
     * classification that depends on it keeps working. It decides whether
     * there will be any pictures.
     *
     * @returns {boolean}
     */
    isConfigured() {
        return Boolean(this.token);
    }

    /** Milliseconds between requests, from the configured rate. */
    get _interval() {
        return Math.ceil(60_000 / this.perMinute);
    }

    /**
     * One GET, in turn.
     *
     * Serialized through a promise chain rather than rate-limited per call: two
     * callers asking at once would both read a stale `_lastRequestAt` and fire
     * together, which is the one thing a per-minute budget cannot absorb.
     *
     * @param {string} path - Beginning with a slash.
     * @returns {Promise<Object>}
     * @private
     */
    async _get(path) {
        const run = async () => {
            const wait = this._lastRequestAt + this._interval - this.now();
            if (wait > 0) await this.sleep(wait);
            this._lastRequestAt = this.now();

            const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
            // Discogs' own scheme, and not a Bearer token. OAuth is the other
            // one and is only needed to act on somebody else's account.
            if (this.token) headers.Authorization = `Discogs token=${this.token}`;

            const response = await this.fetch(`${this.apiBase}${path}`, { headers });
            if (!response.ok) {
                const error = new Error(`Discogs responded ${response.status}`);
                error.status = response.status;
                throw error;
            }
            return response.json();
        };

        this._queue = this._queue.then(run, run);
        return this._queue;
    }

    /**
     * An artist, its picture, and its members with theirs.
     *
     * @param {string|number} id - A Discogs artist id.
     * @returns {Promise<{id: number|null, name: string|null, photo: string|null,
     *                    members: Array<{id: number|null, name: string,
     *                                    photo: string|null, active: boolean}>}>}
     */
    async artistWithMembers(id) {
        const artist = await this._get(`/artists/${encodeURIComponent(id)}`);

        const roster = Array.isArray(artist?.members) ? artist.members : [];
        const members = [];

        for (const member of roster.slice(0, MEMBER_PHOTO_LIMIT)) {
            const name = String(member?.name ?? '').trim();
            if (!name) continue;

            const entry = {
                id: member?.id ?? null,
                name,
                photo: null,
                active: member?.active !== false,
            };

            // A member entry carries no images of its own, only an id — so a
            // photograph of this person is another request. Each one is
            // allowed to fail on its own: a missing picture is cosmetic, and
            // one dead artist page must not cost the whole roster.
            if (entry.id != null && this.token) {
                try {
                    entry.photo = primaryImage((await this._get(
                        `/artists/${encodeURIComponent(entry.id)}`))?.images);
                } catch (error) {
                    log.warn('member_photo_failed', { id: entry.id, error: error.message });
                }
            }

            members.push(entry);
        }

        // The ones past the limit still belong to the band; they simply arrive
        // without a picture, which is what they would have had anyway.
        for (const member of roster.slice(MEMBER_PHOTO_LIMIT)) {
            const name = String(member?.name ?? '').trim();
            if (name) {
                members.push({
                    id: member?.id ?? null, name, photo: null,
                    active: member?.active !== false,
                });
            }
        }

        return {
            id: artist?.id ?? null,
            name: String(artist?.name ?? '').trim() || null,
            photo: primaryImage(artist?.images),
            members,
        };
    }
}
