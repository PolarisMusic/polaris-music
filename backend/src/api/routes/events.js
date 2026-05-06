/**
 * Event endpoints — preparation, creation (signed flow + anchor-auth flow),
 * retrieval, and dev-only signing helpers.
 *
 * Mounted at /api/events. Extracted from `api/server.js` (Stage I).
 *
 *   POST /api/events/prepare
 *   GET  /api/events/dev-pubkey
 *   POST /api/events/dev-sign
 *   POST /api/events/create
 *   GET  /api/events/:hash
 *   POST /api/events/store-for-anchor
 *   POST /api/events/confirm-anchor
 *
 * @module api/routes/events
 */

import express from 'express';
import { normalizeReleaseBundle } from '../../graph/normalizeReleaseBundle.js';
import { validateReleaseBundleOrThrow } from '../../schema/validateReleaseBundle.js';
import { getDevSigner } from '../../crypto/devSigner.js';
import { createLogger } from '../../utils/logger.js';
import { sanitizeError } from '../../utils/errorSanitizer.js';

/**
 * @param {Object} ctx
 * @param {Object} ctx.store
 * @param {Object} ctx.config
 * @param {express.RequestHandler} ctx.writeRateLimiter
 * @returns {express.Router}
 */
export function createEventsRoutes({ store, config, writeRateLimiter }) {
    const router = express.Router();

    /**
     * POST /api/events/prepare
     * Prepare an event for signing/anchoring by normalizing and returning canonical hash.
     *
     * Flow:
     * 1. Frontend builds event (without sig)
     * 2. Calls /api/events/prepare to get canonical hash
     * 3. Signs the returned hash
     * 4. Adds sig to event
     * 5. Calls /api/events/create to store
     *
     * IMPORTANT: The event passed to /prepare must include author_pubkey.
     * If you prepare without author_pubkey and add it later, the canonical
     * payload/hash will not match what the verifier hashes (which includes
     * author_pubkey), causing signature verification to fail.
     */
    router.post('/prepare', writeRateLimiter, async (req, res) => {
        try {
            const event = req.body;

            // Clone event to avoid mutating the original
            const preparedEvent = JSON.parse(JSON.stringify(event));

            if (preparedEvent.type === 'CREATE_RELEASE_BUNDLE' && preparedEvent.body) {
                const normalizedBundle = normalizeReleaseBundle(preparedEvent.body);
                validateReleaseBundleOrThrow(normalizedBundle);
                preparedEvent.body = normalizedBundle;
            }

            const hash = store.calculateHash(preparedEvent);
            // Frontend must sign this exact string, not the hash
            const canonical_payload = store.getCanonicalPayload(preparedEvent);

            res.json({
                success: true,
                hash,
                normalizedEvent: preparedEvent,
                canonical_payload
            });
        } catch (error) {
            console.error('Event preparation failed:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    });

    /**
     * GET /api/events/dev-pubkey
     * Development-only endpoint for getting the dev signer public key.
     *
     * WARNING: DEV/TEST ONLY!
     */
    router.get('/dev-pubkey', (req, res) => {
        try {
            const devSigner = getDevSigner();
            if (!devSigner?.isEnabled?.() || !devSigner.getPublicKey?.()) {
                return res.status(403).json({
                    success: false,
                    error: 'DevSigner not enabled. Set DEV_SIGNER_PRIVATE_KEY and ensure NODE_ENV !== production'
                });
            }

            return res.json({
                success: true,
                author_pubkey: devSigner.getPublicKey()
            });
        } catch (error) {
            return res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    /**
     * POST /api/events/dev-sign
     * Development-only endpoint for signing event canonical payloads.
     *
     * WARNING: DEV/TEST ONLY!
     */
    router.post('/dev-sign', async (req, res) => {
        const devSigner = getDevSigner();

        // Return 404 if dev signer not enabled (so it's not discoverable in prod)
        if (!devSigner.isEnabled()) {
            return res.status(404).json({
                success: false,
                error: 'Not found'
            });
        }

        try {
            const { canonical_payload } = req.body;

            if (!canonical_payload || typeof canonical_payload !== 'string') {
                return res.status(400).json({
                    success: false,
                    error: 'canonical_payload is required and must be a string'
                });
            }

            if (canonical_payload.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'canonical_payload cannot be empty'
                });
            }

            const { sig, author_pubkey } = devSigner.signCanonicalPayload(canonical_payload);

            res.json({
                success: true,
                sig,
                author_pubkey
            });
        } catch (error) {
            console.error('Dev signing failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    /**
     * POST /api/events/create
     * Submit a new event to storage and blockchain.
     *
     * Validates CREATE_RELEASE_BUNDLE events against canonical schema
     * to ensure no partial writes and deterministic error messages.
     */
    router.post('/create', writeRateLimiter, async (req, res) => {
        const evtLog = createLogger('api.events.create', { request_id: req.requestId });
        const timer = evtLog.startTimer();
        try {
            const { expected_hash, ...event } = req.body;
            evtLog.info('event_create_start', { event_type: event.type, expected_hash: expected_hash || undefined });

            if (event.type === 'CREATE_RELEASE_BUNDLE' && event.body) {
                const normalizedBundle = normalizeReleaseBundle(event.body);
                validateReleaseBundleOrThrow(normalizedBundle);
                event.body = normalizedBundle;
            }

            const result = await store.storeEvent(event, expected_hash || null);

            // CRITICAL: event_cid is REQUIRED for blockchain anchoring.
            // If storage succeeded but event_cid is missing, return 503.
            // This prevents the frontend from attempting blockchain submission with null event_cid.
            if (!result.event_cid) {
                console.error('Event storage incomplete: missing event_cid');
                return res.status(503).json({
                    success: false,
                    error: 'IPFS required: could not produce event_cid for blockchain anchoring',
                    hash: result.hash,
                    stored: {
                        canonical_cid: result.canonical_cid,
                        event_cid: result.event_cid,
                        s3: result.s3,
                        redis: result.redis
                    },
                    replication: result.replication || { canonical: {}, event: {} },
                    pinning: result.pinning || { attempted: false, success: false },
                    errors: result.errors,
                    message: 'Event stored to fallback storage but cannot be anchored on blockchain without IPFS event_cid. Check IPFS daemon status.'
                });
            }

            timer.end('event_create_end', { event_hash: result.hash, event_cid: result.event_cid });
            res.status(201).json({
                success: true,
                hash: result.hash,
                stored: {
                    canonical_cid: result.canonical_cid,
                    event_cid: result.event_cid,
                    s3: result.s3,
                    redis: result.redis
                },
                replication: result.replication || { canonical: {}, event: {} },
                pinning: result.pinning || { attempted: false, success: false },
                errors: result.errors
            });
        } catch (error) {
            timer.endError('event_create_error', { error: error.message });
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    });

    /**
     * GET /api/events/:hash
     * Retrieve an event by its hash
     */
    router.get('/:hash', async (req, res) => {
        const retLog = createLogger('api.events.retrieve', { request_id: req.requestId });
        const timer = retLog.startTimer();
        try {
            retLog.info('event_retrieve_start', { event_hash: req.params.hash });
            const event = await store.retrieveEvent(req.params.hash);

            timer.end('event_retrieve_end', { event_hash: req.params.hash });
            res.json({
                success: true,
                event
            });
        } catch (error) {
            timer.endError('event_retrieve_error', { event_hash: req.params.hash, error: error.message });
            res.status(404).json({
                success: false,
                error: error.message
            });
        }
    });

    // NOTE: /api/merge has been removed. Merges go through:
    //   - Chain mode: POST /api/events/prepare → sign → POST /api/events/create → anchor on-chain
    //   - Dev mode: POST /api/identity/merge (applies immediately, stores event for replay)
    // See docs/12-identity-protocol.md for the canonical merge workflow.

    /**
     * POST /api/events/store-for-anchor
     * Store an event using anchor-auth flow (no off-chain signature required).
     *
     * In this flow, the on-chain put() transaction serves as the authoritative
     * proof of authorship, replacing the unsupported WharfKit signMessage() call.
     */
    router.post('/store-for-anchor', writeRateLimiter, async (req, res) => {
        const evtLog = createLogger('api.events.storeForAnchor', { request_id: req.requestId });
        const timer = evtLog.startTimer();
        try {
            const { expected_hash, author_account, author_permission, ...event } = req.body;
            evtLog.info('store_for_anchor_start', {
                event_type: event.type,
                author_account,
                expected_hash: expected_hash || undefined
            });

            if (!author_account) {
                return res.status(400).json({
                    success: false,
                    error: 'author_account is required for anchor-auth flow'
                });
            }

            if (event.type === 'CREATE_RELEASE_BUNDLE' && event.body) {
                const normalizedBundle = normalizeReleaseBundle(event.body);
                validateReleaseBundleOrThrow(normalizedBundle);
                event.body = normalizedBundle;
            }

            const result = await store.storeEvent(event, expected_hash || null, { anchorAuth: true });

            if (!result.event_cid) {
                return res.status(503).json({
                    success: false,
                    error: 'IPFS required: could not produce event_cid for blockchain anchoring',
                    hash: result.hash,
                    stored: {
                        canonical_cid: result.canonical_cid,
                        event_cid: result.event_cid,
                        s3: result.s3,
                        redis: result.redis
                    }
                });
            }

            timer.end('store_for_anchor_end', { event_hash: result.hash, event_cid: result.event_cid });
            res.status(201).json({
                success: true,
                hash: result.hash,
                stored: {
                    canonical_cid: result.canonical_cid,
                    event_cid: result.event_cid,
                    s3: result.s3,
                    redis: result.redis
                },
                replication: result.replication || { canonical: {}, event: {} },
                pinning: result.pinning || { attempted: false, success: false },
                errors: result.errors
            });
        } catch (error) {
            timer.endError('store_for_anchor_error', { error: error.message });
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    });

    /**
     * POST /api/events/confirm-anchor
     * Confirm that a stored event has been anchored on-chain via put() transaction.
     */
    router.post('/confirm-anchor', writeRateLimiter, async (req, res) => {
        const evtLog = createLogger('api.events.confirmAnchor', { request_id: req.requestId });
        try {
            const { hash, event_cid, trx_id, author_account, author_permission } = req.body;

            if (!hash || !trx_id || !author_account) {
                return res.status(400).json({
                    success: false,
                    error: 'hash, trx_id, and author_account are required'
                });
            }

            evtLog.info('confirm_anchor', {
                event_hash: hash,
                trx_id,
                author_account,
                author_permission: author_permission || 'active',
                event_cid: event_cid || ''
            });

            // Store anchor confirmation metadata in Redis if available
            if (store.redis) {
                try {
                    const anchorKey = `anchor:${hash}`;
                    await store.redis.hmset(anchorKey, {
                        trx_id,
                        author_account,
                        author_permission: author_permission || 'active',
                        event_cid: event_cid || '',
                        confirmed_at: Math.floor(Date.now() / 1000)
                    });
                    await store.redis.expire(anchorKey, 30 * 24 * 60 * 60); // 30 days TTL
                } catch (redisErr) {
                    evtLog.warn('confirm_anchor_redis_error', { error: redisErr.message });
                }
            }

            res.json({
                success: true,
                hash,
                trx_id,
                author_account,
                status: 'anchored'
            });
        } catch (error) {
            evtLog.error('confirm_anchor_error', { error: error.message });
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    return router;
}
