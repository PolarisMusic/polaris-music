/**
 * @fileoverview Reading a Bandcamp release for the submission form.
 *
 * Server-side because it has to be. Bandcamp sends no `Access-Control-Allow-Origin`,
 * so a browser cannot read one of their pages at all — unlike api.discogs.com,
 * which is why the Discogs import runs in the browser and this does not. The
 * page is also HTML rather than JSON, and parsing it belongs where it can be
 * tested without a browser.
 *
 * One page per paste. Nothing here follows a link, enumerates a discography or
 * runs on a schedule, and the request carries a User-Agent that says who is
 * asking. Rate-limited like every other write-shaped endpoint, because it
 * spends somebody else's bandwidth.
 *
 * @module api/routes/bandcamp
 */

import express from 'express';
import { BandcampClient } from '../bandcampClient.js';
import { sanitizeError } from '../../utils/errorSanitizer.js';

/**
 * Turn a client failure into something the submitter can act on.
 *
 * Same discipline as routes/spotify.js: a 502 with no message is true,
 * unactionable, and identical whether the link was wrong, the release was
 * taken down, or Bandcamp changed their markup. Each of those has a different
 * answer and only one of them is a fault here.
 *
 * @param {Error & {status?: number, reason?: string, name?: string}} error
 * @returns {{reason: string, message: string}|null} null when it really is a
 *   fault and should be reported as one.
 */
export function describeFailure(error) {
    if (error?.reason === 'not_bandcamp') {
        return {
            reason: 'not_bandcamp',
            message: 'That is not a Bandcamp album or track link. A label on its own '
                + 'domain cannot be read from the URL alone — use its bandcamp.com link.',
        };
    }

    if (error?.status === 404 || error?.status === 410) {
        return {
            reason: 'release_not_found',
            message: `Bandcamp has no page there (HTTP ${error.status}). The release may have `
                + 'been taken down, or the link may be to a private or unreleased page.',
        };
    }

    if (error?.status === 429) {
        return {
            reason: 'rate_limited',
            message: 'Bandcamp is rate-limiting this server. Try again in a minute.',
        };
    }

    if (error?.status >= 400) {
        return {
            reason: 'refused',
            message: `Bandcamp refused the request (HTTP ${error.status}).`,
        };
    }

    // A timeout aborts the fetch; a DNS or egress failure throws a TypeError
    // whose message is "fetch failed". Neither reaches Bandcamp at all.
    if (error?.name === 'AbortError' || /fetch failed/i.test(error?.message ?? '')) {
        return {
            reason: 'unreachable',
            message: 'This server could not reach Bandcamp. It may have no outbound '
                + 'access to bandcamp.com.',
        };
    }

    return null;
}

/**
 * @param {Object} ctx - Server context.
 * @param {Object} ctx.config
 * @param {Function} ctx.writeRateLimiter
 * @param {BandcampClient} [ctx.bandcampClient] - Injectable for tests.
 * @returns {express.Router}
 */
export function createBandcampRoutes({ config, writeRateLimiter, bandcampClient } = {}) {
    const router = express.Router();
    const client = bandcampClient ?? new BandcampClient();

    /**
     * POST /api/bandcamp/album
     *
     * Body: { url: string }
     * Returns { success, album } — the release as the page describes it, with
     * the free-text credits as they were typed. Bandcamp has no structured
     * credits, so there are no people in the answer.
     */
    router.post('/album', writeRateLimiter ?? ((req, res, next) => next()), async (req, res) => {
        try {
            const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
            if (!url) {
                return res.status(400).json({
                    success: false,
                    reason: 'no_url',
                    message: 'Provide a Bandcamp album or track URL.',
                });
            }

            const album = await client.fetchRelease(url);

            if (!album) {
                // The page loaded and carried nothing this understands. Not a
                // fault: Bandcamp publishes no interface here and can change
                // the markup whenever they like, which is what this says.
                return res.json({
                    success: false,
                    reason: 'unreadable',
                    message: 'That page carries no release data this server can read. '
                        + 'Bandcamp may have changed their page markup — '
                        + 'scripts/checkBandcamp.js shows what a page yields now.',
                });
            }

            res.json({ success: true, album });
        } catch (error) {
            const described = describeFailure(error);
            if (described) {
                console.warn('Bandcamp import unavailable:', error.message);
                return res.json({ success: false, ...described });
            }

            console.error('Bandcamp import failed:', error.message);
            res.status(502).json(sanitizeError(error, req.requestId, {
                success: false,
                reason: 'import_failed',
                env: config?.env,
            }));
        }
    });

    return router;
}

export default createBandcampRoutes;
