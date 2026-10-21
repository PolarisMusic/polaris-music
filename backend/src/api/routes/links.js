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
import { OdesliClient } from '../odesliClient.js';
import { sanitizeError } from '../../utils/errorSanitizer.js';

/**
 * Guard against a caller sending a whole catalogue.
 *
 * A box set is the largest honest request; past that it is somebody using the
 * endpoint as a bulk resolver, which would spend a shared rate limit.
 */
const MAX_ISRCS = 60;

/**
 * Read the request into the one shape every provider is asked in.
 *
 * Two bodies are accepted. `{isrcs: [...]}` is what the form sent before
 * Odesli, and is kept working because the answer it produces is identical: the
 * ISRC doubles as the id. `{tracks: [{isrc, url}]}` is the shape that can also
 * carry a platform URL, which is the only way into Odesli — it resolves by link
 * rather than by code.
 *
 * The id is the caller's handle on a row, so the answer can be mapped back to
 * it without the caller having to know which identifier each provider used.
 *
 * @param {Object} body
 * @returns {Array<{id: string, isrc?: string, url?: string}>}
 */
function itemsFrom(body) {
    if (Array.isArray(body?.tracks)) {
        return body.tracks
            .map((track) => {
                const isrc = typeof track?.isrc === 'string' ? track.isrc.trim() : '';
                const url = typeof track?.url === 'string' ? track.url.trim() : '';
                const id = (typeof track?.id === 'string' && track.id) || isrc || url;
                return id ? { id, isrc: isrc || undefined, url: url || undefined } : null;
            })
            .filter(Boolean);
    }

    if (Array.isArray(body?.isrcs)) {
        return body.isrcs
            .filter((isrc) => typeof isrc === 'string' && isrc.trim())
            .map((isrc) => ({ id: isrc.trim(), isrc: isrc.trim() }));
    }

    return [];
}

/**
 * @param {Object} ctx - Server context.
 * @param {Object} ctx.config
 * @param {Function} ctx.writeRateLimiter
 * @param {Object} [ctx.linkProviders] - Injectable for tests: name -> client.
 * @returns {express.Router}
 */
export function createLinkRoutes({ config, writeRateLimiter, linkProviders } = {}) {
    const router = express.Router();
    // Odesli first: one request answers for every service at once, so a key
    // that works makes the per-service providers a fallback rather than the
    // mechanism. Deezer stays because it needs no credentials and therefore
    // answers on a deployment that has no Odesli key — which, until the key was
    // granted, was this one.
    const providers = linkProviders ?? {
        odesli: new OdesliClient(),
        deezer: new DeezerClient(),
    };

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
            const items = itemsFrom(req.body);

            if (items.length === 0) {
                return res.status(400).json({
                    success: false,
                    reason: 'no_isrcs',
                    message: 'Provide at least one ISRC or track link.',
                });
            }
            if (items.length > MAX_ISRCS) {
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
            const providersAsked = [];

            for (const [name, client] of asked) {
                providersAsked.push(name);

                // One provider failing is not the request failing. The others
                // have answers, and a partial result is worth returning.
                let found;
                try {
                    found = await client.resolveLinks(items);
                } catch (error) {
                    console.warn(`Link provider ${name} failed:`, error.message);
                    continue;
                }

                for (const [id, services] of found) {
                    // Earlier providers win a collision. Odesli runs first and
                    // answers for every service at once, so a later per-service
                    // provider only ever fills a gap it left.
                    links[id] = { ...services, ...(links[id] ?? {}) };
                }
            }

            res.json({
                success: true,
                links,
                // What is in the answer, not who was asked for it: a caller
                // telling a submitter what was added means the services, and
                // one provider can answer for nine of them.
                services: [...new Set(Object.values(links).flatMap(Object.keys))].sort(),
                providers: providersAsked,
            });
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
