/**
 * Entity Merge and Resolution Operations
 *
 * Implements merge semantics that preserve provenance and allow reversal.
 *
 * Core principles:
 * - Merges are recorded as events, not deletions
 * - All claims from absorbed entities are preserved
 * - All edges are rewired to the survivor
 * - Absorbed entities become tombstones with redirect info
 * - Operations are transaction-based for atomicity
 */

import { IdentityService } from '../identity/idService.js';

/**
 * Merge status constants
 */
export const MergeStatus = {
    ACTIVE: 'ACTIVE',
    MERGED: 'MERGED',
    TOMBSTONE: 'TOMBSTONE'
};

/**
 * Merge operations for Neo4j graph
 */
export class MergeOperations {
    /**
     * Merge multiple entities into a single survivor entity
     *
     * @param {Object} session - Neo4j session
     * @param {string} survivorId - Canonical ID of the entity to keep
     * @param {Array<string>} absorbedIds - IDs of entities to merge into survivor
     * @param {Object} options - Merge options
     * @param {string} options.submitter - Account performing the merge
     * @param {string} options.eventHash - Hash of the MERGE_ENTITY event
     * @param {string} options.evidence - Evidence/justification for merge
     * @param {boolean} options.rewireEdges - Whether to rewire edges (default: true)
     * @param {boolean} options.moveClaims - Whether to move claims (default: true)
     * @returns {Promise<Object>} Merge result statistics
     */
    static async mergeEntities(session, survivorId, absorbedIds, options = {}) {
        const {
            submitter = 'system',
            eventHash = null,
            evidence = '',
            rewireEdges = true,
            moveClaims = true
        } = options;

        // Validate inputs
        if (!survivorId || !absorbedIds || absorbedIds.length === 0) {
            throw new Error('Merge requires survivorId and at least one absorbedId');
        }

        // Check survivor is canonical
        if (!IdentityService.isCanonical(survivorId)) {
            throw new Error(`Survivor ID must be canonical, got: ${survivorId}`);
        }

        const stats = {
            survivorId,
            absorbedCount: absorbedIds.length,
            edgesRewired: 0,
            claimsMoved: 0,
            tombstonesCreated: 0
        };

        console.log(`Merging ${absorbedIds.length} entities into ${survivorId}...`);

        // Use transaction for atomicity
        const tx = session.beginTransaction();

        try {
            // 1. Verify survivor exists
            const survivorCheck = await tx.run(
                `MATCH (survivor {id: $survivorId})
                 RETURN survivor.id as id, labels(survivor)[0] as type`,
                { survivorId }
            );

            if (survivorCheck.records.length === 0) {
                throw new Error(`Survivor entity not found: ${survivorId}`);
            }

            const survivorType = survivorCheck.records[0].get('type');
            console.log(`  Survivor type: ${survivorType}`);

            // 2. For each absorbed entity
            for (const absorbedId of absorbedIds) {
                console.log(`  Processing absorbed entity: ${absorbedId}`);

                // Verify absorbed entity exists
                const absorbedCheck = await tx.run(
                    `MATCH (absorbed {id: $absorbedId})
                     RETURN absorbed.id as id, labels(absorbed)[0] as type`,
                    { absorbedId }
                );

                if (absorbedCheck.records.length === 0) {
                    console.warn(`    Absorbed entity not found, skipping: ${absorbedId}`);
                    continue;
                }

                const absorbedType = absorbedCheck.records[0].get('type');

                // Type safety check
                if (absorbedType !== survivorType) {
                    throw new Error(
                        `Type mismatch: survivor is ${survivorType}, absorbed is ${absorbedType}`
                    );
                }

                // 3. Rewire incoming edges
                if (rewireEdges) {
                    const incomingResult = await tx.run(
                        `MATCH (source)-[r]->(absorbed {id: $absorbedId})
                         WHERE source.id <> $survivorId
                         MATCH (survivor {id: $survivorId})
                         WITH source, r, absorbed, survivor, type(r) as relType, properties(r) as props
                         CREATE (source)-[r2:TEMP]->(survivor)
                         SET r2 = props
                         WITH r2, relType
                         CALL apoc.refactor.rename.type('TEMP', relType, [r2])
                         RETURN count(*) as rewired`,
                        { absorbedId, survivorId }
                    );

                    const incomingRewired = incomingResult.records[0]?.get('rewired').toNumber() || 0;
                    stats.edgesRewired += incomingRewired;
                    console.log(`    Rewired ${incomingRewired} incoming edges`);
                }

                // 4. Rewire outgoing edges
                if (rewireEdges) {
                    const outgoingResult = await tx.run(
                        `MATCH (absorbed {id: $absorbedId})-[r]->(target)
                         WHERE target.id <> $survivorId
                         MATCH (survivor {id: $survivorId})
                         WITH absorbed, r, target, survivor, type(r) as relType, properties(r) as props
                         CREATE (survivor)-[r2:TEMP]->(target)
                         SET r2 = props
                         WITH r2, relType
                         CALL apoc.refactor.rename.type('TEMP', relType, [r2])
                         RETURN count(*) as rewired`,
                        { absorbedId, survivorId }
                    );

                    const outgoingRewired = outgoingResult.records[0]?.get('rewired').toNumber() || 0;
                    stats.edgesRewired += outgoingRewired;
                    console.log(`    Rewired ${outgoingRewired} outgoing edges`);
                }

                // 5. Move claims (if using Claim nodes)
                if (moveClaims) {
                    const claimsResult = await tx.run(
                        `MATCH (absorbed {id: $absorbedId})<-[r:CLAIMS_ABOUT]-(claim:Claim)
                         MATCH (survivor {id: $survivorId})
                         DELETE r
                         CREATE (claim)-[:CLAIMS_ABOUT]->(survivor)
                         SET claim.merged_from = $absorbedId,
                             claim.merged_at = datetime(),
                             claim.merged_by = $submitter
                         RETURN count(*) as moved`,
                        { absorbedId, survivorId, submitter }
                    );

                    const claimsMoved = claimsResult.records[0]?.get('moved').toNumber() || 0;
                    stats.claimsMoved += claimsMoved;
                    console.log(`    Moved ${claimsMoved} claims`);
                }

                // 6. Delete all edges from absorbed node
                await tx.run(
                    `MATCH (absorbed {id: $absorbedId})
                     OPTIONAL MATCH (absorbed)-[r]-()
                     DELETE r`,
                    { absorbedId }
                );

                // 7. Mark absorbed node as tombstone
                await tx.run(
                    `MATCH (absorbed {id: $absorbedId})
                     SET absorbed.status = $status,
                         absorbed.merged_into = $survivorId,
                         absorbed.merged_at = datetime(),
                         absorbed.merged_by = $submitter,
                         absorbed.merge_event_hash = $eventHash,
                         absorbed.merge_evidence = $evidence`,
                    {
                        absorbedId,
                        status: MergeStatus.MERGED,
                        survivorId,
                        submitter,
                        eventHash,
                        evidence
                    }
                );

                stats.tombstonesCreated++;
                console.log(`    Marked as tombstone redirecting to ${survivorId}`);
            }

            // 8. Update survivor metadata
            await tx.run(
                `MATCH (survivor {id: $survivorId})
                 SET survivor.last_merged_at = datetime(),
                     survivor.absorbed_count = coalesce(survivor.absorbed_count, 0) + $absorbedCount`,
                { survivorId, absorbedCount: absorbedIds.length }
            );

            // 9. Safety check: Ensure no TEMP relationships remain
            const tempCheckResult = await tx.run(
                `MATCH ()-[r:TEMP]->()
                 RETURN count(r) as tempCount`
            );
            const tempCount = tempCheckResult.records[0]?.get('tempCount').toNumber() || 0;
            if (tempCount > 0) {
                console.error(`⚠️  ERROR: ${tempCount} TEMP relationships remain after merge!`);
                console.error('   This indicates the APOC rename failed - rolling back to prevent corruption');
                throw new Error(`Merge failed: ${tempCount} TEMP relationships remain (APOC rename failed)`);
            }

            // Commit transaction
            await tx.commit();

            console.log(` Merge completed: ${JSON.stringify(stats)}`);
            return stats;

        } catch (error) {
            // Rollback on error
            await tx.rollback();
            console.error(' Merge failed, rolled back:', error);
            throw error;
        }
    }

    /**
     * Create or update an IdentityMap entry
     * Maps an external ID to a canonical ID
     *
     * @param {Object} session - Neo4j session
     * @param {Object} mapping - Identity mapping
     * @param {string} mapping.source - Source system (discogs, musicbrainz, etc.)
     * @param {string} mapping.externalType - Type in external system
     * @param {string} mapping.externalId - ID in external system
     * @param {string} mapping.canonicalId - Canonical ID to map to
     * @param {number} mapping.confidence - Confidence level (0-1)
     * @param {string} mapping.submitter - Account creating mapping
     * @param {string} mapping.evidence - Evidence for mapping
     * @returns {Promise<Object>} Created/updated mapping
     */
    static async createIdentityMapping(session, mapping) {
        const {
            source,
            externalType,
            externalId,
            canonicalId,
            confidence = 1.0,
            submitter = 'system',
            evidence = ''
        } = mapping;

        // Validate inputs
        if (!source || !externalType || !externalId || !canonicalId) {
            throw new Error('Identity mapping requires source, externalType, externalId, and canonicalId');
        }

        if (!IdentityService.isCanonical(canonicalId)) {
            throw new Error(`Canonical ID required, got: ${canonicalId}`);
        }

        // Create unique key
        const key = `${source}:${externalType}:${externalId}`;

        console.log(`Creating identity mapping: ${key} → ${canonicalId}`);

        const result = await session.run(
            `MERGE (im:IdentityMap {key: $key})
             ON CREATE SET
                 im.source = $source,
                 im.external_type = $externalType,
                 im.external_id = $externalId,
                 im.canonical_id = $canonicalId,
                 im.confidence = $confidence,
                 im.created_by = $submitter,
                 im.created_at = datetime(),
                 im.evidence = $evidence
             ON MATCH SET
                 im.canonical_id = $canonicalId,
                 im.confidence = $confidence,
                 im.updated_by = $submitter,
                 im.updated_at = datetime(),
                 im.evidence = $evidence
             RETURN im.key as key, im.canonical_id as canonicalId`,
            {
                key,
                source,
                externalType,
                externalId,
                canonicalId,
                confidence,
                submitter,
                evidence
            }
        );

        return result.records[0].toObject();
    }

    /**
     * Resolve an external ID to a canonical ID
     *
     * @param {Object} session - Neo4j session
     * @param {string} source - Source system
     * @param {string} externalType - Type in external system
     * @param {string} externalId - ID in external system
     * @returns {Promise<string|null>} Canonical ID or null if not mapped
     */
    static async resolveExternalId(session, source, externalType, externalId) {
        const key = `${source}:${externalType}:${externalId}`;

        const result = await session.run(
            `MATCH (im:IdentityMap {key: $key})
             RETURN im.canonical_id as canonicalId`,
            { key }
        );

        if (result.records.length === 0) {
            return null;
        }

        return result.records[0].get('canonicalId');
    }

    /**
     * Follow merge redirects to find the current canonical ID
     *
     * @param {Object} session - Neo4j session
     * @param {string} id - ID to resolve (might be merged)
     * @returns {Promise<string>} Current canonical ID
     */
    static async resolveToCanonical(session, id) {
        const result = await session.run(
            `MATCH (node {id: $id})
             OPTIONAL MATCH (node)-[:MERGED_INTO*]->(canonical)
             WHERE canonical.status <> $mergedStatus OR canonical.status IS NULL
             RETURN coalesce(canonical.id, node.id) as canonicalId,
                    node.status as status`,
            { id, mergedStatus: MergeStatus.MERGED }
        );

        if (result.records.length === 0) {
            throw new Error(`Entity not found: ${id}`);
        }

        return result.records[0].get('canonicalId');
    }

    /**
     * Create an ALIAS_OF relationship from provisional/external ID to canonical.
     * Creates the alias node if it doesn't exist (prevents silent failure).
     *
     * @param {Object} session - Neo4j session
     * @param {string} aliasId - Provisional or external ID
     * @param {string} canonicalId - Canonical ID
     * @param {Object} [metadata] - Optional metadata for alias node
     * @param {string} [metadata.createdBy] - Account creating the alias
     * @param {string} [metadata.aliasKind] - Kind of alias (provisional, external)
     * @param {string} [metadata.method] - Resolution method (manual, import, etc.)
     * @returns {Promise<void>}
     */
    static async createAlias(session, aliasId, canonicalId, metadata = {}) {
        const {
            createdBy = 'system',
            aliasKind = 'provisional',
            method = 'manual'
        } = metadata;

        await session.run(
            `MERGE (alias:Alias {id: $aliasId})
             ON CREATE SET
                alias.created_at = datetime(),
                alias.created_by = $createdBy,
                alias.alias_kind = $aliasKind,
                alias.resolution_method = $method
             MATCH (canonical {id: $canonicalId})
             MERGE (alias)-[r:ALIAS_OF]->(canonical)
             SET r.created_at = coalesce(r.created_at, datetime())`,
            { aliasId, canonicalId, createdBy, aliasKind, method }
        );

        console.log(`Created alias: ${aliasId} → ${canonicalId}`);
    }
}

export default MergeOperations;
