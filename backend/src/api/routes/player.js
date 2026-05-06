/**
 * Player queue endpoint.
 *
 * Mounted at /api/player. Extracted from `api/server.js` (Stage I).
 *
 *   GET /api/player/queue?contextType=<release|group|person>&contextId=<id>
 *
 * @module api/routes/player
 */

import express from 'express';
import { sanitizeError } from '../../utils/errorSanitizer.js';

/**
 * @param {Object} ctx
 * @param {Object} ctx.playerService
 * @param {Object} ctx.config
 * @returns {express.Router}
 */
export function createPlayerRoutes({ playerService, config }) {
    const router = express.Router();

    /**
     * GET /api/player/queue
     * Build a playback queue for a release, group, or person context.
     *
     * Query params:
     *   contextType - 'release', 'group', or 'person'
     *   contextId   - Entity ID (e.g. 'prov:release:...')
     */
    router.get('/queue', async (req, res) => {
        try {
            const { contextType, contextId } = req.query;
            if (!contextType || !contextId) {
                return res.status(400).json({
                    success: false,
                    error: 'contextType and contextId are required'
                });
            }

            if (!['release', 'group', 'person'].includes(contextType)) {
                return res.status(400).json({
                    success: false,
                    error: 'contextType must be release, group, or person'
                });
            }

            const { context, queue } = await playerService.buildQueue(contextType, contextId);
            res.json({ success: true, context, queue });
        } catch (error) {
            console.error('Player queue failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    return router;
}
