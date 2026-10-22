/**
 * @fileoverview Minimal Spotify Web API client, for cross-checking submissions.
 *
 * The submission form imports a tracklist from Discogs, which is
 * community-edited and often disagrees with the streaming release — a missing
 * pre-roll track, a tracklist taken from a different edition. This client
 * fetches what Spotify says an album contains so the two can be compared before
 * a submission is signed and anchored.
 *
 * It lives on the backend rather than in the browser because the
 * client-credentials flow needs a secret, and everything under frontend/src is
 * inlined into the public bundle by Vite. The page's CSP also does not list
 * Spotify, whereas it already permits our own API.
 *
 * Credentials are optional. With SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET
 * unset the client reports itself unconfigured and callers degrade to "check
 * unavailable" — local development and CI have no credentials and must not
 * fail because of it.
 *
 * @module api/spotifyClient
 */

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

/** Node's fetch has no default timeout; an unreachable host would hang. */
const REQUEST_TIMEOUT_MS = 8000;

/** Refresh this long before actual expiry, so a request never races it. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** Spotify pages album tracks; 50 is its maximum page size. */
const PAGE_SIZE = 50;

/**
 * How many albums a barcode search may come back with.
 *
 * A UPC identifies one release, so more than a couple of hits means the filter
 * fell back to loose matching and the extras are not this release.
 */
const UPC_SEARCH_LIMIT = 3;

/**
 * How many albums a name search may come back with.
 *
 * Each one costs an album fetch and an ISRC page to judge, and the judgement
 * happens on candidates rather than on an answer, so this is a quota bound as
 * much as a relevance one. Spotify orders exact field matches first; past the
 * third hit a name search is not going to be right.
 */
const NAME_SEARCH_LIMIT = 3;

/**
 * An Error carrying the HTTP status that caused it.
 *
 * Callers need to tell apart a refusal they should explain — a 403 from
 * /search, which a development-mode app gets whatever it asks for — from a
 * failure they should report as a fault.
 *
 * @param {number} status
 * @returns {Error}
 */
function statusError(status, phase = 'request') {
    const error = new Error(`Spotify ${phase} failed with status ${status}`);
    error.status = status;
    // Which half of the exchange refused. A token refusal is a credentials
    // problem an operator fixes; a request refusal is about what was asked
    // for, with the same credentials Spotify has already accepted. Reporting
    // them identically sends somebody to check the wrong thing.
    error.phase = phase;
    return error;
}

/**
 * fetch() with an enforced timeout.
 *
 * Mirrors the AbortController pattern in routes/curate.js, utils/verifyChainId.js
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

/**
 * A catalogue string reduced to something safe to put inside a search filter.
 *
 * Double quotes and colons are the query language's own punctuation: left in,
 * they would turn `album:"Nevermind: Live"` into a filter that ends mid-title
 * and a second one Spotify does not have. Apostrophes stay — they are part of
 * how titles are spelled, and Spotify's tokenizer handles them. Length is
 * capped because no release title is a paragraph, and a long one is a sign the
 * caller sent the wrong field.
 *
 * @param {string} value
 * @returns {string}
 */
function searchTerm(value) {
    return String(value ?? '')
        .replace(/["\u201c\u201d:]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100);
}

export class SpotifyClient {
    /**
     * @param {Object} [options]
     * @param {string} [options.clientId] - Defaults to SPOTIFY_CLIENT_ID.
     * @param {string} [options.clientSecret] - Defaults to SPOTIFY_CLIENT_SECRET.
     * @param {Function} [options.fetchImpl] - Injectable for tests; no network in CI.
     */
    constructor({ clientId, clientSecret, fetchImpl } = {}) {
        this.clientId = clientId ?? process.env.SPOTIFY_CLIENT_ID ?? '';
        this.clientSecret = clientSecret ?? process.env.SPOTIFY_CLIENT_SECRET ?? '';
        this.fetch = fetchImpl ?? fetchWithTimeout;

        this._token = null;
        this._tokenExpiresAt = 0;

        // Set once the batch track endpoint has refused this app, so the rest
        // of the process stops paying for the same 403. See getTracks.
        this._batchTracksRefused = false;
    }

    /**
     * Whether credentials are present.
     *
     * Callers check this and return a "not configured" response rather than an
     * error: a missing optional integration is not a server fault.
     *
     * @returns {boolean}
     */
    isConfigured() {
        return Boolean(this.clientId && this.clientSecret);
    }

    /**
     * Get a client-credentials access token, reusing the cached one.
     *
     * Cached in process rather than in Redis: tokens last an hour and are
     * per-app, so every worker holding its own costs nothing and avoids
     * reaching into EventStore's private Redis handle.
     *
     * @returns {Promise<string>}
     * @throws {Error} If credentials are missing or Spotify rejects them.
     */
    async getAccessToken() {
        if (!this.isConfigured()) {
            const error = new Error('Spotify credentials are not configured');
            error.phase = 'token request';
            throw error;
        }
        if (this._token && Date.now() < this._tokenExpiresAt - TOKEN_EXPIRY_MARGIN_MS) {
            return this._token;
        }

        const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
        const response = await this.fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${basic}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: 'grant_type=client_credentials',
        });

        if (!response.ok) {
            // Deliberately does not include the response body: it can echo the
            // credentials back in an error description.
            throw statusError(response.status, 'token request');
        }

        const data = await response.json();
        this._token = data.access_token;
        this._tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
        return this._token;
    }

    /**
     * GET a Spotify API path, with the bearer token attached.
     *
     * @param {string} path - Path after /v1, e.g. "/albums/xyz".
     * @returns {Promise<Object>}
     * @private
     */
    async _get(path) {
        const token = await this.getAccessToken();
        const response = await this.fetch(`${API_BASE}${path}`, {
            headers: { Authorization: `Bearer ${token}` },
        });

        if (response.status === 401) {
            // Token rejected despite not having expired by our clock. Drop it
            // and try once more rather than failing the whole check.
            this._token = null;
            const retryToken = await this.getAccessToken();
            const retry = await this.fetch(`${API_BASE}${path}`, {
                headers: { Authorization: `Bearer ${retryToken}` },
            });
            if (!retry.ok) throw statusError(retry.status);
            return retry.json();
        }

        if (!response.ok) {
            throw statusError(response.status);
        }
        return response.json();
    }

    /**
     * Album ids Spotify files under a barcode.
     *
     * The `upc:` filter is the only identifier-based way into the catalogue
     * from outside it: everything else about a release — artist, title, year —
     * is a string two databases spell differently, which is the guesswork this
     * avoids.
     *
     * The results are *simplified* album objects and carry no `external_ids`,
     * so nothing here proves the barcode matched. Only the full album says
     * that, which is why this returns candidates rather than an answer.
     *
     * @param {string} upc - Digits, as the sleeve prints them.
     * @returns {Promise<string[]>} Album ids, Spotify's order.
     */
    async albumIdsByUpc(upc) {
        const digits = String(upc ?? '').replace(/\D/g, '');
        if (!digits) return [];

        const query = encodeURIComponent(`upc:${digits}`);
        const data = await this._get(`/search?q=${query}&type=album&limit=${UPC_SEARCH_LIMIT}`);
        return (data.albums?.items ?? []).map(album => album?.id).filter(Boolean);
    }

    /**
     * Albums Spotify files under an artist and a title.
     *
     * Strings, which is the whole problem with this route into the catalogue:
     * two databases spell the same release differently and a search hit is an
     * opinion about relevance, not an identifier. It is offered anyway because
     * the caller has independent evidence to check it against — a tracklist —
     * and because the alternative for a release with no barcode is nothing at
     * all. Returns candidates, never an answer.
     *
     * Field filters are used rather than a bare query so that a title is
     * matched as a title: `q=bleed american` also ranks tracks called that on
     * other people's albums.
     *
     * @param {string} artist - Optional; narrows the search when present.
     * @param {string} album - Release title.
     * @returns {Promise<string[]>} Album ids, Spotify's relevance order.
     */
    async albumIdsByName(artist, album) {
        const title = searchTerm(album);
        if (!title) return [];

        // Quotes would close the filter early and a colon would open another
        // one, so searchTerm drops both; what is left is matched as a phrase.
        const filters = [`album:"${title}"`];
        const who = searchTerm(artist);
        if (who) filters.push(`artist:"${who}"`);

        const query = encodeURIComponent(filters.join(' '));
        const data = await this._get(`/search?q=${query}&type=album&limit=${NAME_SEARCH_LIMIT}`);
        return (data.albums?.items ?? []).map(item => item?.id).filter(Boolean);
    }

    /**
     * Look up several tracks, in one request where that is allowed.
     *
     * Spotify refuses `GET /v1/tracks?ids=…` for some apps with a bare 403 —
     * measured on this deployment on 2026-10-22, where `/v1/albums/{id}` and
     * `/v1/tracks/{id}` both answer 200 and only the batch form is turned
     * down, with or without a market. It is not on Spotify's published list of
     * restricted endpoints, and the 403 carries no explanation, so there is
     * nothing to read: either the app may ask for several tracks or it may not.
     *
     * One request per track is the same data for more quota — eleven requests
     * for an album instead of one — and the alternative is losing the ISRCs
     * altogether, which are what every other catalogue is asked about the same
     * recording with and what the registry prefers as a track's identity. So
     * the batch form is tried first and the refusal is remembered, per process,
     * so a box set pays for it once rather than once per page of fifty.
     *
     * @param {string[]} ids - Spotify track ids, at most 50.
     * @returns {Promise<Object[]>} Tracks, nulls for ids Spotify does not know.
     */
    async getTracks(ids) {
        if (!ids || ids.length === 0) return [];
        const wanted = ids.slice(0, 50);

        if (!this._batchTracksRefused) {
            try {
                const data = await this._get(
                    `/tracks?ids=${encodeURIComponent(wanted.join(','))}`);
                return data.tracks ?? [];
            } catch (error) {
                // Only a 403 is a refusal of the endpoint itself. A 429 or a
                // 5xx says nothing about what this app may ask for, and
                // answering it with fifty more requests would be the worst
                // possible response to being rate-limited.
                if (error?.status !== 403) throw error;

                this._batchTracksRefused = true;
                console.warn('Spotify refused /tracks?ids= for this app (403); '
                    + 'falling back to one request per track');
            }
        }

        return this._getTracksSingly(wanted);
    }

    /**
     * The same tracks, one request each.
     *
     * Keeps getTracks' contract: a track Spotify does not know is a null in
     * place rather than a gap, because callers match the answer up by position
     * (resolveAlbumId counts albums per track) and a shorter array would
     * silently shift it.
     *
     * @param {string[]} ids
     * @returns {Promise<Object[]>}
     * @private
     */
    async _getTracksSingly(ids) {
        const tracks = [];
        for (const id of ids) {
            try {
                tracks.push(await this._get(`/tracks/${encodeURIComponent(id)}`));
            } catch (error) {
                // 404 is how the batch endpoint reports an id it does not know,
                // so it stays a null here. Anything else is this request
                // failing and is the caller's to hear about — getAlbumWithTracks
                // degrades to no ISRCs rather than losing the tracklist.
                if (error?.status !== 404) throw error;
                tracks.push(null);
            }
        }
        return tracks;
    }

    /**
     * The ISRC of each of these tracks, where Spotify knows one.
     *
     * Not available from either album endpoint: both return *simplified* track
     * objects, which carry no `external_ids` at all. The ISRC lives on the full
     * object, so it costs one extra request per fifty tracks — a dozen-track
     * album pays for one, a box set for two.
     *
     * Worth the request because an ISRC is how the registry names a recording:
     * `prov:track:isrc:{isrc}` is the first choice of provisional id, ahead of
     * anything derived from a title, and it is the key every other streaming
     * service can be asked about the same recording with.
     *
     * @param {string[]} ids - Spotify track ids.
     * @returns {Promise<Map<string, string>>} track id -> ISRC, absent where
     *   Spotify has none.
     */
    async isrcsForTracks(ids) {
        const found = new Map();
        const real = (ids ?? []).filter(Boolean);

        for (let offset = 0; offset < real.length; offset += PAGE_SIZE) {
            const batch = await this.getTracks(real.slice(offset, offset + PAGE_SIZE));
            for (const track of batch) {
                const isrc = track?.external_ids?.isrc;
                if (track?.id && isrc) found.set(track.id, isrc);
            }
        }
        return found;
    }

    /**
     * Fetch an album with its complete tracklist.
     *
     * Spotify pages album tracks, and the album object itself carries only the
     * first page — a release longer than 50 tracks would silently come back
     * truncated, which for a comparison tool would read as "tracks missing".
     *
     * The codes come back too, and they are not the same code: a UPC names the
     * release and an ISRC names each recording on it. Confusing the two is easy
     * and expensive — matching a whole album by one of its tracks' ISRCs finds
     * whichever release that recording also appears on, which for a hit single
     * is a compilation nobody asked about.
     *
     * @param {string} albumId
     * @returns {Promise<{id: string, name: string, release_date: string,
     *                    total_tracks: number, upc: string|null,
     *                    tracks: Object[]}>}
     */
    async getAlbumWithTracks(albumId) {
        const album = await this._get(`/albums/${encodeURIComponent(albumId)}`);
        const tracks = [...(album.tracks?.items ?? [])];

        let offset = tracks.length;
        while (offset < (album.total_tracks ?? 0)) {
            const page = await this._get(
                `/albums/${encodeURIComponent(albumId)}/tracks?limit=${PAGE_SIZE}&offset=${offset}`);
            const items = page.items ?? [];
            if (items.length === 0) break;      // Never loop on an empty page.
            tracks.push(...items);
            offset += items.length;
        }

        // The ISRCs are a bonus on top of the tracklist, and must not be able
        // to take it down with them. This is one extra request per fifty
        // tracks against a *different* endpoint, so it can be refused on its
        // own — and a submitter asking "does this tracklist match" would then
        // get nothing at all, having previously got an answer. Degrade to no
        // ISRCs instead, and say so in the log.
        let isrcs = new Map();
        try {
            isrcs = await this.isrcsForTracks(tracks.map(t => t.id));
        } catch (error) {
            console.warn('Spotify ISRC lookup failed, continuing without codes:',
                error.message);
        }

        return {
            id: album.id,
            name: album.name,
            release_date: album.release_date,
            total_tracks: album.total_tracks,
            upc: album.external_ids?.upc ?? null,
            tracks: tracks.map(t => ({
                id: t.id,
                name: t.name,
                track_number: t.track_number,
                disc_number: t.disc_number,
                duration_ms: t.duration_ms,
                isrc: isrcs.get(t.id) ?? null,
            })),
        };
    }
}

export default SpotifyClient;
