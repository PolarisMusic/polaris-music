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
            throw new Error('Spotify credentials are not configured');
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
            throw new Error(`Spotify token request failed with status ${response.status}`);
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
            if (!retry.ok) throw new Error(`Spotify request failed with status ${retry.status}`);
            return retry.json();
        }

        if (!response.ok) {
            throw new Error(`Spotify request failed with status ${response.status}`);
        }
        return response.json();
    }

    /**
     * Look up several tracks at once.
     *
     * @param {string[]} ids - Spotify track ids, at most 50.
     * @returns {Promise<Object[]>} Tracks, nulls for ids Spotify does not know.
     */
    async getTracks(ids) {
        if (!ids || ids.length === 0) return [];
        const data = await this._get(`/tracks?ids=${encodeURIComponent(ids.slice(0, 50).join(','))}`);
        return data.tracks ?? [];
    }

    /**
     * Fetch an album with its complete tracklist.
     *
     * Spotify pages album tracks, and the album object itself carries only the
     * first page — a release longer than 50 tracks would silently come back
     * truncated, which for a comparison tool would read as "tracks missing".
     *
     * @param {string} albumId
     * @returns {Promise<{id: string, name: string, release_date: string,
     *                    total_tracks: number, tracks: Object[]}>}
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

        return {
            id: album.id,
            name: album.name,
            release_date: album.release_date,
            total_tracks: album.total_tracks,
            tracks: tracks.map(t => ({
                id: t.id,
                name: t.name,
                track_number: t.track_number,
                disc_number: t.disc_number,
                duration_ms: t.duration_ms,
            })),
        };
    }
}

export default SpotifyClient;
