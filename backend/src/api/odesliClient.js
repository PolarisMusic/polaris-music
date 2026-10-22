/**
 * @fileoverview Odesli (song.link): one recording, every service, one request.
 *
 * Odesli is what the per-service clients in this directory were a workaround
 * for. Given one platform's URL it returns the same recording on Apple Music,
 * Tidal, YouTube Music, Amazon Music, Deezer, SoundCloud and Pandora — which is
 * the whole of the cross-service link feature in a single call, where the
 * alternative is a client, a credential and a rate limit per service.
 *
 * It needs a key. Odesli stopped issuing them and retired keyless access: an
 * unauthenticated request answers `401 PUBLIC_API_ACCESS_DEPRECATED`, which is
 * what this deployment measured on 2026-10-17 before a key was granted. So the
 * client reports a 401 as "the key is not being accepted" rather than as an
 * outage, because with a key configured that is what a 401 means.
 *
 * Three things about the service are set by the key rather than by the
 * documentation, and all three are environment variables so that correcting
 * one is a restart rather than a release:
 *
 *   ODESLI_API_KEY               — the key itself; nothing works without it
 *   ODESLI_API_BASE              — the namespace, in case it has moved on from
 *                                  v1-alpha.1, whose retirement they announced
 *   ODESLI_REQUESTS_PER_MINUTE   — the keyless tier was 10; a key raises it,
 *                                  and the grant says to what
 *
 * Resolution is by URL, not by ISRC. That is Odesli's own interface and it
 * suits this registry: the Spotify URL a submission already holds was itself
 * matched by barcode or by title under the rules in tracklistDiff.js, so the
 * identity question is already settled before Odesli is asked. Asking by name
 * never happens.
 *
 * @module api/odesliClient
 */

import { envSetting } from '../utils/envSetting.js';

/**
 * The namespace the grant names, overridable because they announced its end.
 *
 * api.odesli.co rather than api.song.link: both have served this API, and the
 * approval email gives odesli.co as the host to authenticate against. A key is
 * issued for what the issuer says to call.
 */
const DEFAULT_API_BASE = 'https://api.odesli.co/v1-alpha.1';

/**
 * Requests a minute, when the grant does not say.
 *
 * Sixty rather than ten, because a key is required for this client to work at
 * all and the retired keyless figure is never the right one here. Set
 * ODESLI_REQUESTS_PER_MINUTE to whatever the grant says — this deployment's is
 * 2/min with an hourly cap of 120, which is the rate the budget below exists
 * for.
 */
const DEFAULT_PER_MINUTE = 60;

/**
 * How long a batch may spend waiting for its turn before it gives up the rest.
 *
 * A rate limit is not a speed; it is a queue, and at 2/min the queue is thirty
 * seconds long. A twelve-row album is then five and a half minutes during which
 * an HTTP request is held open — there is no timeout in the browser, in Caddy
 * or on the route — and the hourly cap of 120 would be gone after ten albums.
 *
 * So a batch resolves what it can inside this budget and leaves the rest. It
 * always attempts the first item, however slow the queue, because the caller
 * orders the batch by value: routes/links.js is sent the release row first, and
 * one request that returns the album on nine services is the most useful single
 * answer there is. Costs nothing at a generous rate: at 60/min the interval is
 * a second and every row of an album fits.
 */
const DEFAULT_BUDGET_MS = 25_000;

/** Node's fetch has no default timeout; an unreachable host would hang. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Platforms whose links this registry stores, and what it calls them.
 *
 * An allowlist rather than everything Odesli knows about, for two reasons. A
 * stored link should be one `utils/listenLinks.js` can reduce to its identity,
 * or it goes in raw with whatever tracking the URL carried. And the field is
 * called listen_links: `itunes`, `amazonStore` and `googleStore` are purchase
 * pages, which is a different claim about a recording.
 *
 * Adding a service means a line here and a parser there, in that order.
 */
export const PLATFORMS = Object.freeze({
    spotify: 'spotify',
    appleMusic: 'apple',
    deezer: 'deezer',
    tidal: 'tidal',
    youtubeMusic: 'youtubeMusic',
    youtube: 'youtube',
    amazonMusic: 'amazonMusic',
    soundcloud: 'soundcloud',
    pandora: 'pandora',
});

export class OdesliClient {
    /**
     * @param {Object} [options]
     * @param {string} [options.apiKey] - Defaults to ODESLI_API_KEY.
     * @param {string} [options.apiBase] - Defaults to ODESLI_API_BASE.
     * @param {number} [options.perMinute] - Defaults to ODESLI_REQUESTS_PER_MINUTE.
     * @param {string} [options.userCountry] - Two-letter country whose
     *   catalogue is asked about; a recording can be absent from one store and
     *   present in another.
     * @param {Function} [options.fetchImpl] - Injectable for tests; no network in CI.
     * @param {Function} [options.sleep] - Injectable for tests, so the rate
     *   limiter is assertable without a suite that waits a second a call.
     */
    constructor({ apiKey, apiBase, perMinute, userCountry, budgetMs,
        fetchImpl, sleep } = {}) {
        // envSetting, not ??: compose passes every optional setting as an
        // empty string, which ?? accepts as configured. A blank ODESLI_API_BASE
        // reaching `${this.apiBase}/links` is a relative URL, and fetch throws
        // on it — so the key alone would have produced a feature that failed
        // every lookup. See utils/envSetting.js.
        this.apiKey = envSetting(apiKey, process.env.ODESLI_API_KEY);
        // Trailing slashes stripped because this one is typed by an operator,
        // and `…/v1-alpha.1//links` is not a path Odesli serves.
        this.apiBase = envSetting(apiBase, process.env.ODESLI_API_BASE, DEFAULT_API_BASE)
            .replace(/\/+$/, '');
        this.userCountry = envSetting(userCountry, process.env.ODESLI_USER_COUNTRY, 'US');

        const configured = Number(perMinute ?? process.env.ODESLI_REQUESTS_PER_MINUTE);
        this.perMinute = Number.isFinite(configured) && configured > 0
            ? configured
            : DEFAULT_PER_MINUTE;

        this.budgetMs = Number(budgetMs) > 0 ? Number(budgetMs) : DEFAULT_BUDGET_MS;

        this.fetch = fetchImpl ?? fetch;
        this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        /** Injectable clock, so the batch budget is testable without waiting. */
        this.now = () => Date.now();

        /** Tail of the request chain, so concurrent callers still queue. */
        this._queue = Promise.resolve();
        this._lastRequestAt = -Infinity;
    }

    /**
     * Whether a key is present.
     *
     * Checked rather than assumed because every other provider in this table
     * answers without credentials: an unconfigured Odesli has to drop out of
     * the answer rather than fill it with 401s.
     *
     * @returns {boolean}
     */
    isConfigured() {
        return Boolean(this.apiKey);
    }

    /** Milliseconds between requests, from the configured rate. */
    get _interval() {
        return Math.ceil(60_000 / this.perMinute);
    }

    /**
     * GET /links for one URL, in turn.
     *
     * Serialized through a promise chain rather than rate-limited per call: two
     * callers asking at once would both see a stale `_lastRequestAt` and fire
     * together, which is the one thing a per-minute budget cannot absorb.
     *
     * @param {string} url - A platform URL, e.g. an open.spotify.com track.
     * @returns {Promise<Object>} The raw Odesli response.
     * @private
     */
    async _links(url) {
        const query = new URLSearchParams({
            url,
            userCountry: this.userCountry,
            key: this.apiKey,
            // Odesli otherwise answers a single's album URL with the song, which
            // silently turns a release link into a track link.
            songIfSingle: 'false',
        });

        const run = this._queue.then(async () => {
            // this.now() rather than Date.now() so the pacing and the batch
            // budget are measured against one clock; the first request of a
            // process is immediate because nothing has been sent yet.
            const since = this.now() - this._lastRequestAt;
            if (since < this._interval) await this.sleep(this._interval - since);
            this._lastRequestAt = this.now();

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            try {
                const response = await this.fetch(`${this.apiBase}/links?${query}`, {
                    headers: { Accept: 'application/json' },
                    signal: controller.signal,
                });

                if (!response.ok) {
                    const error = new Error(describeStatus(response.status));
                    error.status = response.status;
                    throw error;
                }
                return await response.json();
            } finally {
                clearTimeout(timer);
            }
        });

        // The chain has to survive a rejection or one failure stops every later
        // request in the process.
        this._queue = run.then(() => undefined, () => undefined);
        return run;
    }

    /**
     * Every service Odesli knows this recording on.
     *
     * @param {string} url - A platform URL for the recording.
     * @returns {Promise<Record<string, string>>} service name -> URL, empty
     *   when Odesli does not know the recording.
     */
    async linksFor(url) {
        if (!this.isConfigured()) throw missingKey();
        if (!/^https?:\/\//i.test(String(url ?? '').trim())) return {};

        const data = await this._links(String(url).trim());
        const byPlatform = data?.linksByPlatform ?? {};

        const found = {};
        for (const [platform, service] of Object.entries(PLATFORMS)) {
            const link = byPlatform[platform]?.url;
            if (typeof link === 'string' && /^https?:\/\//i.test(link)) {
                found[service] = link;
            }
        }
        return found;
    }

    /**
     * Resolve a batch, one request each, skipping what it cannot ask about.
     *
     * Shaped to the provider table in routes/links.js: items carry an id the
     * caller assigns, and the answer is keyed by it. An item with no URL is not
     * an error — Odesli has no other way in, and another provider in the table
     * may resolve it by ISRC.
     *
     * One failure does not fail the batch. A rate limit reached half way
     * through a long album should leave the links it already found in place.
     *
     * Stops when the next item's turn would not come inside the budget, and
     * says so in the log. The caller gets fewer answers rather than a request
     * that takes minutes — see DEFAULT_BUDGET_MS — so the order items arrive in
     * is the order they are worth asking about.
     *
     * @param {Array<{id: string, url?: string}>} items
     * @param {Object} [options]
     * @param {number} [options.budgetMs] - Overrides the instance's budget.
     * @returns {Promise<Map<string, Record<string, string>>>}
     */
    async resolveLinks(items, { budgetMs = this.budgetMs } = {}) {
        const found = new Map();
        if (!this.isConfigured()) return found;

        const startedAt = this.now();
        let asked = 0;
        const askable = (Array.isArray(items) ? items : []).filter((i) => i?.id && i?.url);

        for (const item of askable) {
            // Never on the first: a batch that resolves nothing is worse than
            // one that resolves the row the caller put first.
            if (asked > 0 && this.now() - startedAt + this._interval > budgetMs) {
                console.warn(`Odesli: resolved ${asked} of ${askable.length} within `
                    + `${budgetMs}ms at ${this.perMinute}/min; the rest were not asked`);
                break;
            }

            asked++;
            try {
                const links = await this.linksFor(item.url);
                if (Object.keys(links).length > 0) found.set(item.id, links);
            } catch (error) {
                // Reported once per item rather than thrown: a 429 on track
                // nine must not discard tracks one to eight.
                console.warn(`Odesli lookup failed for ${item.id}:`, error.message);
                if (error.status === 401) break;   // The key is wrong; stop asking.
            }
        }
        return found;
    }
}

/**
 * What a status code from Odesli means for an operator.
 *
 * @param {number} status
 * @returns {string}
 */
function describeStatus(status) {
    if (status === 401) {
        return 'Odesli rejected the API key (401). Keyless access is retired, so '
            + 'this means ODESLI_API_KEY is missing, wrong, or not yet active.';
    }
    if (status === 404) return 'Odesli does not know that link (404)';
    if (status === 429) return 'Odesli is rate-limiting this key (429)';
    if (status === 410) {
        return 'Odesli has retired this API namespace (410). Set ODESLI_API_BASE '
            + 'to the namespace the key was granted for.';
    }
    return `Odesli request failed with status ${status}`;
}

/** @returns {Error} */
function missingKey() {
    const error = new Error('Odesli API key is not configured');
    error.status = 401;
    return error;
}

export default OdesliClient;
