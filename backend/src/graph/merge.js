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

import neo4j from 'neo4j-driver';
import { IdentityService } from '../identity/idService.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('graph.merge');

/**
 * Merge status constants
 */
export const MergeStatus = {
    ACTIVE: 'ACTIVE',
    MERGED: 'MERGED',
    TOMBSTONE: 'TOMBSTONE'
};

/**
 * Conflict resolution strategies for property merging
 */
export const ConflictStrategy = {
    PREFER_CANONICAL: 'prefer_canonical',  // Prefer survivor's values
    PREFER_EXTERNAL: 'prefer_external',    // Prefer values from external IDs
    PREFER_NEWER: 'prefer_newer',          // Prefer newer timestamps
    PREFER_LONGER: 'prefer_longer',        // Prefer longer strings (more detail)
    PREFER_NON_NULL: 'prefer_non_null',    // Prefer non-null values
    CONCATENATE: 'concatenate',            // Combine values (for arrays, strings)
    KEEP_ALL: 'keep_all'                   // Store all conflicting values
};

/**
 * Default conflict resolution rules by property name
 */
const DEFAULT_RESOLUTION_RULES = {
    // Identity properties - prefer canonical
    'id': ConflictStrategy.PREFER_CANONICAL,
    'person_id': ConflictStrategy.PREFER_CANONICAL,
    'group_id': ConflictStrategy.PREFER_CANONICAL,
    'track_id': ConflictStrategy.PREFER_CANONICAL,
    'release_id': ConflictStrategy.PREFER_CANONICAL,

    // Names - prefer external, then longer
    'name': ConflictStrategy.PREFER_EXTERNAL,
    'legal_name': ConflictStrategy.PREFER_EXTERNAL,
    'display_name': ConflictStrategy.PREFER_EXTERNAL,

    // Descriptions - prefer longer (more detail)
    'bio': ConflictStrategy.PREFER_LONGER,
    'description': ConflictStrategy.PREFER_LONGER,
    'notes': ConflictStrategy.PREFER_LONGER,

    // Dates - prefer external sources
    'birth_date': ConflictStrategy.PREFER_EXTERNAL,
    'death_date': ConflictStrategy.PREFER_EXTERNAL,
    'formed_date': ConflictStrategy.PREFER_EXTERNAL,
    'disbanded_date': ConflictStrategy.PREFER_EXTERNAL,
    'release_date': ConflictStrategy.PREFER_EXTERNAL,

    // Arrays - concatenate and deduplicate
    'genres': ConflictStrategy.CONCATENATE,
    'styles': ConflictStrategy.CONCATENATE,
    'tags': ConflictStrategy.CONCATENATE,
    'aliases': ConflictStrategy.CONCATENATE,

    // Status and metadata - prefer canonical
    'status': ConflictStrategy.PREFER_CANONICAL,
    'id_kind': ConflictStrategy.PREFER_CANONICAL,
    'visibility': ConflictStrategy.PREFER_CANONICAL,

    // Provenance - keep non-null
    'source': ConflictStrategy.PREFER_NON_NULL,
    'external_url': ConflictStrategy.PREFER_NON_NULL,
    'external_id': ConflictStrategy.PREFER_EXTERNAL,

    // Timestamps - prefer newer
    'created_at': ConflictStrategy.PREFER_CANONICAL,
    'updated_at': ConflictStrategy.PREFER_NEWER,
    'last_edited_at': ConflictStrategy.PREFER_NEWER
};

/**
 * Resolve property conflicts using configured strategy
 *
 * @param {string} propName - Property name
 * @param {*} survivorValue - Survivor's property value
 * @param {*} absorbedValue - Absorbed entity's property value
 * @param {Object} metadata - Additional metadata for resolution
 * @param {boolean} metadata.survivorIsExternal - Survivor has external ID
 * @param {boolean} metadata.absorbedIsExternal - Absorbed has external ID
 * @param {string} strategy - Override default strategy
 * @returns {Object} Resolution result {value, conflicts, strategy}
 */
function resolvePropertyConflict(propName, survivorValue, absorbedValue, metadata = {}, strategy = null) {
    // If values are equal, no conflict
    if (survivorValue === absorbedValue) {
        return { value: survivorValue, conflicts: [], strategy: 'no_conflict' };
    }

    // If one is null, prefer non-null
    if (survivorValue == null && absorbedValue != null) {
        return {
            value: absorbedValue,
            conflicts: [{ property: propName, survivor: null, absorbed: absorbedValue }],
            strategy: ConflictStrategy.PREFER_NON_NULL
        };
    }
    if (absorbedValue == null && survivorValue != null) {
        return {
            value: survivorValue,
            conflicts: [],
            strategy: ConflictStrategy.PREFER_NON_NULL
        };
    }

    // Determine strategy
    const resolvedStrategy = strategy || DEFAULT_RESOLUTION_RULES[propName] || ConflictStrategy.PREFER_CANONICAL;

    const conflict = {
        property: propName,
        survivor: survivorValue,
        absorbed: absorbedValue,
        resolution: resolvedStrategy
    };

    let resolvedValue;

    switch (resolvedStrategy) {
        case ConflictStrategy.PREFER_CANONICAL:
            resolvedValue = survivorValue;
            break;

        case ConflictStrategy.PREFER_EXTERNAL:
            // If survivor has external ID, prefer survivor; otherwise prefer absorbed if it's external
            if (metadata.survivorIsExternal) {
                resolvedValue = survivorValue;
            } else if (metadata.absorbedIsExternal) {
                resolvedValue = absorbedValue;
            } else {
                // Neither is external, prefer canonical (survivor)
                resolvedValue = survivorValue;
            }
            break;

        case ConflictStrategy.PREFER_NEWER:
            // For timestamps, prefer the newer one
            if (typeof survivorValue === 'string' && typeof absorbedValue === 'string') {
                const survivorDate = new Date(survivorValue);
                const absorbedDate = new Date(absorbedValue);
                resolvedValue = survivorDate > absorbedDate ? survivorValue : absorbedValue;
            } else {
                resolvedValue = survivorValue;
            }
            break;

        case ConflictStrategy.PREFER_LONGER:
            // For strings, prefer the longer one (more detail)
            if (typeof survivorValue === 'string' && typeof absorbedValue === 'string') {
                resolvedValue = survivorValue.length >= absorbedValue.length ? survivorValue : absorbedValue;
            } else {
                resolvedValue = survivorValue;
            }
            break;

        case ConflictStrategy.CONCATENATE:
            // For arrays or strings, combine and deduplicate
            if (Array.isArray(survivorValue) && Array.isArray(absorbedValue)) {
                resolvedValue = [...new Set([...survivorValue, ...absorbedValue])];
            } else if (typeof survivorValue === 'string' && typeof absorbedValue === 'string') {
                // Combine strings with separator, deduplicate
                const combined = `${survivorValue}; ${absorbedValue}`;
                resolvedValue = combined;
            } else {
                resolvedValue = survivorValue;
            }
            break;

        case ConflictStrategy.KEEP_ALL:
            // Store both values in an array
            resolvedValue = [survivorValue, absorbedValue];
            break;

        case ConflictStrategy.PREFER_NON_NULL:
            resolvedValue = survivorValue != null ? survivorValue : absorbedValue;
            break;

        default:
            // Default to canonical (survivor)
            resolvedValue = survivorValue;
    }

    return {
        value: resolvedValue,
        conflicts: [conflict],
        strategy: resolvedStrategy
    };
}

/**
 * Merge properties from absorbed node into survivor node
 *
 * @param {Object} tx - Neo4j transaction
 * @param {string} survivorId - Survivor node ID
 * @param {string} absorbedId - Absorbed node ID
 * @param {Object} options - Merge options
 * @param {Object} options.resolutionRules - Custom resolution rules
 * @returns {Promise<Object>} Merge result {merged: {}, conflicts: []}
 */
async function mergeProperties(tx, survivorId, absorbedId, options = {}) {
    const { resolutionRules = {} } = options;

    // Fetch both nodes' properties
    const result = await tx.run(
        `MATCH (survivor {id: $survivorId})
         MATCH (absorbed {id: $absorbedId})
         RETURN properties(survivor) as survivorProps,
                properties(absorbed) as absorbedProps,
                survivor.id_kind as survivorIdKind,
                absorbed.id_kind as absorbedIdKind`,
        { survivorId, absorbedId }
    );

    if (result.records.length === 0) {
        throw new Error('Could not fetch properties for merge');
    }

    const record = result.records[0];
    const survivorProps = record.get('survivorProps');
    const absorbedProps = record.get('absorbedProps');
    const survivorIdKind = record.get('survivorIdKind');
    const absorbedIdKind = record.get('absorbedIdKind');

    // Determine if IDs are external (not provisional)
    const metadata = {
        survivorIsExternal: survivorIdKind === 'external' || !survivorId.startsWith('prov:'),
        absorbedIsExternal: absorbedIdKind === 'external' || !absorbedId.startsWith('prov:')
    };

    const mergedProps = { ...survivorProps };
    const conflicts = [];

    // Protected properties that should never be overwritten
    const protectedProps = new Set(['id', 'person_id', 'group_id', 'track_id', 'release_id', 'song_id', 'master_id', 'label_id']);

    // Merge each property from absorbed into survivor
    for (const [propName, absorbedValue] of Object.entries(absorbedProps)) {
        // Skip protected properties
        if (protectedProps.has(propName)) {
            continue;
        }

        const survivorValue = survivorProps[propName];
        const customStrategy = resolutionRules[propName];

        const resolution = resolvePropertyConflict(
            propName,
            survivorValue,
            absorbedValue,
            metadata,
            customStrategy
        );

        mergedProps[propName] = resolution.value;
        if (resolution.conflicts.length > 0) {
            conflicts.push(...resolution.conflicts);
        }
    }

    // Update survivor with merged properties
    if (conflicts.length > 0) {
        // Store conflict log in survivor node for audit trail
        mergedProps.merge_conflicts = JSON.stringify(conflicts);
        mergedProps.merge_conflicts_count = conflicts.length;
    }

    await tx.run(
        `MATCH (survivor {id: $survivorId})
         SET survivor = $mergedProps`,
        { survivorId, mergedProps }
    );

    return { merged: mergedProps, conflicts };
}

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
     * @param {Object} options.resolutionRules - Custom property conflict resolution rules
     * @returns {Promise<Object>} Merge result statistics (includes conflictsResolved)
     */
    static async mergeEntities(session, survivorId, absorbedIds, options = {}) {
        const timer = log.startTimer();
        const {
            submitter = 'system',
            eventHash = null,
            evidence = '',
            rewireEdges = true,
            moveClaims = true,
            eventTimestamp = null
        } = options;

        // Deterministic event timestamp (same pattern as processReleaseBundle)
        // Must wrap in neo4j.int() because datetime({epochMillis:}) rejects Double in Neo4j 5+
        let rawTs;
        if (eventTimestamp != null) {
            const raw = typeof eventTimestamp === 'number' ? eventTimestamp : Number(eventTimestamp);
            rawTs = raw < 1e12 ? raw * 1000 : raw;
        } else {
            rawTs = Date.now();
        }
        const eventTs = neo4j.int(Math.trunc(rawTs));

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
            tombstonesCreated: 0,
            conflictsResolved: 0
        };

        log.info('merge_start', { survivor_id: survivorId, absorbed_count: absorbedIds.length });

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
            log.debug('merge_survivor_type', { type: survivorType });

            // 2. For each absorbed entity
            for (const absorbedId of absorbedIds) {
                log.debug('merge_absorb', { absorbed_id: absorbedId });

                // Verify absorbed entity exists
                const absorbedCheck = await tx.run(
                    `MATCH (absorbed {id: $absorbedId})
                     RETURN absorbed.id as id, labels(absorbed)[0] as type`,
                    { absorbedId }
                );

                if (absorbedCheck.records.length === 0) {
                    log.warn('merge_absorbed_not_found', { absorbed_id: absorbedId });
                    continue;
                }

                const absorbedType = absorbedCheck.records[0].get('type');

                // Type safety check
                if (absorbedType !== survivorType) {
                    throw new Error(
                        `Type mismatch: survivor is ${survivorType}, absorbed is ${absorbedType}`
                    );
                }

                // 3. Merge properties with conflict resolution
                log.debug('merge_properties', { absorbed_id: absorbedId, survivor_id: survivorId });
                const propertyMergeResult = await mergeProperties(tx, survivorId, absorbedId, {
                    resolutionRules: options.resolutionRules || {}
                });

                if (propertyMergeResult.conflicts.length > 0) {
                    log.info('merge_conflicts_resolved', {
                        absorbed_id: absorbedId,
                        survivor_id: survivorId,
                        conflict_count: propertyMergeResult.conflicts.length,
                        conflicts: propertyMergeResult.conflicts
                    });
                }

                stats.conflictsResolved = (stats.conflictsResolved || 0) + propertyMergeResult.conflicts.length;

                // 4. Rewire incoming edges (native Cypher — no APOC dependency)
                if (rewireEdges) {
                    // Collect incoming edge data before deletion
                    const incomingEdges = await tx.run(
                        `MATCH (survivor {id: $survivorId})
                         MATCH (source)-[r]->(absorbed {id: $absorbedId})
                         WHERE source <> survivor
                         RETURN id(source) as sourceNodeId, type(r) as relType, properties(r) as props`,
                        { survivorId, absorbedId }
                    );

                    // Delete original incoming edges
                    if (incomingEdges.records.length > 0) {
                        await tx.run(
                            `MATCH (survivor {id: $survivorId})
                             MATCH (source)-[r]->(absorbed {id: $absorbedId})
                             WHERE source <> survivor
                             DELETE r`,
                            { survivorId, absorbedId }
                        );
                    }

                    // Recreate edges pointing to survivor with correct dynamic type
                    for (const record of incomingEdges.records) {
                        const relType = record.get('relType');
                        const props = record.get('props');
                        const sourceNodeId = record.get('sourceNodeId');
                        // relType from existing DB relationships — safe for backtick interpolation
                        await tx.run(
                            `MATCH (source) WHERE id(source) = $sourceNodeId
                             MATCH (survivor {id: $survivorId})
                             CREATE (source)-[r:\`${relType}\`]->(survivor)
                             SET r = $props`,
                            { sourceNodeId, survivorId, props }
                        );
                    }

                    stats.edgesRewired += incomingEdges.records.length;
                    log.debug('merge_rewire_incoming', { absorbed_id: absorbedId, count: incomingEdges.records.length });
                }

                // 5. Rewire outgoing edges (native Cypher — no APOC dependency)
                if (rewireEdges) {
                    // Collect outgoing edge data before deletion
                    const outgoingEdges = await tx.run(
                        `MATCH (survivor {id: $survivorId})
                         MATCH (absorbed {id: $absorbedId})-[r]->(target)
                         WHERE target <> survivor
                         RETURN id(target) as targetNodeId, type(r) as relType, properties(r) as props`,
                        { survivorId, absorbedId }
                    );

                    // Delete original outgoing edges
                    if (outgoingEdges.records.length > 0) {
                        await tx.run(
                            `MATCH (survivor {id: $survivorId})
                             MATCH (absorbed {id: $absorbedId})-[r]->(target)
                             WHERE target <> survivor
                             DELETE r`,
                            { survivorId, absorbedId }
                        );
                    }

                    // Recreate edges from survivor with correct dynamic type
                    for (const record of outgoingEdges.records) {
                        const relType = record.get('relType');
                        const props = record.get('props');
                        const targetNodeId = record.get('targetNodeId');
                        await tx.run(
                            `MATCH (survivor {id: $survivorId})
                             MATCH (target) WHERE id(target) = $targetNodeId
                             CREATE (survivor)-[r:\`${relType}\`]->(target)
                             SET r = $props`,
                            { survivorId, targetNodeId, props }
                        );
                    }

                    stats.edgesRewired += outgoingEdges.records.length;
                    log.debug('merge_rewire_outgoing', { absorbed_id: absorbedId, count: outgoingEdges.records.length });
                }

                // 6. Move claims (if using Claim nodes)
                if (moveClaims) {
                    const claimsResult = await tx.run(
                        `MATCH (absorbed {id: $absorbedId})<-[r:CLAIMS_ABOUT]-(claim:Claim)
                         MATCH (survivor {id: $survivorId})
                         DELETE r
                         CREATE (claim)-[:CLAIMS_ABOUT]->(survivor)
                         SET claim.merged_from = $absorbedId,
                             claim.merged_at = datetime({epochMillis: $eventTs}),
                             claim.merged_by = $submitter
                         RETURN count(*) as moved`,
                        { absorbedId, survivorId, submitter, eventTs }
                    );

                    const claimsMoved = claimsResult.records[0]?.get('moved').toNumber() || 0;
                    stats.claimsMoved += claimsMoved;
                    log.debug('merge_claims_moved', { absorbed_id: absorbedId, count: claimsMoved });
                }

                // 7. Delete all edges from absorbed node
                await tx.run(
                    `MATCH (absorbed {id: $absorbedId})
                     OPTIONAL MATCH (absorbed)-[r]-()
                     DELETE r`,
                    { absorbedId }
                );

                // 8. Mark absorbed node as tombstone
                await tx.run(
                    `MATCH (absorbed {id: $absorbedId})
                     SET absorbed.status = $status,
                         absorbed.merged_into = $survivorId,
                         absorbed.merged_at = datetime({epochMillis: $eventTs}),
                         absorbed.merged_by = $submitter,
                         absorbed.merge_event_hash = $eventHash,
                         absorbed.merge_evidence = $evidence`,
                    {
                        absorbedId,
                        status: MergeStatus.MERGED,
                        survivorId,
                        submitter,
                        eventHash,
                        evidence,
                        eventTs
                    }
                );

                stats.tombstonesCreated++;
                log.debug('merge_tombstone', { absorbed_id: absorbedId, survivor_id: survivorId });
            }

            // 9. Update survivor metadata
            await tx.run(
                `MATCH (survivor {id: $survivorId})
                 SET survivor.last_merged_at = datetime({epochMillis: $eventTs}),
                     survivor.absorbed_count = coalesce(survivor.absorbed_count, 0) + $absorbedCount`,
                { survivorId, absorbedCount: absorbedIds.length, eventTs }
            );

            // Commit transaction
            await tx.commit();

            timer.end('merge_end', { survivor_id: survivorId, ...stats });
            return stats;

        } catch (error) {
            // Rollback on error
            await tx.rollback();
            timer.endError('merge_fail', { survivor_id: survivorId, error: error.message });
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

        log.info('identity_map_create', { key, canonical_id: canonicalId });

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

        // CRITICAL: MATCH canonical FIRST to prevent creating orphan alias nodes
        const canonicalCheck = await session.run(
            `
            MATCH (c {id: $canonicalId})
            RETURN c
            `,
            { canonicalId }
        );

        if (canonicalCheck.records.length === 0) {
            throw new Error(`Canonical node does not exist: ${canonicalId}`);
        }

        // If canonical doesn't exist, query fails before creating alias (good!)
        // Canonical exists — safe to create alias
        await session.run(
            `MATCH (canonical {id: $canonicalId})
             MERGE (alias:Alias {id: $aliasId})
             ON CREATE SET
                alias.created_at = datetime(),
                alias.created_by = $createdBy,
                alias.alias_kind = $aliasKind,
                alias.resolution_method = $method
             MERGE (alias)-[r:ALIAS_OF]->(canonical)
             SET r.created_at = coalesce(r.created_at, datetime())`,
            { aliasId, canonicalId, createdBy, aliasKind, method }
        );

        log.info('alias_created', { alias_id: aliasId, canonical_id: canonicalId });
    }
}

/**
 * Safe relationship type whitelist for mergeBundle.
 * Only these relationship types can be created via mergeBundle.
 * Prevents Cypher injection through relationship type names.
 */
const SAFE_REL_TYPES = new Set([
    'MEMBER_OF',
    'GUEST_ON',
    'PERFORMED_ON',
    'PRODUCED',
    'WROTE',
    'ARRANGED',
    'RECORDING_OF',
    'IN_RELEASE',
    'RELEASED',
    'ORIGIN',
    'SAMPLES',
    'COVER_OF'
]);

/**
 * Safe label whitelist for mergeBundle.
 * Maps lowercase label to { label, idProp } for use in parameterized MERGE.
 */
const SAFE_LABELS = {
    'person': { label: 'Person', idProp: 'person_id' },
    'group': { label: 'Group', idProp: 'group_id' },
    'track': { label: 'Track', idProp: 'track_id' },
    'release': { label: 'Release', idProp: 'release_id' },
    'song': { label: 'Song', idProp: 'song_id' },
    'label': { label: 'Label', idProp: 'label_id' },
    'master': { label: 'Master', idProp: 'master_id' },
    'city': { label: 'City', idProp: 'city_id' }
};

/**
 * Merge all explicit relationships into the graph.
 *
 * Uses MERGE for both endpoints and the relationship itself, ensuring:
 * - Nodes are created if missing (with name fallback)
 * - Relationships are created without duplicates
 * - Cross-bundle relationships (e.g., Person MEMBER_OF multiple Groups) are
 *   correctly created regardless of bundle processing order
 *
 * SECURITY: All labels and relationship types are validated against whitelists
 * before interpolation into Cypher queries.
 *
 * @param {import('neo4j-driver').Driver} driver - Neo4j driver instance
 * @param {Array} relationships - Explicit relationship descriptors (from extractRelationships)
 * @param {Object} [options]
 * @param {string} [options.eventHash] - Event hash for audit trail
 * @param {import('neo4j-driver').Transaction} [options.tx] - Existing transaction to use (skips session management)
 * @returns {Promise<Object>} Statistics { relationshipsMerged, nodesEnsured, skipped }
 */
async function mergeBundle(driver, relationships, options = {}) {
    const { eventHash = null, tx: existingTx = null } = options;

    if (relationships.length === 0) {
        return { relationshipsMerged: 0, nodesEnsured: 0, skipped: 0 };
    }

    const stats = { relationshipsMerged: 0, nodesEnsured: 0, skipped: 0 };
    let session = null;
    let tx = existingTx;

    try {
        if (!existingTx) {
            session = driver.session();
            tx = session.beginTransaction();
        }

        for (const rel of relationships) {
            // Validate relationship type against whitelist
            if (!SAFE_REL_TYPES.has(rel.type)) {
                log.warn('merge_bundle_skip_rel', { type: rel.type, reason: 'not_in_whitelist' });
                stats.skipped++;
                continue;
            }

            // Validate from/to labels
            const fromMapping = SAFE_LABELS[rel.from.label.toLowerCase()];
            const toMapping = SAFE_LABELS[rel.to.label.toLowerCase()];

            if (!fromMapping || !toMapping) {
                log.warn('merge_bundle_skip_label', {
                    from_label: rel.from.label,
                    to_label: rel.to.label,
                    reason: 'unknown_label'
                });
                stats.skipped++;
                continue;
            }

            // Must have at least an id or name for each endpoint
            if (!rel.from.id && !rel.from.name) {
                stats.skipped++;
                continue;
            }
            if (!rel.to.id && !rel.to.name) {
                stats.skipped++;
                continue;
            }

            // Build Cypher for MERGE of both endpoints and the relationship.
            // Use id when available; fall back to name-based provisional match.
            const fromIdProp = fromMapping.idProp;
            const toIdProp = toMapping.idProp;
            const fromLabel = fromMapping.label;
            const toLabel = toMapping.label;

            // Build safe property map for relationship (filter out null/undefined)
            const relProps = {};
            if (rel.props) {
                for (const [k, v] of Object.entries(rel.props)) {
                    if (v !== null && v !== undefined) {
                        relProps[k] = v;
                    }
                }
            }

            // Use MERGE on id field if available, otherwise use name
            const fromMergeField = rel.from.id ? fromIdProp : 'name';
            const fromMergeValue = rel.from.id || rel.from.name;
            const toMergeField = rel.to.id ? toIdProp : 'name';
            const toMergeValue = rel.to.id || rel.to.name;

            // SECURITY: fromLabel, toLabel, rel.type are validated against whitelists above
            // fromMergeField, toMergeField are derived from the whitelisted SAFE_LABELS
            const cypher = `
                MERGE (from:\`${fromLabel}\` {\`${fromMergeField}\`: $fromId})
                ON CREATE SET from.id = $fromIdVal,
                              from.name = $fromName,
                              from.status = 'PROVISIONAL'
                MERGE (to:\`${toLabel}\` {\`${toMergeField}\`: $toId})
                ON CREATE SET to.id = $toIdVal,
                              to.name = $toName,
                              to.status = 'PROVISIONAL'
                MERGE (from)-[r:\`${rel.type}\`]->(to)
                SET r += $relProps
            `;

            const params = {
                fromId: fromMergeValue,
                fromIdVal: rel.from.id || fromMergeValue,
                fromName: rel.from.name || null,
                toId: toMergeValue,
                toIdVal: rel.to.id || toMergeValue,
                toName: rel.to.name || null,
                relProps
            };

            await tx.run(cypher, params);
            stats.relationshipsMerged++;
            stats.nodesEnsured += 2;
        }

        // Only commit if we created our own transaction
        if (!existingTx) {
            await tx.commit();
        }

        log.info('merge_bundle_end', stats);
        return stats;

    } catch (error) {
        if (!existingTx && tx) {
            await tx.rollback();
        }
        log.error('merge_bundle_fail', { error: error.message, event_hash: eventHash });
        throw error;
    } finally {
        if (session) {
            await session.close();
        }
    }
}

export { mergeBundle, SAFE_REL_TYPES, SAFE_LABELS };
export default MergeOperations;
