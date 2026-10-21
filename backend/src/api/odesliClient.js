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

/** Odesli's own namespace, overridable because they have announced its end. */
const DEFAULT_API_BASE = 'https://api.song.link/v1-alpha.1';

/**
 * Requests a minute. The keyless tier was ten; a key raises it.
 *
 * Defaulted to sixty rather than ten because a key is required for this client
 * to work at all, so the keyless figure is never the right one here. Lower it
 * if the grant says less: one request per track means a twelve-track album is
 * thirteen requests, which is thirteen seconds at sixty and eighty at ten.
 */
const DEFAULT_PER_MINUTE = 60;

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
    constructor({ apiKey, apiBase, perMinute, userCountry, fetchImpl, sleep } = {}) {
        this.apiKey = apiKey ?? process.env.ODESLI_API_KEY ?? '';
        this.apiBase = apiBase ?? process.env.ODESLI_API_BASE ?? DEFAULT_API_BASE;
        this.userCountry = userCountry ?? process.env.ODESLI_USER_COUNTRY ?? 'US';

        const configured = Number(perMinute ?? process.env.ODESLI_REQUESTS_PER_MINUTE);
        this.perMinute = Number.isFinite(configured) && configured > 0
            ? configured
            : DEFAULT_PER_MINUTE;

        this.fetch = fetchImpl ?? fetch;
        this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

        /** Tail of the request chain, so concurrent callers still queue. */
        this._queue = Promise.resolve();
        this._lastRequestAt = 0;
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
            const since = Date.now() - this._lastRequestAt;
            if (since < this._interval) await this.sleep(this._interval - since);
            this._lastRequestAt = Date.now();

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
     * @param {Array<{id: string, url?: string}>} items
     * @returns {Promise<Map<string, Record<string, string>>>}
     */
    async resolveLinks(items) {
        const found = new Map();
        if (!this.isConfigured()) return found;

        for (const item of Array.isArray(items) ? items : []) {
            if (!item?.id || !item?.url) continue;
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
