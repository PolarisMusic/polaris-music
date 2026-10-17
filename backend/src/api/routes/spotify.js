/**
 * @fileoverview Spotify cross-check endpoint for the submission form.
 *
 * The form imports a tracklist from Discogs. Discogs is community-edited and
 * regularly disagrees with the streaming release, so before a submission is
 * signed and anchored it is worth asking a second source what the album
 * contains. This endpoint answers that question; it does not decide anything.
 *
 * It is a thin proxy on purpose: it returns Spotify's tracklist rather than a
 * verdict, and the comparison happens in frontend/src/utils/tracklistDiff.js
 * where it is pure and unit-testable. Putting the diff here would make it
 * reachable only through a network call.
 *
 * @module api/routes/spotify
 */

import express from 'express';
import { SpotifyClient } from '../spotifyClient.js';
import { sanitizeError } from '../../utils/errorSanitizer.js';

/** Guard against a caller sending a whole catalogue of links. */
const MAX_LINKS = 60;

/**
 * Pull the type and id out of a Spotify URL or URI.
 *
 * Deliberately duplicated from frontend/src/utils/listenLinks.js rather than
 * shared: that module is browser code and importing it here would couple the
 * API to the frontend build. The forms accepted are kept in step by hand.
 *
 * @param {string} link
 * @returns {{type: string, id: string}|null}
 */
function parseSpotifyRef(link) {
    if (typeof link !== 'string') return null;
    const raw = link.trim();
    if (!raw) return null;

    const uri = /^spotify:([a-z]+):([A-Za-z0-9]+)$/.exec(raw);
    if (uri) return { type: uri[1], id: uri[2] };

    let url;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (!/(^|\.)spotify\.com$/.test(url.hostname)) return null;

    const segments = url.pathname.split('/').filter(Boolean)
        .filter(s => !/^intl-[a-z]{2,3}$/i.test(s) && s.toLowerCase() !== 'embed');
    const [type, id] = segments;
    return type && id ? { type: type.toLowerCase(), id } : null;
}

/**
 * Decide which album a set of links is about.
 *
 * Album links are taken at their word. Otherwise the track links are looked up
 * and the album most of them belong to wins — a single track pointing somewhere
 * else is exactly the kind of mistake this check exists to surface, and it
 * should not be allowed to redirect the whole comparison.
 *
 * @param {{type: string, id: string}[]} refs
 * @param {SpotifyClient} client
 * @returns {Promise<string|null>}
 */
async function resolveAlbumId(refs, client) {
    const albumRefs = refs.filter(r => r.type === 'album');
    if (albumRefs.length > 0) return albumRefs[0].id;

    const trackIds = refs.filter(r => r.type === 'track').map(r => r.id);
    if (trackIds.length === 0) return null;

    const tracks = await client.getTracks(trackIds);
    const counts = new Map();
    for (const track of tracks) {
        const albumId = track?.album?.id;
        if (albumId) counts.set(albumId, (counts.get(albumId) ?? 0) + 1);
    }

    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    return ranked.length > 0 ? ranked[0][0] : null;
}

/**
 * Reduce a printed barcode to digits.
 *
 * Duplicated from frontend/src/utils/discogsBarcode.js rather than shared, for
 * the same reason as parseSpotifyRef above and with the same obligation: the
 * API image is built from ./backend alone (docker-compose context), so an
 * import reaching into frontend/ is a file that does not exist in the
 * container. The forms accepted are kept in step by hand, and both copies have
 * their own tests.
 *
 * @param {string} value
 * @returns {string} Digits only; '' when there is nothing usable.
 */
function barcodeDigits(value) {
    const digits = String(value ?? '').replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 14 ? digits : '';
}

/**
 * Whether two barcodes name the same article, ignoring leading zeros.
 *
 * A 12-digit UPC-A and its 13-digit EAN form are the same number written for
 * different scanners, and which one a catalogue stores is a coin toss.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameBarcode(a, b) {
    const left = barcodeDigits(a).replace(/^0+/, '');
    const right = barcodeDigits(b).replace(/^0+/, '');
    return left.length > 0 && left === right;
}

/**
 * The forms of a barcode worth asking Spotify about.
 *
 * The `upc:` filter matches the string it is given, so a UPC-A stored as a
 * zero-padded EAN-13 is a miss unless both are tried. Two queries at most.
 *
 * @param {string} barcode
 * @returns {string[]}
 */
function barcodeVariants(barcode) {
    const digits = barcodeDigits(barcode);
    if (!digits) return [];

    const variants = [digits];
    const padded = digits.replace(/^0+/, '').padStart(13, '0');
    if (padded !== digits) variants.push(padded);
    return variants;
}

/**
 * Find the album a barcode names, and prove it before returning it.
 *
 * A search hit is Spotify's word that the barcode matched, not evidence of it:
 * search returns *simplified* album objects, which carry no `external_ids` at
 * all, so nothing in the result can be checked. The full album can be, and is.
 * An unverified album here would attach a whole tracklist of links, ISRCs and
 * titles to the wrong edition, silently, which is the one outcome this
 * endpoint exists to prevent.
 *
 * @param {string} upc
 * @param {SpotifyClient} client
 * @returns {Promise<Object|null>} The album with its tracklist, or null.
 */
async function resolveAlbumByUpc(upc, client) {
    for (const variant of barcodeVariants(upc)) {
        const ids = await client.albumIdsByUpc(variant);
        for (const id of ids) {
            const album = await client.getAlbumWithTracks(id);
            if (sameBarcode(album?.upc, upc)) return album;
        }
    }
    return null;
}

/**
 * @param {Object} ctx - Server context.
 * @param {Object} ctx.config
 * @param {Function} ctx.writeRateLimiter
 * @param {SpotifyClient} [ctx.spotifyClient] - Injectable for tests.
 * @returns {express.Router}
 */
export function createSpotifyRoutes({ config, writeRateLimiter, spotifyClient } = {}) {
    const router = express.Router();
    const client = spotifyClient ?? new SpotifyClient();

    /**
     * POST /api/spotify/album
     *
     * Body: { links: string[] }
     * Returns the album those links belong to, with its full tracklist, for the
     * caller to compare against.
     *
     * Rate-limited because it spends Spotify's quota, not ours.
     */
    router.post('/album', writeRateLimiter ?? ((req, res, next) => next()), async (req, res) => {
        try {
            if (!client.isConfigured()) {
                // Not an error: the integration is optional, and local
                // development and CI run without credentials. A 500 here would
                // make an unconfigured deployment look broken.
                return res.json({
                    success: false,
                    reason: 'not_configured',
                    message: 'Spotify lookup is not configured on this server.',
                });
            }

            const links = Array.isArray(req.body?.links) ? req.body.links : [];
            const upc = typeof req.body?.upc === 'string' ? req.body.upc : '';

            if (links.length === 0 && !upc) {
                return res.status(400).json({
                    success: false,
                    reason: 'no_links',
                    message: 'Provide a Spotify link or a barcode.',
                });
            }
            if (links.length > MAX_LINKS) {
                return res.status(400).json({
                    success: false,
                    reason: 'too_many_links',
                    message: `At most ${MAX_LINKS} links can be checked at once.`,
                });
            }

            const refs = links.map(parseSpotifyRef).filter(Boolean);
            if (refs.length === 0 && !upc) {
                return res.json({
                    success: false,
                    reason: 'no_spotify_links',
                    message: 'None of those links are Spotify links.',
                });
            }

            // A link the submitter supplied outranks a barcode read off a
            // Discogs page: it is a statement about which release they mean,
            // and the barcode is only ever a way of guessing it.
            const albumId = refs.length > 0 ? await resolveAlbumId(refs, client) : null;
            if (albumId) {
                const album = await client.getAlbumWithTracks(albumId);
                return res.json({ success: true, album, matched_by: 'link' });
            }

            if (upc) {
                let album;
                try {
                    album = await resolveAlbumByUpc(upc, client);
                } catch (error) {
                    // 403 is the documented answer to /search from an app still
                    // in development mode: a property of this deployment's
                    // credentials rather than of the request. Reported as a
                    // reason, because a 502 reads as "the server is broken"
                    // when the truth is "this app cannot search". Caught here
                    // rather than below so it only ever explains a search —
                    // a 403 from anywhere else is still a fault.
                    if (error?.status !== 403) throw error;

                    return res.json({
                        success: false,
                        reason: 'search_unavailable',
                        message: 'Spotify refused the barcode search for this app. '
                            + 'Paste a Spotify album link instead.',
                    });
                }

                if (album) return res.json({ success: true, album, matched_by: 'upc' });

                return res.json({
                    success: false,
                    reason: 'upc_not_found',
                    message: 'Spotify has no release under that barcode. '
                        + 'Paste a Spotify album link to compare against instead.',
                });
            }

            return res.json({
                success: false,
                reason: 'album_not_found',
                message: 'Could not work out which album those links belong to.',
            });
        } catch (error) {
            console.error('Spotify lookup failed:', error.message);
            res.status(502).json(sanitizeError(error, req.requestId, {
                success: false,
                reason: 'lookup_failed',
                env: config?.env,
            }));
        }
    });

    return router;
}

export { parseSpotifyRef, resolveAlbumId, resolveAlbumByUpc, barcodeVariants, sameBarcode };
export default createSpotifyRoutes;
