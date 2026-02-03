/**
 * Identity Management API Routes
 *
 * Provides endpoints for:
 * - Minting new canonical entities
 * - Resolving provisional/external IDs to canonical IDs
 * - Merging duplicate entities
 * - Looking up canonical IDs from external references
 *
 * @module api/routes/identity
 */

import express from 'express';
import { IdentityService, EntityType, IDKind } from '../../identity/idService.js';
import { MergeOperations } from '../../graph/merge.js';
import { getDevSigner } from '../../crypto/devSigner.js';
import { createLogger } from '../../utils/logger.js';

/**
 * Initialize identity routes with database and event store
 *
 * @param {MusicGraphDatabase} db - Graph database instance
 * @param {EventStore} store - Event store instance
 * @param {EventProcessor} eventProcessor - Event processor with canonical handlers
 * @returns {express.Router} Configured router
 */
export function createIdentityRoutes(db, store, eventProcessor) {
    const router = express.Router();
    /**
     * POST /api/identity/mint
     * Create a new canonical entity
     *
     * Request body:
     * {
     *   entity_type: "person" | "group" | "song" | "track" | "release" | "master" | "label",
     *   initial_claims: [{ property: string, value: any, confidence: number }],
     *   provenance: {
     *     source: "manual" | "import" | "ai_suggested",
     *     submitter: string,
     *     evidence: string
     *   }
     * }
     *
     * Response:
     * {
     *   success: true,
     *   canonical_id: "polaris:{type}:{uuid}",
     *   status: "ACTIVE",
     *   event_hash: string
     * }
     */
    router.post('/mint', async (req, res) => {
        const log = createLogger('api.identity', { request_id: req.requestId });
        const timer = log.startTimer();
        try {
            // In chain mode, entity minting must go through the event-sourced pipeline
            const ingestMode = process.env.INGEST_MODE || 'chain';
            if (ingestMode === 'chain') {
                return res.status(501).json({
                    success: false,
                    error: 'Direct minting is disabled in chain mode. ' +
                           'Use the event-sourced pipeline: POST /api/events/prepare (type MINT_ENTITY) ' +
                           '→ sign → POST /api/events/create → anchor on-chain → ingestion applies mint.'
                });
            }

            const { entity_type, initial_claims = [], provenance = {} } = req.body;

            // Validate entity type
            if (!Object.values(EntityType).includes(entity_type)) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid entity_type. Must be one of: ${Object.values(EntityType).join(', ')}`
                });
            }

            // Generate canonical ID
            const canonicalId = IdentityService.mintCanonicalId(entity_type);
            const nowUnix = Math.floor(Date.now() / 1000);

            log.info('mint_start', { entity_type, canonical_id: canonicalId });

            // DEV mode: create event, sign with DevSigner, apply immediately via EventProcessor
            const devSigner = getDevSigner();
            if (!devSigner.isEnabled()) {
                return res.status(503).json({
                    success: false,
                    error: 'DevSigner not enabled. Set DEV_SIGNER_PRIVATE_KEY in environment.'
                });
            }

            const unsignedMintEvent = {
                v: 1,
                type: 'MINT_ENTITY',
                created_at: nowUnix,
                parents: [],
                body: {
                    entity_type,
                    canonical_id: canonicalId,
                    initial_claims,
                    provenance
                },
                proofs: { source_links: [] }
            };

            // Sign with DevSigner — sets author_pubkey and sig
            const mintEvent = devSigner.signEvent(unsignedMintEvent);

            // Store event for replay (signature verification passes)
            const storeResult = await store.storeEvent(mintEvent);
            const eventHash = storeResult.hash;
            log.info('mint_event_stored', { event_hash: eventHash, entity_type, canonical_id: canonicalId });

            // Apply immediately via canonical EventProcessor handler
            // This ensures dev-mode and replay produce identical graph state:
            // - NODE_LABELS whitelist (no Cypher label injection)
            // - Both 'id' and entity-specific fields (person_id, group_id, etc.)
            // - Deterministic claim IDs (sha256(eventHash:mint_claim:i))
            // - MERGE-based idempotency
            await eventProcessor.handleMintEntity(mintEvent, {
                hash: eventHash,
                author: provenance.submitter || 'system',
                ts: nowUnix
            });

            timer.end('mint_end', { event_hash: eventHash, entity_type, canonical_id: canonicalId });

            res.status(201).json({
                success: true,
                canonical_id: canonicalId,
                status: 'ACTIVE',
                eventHash,
                initial_claims: initial_claims.length,
                message: `Created canonical ${entity_type}`
            });

        } catch (error) {
            timer.endError('mint_error', { entity_type: req.body?.entity_type, error: error.message, error_class: error.constructor.name });
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    /**
     * POST /api/identity/resolve
     * Map a provisional or external ID to a canonical ID
     *
     * Request body:
     * {
     *   subject_id: string,  // provisional or external ID
     *   canonical_id: string, // canonical ID to map to
     *   confidence: number,   // 0-1, default 1.0
     *   method: "manual" | "import" | "ai_suggested" | "authority_source",
     *   evidence: string
     * }
     *
     * Response:
     * {
     *   success: true,
     *   mapping: {
     *     key: string,
     *     subject_id: string,
     *     canonical_id: string,
     *     status: "mapped"
     *   }
     * }
     */
    router.post('/resolve', async (req, res) => {
        const log = createLogger('api.identity', { request_id: req.requestId });
        const timer = log.startTimer();
        try {
            // In chain mode, ID resolution must go through the event-sourced pipeline
            const ingestMode = process.env.INGEST_MODE || 'chain';
            if (ingestMode === 'chain') {
                return res.status(501).json({
                    success: false,
                    error: 'Direct ID resolution is disabled in chain mode. ' +
                           'Use the event-sourced pipeline: POST /api/events/prepare (type RESOLVE_ID) ' +
                           '→ sign → POST /api/events/create → anchor on-chain → ingestion applies resolution.'
                });
            }

            const {
                subject_id,
                canonical_id,
                confidence = 1.0,
                method = 'manual',
                evidence = '',
                submitter = 'system'
            } = req.body;

            // Validate inputs
            if (!subject_id || !canonical_id) {
                return res.status(400).json({
                    success: false,
                    error: 'subject_id and canonical_id are required'
                });
            }

            // Parse IDs
            const subjectParsed = IdentityService.parseId(subject_id);
            const canonicalParsed = IdentityService.parseId(canonical_id);

            // Validate canonical ID
            if (!IdentityService.isCanonical(canonical_id)) {
                return res.status(400).json({
                    success: false,
                    error: `canonical_id must be a canonical ID (polaris:{type}:{uuid}), got: ${canonical_id}`
                });
            }

            // Validate subject ID is not canonical
            if (subjectParsed.kind === IDKind.CANONICAL) {
                return res.status(400).json({
                    success: false,
                    error: 'subject_id must be provisional or external, not canonical. Use /merge for canonical→canonical mapping.'
                });
            }

            const nowUnix = Math.floor(Date.now() / 1000);

            log.info('resolve_start', { subject_id, canonical_id, method, confidence });

            // DEV mode: create event, sign with DevSigner, apply immediately via EventProcessor
            const devSigner = getDevSigner();
            if (!devSigner.isEnabled()) {
                return res.status(503).json({
                    success: false,
                    error: 'DevSigner not enabled. Set DEV_SIGNER_PRIVATE_KEY in environment.'
                });
            }

            const unsignedResolveEvent = {
                v: 1,
                type: 'RESOLVE_ID',
                created_at: nowUnix,
                parents: [],
                body: {
                    subject_id,
                    canonical_id,
                    confidence,
                    method,
                    evidence
                },
                proofs: { source_links: [] }
            };

            // Sign with DevSigner — sets author_pubkey and sig
            const resolveEvent = devSigner.signEvent(unsignedResolveEvent);

            // Store event for replay (signature verification passes)
            const storeResult = await store.storeEvent(resolveEvent);
            const eventHash = storeResult.hash;
            log.info('resolve_event_stored', { event_hash: eventHash, subject_id, canonical_id });

            // Apply immediately via canonical EventProcessor handler
            // This ensures dev-mode and replay produce identical graph state
            await eventProcessor.handleResolveId(resolveEvent, {
                hash: eventHash,
                author: submitter,
                ts: nowUnix
            });

            timer.end('resolve_end', { event_hash: eventHash, subject_id, canonical_id, method, confidence });

            res.status(200).json({
                success: true,
                eventHash,
                mapping: {
                    subject_id,
                    canonical_id,
                    status: 'mapped',
                    method,
                    confidence
                }
            });

        } catch (error) {
            timer.endError('resolve_error', { subject_id: req.body?.subject_id, canonical_id: req.body?.canonical_id, error: error.message, error_class: error.constructor.name });
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    /**
     * POST /api/identity/merge
     * Merge duplicate entities
     *
     * Request body:
     * {
     *   survivor_id: string,   // canonical ID to keep
     *   absorbed_ids: string[], // canonical/provisional IDs to merge
     *   evidence: string,
     *   submitter: string
     * }
     *
     * Response:
     * {
     *   success: true,
     *   merge_result: {
     *     survivor_id: string,
     *     absorbed_count: number,
     *     edges_rewired: number,
     *     claims_moved: number,
     *     tombstones_created: number
     *   }
     * }
     */
    router.post('/merge', async (req, res) => {
        const log = createLogger('api.identity', { request_id: req.requestId });
        const timer = log.startTimer();
        try {
            // In chain mode, merges must go through the event-sourced pipeline:
            // POST /api/events/prepare → sign → POST /api/events/create → anchor on-chain
            // Neo4j mutation only happens via ingestion of chain-anchored MERGE_ENTITY event.
            const ingestMode = process.env.INGEST_MODE || 'chain';
            if (ingestMode === 'chain') {
                return res.status(501).json({
                    success: false,
                    error: 'Direct merge is disabled in chain mode. ' +
                           'Use the event-sourced pipeline: POST /api/events/prepare (type MERGE_ENTITY) ' +
                           '→ sign → POST /api/events/create → anchor on-chain → ingestion applies merge.'
                });
            }

            const {
                survivor_id,
                absorbed_ids,
                evidence = '',
                submitter = 'system'
            } = req.body;

            // Validate inputs
            if (!survivor_id || !absorbed_ids || !Array.isArray(absorbed_ids) || absorbed_ids.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'survivor_id and absorbed_ids (non-empty array) are required'
                });
            }

            // Validate survivor is canonical
            if (!IdentityService.isCanonical(survivor_id)) {
                return res.status(400).json({
                    success: false,
                    error: `survivor_id must be canonical, got: ${survivor_id}`
                });
            }

            log.info('merge_start', { survivor_id, absorbed_count: absorbed_ids.length });

            // DEV mode: create event, sign with DevSigner, apply merge immediately via EventProcessor
            const nowUnix = Math.floor(Date.now() / 1000);
            const devSigner = getDevSigner();
            if (!devSigner.isEnabled()) {
                return res.status(503).json({
                    success: false,
                    error: 'DevSigner not enabled. Set DEV_SIGNER_PRIVATE_KEY in environment.'
                });
            }

            const unsignedMergeEvent = {
                v: 1,
                type: 'MERGE_ENTITY',
                created_at: nowUnix,
                parents: [],
                body: {
                    survivor_id,
                    absorbed_ids,
                    evidence,
                    submitter
                },
                proofs: { source_links: [] }
            };

            // Sign with DevSigner — sets author_pubkey and sig
            const mergeEvent = devSigner.signEvent(unsignedMergeEvent);

            // Store event for replay (signature verification passes)
            const storeResult = await store.storeEvent(mergeEvent);
            const eventHash = storeResult.hash;

            log.info('merge_event_stored', { event_hash: eventHash, survivor_id, absorbed_count: absorbed_ids.length });

            // Apply immediately via canonical EventProcessor handler
            // This ensures dev-mode and replay produce identical graph state:
            // - Idempotency guard (merge_event_hash check)
            // - Deterministic timestamps from event time
            await eventProcessor.handleMergeEntity(mergeEvent, {
                hash: eventHash,
                author: submitter,
                ts: nowUnix
            });

            timer.end('merge_end', { event_hash: eventHash, survivor_id, absorbed_count: absorbed_ids.length });

            res.status(200).json({
                success: true,
                eventHash,
                message: `Successfully merged ${absorbed_ids.length} entities into ${survivor_id}`
            });

        } catch (error) {
            timer.endError('merge_error', { survivor_id: req.body?.survivor_id, error: error.message, error_class: error.constructor.name });
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    /**
     * GET /api/identity/lookup/:external_id
     * Resolve an external ID to canonical ID
     *
     * Parameters:
     * - external_id: External reference (e.g., "discogs:artist:12345")
     *
     * Response:
     * {
     *   success: true,
     *   external_id: string,
     *   canonical_id: string,
     *   source: string,
     *   external_type: string
     * }
     */
    router.get('/lookup/:external_id', async (req, res) => {
        const log = createLogger('api.identity', { request_id: req.requestId });
        try {
            const externalId = req.params.external_id;

            // Parse external ID
            const parsed = IdentityService.parseId(externalId);

            if (parsed.kind !== IDKind.EXTERNAL) {
                return res.status(400).json({
                    success: false,
                    error: 'Must provide external ID in format: source:type:id (e.g., discogs:artist:12345)'
                });
            }

            log.info('lookup_start', { external_id: externalId });

            const session = db.driver.session();
            try {
                // Query IdentityMap
                const canonicalId = await MergeOperations.resolveExternalId(
                    session,
                    parsed.source,
                    parsed.externalType,
                    parsed.externalId
                );

                if (!canonicalId) {
                    return res.status(404).json({
                        success: false,
                        error: `No mapping found for ${externalId}`,
                        external_id: externalId
                    });
                }

                res.status(200).json({
                    success: true,
                    external_id: externalId,
                    canonical_id: canonicalId,
                    source: parsed.source,
                    external_type: parsed.externalType
                });

            } finally {
                await session.close();
            }

        } catch (error) {
            log.error('lookup_error', { external_id: req.params.external_id, error: error.message, error_class: error.constructor.name });
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    /**
     * GET /api/identity/info/:id
     * Get information about any ID (canonical, provisional, or external)
     *
     * Response:
     * {
     *   success: true,
     *   id: string,
     *   kind: "canonical" | "provisional" | "external",
     *   details: object,
     *   resolves_to: string (if applicable)
     * }
     */
    router.get('/info/:id', async (req, res) => {
        const log = createLogger('api.identity', { request_id: req.requestId });
        try {
            const id = req.params.id;
            const parsed = IdentityService.parseId(id);

            const info = {
                id,
                kind: parsed.kind,
                valid: parsed.valid,
                details: parsed
            };

            // If external or provisional, try to resolve
            if (parsed.kind === IDKind.EXTERNAL) {
                const session = db.driver.session();
                try {
                    const canonicalId = await MergeOperations.resolveExternalId(
                        session,
                        parsed.source,
                        parsed.externalType,
                        parsed.externalId
                    );

                    if (canonicalId) {
                        info.resolves_to = canonicalId;
                    }
                } finally {
                    await session.close();
                }
            }

            res.status(200).json({
                success: true,
                ...info
            });

        } catch (error) {
            log.error('info_error', { id: req.params.id, error: error.message, error_class: error.constructor.name });
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    return router;
}

export default createIdentityRoutes;
