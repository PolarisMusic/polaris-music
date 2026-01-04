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

const router = express.Router();

/**
 * Initialize identity routes with database and event store
 *
 * @param {MusicGraphDatabase} db - Graph database instance
 * @param {EventStore} store - Event store instance
 * @returns {express.Router} Configured router
 */
export function createIdentityRoutes(db, store) {
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
        try {
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

            console.log(`Minting new canonical ${entity_type}: ${canonicalId}`);

            // Create the entity node in the graph
            const session = db.driver.session();
            try {
                await session.run(
                    `CREATE (n:${capitalizeFirst(entity_type)} {
                        id: $id,
                        status: 'ACTIVE',
                        created_at: datetime(),
                        created_by: $submitter,
                        creation_source: $source
                    })
                    RETURN n.id as id`,
                    {
                        id: canonicalId,
                        submitter: provenance.submitter || 'system',
                        source: provenance.source || 'manual'
                    }
                );

                // Add initial claims if provided
                for (const claim of initial_claims) {
                    await session.run(
                        `MATCH (n {id: $entityId})
                         CREATE (c:Claim {
                             claim_id: randomUUID(),
                             property: $property,
                             value: $value,
                             confidence: $confidence,
                             created_at: datetime(),
                             created_by: $submitter
                         })
                         CREATE (c)-[:CLAIMS_ABOUT]->(n)`,
                        {
                            entityId: canonicalId,
                            property: claim.property,
                            value: JSON.stringify(claim.value),
                            confidence: claim.confidence || 1.0,
                            submitter: provenance.submitter || 'system'
                        }
                    );
                }

                res.status(201).json({
                    success: true,
                    canonical_id: canonicalId,
                    status: 'ACTIVE',
                    initial_claims: initial_claims.length,
                    message: `Created canonical ${entity_type}`
                });

            } finally {
                await session.close();
            }

        } catch (error) {
            console.error('Mint entity failed:', error);
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
        try {
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

            console.log(`Resolving ${subject_id} → ${canonical_id} (${method}, confidence: ${confidence})`);

            const session = db.driver.session();
            try {
                let mapping;

                // If subject is external ID, create IdentityMap entry
                if (subjectParsed.kind === IDKind.EXTERNAL) {
                    mapping = await MergeOperations.createIdentityMapping(session, {
                        source: subjectParsed.source,
                        externalType: subjectParsed.externalType,
                        externalId: subjectParsed.externalId,
                        canonicalId: canonical_id,
                        confidence,
                        submitter,
                        evidence
                    });
                }

                // If subject is provisional, create ALIAS_OF relationship
                if (subjectParsed.kind === IDKind.PROVISIONAL) {
                    await MergeOperations.createAlias(session, subject_id, canonical_id);

                    mapping = {
                        key: subject_id,
                        canonical_id: canonical_id
                    };
                }

                res.status(200).json({
                    success: true,
                    mapping: {
                        ...mapping,
                        subject_id,
                        canonical_id,
                        status: 'mapped',
                        method,
                        confidence
                    }
                });

            } finally {
                await session.close();
            }

        } catch (error) {
            console.error('Resolve ID failed:', error);
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
        try {
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

            console.log(`Merging ${absorbed_ids.length} entities into ${survivor_id}`);

            // Create MERGE_ENTITY event for provenance
            const mergeEvent = {
                v: 1,
                type: 'MERGE_ENTITY',
                author_pubkey: submitter,
                created_at: Math.floor(Date.now() / 1000),
                parents: [],
                body: {
                    survivor_id,
                    absorbed_ids,
                    evidence,
                    merged_at: new Date().toISOString()
                },
                proofs: {
                    source_links: []
                },
                sig: '' // In production, should be signed by submitter
            };

            // Store event to get hash
            const storeResult = await store.storeEvent(mergeEvent);
            const eventHash = storeResult.hash;

            console.log(`Merge event created: ${eventHash}`);

            const session = db.driver.session();
            try {
                // Execute merge with event hash
                const stats = await MergeOperations.mergeEntities(
                    session,
                    survivor_id,
                    absorbed_ids,
                    {
                        submitter,
                        evidence,
                        eventHash, // Now has proper event hash
                        rewireEdges: true,
                        moveClaims: true
                    }
                );

                res.status(200).json({
                    success: true,
                    eventHash,
                    merge_result: stats,
                    message: `Successfully merged ${stats.absorbedCount} entities into ${survivor_id}`
                });

            } finally {
                await session.close();
            }

        } catch (error) {
            console.error('Merge entities failed:', error);
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

            console.log(`Looking up ${externalId}...`);

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
            console.error('Lookup failed:', error);
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
            console.error('ID info failed:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    return router;
}

/**
 * Helper function to capitalize first letter
 */
function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

export default createIdentityRoutes;
