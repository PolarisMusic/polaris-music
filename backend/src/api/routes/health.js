/**
 * Health, status, and stats routes.
 *
 *   GET  /health
 *   GET  /api/status
 *   GET  /api/stats
 *
 * Extracted from `api/server.js` (Stage I).
 *
 * @module api/routes/health
 */

import express from 'express';
import { getStatus } from '../status.js';
import { sanitizeError } from '../../utils/errorSanitizer.js';

/**
 * @param {Object} ctx
 * @param {Object} ctx.db
 * @param {Object} ctx.store
 * @param {Object} ctx.config
 * @returns {{ healthRouter: express.Router, statusRouter: express.Router, statsRouter: express.Router }}
 */
export function createHealthRoutes({ db, store, config }) {
    // /health is a top-level path, /api/status and /api/stats live under /api.
    // Returning three routers keeps mounting in server.js explicit.

    const healthRouter = express.Router();
    healthRouter.get('/', (req, res) => {
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
        });
    });

    const statusRouter = express.Router();
    /**
     * GET /api/status
     * Comprehensive system status check for smoke testing and monitoring.
     *
     * Returns:
     *   - 200 with ok:true if all critical services are healthy
     *   - 503 with ok:false if any critical service is down
     */
    statusRouter.get('/', async (req, res) => {
        try {
            const status = await getStatus({
                eventStore: store,
                neo4jDriver: db?.driver,
                redisClient: store?.redis,
                pinningProvider: store?.pinningProvider
            });

            const httpStatus = status.ok ? 200 : 503;
            res.status(httpStatus).json(status);
        } catch (error) {
            console.error('Status check failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, {
                env: config.env,
            }));
        }
    });

    const statsRouter = express.Router();
    /**
     * GET /api/stats
     * Get overall system statistics
     */
    statsRouter.get('/', async (req, res) => {
        try {
            const dbStats = await db.getStats();
            const storageStats = store.getStats();

            res.json({
                success: true,
                database: dbStats,
                storage: storageStats,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('Stats retrieval failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    return { healthRouter, statusRouter, statsRouter };
}
