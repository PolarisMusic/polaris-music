/**
 * Node search endpoint.
 *
 * Mounted at /api/search. Extracted from `api/server.js` (Stage I).
 *
 *   GET /api/search/nodes?q=<query>&types=Person,Group&limit=20
 *
 * @module api/routes/search
 */

import express from 'express';
import { NodeSearchService } from '../nodeSearchService.js';
import { sanitizeError } from '../../utils/errorSanitizer.js';

/**
 * @param {Object} ctx
 * @param {Object} ctx.db
 * @param {Object} ctx.config
 * @returns {express.Router}
 */
export function createSearchRoutes({ db, config }) {
    const router = express.Router();

    /**
     * GET /api/search/nodes?q=<query>&types=Person,Group&limit=20
     * Unified node search across user-facing entity labels.
     */
    router.get('/nodes', async (req, res) => {
        try {
            const q = req.query.q;
            if (!q || q.trim().length < 2) {
                return res.json({ success: true, results: [] });
            }

            const types = req.query.types
                ? req.query.types.split(',').map(t => t.trim()).filter(Boolean)
                : [];
            const limit = Math.min(parseInt(req.query.limit) || 20, 100);

            const searchService = new NodeSearchService(db.driver);
            const results = await searchService.search(q, { types, limit });

            res.json({ success: true, results });
        } catch (error) {
            console.error('Node search failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    return router;
}
