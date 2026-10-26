/**
 * @fileoverview Reading a Discogs artist for the submission form.
 *
 * Server-side for one reason: the token. **Discogs serves no `images` to an
 * unauthenticated request**, and a browser cannot hold a credential, because
 * everything in that bundle is public. Nothing else about Discogs needs a
 * server — api.discogs.com sends CORS headers and the tracklist import reads
 * it straight from the page — so this route exists purely to put pictures
 * within reach.
 *
 * It answers the roster in the same breath, which is the part that already
 * worked: `/artists/{id}` returns `members` with or without a token, and the
 * roster is what distinguishes a band member from a session player. One call
 * now returns both, so an import that was already asking for the membership
 * list gets the photographs for free.
 *
 * Without a token it still answers, still carries the roster, and carries no
 * pictures — which is exactly what the browser could do for itself, so
 * nothing is lost by routing through here either way.
 *
 * @module api/routes/discogs
 */

import express from 'express';
import { DiscogsClient } from '../discogsClient.js';
import { sanitizeError } from '../../utils/errorSanitizer.js';

/**
 * Turn a client failure into something the submitter can act on.
 *
 * Same discipline as the Spotify and Bandcamp routes: a bare 502 is true,
 * unactionable, and identical whether the artist does not exist, the token is
 * wrong, or Discogs is rate-limiting — and each of those has a different
 * answer.
 *
 * @param {Error & {status?: number}} error
 * @returns {{reason: string, message: string}|null} null when it really is a
 *   fault here and should be reported as one.
 */
export function describeFailure(error) {
    const status = error?.status;

    if (status === 404) {
        return {
            reason: 'artist_not_found',
            message: 'Discogs has no artist under that id.',
        };
    }
    if (status === 401 || status === 403) {
        return {
            reason: 'refused',
            message: 'Discogs refused the request. If DISCOGS_TOKEN is set, check it is a '
                + 'personal access token from discogs.com/settings/developers and has not '
                + 'been revoked; the roster will still import without one, but not photos.',
        };
    }
    if (status === 429) {
        return {
            reason: 'rate_limited',
            message: 'Discogs is rate-limiting this server (60 requests a minute with a '
                + 'token, 25 without). Try again shortly.',
        };
    }
    if (error?.name === 'TypeError' || /fetch failed|ENOTFOUND|EAI_AGAIN/i.test(error?.message ?? '')) {
        return {
            reason: 'unreachable',
            message: 'This server could not reach Discogs.',
        };
    }
    return null;
}

/**
 * @param {Object} ctx
 * @param {Object} [ctx.config]
 * @param {Function} [ctx.writeRateLimiter]
 * @param {Object} [ctx.discogsClient] - Injectable for tests.
 * @returns {express.Router}
 */
export function createDiscogsRoutes({ config, writeRateLimiter, discogsClient } = {}) {
    const router = express.Router();
    const client = discogsClient ?? new DiscogsClient();

    /**
     * POST /api/discogs/artist
     *
     * Body: { id: string|number }
     * Returns { success, configured, artist } where `artist` carries the act's
     * own photo and its members with theirs. `configured` says whether a token
     * was in hand, which is the difference between "this band has no picture
     * on Discogs" and "this server cannot see pictures".
     */
    router.post('/artist', writeRateLimiter ?? ((req, res, next) => next()), async (req, res) => {
        try {
            const raw = req.body?.id;
            const id = typeof raw === 'number' ? String(raw) : String(raw ?? '').trim();
            // Discogs ids are positive integers. Checked rather than passed
            // through: this value goes into a path.
            if (!/^\d+$/.test(id)) {
                return res.status(400).json({
                    success: false,
                    reason: 'bad_id',
                    message: 'Provide a numeric Discogs artist id.',
                });
            }

            const artist = await client.artistWithMembers(id);

            res.json({ success: true, configured: client.isConfigured(), artist });
        } catch (error) {
            const described = describeFailure(error);
            if (described) {
                console.warn('Discogs artist lookup unavailable:', error.message);
                return res.json({ success: false, configured: client.isConfigured(), ...described });
            }

            console.error('Discogs artist lookup failed:', error.message);
            res.status(502).json(sanitizeError(error, req.requestId, {
                success: false,
                reason: 'lookup_failed',
                env: config?.env,
            }));
        }
    });

    return router;
}
