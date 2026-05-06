/**
 * Chain ingestion endpoint (T5).
 *
 * Mounted at /api/ingest. Accepts anchored events from Substreams chain
 * ingestion and routes them through the IngestionHandler.
 *
 *   POST /api/ingest/anchored-event
 *
 * Extracted from `api/server.js` (Stage I).
 *
 * @module api/routes/ingest
 */

import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { sanitizeError } from '../../utils/errorSanitizer.js';

/**
 * @param {Object} ctx
 * @param {Object} ctx.ingestionHandler
 * @param {Object} ctx.config
 * @param {express.RequestHandler} ctx.writeRateLimiter
 * @param {express.RequestHandler} ctx.requireApiKey
 * @returns {express.Router}
 */
export function createIngestRoutes({ ingestionHandler, config, writeRateLimiter, requireApiKey }) {
    const router = express.Router();

    /**
     * POST /api/ingest/anchored-event
     * Ingest anchored event from Substreams chain ingestion.
     */
    router.post('/anchored-event', writeRateLimiter, requireApiKey, async (req, res) => {
        const ingestLog = createLogger('api.ingest', { request_id: req.requestId });
        const timer = ingestLog.startTimer();
        try {
            const anchoredEvent = req.body.anchoredEvent || req.body;

            if (!anchoredEvent.content_hash || !anchoredEvent.payload) {
                return res.status(400).json({
                    status: 'error',
                    error: 'Missing required fields: content_hash and payload'
                });
            }

            ingestLog.info('ingest_start', {
                event_hash: anchoredEvent.content_hash,
                source: anchoredEvent.source,
                block_num: anchoredEvent.block_num,
                trx_id: anchoredEvent.trx_id,
                action_name: anchoredEvent.action_name
            });

            const result = await ingestionHandler.processAnchoredEvent(anchoredEvent);

            const statusCode = result.status === 'duplicate' ? 200 : 201;

            timer.end('ingest_end', {
                event_hash: anchoredEvent.content_hash,
                result_status: result.status,
                status: statusCode
            });

            res.status(statusCode).json(result);
        } catch (error) {
            timer.endError('ingest_error', {
                error: error.message,
                error_class: error.constructor.name
            });
            res.status(500).json(sanitizeError(error, req.requestId, { env: config.env }));
        }
    });

    return router;
}
