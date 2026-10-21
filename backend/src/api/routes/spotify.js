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
 * There are three ways in, in descending order of how much they prove: a
 * Spotify link the submitter supplied, a barcode read off the Discogs release,
 * and the artist and title. The first two identify one release; the last is
 * guesswork, so it returns several candidates with their tracklists and lets
 * the caller's own tracklist decide between them.
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
 * Turn a client failure into something the submitter can act on.
 *
 * The alternative is what this endpoint used to do: a 502 whose sanitized body
 * carries no message at all, which the form renders as "The Spotify check is
 * unavailable" — true, unactionable, and identical whether the credentials are
 * wrong, the app is restricted, the quota is spent or the host cannot be
 * reached. Each of those has a different fix and only one of them is a fault.
 *
 * No secret is disclosed: a status code and which half of the exchange refused,
 * never a response body (Spotify's token errors can echo the credentials back
 * in a description).
 *
 * @param {Error & {status?: number, phase?: string}} error
 * @returns {{reason: string, message: string}|null} null when it really is a
 *   fault and should be reported as one.
 */
function describeFailure(error) {
    if (error?.phase === 'token request') {
        return {
            reason: 'credentials_rejected',
            message: error.status
                ? `Spotify rejected this server's credentials (HTTP ${error.status}). `
                    + 'SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET need checking.'
                : 'Spotify credentials are not configured on this server.',
        };
    }

    if (error?.status === 403) {
        return {
            reason: 'request_refused',
            message: 'Spotify refused the request for this app (HTTP 403). An app '
                + 'still in development mode is refused for some endpoints.',
        };
    }

    if (error?.status === 429) {
        return {
            reason: 'rate_limited',
            message: 'Spotify is rate-limiting this server. Try again in a minute.',
        };
    }

    // A timeout aborts the fetch; a DNS or egress failure throws a TypeError
    // whose message is "fetch failed". Neither reaches Spotify at all, so
    // neither is a fault in the registry or in the submission.
    if (error?.name === 'AbortError' || /fetch failed/i.test(error?.message ?? '')) {
        return {
            reason: 'unreachable',
            message: 'This server could not reach Spotify. It may have no outbound '
                + 'access to accounts.spotify.com or api.spotify.com.',
        };
    }

    return null;
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
 * How many name-search hits are fetched in full for the caller to judge.
 *
 * Each costs an album request and an ISRC page, and all of them may turn out
 * to be the wrong record, so this is deliberately small. It also bounds what a
 * caller can spend by sending a title.
 */
const MAX_NAME_CANDIDATES = 3;

/**
 * Albums that might be the one a name describes, with their tracklists.
 *
 * Returns candidates rather than a match, and that is the whole design: a
 * barcode names one release and can be verified here, while a title and an
 * artist name a shelf of them and cannot be verified by anything this endpoint
 * knows. What *can* decide is the tracklist already sitting in the submitter's
 * form, which lives in the browser — so the evidence goes back with the
 * candidates and frontend/src/utils/tracklistDiff.js makes the call.
 *
 * Returning one album and calling it a match would be the confidently-wrong
 * answer this whole cross-check exists to prevent: it would attach a
 * tracklist's worth of links, ISRCs and spellings to whichever reissue Spotify
 * ranked first.
 *
 * @param {{artist: string, album: string}} name
 * @param {SpotifyClient} client
 * @returns {Promise<Object[]>}
 */
async function resolveAlbumCandidatesByName(name, client) {
    const ids = await client.albumIdsByName(name.artist, name.album);

    const candidates = [];
    for (const id of ids.slice(0, MAX_NAME_CANDIDATES)) {
        candidates.push(await client.getAlbumWithTracks(id));
    }
    return candidates;
}

/**
 * Read an artist and a title out of a request body.
 *
 * The title is required: an artist on its own is a discography, not a
 * proposal. An artist is optional because the acceptance test is the
 * tracklist either way, and a form that has a title but no group filled in
 * still deserves an attempt.
 *
 * @param {Object} body
 * @returns {{artist: string, album: string}|null}
 */
function nameFrom(body) {
    const album = typeof body?.album === 'string' ? body.album.trim() : '';
    if (!album) return null;

    const artist = typeof body?.artist === 'string' ? body.artist.trim() : '';
    return { artist, album };
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
     * Body: { links?: string[], upc?: string, artist?: string, album?: string }
     *
     * Returns `{album}` when something identified one release — a Spotify link
     * or a barcode Spotify confirms — and `{candidates}` when only the artist
     * and title were available, for the caller to choose between by tracklist.
     * `matched_by` says which it was.
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
            const name = nameFrom(req.body);

            if (links.length === 0 && !upc && !name) {
                return res.status(400).json({
                    success: false,
                    reason: 'no_links',
                    message: 'Provide a Spotify link, a barcode, or a release title.',
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
            if (refs.length === 0 && !upc && !name) {
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

            // 403 is the documented answer to /search from an app still in
            // development mode: a property of this deployment's credentials
            // rather than of the request, and it refuses every search the same
            // way — so the second search is not attempted after the first one
            // is turned down. Reported as a reason, because a 502 reads as
            // "the server is broken" when the truth is "this app cannot
            // search". Caught around the searches only: a 403 from anywhere
            // else is still a fault.
            let searchRefused = false;

            if (upc) {
                try {
                    const album = await resolveAlbumByUpc(upc, client);
                    if (album) return res.json({ success: true, album, matched_by: 'upc' });
                } catch (error) {
                    if (error?.status !== 403) throw error;
                    searchRefused = true;
                }
            }

            // Last resort, and the only one a release with no barcode has.
            // Candidates, not a match — see resolveAlbumCandidatesByName.
            if (name && !searchRefused) {
                try {
                    const candidates = await resolveAlbumCandidatesByName(name, client);
                    if (candidates.length > 0) {
                        return res.json({ success: true, candidates, matched_by: 'name' });
                    }
                } catch (error) {
                    if (error?.status !== 403) throw error;
                    searchRefused = true;
                }
            }

            if (searchRefused) {
                return res.json({
                    success: false,
                    reason: 'search_unavailable',
                    message: 'Spotify refused the catalogue search for this app. '
                        + 'Paste a Spotify album link instead.',
                });
            }

            // Say what was looked for, not just that it was not found: the
            // barcode and the title come from different places and a submitter
            // who cannot see which was used cannot tell a wrong barcode from a
            // release Spotify does not carry.
            const tried = [];
            if (upc) tried.push('under that barcode');
            if (name) {
                tried.push(`called "${name.album}"`
                    + (name.artist ? ` by "${name.artist}"` : ''));
            }

            if (tried.length > 0) {
                return res.json({
                    success: false,
                    reason: name ? 'name_not_found' : 'upc_not_found',
                    message: `Spotify has no release ${tried.join(' or ')}. `
                        + 'Paste a Spotify album link to compare against instead.',
                });
            }

            return res.json({
                success: false,
                reason: 'album_not_found',
                message: 'Could not work out which album those links belong to.',
            });
        } catch (error) {
            const described = describeFailure(error);
            if (described) {
                // Not a 502: none of these are this server failing at its job,
                // and the form shows the message rather than a shrug.
                console.warn('Spotify lookup unavailable:', error.message);
                return res.json({ success: false, ...described });
            }

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

export {
    parseSpotifyRef, resolveAlbumId, resolveAlbumByUpc,
    resolveAlbumCandidatesByName, nameFrom,
    barcodeVariants, sameBarcode, describeFailure,
};
export default createSpotifyRoutes;
