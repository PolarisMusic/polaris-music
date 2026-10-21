/**
 * @fileoverview Minimal Deezer client: the same recording, on another service.
 *
 * A listen link is one service's address for a recording. A visitor who does
 * not use that service gets a dead end, which for a registry meant to be the
 * canonical reference is a poor showing. The ISRC the submission already
 * records is the way out: it names the recording itself, and other catalogues
 * can be asked about it directly.
 *
 * Deezer is first because it is the only one that needs nothing. No client id,
 * no token, no developer account: `GET /track/isrc:{isrc}` answers a plain GET.
 * Verified against the live API from the production host on 2026-10-17 — an
 * ISRC it does not hold answers 200 with
 * `{"error":{"type":"DataException","message":"no data","code":800}}`, which is
 * the shape the miss path below reads.
 *
 * The obvious alternative was Odesli, which answered for every service at
 * once. Linktree retired its public API on 2026-07-31 and stopped issuing
 * keys; a keyless request from the production host answers 401. One
 * aggregator for every service turned out to be one point of failure for every
 * service, which is why this is per-service and each provider is separately
 * skippable. See docs/16-cross-service-links.md.
 *
 * @module api/deezerClient
 */

const API_BASE = 'https://api.deezer.com';

/** Node's fetch has no default timeout; an unreachable host would hang. */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * How many lookups are in flight at once.
 *
 * Deezer's documented ceiling is 50 requests per 5 seconds per IP. A dozen-
 * track album is nowhere near that at four at a time, and four keeps a long
 * tracklist from arriving as one burst — the limit is per IP, and this server
 * has one for everybody.
 */
const CONCURRENCY = 4;

/** An ISRC is 12 characters: two letters, three alphanumerics, seven digits. */
const ISRC_PATTERN = /^[A-Za-z]{2}[A-Za-z0-9]{3}\d{7}$/;

/**
 * fetch() with an enforced timeout.
 *
 * Mirrors the AbortController pattern in api/spotifyClient.js, routes/curate.js
 * and storage/pinningProvider.js.
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {number} [timeoutMs]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

export class DeezerClient {
    /**
     * @param {Object} [options]
     * @param {Function} [options.fetchImpl] - Injectable for tests; no network in CI.
     */
    constructor({ fetchImpl } = {}) {
        this.fetch = fetchImpl ?? fetchWithTimeout;
    }

    /**
     * Always configured: there is nothing to configure.
     *
     * Present so callers can treat every provider the same way, and so the one
     * that does need credentials can say no without a special case.
     *
     * @returns {boolean}
     */
    isConfigured() {
        return true;
    }

    /**
     * The Deezer link for a recording, by ISRC.
     *
     * Returns null rather than throwing for a recording Deezer does not have,
     * which is the common case, not an error: a 1970s pressing's B-side is
     * frequently absent from a streaming catalogue entirely.
     *
     * @param {string} isrc
     * @returns {Promise<string|null>} A deezer.com track URL, or null.
     */
    async trackByIsrc(isrc) {
        const code = String(isrc ?? '').trim().toUpperCase();
        if (!ISRC_PATTERN.test(code)) return null;

        let response;
        try {
            response = await this.fetch(`${API_BASE}/track/isrc:${encodeURIComponent(code)}`);
        } catch {
            // A timeout or a DNS failure is not worth failing a submission
            // over: the link is a convenience, and the ISRC that would let it
            // be resolved later is already recorded.
            return null;
        }
        if (!response.ok) return null;

        let data;
        try {
            data = await response.json();
        } catch {
            return null;
        }

        // The id is the whole test, and it has to be: Deezer reports a miss as
        // `{"error":{…,"code":800}}` with HTTP 200, and a quota refusal the
        // same way with code 4 — neither carries an id, and the status says
        // nothing about either. Checking `error` as well would be a second
        // guard on the same fact, which no test could tell from this one.
        if (!data?.id) return null;

        // Built from the id rather than taken from `data.link`: one predictable
        // shape, canonical by construction, and nothing downstream has to trust
        // a URL this server did not write. normalizeListenLink in the frontend
        // parses exactly this form.
        return `https://www.deezer.com/track/${data.id}`;
    }

    /**
     * Resolve a batch, as the provider table in routes/links.js calls it.
     *
     * The table hands every provider the same shape — an id the caller
     * assigned, plus whatever identifiers are known for it — and takes back a
     * map of service names. Deezer uses the ISRC and ignores the URL; Odesli
     * does the opposite. Neither has to know about the other.
     *
     * @param {Array<{id: string, isrc?: string}>} items
     * @returns {Promise<Map<string, Record<string, string>>>}
     */
    async resolveLinks(items) {
        const byIsrc = new Map();
        for (const item of Array.isArray(items) ? items : []) {
            if (item?.id && item?.isrc) byIsrc.set(String(item.isrc).toUpperCase(), item.id);
        }

        const found = await this.tracksByIsrcs([...byIsrc.keys()]);

        const resolved = new Map();
        for (const [isrc, url] of found) {
            const id = byIsrc.get(isrc);
            if (id) resolved.set(id, { deezer: url });
        }
        return resolved;
    }

    /**
     * Resolve several ISRCs, a few at a time.
     *
     * @param {string[]} isrcs
     * @returns {Promise<Map<string, string>>} ISRC -> Deezer URL, absent where
     *   Deezer has no such recording.
     */
    async tracksByIsrcs(isrcs) {
        const found = new Map();

        // Deduplicated: the same recording can appear twice on a release — a
        // reprise, a radio edit of a track already on it — and asking twice
        // spends somebody else's quota to learn the same thing.
        const queue = [...new Set((isrcs ?? [])
            .map(code => String(code ?? '').trim().toUpperCase())
            .filter(code => ISRC_PATTERN.test(code)))];

        let next = 0;
        const worker = async () => {
            while (next < queue.length) {
                const code = queue[next++];
                const link = await this.trackByIsrc(code);
                if (link) found.set(code, link);
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

        return found;
    }
}

export default DeezerClient;
