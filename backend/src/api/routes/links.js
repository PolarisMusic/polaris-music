/**
 * @fileoverview Cross-service link resolution, by recording identifier.
 *
 * The submission form records an ISRC per track, from the Spotify cross-check.
 * This turns those into links on other services, so a visitor who does not use
 * Spotify is not shown a dead end.
 *
 * One endpoint, a provider table behind it. That shape is the lesson of the
 * thing it replaces: Odesli answered for every service at once and was retired
 * on 2026-07-31, taking every service with it. A table of independent
 * providers degrades one service at a time, and a provider with no credentials
 * configured simply does not appear in the answer.
 *
 * @module api/routes/links
 */

import express from 'express';
import { DeezerClient } from '../deezerClient.js';
import { sanitizeError } from '../../utils/errorSanitizer.js';

/**
 * Guard against a caller sending a whole catalogue.
 *
 * A box set is the largest honest request; past that it is somebody using the
 * endpoint as a bulk resolver, which would spend a shared rate limit.
 */
const MAX_ISRCS = 60;

/**
 * @param {Object} ctx - Server context.
 * @param {Object} ctx.config
 * @param {Function} ctx.writeRateLimiter
 * @param {Object} [ctx.linkProviders] - Injectable for tests: name -> client.
 * @returns {express.Router}
 */
export function createLinkRoutes({ config, writeRateLimiter, linkProviders } = {}) {
    const router = express.Router();
    const providers = linkProviders ?? { deezer: new DeezerClient() };

    /**
     * POST /api/links/resolve
     *
     * Body: { isrcs: string[] }
     * Returns { success, links: { [isrc]: { [service]: url } }, services }.
     *
     * `services` names the providers that were actually asked, so a caller can
     * tell "Deezer does not have this recording" from "Deezer was not asked".
     *
     * Rate-limited because it spends other services' quota, not ours.
     */
    router.post('/resolve', writeRateLimiter ?? ((req, res, next) => next()), async (req, res) => {
        try {
            const isrcs = Array.isArray(req.body?.isrcs) ? req.body.isrcs : [];

            if (isrcs.length === 0) {
                return res.status(400).json({
                    success: false,
                    reason: 'no_isrcs',
                    message: 'Provide at least one ISRC.',
                });
            }
            if (isrcs.length > MAX_ISRCS) {
                return res.status(400).json({
                    success: false,
                    reason: 'too_many_isrcs',
                    message: `At most ${MAX_ISRCS} recordings can be resolved at once.`,
                });
            }

            const asked = Object.entries(providers)
                .filter(([, client]) => client?.isConfigured?.());

            if (asked.length === 0) {
                // Every provider needs credentials this deployment has not
                // got. Not an error: a missing optional integration is a
                // configuration state, and the ISRCs are recorded either way,
                // so the links can be resolved later without asking the
                // submitter anything again.
                return res.json({
                    success: false,
                    reason: 'not_configured',
                    message: 'No link providers are configured on this server.',
                    services: [],
                });
            }

            /** @type {Record<string, Record<string, string>>} */
            const links = {};
            const services = [];

            for (const [service, client] of asked) {
                services.push(service);

                // One provider failing is not the request failing. The others
                // have answers, and a partial result is worth returning.
                let found;
                try {
                    found = await client.tracksByIsrcs(isrcs);
                } catch (error) {
                    console.warn(`Link provider ${service} failed:`, error.message);
                    continue;
                }

                for (const [isrc, url] of found) {
                    links[isrc] = { ...(links[isrc] ?? {}), [service]: url };
                }
            }

            res.json({ success: true, links, services });
        } catch (error) {
            console.error('Link resolution failed:', error.message);
            res.status(502).json(sanitizeError(error, req.requestId, {
                success: false,
                reason: 'resolve_failed',
                env: config?.env,
            }));
        }
    });

    return router;
}

export default createLinkRoutes;
