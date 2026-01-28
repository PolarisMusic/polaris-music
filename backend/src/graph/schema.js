/**
 * @fileoverview Neo4j graph database schema and operations for Polaris Music Registry
 *
 * This module implements the core graph database layer that stores normalized music data
 * with Groups as primary performance entities and careful tracking of member/guest relationships.
 *
 * Key Concepts:
 * - Groups (not individual artists) are the primary performance entities
 * - MEMBER_OF relationships track core group membership with date ranges
 * - GUEST_ON relationships track session musicians and non-member contributors
 * - All operations are idempotent and can be safely replayed
 * - Provisional IDs are used when external canonical IDs are unavailable
 *
 * @module graph/schema
 */

import neo4j from 'neo4j-driver';
import { createHash } from 'crypto';
import { IdentityService, EntityType } from '../identity/idService.js';
import { MergeOperations } from './merge.js';
import { normalizeReleaseBundle } from './normalizeReleaseBundle.js';
import { validateReleaseBundleOrThrow } from '../schema/validateReleaseBundle.js';
import { normalizeRole, normalizeRoles, normalizeRoleInput } from './roleNormalization.js';

/**
 * Whitelist mapping for safe node type validation.
 * Prevents Cypher injection by validating node.type against known entity types.
 *
 * SECURITY: Always use this mapping when interpolating node types into Cypher queries.
 * Accepts both lowercase ("person") and capitalized ("Person") inputs.
 *
 * @constant {Object} SAFE_NODE_TYPES
 */
const SAFE_NODE_TYPES = {
    'person': { label: 'Person', idField: 'person_id' },
    'group': { label: 'Group', idField: 'group_id' },
    'song': { label: 'Song', idField: 'song_id' },
    'track': { label: 'Track', idField: 'track_id' },
    'release': { label: 'Release', idField: 'release_id' },
    'master': { label: 'Master', idField: 'master_id' },
    'label': { label: 'Label', idField: 'label_id' },
    'city': { label: 'City', idField: 'city_id' }
};

/**
 * Protected fields that cannot be modified via ADD_CLAIM events.
 * Prevents graph corruption by protecting identity, audit, and system fields.
 *
 * SECURITY: Claims trying to set these fields will be rejected with an error.
 * This prevents both malicious attacks and accidental bugs from corrupting core data.
 *
 * @constant {Set<string>} PROTECTED_FIELDS
 */
const PROTECTED_FIELDS = new Set([
    // Universal ID field
    'id',

    // Entity-specific ID fields (constraint keys)
    'person_id',
    'group_id',
    'song_id',
    'track_id',
    'release_id',
    'master_id',
    'label_id',
    'city_id',
    'claim_id',
    'source_id',

    // Audit trail fields
    'created_at',
    'created_by',
    'creation_source',
    'event_hash',
    'updated_at',
    'updated_by',
    'last_updated',
    'last_updated_by',
    'last_seen_at',

    // System status fields
    'status',
    'blockchain_verified',

    // Internal tracking fields
    '_just_created',
    '_merged_into'
]);

/**
 * Regular expression to validate safe property names for Neo4j.
 * Property names must start with a letter or underscore, followed by
 * alphanumeric characters or underscores.
 */
const SAFE_PROPERTY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate that a field name is safe for use as a Neo4j property.
 * Throws an error if the field name contains invalid characters.
 *
 * @param {string} field - The field name to validate
 * @throws {Error} If field name is invalid
 */
function assertSafePropertyName(field) {
    if (!SAFE_PROPERTY_RE.test(field)) {
        throw new Error(`Invalid field name: "${field}". Field must match ${SAFE_PROPERTY_RE}`);
    }
}

/**
 * Derive track placement (disc, side, track number) from position string.
 * Handles common formats like "A1", "B2", "2-A3", or plain numbers "1", "02".
 *
 * @param {string|number} positionRaw - Position string from tracklist (e.g., "A1", "B12", "2-A3")
 * @param {number} index - Zero-based index in tracklist (used as fallback)
 * @returns {Object} { position, disc, side, trackNo }
 */
function deriveTrackPlacement(positionRaw, index) {
    const position = String(positionRaw ?? '').trim();

    let disc = 1;
    let side = null;
    let trackNo = null;

    // Common vinyl-ish forms: "A1", "B2", "C10"
    let m = position.match(/^([A-Za-z])\s*([0-9]+)$/);
    if (m) {
        side = m[1].toUpperCase();
        trackNo = parseInt(m[2], 10);
    }

    // Numeric-only: "1", "02"
    if (!m) {
        m = position.match(/^([0-9]+)$/);
        if (m) trackNo = parseInt(m[1], 10);
    }

    // Disc + side + track: "2-A3" or "2 A3"
    if (!m) {
        m = position.match(/^([0-9]+)\s*[- ]\s*([A-Za-z])\s*([0-9]+)$/);
        if (m) {
            disc = parseInt(m[1], 10);
            side = m[2].toUpperCase();
            trackNo = parseInt(m[3], 10);
        }
    }

    // Deterministic fallback
    if (!Number.isInteger(trackNo) || trackNo <= 0) trackNo = index + 1;
    if (!Number.isInteger(disc) || disc <= 0) disc = 1;

    return {
        position: position || String(index + 1),
        disc,
        side,
        trackNo
    };
}

/**
 * Convert a value to a positive integer or null.
 *
 * @param {*} v - Value to convert
 * @returns {number|null} Positive integer or null
 */
function toPositiveIntOrNull(v) {
    const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Normalize a value for safe Neo4j property storage.
 * Neo4j supports primitives and homogeneous lists, but not arbitrary nested objects.
 *
 * @param {*} value - Value to normalize
 * @returns {*} Neo4j-compatible value (primitive, list of primitives, or JSON string)
 */
function normalizeValueForNeo4j(value) {
    // Null/undefined are fine
    if (value === null || value === undefined) {
        return null;
    }

    // Primitives are fine (string, number, boolean)
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }

    // Arrays need special handling
    if (Array.isArray(value)) {
        // Empty array is fine
        if (value.length === 0) {
            return value;
        }

        // Check if all elements are primitives (homogeneous list)
        const allPrimitives = value.every(item =>
            item === null ||
            typeof item === 'string' ||
            typeof item === 'number' ||
            typeof item === 'boolean'
        );

        if (allPrimitives) {
            return value;  // Neo4j can store homogeneous primitive lists
        }

        // Complex array (objects, nested arrays, mixed types) -> JSON stringify
        return JSON.stringify(value);
    }

    // Objects (including Date, etc.) -> JSON stringify
    // Neo4j maps have limitations (flat only), so safer to JSON-stringify
    return JSON.stringify(value);
}

/**
 * Main class for interacting with the Neo4j graph database.
 * Handles schema initialization, event processing, and data queries.
 *
 * @class MusicGraphDatabase
 */
class MusicGraphDatabase {
    /**
     * Create a new database connection
     *
     * @param {Object} config - Database configuration
     * @param {string} config.uri - Neo4j bolt:// connection URI
     * @param {string} config.user - Database username
     * @param {string} config.password - Database password
     * @param {Object} [config.poolConfig] - Optional connection pool configuration
     */
constructor(config = {}) {
  // Allow config OR environment variables (CI sets GRAPH_*).
  const resolved = {
    uri: config.uri ?? process.env.GRAPH_URI ?? process.env.NEO4J_URI ?? process.env.NEO4J_URL,
    user: config.user ?? process.env.GRAPH_USER ?? process.env.NEO4J_USER,
    password: config.password ?? process.env.GRAPH_PASSWORD ?? process.env.NEO4J_PASSWORD,
    // keep any other config fields (database name, etc.)
    ...config,
  };

  if (!resolved.uri || !resolved.user || !resolved.password) {
    throw new Error('Database configuration requires uri, user, and password');
  }

  // IMPORTANT: from here on, use "resolved" not "config"


        // Initialize Neo4j driver with connection pooling
        this.driver = neo4j.driver(
            resolved.uri,
            neo4j.auth.basic(resolved.user, resolved.password),
            {
                maxConnectionPoolSize: resolved.poolConfig?.maxSize || 100,
                connectionTimeout: resolved.poolConfig?.timeout || 30000,
                maxTransactionRetryTime: 30000,
                ...resolved.poolConfig
            }
        );

        this.resolved = resolved;
    }

    /**
     * Initialize all database constraints and indexes.
     * Must be run before any data insertion to ensure integrity.
     * This operation is idempotent and safe to run multiple times.
     *
     * @returns {Promise<void>}
     * @throws {Error} If database connection fails or constraints cannot be created
     */
    async initializeSchema() {
        const session = this.driver.session();

        try {
            console.log('Initializing database schema...');

            // ========== NODE CONSTRAINTS ==========
            // These ensure each entity has a unique identifier

            const constraints = [
                // Person: Individual musician, producer, engineer, etc.
                {
                    name: 'person_id',
                    query: 'CREATE CONSTRAINT person_id IF NOT EXISTS FOR (p:Person) REQUIRE p.person_id IS UNIQUE'
                },

                // Group: Band, orchestra, ensemble - collection of Persons
                {
                    name: 'group_id',
                    query: 'CREATE CONSTRAINT group_id IF NOT EXISTS FOR (g:Group) REQUIRE g.group_id IS UNIQUE'
                },

                // Song: Composition (the written musical work)
                {
                    name: 'song_id',
                    query: 'CREATE CONSTRAINT song_id IF NOT EXISTS FOR (s:Song) REQUIRE s.song_id IS UNIQUE'
                },

                // Track: Recording (specific performance of a song)
                {
                    name: 'track_id',
                    query: 'CREATE CONSTRAINT track_id IF NOT EXISTS FOR (t:Track) REQUIRE t.track_id IS UNIQUE'
                },

                // Release: Album, EP, Single, or other package
                {
                    name: 'release_id',
                    query: 'CREATE CONSTRAINT release_id IF NOT EXISTS FOR (r:Release) REQUIRE r.release_id IS UNIQUE'
                },

                // Master: Canonical album entity (groups multiple releases)
                {
                    name: 'master_id',
                    query: 'CREATE CONSTRAINT master_id IF NOT EXISTS FOR (m:Master) REQUIRE m.master_id IS UNIQUE'
                },

                // Label: Record label / publisher
                {
                    name: 'label_id',
                    query: 'CREATE CONSTRAINT label_id IF NOT EXISTS FOR (l:Label) REQUIRE l.label_id IS UNIQUE'
                },

                // Account: Blockchain account that submits data
                {
                    name: 'account_id',
                    query: 'CREATE CONSTRAINT account_id IF NOT EXISTS FOR (a:Account) REQUIRE a.account_id IS UNIQUE'
                },

                // City: Geographic location for origin attribution
                {
                    name: 'city_id',
                    query: 'CREATE CONSTRAINT city_id IF NOT EXISTS FOR (c:City) REQUIRE c.city_id IS UNIQUE'
                },

                // Claim: Audit trail for all data changes
                {
                    name: 'claim_id',
                    query: 'CREATE CONSTRAINT claim_id IF NOT EXISTS FOR (cl:Claim) REQUIRE cl.claim_id IS UNIQUE'
                },

                // Source: External data source reference
                {
                    name: 'source_id',
                    query: 'CREATE CONSTRAINT source_id IF NOT EXISTS FOR (src:Source) REQUIRE src.source_id IS UNIQUE'
                },

                // Media: Multimedia content reference
                {
                    name: 'media_id',
                    query: 'CREATE CONSTRAINT media_id IF NOT EXISTS FOR (m:Media) REQUIRE m.media_id IS UNIQUE'
                },

                // IdentityMap: Maps external IDs to canonical IDs
                {
                    name: 'identity_map_key',
                    query: 'CREATE CONSTRAINT identity_map_key IF NOT EXISTS FOR (im:IdentityMap) REQUIRE im.key IS UNIQUE'
                },

                // Universal ID constraints (for merge operations)
                // These ensure all nodes have a universal 'id' property for entity merge/resolution
                {
                    name: 'person_universal_id',
                    query: 'CREATE CONSTRAINT person_universal_id IF NOT EXISTS FOR (p:Person) REQUIRE p.id IS UNIQUE'
                },
                {
                    name: 'group_universal_id',
                    query: 'CREATE CONSTRAINT group_universal_id IF NOT EXISTS FOR (g:Group) REQUIRE g.id IS UNIQUE'
                },
                {
                    name: 'song_universal_id',
                    query: 'CREATE CONSTRAINT song_universal_id IF NOT EXISTS FOR (s:Song) REQUIRE s.id IS UNIQUE'
                },
                {
                    name: 'track_universal_id',
                    query: 'CREATE CONSTRAINT track_universal_id IF NOT EXISTS FOR (t:Track) REQUIRE t.id IS UNIQUE'
                },
                {
                    name: 'release_universal_id',
                    query: 'CREATE CONSTRAINT release_universal_id IF NOT EXISTS FOR (r:Release) REQUIRE r.id IS UNIQUE'
                },
                {
                    name: 'master_universal_id',
                    query: 'CREATE CONSTRAINT master_universal_id IF NOT EXISTS FOR (m:Master) REQUIRE m.id IS UNIQUE'
                },
                {
                    name: 'label_universal_id',
                    query: 'CREATE CONSTRAINT label_universal_id IF NOT EXISTS FOR (l:Label) REQUIRE l.id IS UNIQUE'
                },
                {
                    name: 'account_universal_id',
                    query: 'CREATE CONSTRAINT account_universal_id IF NOT EXISTS FOR (a:Account) REQUIRE a.id IS UNIQUE'
                },
                {
                    name: 'city_universal_id',
                    query: 'CREATE CONSTRAINT city_universal_id IF NOT EXISTS FOR (c:City) REQUIRE c.id IS UNIQUE'
                }
            ];

            // Create all constraints
            for (const constraint of constraints) {
                try {
                    await session.run(constraint.query);
                    console.log(`   Created constraint: ${constraint.name}`);
                } catch (error) {
                    // Constraint might already exist - this is fine
                    if (!error.message.includes('already exists')) {
                        console.warn(`  � Warning creating constraint ${constraint.name}:`, error.message);
                    }
                }
            }

            // ========== INDEXES FOR PERFORMANCE ==========

            const indexes = [
                // Name searches (most common query pattern)
                { name: 'person_name', query: 'CREATE INDEX person_name IF NOT EXISTS FOR (p:Person) ON (p.name)' },
                { name: 'group_name', query: 'CREATE INDEX group_name IF NOT EXISTS FOR (g:Group) ON (g.name)' },
                { name: 'release_name', query: 'CREATE INDEX release_name IF NOT EXISTS FOR (r:Release) ON (r.name)' },
                { name: 'track_title', query: 'CREATE INDEX track_title IF NOT EXISTS FOR (t:Track) ON (t.title)' },
                { name: 'song_title', query: 'CREATE INDEX song_title IF NOT EXISTS FOR (s:Song) ON (s.title)' },

                // Date-based queries
                { name: 'release_date', query: 'CREATE INDEX release_date IF NOT EXISTS FOR (r:Release) ON (r.release_date)' },
                { name: 'group_formed', query: 'CREATE INDEX group_formed IF NOT EXISTS FOR (g:Group) ON (g.formed_date)' },

                // Geographic queries
                { name: 'city_location', query: 'CREATE INDEX city_location IF NOT EXISTS FOR (c:City) ON (c.lat, c.lon)' },

                // Status filtering (provisional vs canonical entities)
                { name: 'person_status', query: 'CREATE INDEX person_status IF NOT EXISTS FOR (p:Person) ON (p.status)' },
                { name: 'group_status', query: 'CREATE INDEX group_status IF NOT EXISTS FOR (g:Group) ON (g.status)' },

                // Event hash lookups
                { name: 'claim_event', query: 'CREATE INDEX claim_event IF NOT EXISTS FOR (c:Claim) ON (c.event_hash)' },

                // IdentityMap lookups (for external ID resolution)
                { name: 'identity_map_source', query: 'CREATE INDEX identity_map_source IF NOT EXISTS FOR (im:IdentityMap) ON (im.source)' },
                { name: 'identity_map_external_id', query: 'CREATE INDEX identity_map_external_id IF NOT EXISTS FOR (im:IdentityMap) ON (im.external_id)' },
                { name: 'identity_map_canonical', query: 'CREATE INDEX identity_map_canonical IF NOT EXISTS FOR (im:IdentityMap) ON (im.canonical_id)' },

                // Label and Person city/parent indexes
                { name: 'label_parent_name', query: 'CREATE INDEX label_parent_name IF NOT EXISTS FOR (l:Label) ON (l.parent_label_name)' },
                { name: 'label_origin_city', query: 'CREATE INDEX label_origin_city IF NOT EXISTS FOR (l:Label) ON (l.origin_city_name)' },
                { name: 'person_origin_city', query: 'CREATE INDEX person_origin_city IF NOT EXISTS FOR (p:Person) ON (p.origin_city_name)' },

                // Relationship property indexes for role searchability (Neo4j 5.x+)
                { name: 'performed_on_role', query: 'CREATE INDEX performed_on_role IF NOT EXISTS FOR ()-[r:PERFORMED_ON]-() ON (r.role)' },
                { name: 'performed_on_roles', query: 'CREATE INDEX performed_on_roles IF NOT EXISTS FOR ()-[r:PERFORMED_ON]-() ON (r.roles)' },
                { name: 'performed_on_derived', query: 'CREATE INDEX performed_on_derived IF NOT EXISTS FOR ()-[r:PERFORMED_ON]-() ON (r.derived)' },
                { name: 'performed_on_via_group', query: 'CREATE INDEX performed_on_via_group IF NOT EXISTS FOR ()-[r:PERFORMED_ON]-() ON (r.via_group_id)' },
                { name: 'member_of_role', query: 'CREATE INDEX member_of_role IF NOT EXISTS FOR ()-[r:MEMBER_OF]-() ON (r.role)' },
                { name: 'member_of_roles', query: 'CREATE INDEX member_of_roles IF NOT EXISTS FOR ()-[r:MEMBER_OF]-() ON (r.roles)' },
                { name: 'wrote_role', query: 'CREATE INDEX wrote_role IF NOT EXISTS FOR ()-[r:WROTE]-() ON (r.role)' },
                { name: 'wrote_roles', query: 'CREATE INDEX wrote_roles IF NOT EXISTS FOR ()-[r:WROTE]-() ON (r.roles)' },
                { name: 'wrote_role_detail', query: 'CREATE INDEX wrote_role_detail IF NOT EXISTS FOR ()-[r:WROTE]-() ON (r.role_detail)' },
                { name: 'guest_on_roles', query: 'CREATE INDEX guest_on_roles IF NOT EXISTS FOR ()-[r:GUEST_ON]-() ON (r.roles)' },
                { name: 'guest_on_scope', query: 'CREATE INDEX guest_on_scope IF NOT EXISTS FOR ()-[r:GUEST_ON]-() ON (r.scope)' }
            ];

            // Create all indexes
            for (const index of indexes) {
                try {
                    await session.run(index.query);
                    console.log(`   Created index: ${index.name}`);
                } catch (error) {
                    if (!error.message.includes('already exists')) {
                        console.warn(`  � Warning creating index ${index.name}:`, error.message);
                    }
                }
            }

            // ========== CHECK APOC AVAILABILITY ==========
            // APOC plugin is required for merge operations
            try {
                const apocResult = await session.run(
                    `CALL dbms.procedures() YIELD name
                     WHERE name STARTS WITH 'apoc.'
                     RETURN count(name) as apocCount`
                );

                const apocCount = apocResult.records[0]?.get('apocCount').toNumber() || 0;

                if (apocCount === 0) {
                    console.warn('WARNING: APOC plugin not detected!');
                    console.warn('  Merge operations require APOC plugin.');
                    console.warn('  Install with: neo4j-admin dbms install-plugin apoc');
                    console.warn('  Or download from: https://github.com/neo4j-contrib/neo4j-apoc-procedures/releases');
                    console.warn('  Continuing without APOC - merge operations will fail if attempted.');
                } else {
                    console.log(`  APOC plugin detected (${apocCount} procedures available)`);
                }
            } catch (error) {
                console.warn(' Could not check APOC availability:', error.message);
                console.warn('  Merge operations may fail if APOC is not installed.');
            }

            console.log(' Database schema initialized successfully');

        } catch (error) {
            console.error(' Failed to initialize database schema:', error);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Process a CREATE_RELEASE_BUNDLE event.
     * This is the main entry point for new music data submission.
     * Creates all entities and relationships in a single atomic transaction.
     *
     * The operation is idempotent - replaying the same event hash will not duplicate data.
     *
     * @param {string} eventHash - SHA256 hash of the canonical event
     * @param {Object} bundle - The release bundle data
     * @param {Object} bundle.release - Release information
     * @param {Array} bundle.groups - Groups performing on this release
     * @param {Array} bundle.tracks - Track listing with performers
     * @param {Array} [bundle.songs] - Song compositions (optional, can be inferred from tracks)
     * @param {Array} bundle.tracklist - Track ordering information
     * @param {Array} [bundle.sources] - External source references
     * @param {string} submitterAccount - Blockchain account that submitted this event
     * @param {number} [eventTimestamp] - Event timestamp (Unix seconds or millis). Falls back to Date.now() for older events without timestamps.
     * @returns {Promise<Object>} Result with releaseId and statistics
     * @throws {Error} If transaction fails (will rollback all changes)
     */
    async processReleaseBundle(eventHash, bundle, submitterAccount, eventTimestamp) {
        const session = this.driver.session();
        const tx = session.beginTransaction();

        try {
            // Compute deterministic event timestamp for replay consistency.
            // eventTimestamp may be Unix seconds (from contract ts) or millis;
            // normalize to milliseconds. Falls back to wall-clock time for
            // older events that lack a timestamp.
            let eventTs;
            if (eventTimestamp != null) {
                const raw = typeof eventTimestamp === 'number' ? eventTimestamp : Number(eventTimestamp);
                // Distinguish seconds (< 1e12) from millis (>= 1e12)
                eventTs = raw < 1e12 ? raw * 1000 : raw;
            } else {
                eventTs = Date.now();
            }

            // Validate required fields
            if (!eventHash || !bundle || !bundle.release) {
                throw new Error('Invalid release bundle: missing required fields');
            }

            // Step 1: Normalize bundle to canonical schema format
            // Handles legacy field names (release_name → name, releaseDate → release_date, etc.)
            console.log(`Normalizing release bundle from event ${eventHash.substring(0, 8)}...`);
            const normalizedBundle = normalizeReleaseBundle(bundle);

            // Step 2: Validate normalized bundle against canonical schema
            // This ensures data integrity and prevents partial writes
            console.log(`Validating canonical bundle from event ${eventHash.substring(0, 8)}...`);
            validateReleaseBundleOrThrow(normalizedBundle);

            console.log(`Processing release bundle from event ${eventHash.substring(0, 8)}...`);

            // Generate deterministic operation IDs for each sub-operation
            // This ensures idempotency - replaying the same event is safe
            let opIndex = 0;
            const opId = () => {
                const id = createHash('sha256')
                    .update(eventHash + opIndex.toString())
                    .digest('hex');
                opIndex++;
                return id;
            };

            // ========== 1. CREATE/UPDATE GROUPS ==========
            // Groups must be created before we can link members and performances

            const processedGroups = [];
            // Maps to store release-level lineup for propagating Person -> Track PERFORMED_ON
            const groupMembersById = new Map();    // resolved groupId -> members[]
            const groupMembersByName = new Map();  // lower(group.name) -> members[]

            for (const group of normalizedBundle.groups || []) {
                const groupOpId = opId();
                const groupId = await this.resolveEntityId(tx, 'group', group);

                const idKind = IdentityService.parseId(groupId).kind;
                console.log(`  Creating/updating group: ${group.name} (${groupId.substring(0, 12)}...) [${idKind}]`);

                await tx.run(`
                    MERGE (g:Group {group_id: $groupId})
                    SET g.id = $groupId,
                        g.name = $name,
                        g.alt_names = $altNames,
                        g.bio = $bio,
                        g.formed_date = $formed,
                        g.disbanded_date = $disbanded,
                        g.status = $status,
                        g.id_kind = $id_kind,
                        g.updated_by = $eventHash,
                        g.updated_at = datetime({epochMillis: $eventTs})

                    // Link to submitter Account
                    WITH g
                    MERGE (a:Account {account_id: $account})
                    ON CREATE SET a.id = $account
                    ON CREATE SET a.created_at = datetime({epochMillis: $eventTs})
                    MERGE (a)-[sub:SUBMITTED {event_hash: $eventHash}]->(g)
                    ON CREATE SET sub.timestamp = datetime({epochMillis: $eventTs})

                    RETURN g.group_id as groupId
                `, {
                    eventTs,
                    groupId,
                    name: group.name,
                    altNames: group.alt_names || [],
                    bio: group.bio || null,
                    formed: group.formed_date || null,
                    disbanded: group.disbanded_date || null,
                    status: idKind === 'canonical' ? 'ACTIVE' : 'PROVISIONAL',
                    id_kind: idKind,
                    eventHash,
                    account: submitterAccount
                });

                // Link to origin City if provided
                if (group.origin_city) {
                    const cityId = await this.resolveEntityId(tx, 'city', group.origin_city);

                    await tx.run(`
                        MATCH (g:Group {group_id: $groupId})
                        MERGE (c:City {city_id: $cityId})
                        ON CREATE SET c.id = $cityId,
                                     c.name = $cityName,
                                     c.lat = $cityLat,
                                     c.lon = $cityLon
                        MERGE (g)-[:ORIGIN]->(c)
                    `, {
                        groupId,
                        cityId,
                        cityName: group.origin_city.name,
                        cityLat: group.origin_city.lat,
                        cityLon: group.origin_city.lon
                    });
                }

                // Process Group members with their roles and periods
                for (const member of group.members || []) {
                    const personId = await this.resolveEntityId(tx, 'person', member);
                    const personIdKind = IdentityService.parseId(personId).kind;

                    console.log(`    Adding member: ${member.name} [${personIdKind}]`);

                    // Normalize roles from member (handles comma-separated strings)
                    const memberRoles = normalizeRoleInput(member.roles || member.role || []);
                    const primaryRole = memberRoles[0] || 'member';

                    await tx.run(`
                        MERGE (p:Person {person_id: $personId})
                        ON CREATE SET p.id = $personId,
                            p.name = $name,
                                     p.status = $status,
                                     p.created_at = datetime({epochMillis: $eventTs})
                        SET p.origin_city_name = coalesce($originCityName, p.origin_city_name)

                        WITH p
                        MATCH (g:Group {group_id: $groupId})

                        // MEMBER_OF relationship with full details
                        MERGE (p)-[m:MEMBER_OF {claim_id: $claimId}]->(g)
                        SET m.role = $role,
                            m.roles = $roles,
                            m.from_date = $from,
                            m.to_date = $to,
                            m.instruments = $instruments

                        RETURN p.person_id as personId
                    `, {
                        eventTs,
                        personId,
                        name: member.name,
                        status: personIdKind === 'canonical' ? 'ACTIVE' : 'PROVISIONAL',
                        originCityName: member.origin_city?.name || null,
                        groupId,
                        role: primaryRole,
                        roles: memberRoles,
                        from: member.from_date || null,
                        to: member.to_date || null,
                        instruments: member.instruments || [],
                        claimId: groupOpId
                    });

                    // Link person to origin city if provided
                    if (member.origin_city) {
                        const memberCityId = await this.resolveEntityId(tx, 'city', member.origin_city);

                        await tx.run(`
                            MATCH (p:Person {person_id: $personId})
                            MERGE (c:City {city_id: $cityId})
                            ON CREATE SET c.id = $cityId,
                                     c.name = $cityName,
                                         c.lat = $cityLat,
                                         c.lon = $cityLon
                            MERGE (p)-[:ORIGIN]->(c)
                        `, {
                            personId,
                            cityId: memberCityId,
                            cityName: member.origin_city.name,
                            cityLat: member.origin_city.lat,
                            cityLon: member.origin_city.lon
                        });
                    }
                }

                // Create audit claim for group creation
                await this.createClaim(tx, groupOpId, 'Group', groupId,
                                     'created', group, eventHash, eventTs);

                // Store release-level lineup for propagating Person -> Track PERFORMED_ON later
                groupMembersById.set(groupId, group.members || []);
                if (group.name) {
                    groupMembersByName.set(group.name.toLowerCase(), group.members || []);
                }

                processedGroups.push(groupId);
            }

            // ========== 2. CREATE RELEASE ==========

            const releaseOpId = opId();
            const releaseId = await this.resolveEntityId(tx, 'release', normalizedBundle.release);

            console.log(`  Creating release: ${normalizedBundle.release.name} (${releaseId.substring(0, 12)}...)`);

            await tx.run(`
                MERGE (r:Release {release_id: $releaseId})
                SET r.id = $releaseId,
                    r.name = $name,
                    r.alt_names = $altNames,
                    r.release_date = $date,
                    r.format = $format,
                    r.country = $country,
                    r.catalog_number = $catalogNumber,
                    r.liner_notes = $linerNotes,
                    r.trivia = $trivia,
                    r.album_art = $albumArt,
                    r.status = $status,
                    r.id_kind = $id_kind,
                    r.updated_by = $eventHash,
                    r.updated_at = datetime({epochMillis: $eventTs})

                // Link to submitter
                WITH r
                MERGE (a:Account {account_id: $account})
                    ON CREATE SET a.id = $account
                MERGE (a)-[sub:SUBMITTED {event_hash: $eventHash}]->(r)
                ON CREATE SET sub.timestamp = datetime({epochMillis: $eventTs})

                RETURN r.release_id as releaseId
            `, {
                eventTs,
                releaseId,
                name: normalizedBundle.release.name,
                altNames: normalizedBundle.release.alt_names || [],
                date: normalizedBundle.release.release_date || null,
                format: normalizedBundle.release.format || [],
                country: normalizedBundle.release.country || null,
                catalogNumber: normalizedBundle.release.catalog_number || null,
                linerNotes: normalizedBundle.release.liner_notes || null,
                trivia: normalizedBundle.release.trivia || null,
                albumArt: normalizedBundle.release.album_art || null,
                status: normalizedBundle.release.release_id ? 'ACTIVE' : 'PROVISIONAL',
                id_kind: normalizedBundle.release.release_id ? 'canonical' : 'provisional',
                eventHash,
                account: submitterAccount
            });

            // Process release-level guests (engineers, producers, etc.)
            for (const guest of normalizedBundle.release.guests || []) {
                const personId = await this.resolveEntityId(tx, 'person', guest);

                await tx.run(`
                    MERGE (p:Person {person_id: $personId})
                    ON CREATE SET p.id = $personId,
                            p.name = $name,
                                 p.status = $status
                    SET p.origin_city_name = coalesce($originCityName, p.origin_city_name)

                    WITH p
                    MATCH (r:Release {release_id: $releaseId})
                    MERGE (p)-[g:GUEST_ON {claim_id: $claimId}]->(r)
                    SET g.roles = $roles,
                        g.role = $role,
                        g.role_detail = $roleDetail,
                        g.credited_as = $creditedAs,
                        g.scope = 'release'
                `, {
                    personId,
                    name: guest.name,
                    status: guest.person_id ? 'ACTIVE' : 'PROVISIONAL',
                    originCityName: guest.origin_city?.name || null,
                    releaseId,
                    roles: normalizeRoles(guest.roles || []),
                    role: normalizeRole(guest.roles?.[0] || guest.role),
                    roleDetail: guest.role_detail || null,
                    creditedAs: guest.credited_as || null,
                    claimId: releaseOpId
                });
            }

            // Create audit claim for release
            await this.createClaim(tx, releaseOpId, 'Release', releaseId,
                                 'created', normalizedBundle.release, eventHash, eventTs);

            // ========== 3. PROCESS SONGS (Compositions) ==========

            const processedSongs = new Map(); // songId -> song data

            for (const song of normalizedBundle.songs || []) {
                const songOpId = opId();
                const songId = await this.resolveEntityId(tx, 'song', song);

                console.log(`  Creating song: ${song.title} (${songId.substring(0, 12)}...)`);

                await tx.run(`
                    MERGE (s:Song {song_id: $songId})
                    SET s.id = $songId,
                        s.title = $title,
                        s.alt_titles = $altTitles,
                        s.iswc = $iswc,
                        s.year = $year,
                        s.lyrics = $lyrics,
                        s.status = $status,
                        s.id_kind = $id_kind,
                        s.updated_at = datetime({epochMillis: $eventTs})
                `, {
                    eventTs,
                    songId,
                    title: song.title,
                    altTitles: song.alt_titles || [],
                    iswc: song.iswc || null,
                    year: song.year || null,
                    lyrics: song.lyrics || null,
                    status: song.song_id ? 'ACTIVE' : 'PROVISIONAL',
                    id_kind: song.song_id ? 'canonical' : 'provisional'
                });

                // Link songwriters (Persons who WROTE this Song)
                for (const writer of song.writers || []) {
                    const writerId = await this.resolveEntityId(tx, 'person', writer);

                    // Normalize writing roles (handles comma-separated, synonyms)
                    const writerRoles = normalizeRoleInput(writer.roles || writer.role || []);
                    const primaryRole = writerRoles[0] || 'songwriter';

                    await tx.run(`
                        MERGE (p:Person {person_id: $personId})
                        ON CREATE SET p.id = $personId,
                            p.name = $name,
                                     p.status = $status
                        WITH p
                        MATCH (s:Song {song_id: $songId})
                        MERGE (p)-[w:WROTE {claim_id: $claimId}]->(s)
                        SET w.role = $role,
                            w.roles = $roles,
                            w.role_detail = $roleDetail,
                            w.credited_as = $creditedAs,
                            w.share_percentage = $share
                    `, {
                        personId: writerId,
                        name: writer.name,
                        status: writer.person_id ? 'ACTIVE' : 'PROVISIONAL',
                        songId,
                        role: primaryRole,
                        roles: writerRoles,
                        roleDetail: writer.role_detail || null,
                        creditedAs: writer.credited_as || null,
                        share: writer.share_percentage || null,
                        claimId: songOpId
                    });
                }

                await this.createClaim(tx, songOpId, 'Song', songId,
                                     'created', song, eventHash, eventTs);

                processedSongs.set(songId, song);
            }

            // ========== 4. PROCESS TRACKS (Recordings) ==========

            const processedTracks = [];

            for (const track of normalizedBundle.tracks || []) {
                const trackOpId = opId();
                const trackId = await this.resolveEntityId(tx, 'track', track);

                console.log(`  Creating track: ${track.title} (${trackId.substring(0, 12)}...)`);

                await tx.run(`
                    MERGE (t:Track {track_id: $trackId})
                    SET t.id = $trackId,
                        t.title = $title,
                        t.isrc = $isrc,
                        t.duration = $duration,
                        t.recording_date = $recordingDate,
                        t.recording_location = $location,
                        t.listen_links = $listenLinks,
                        t.status = $status,
                        t.id_kind = $id_kind,
                        t.updated_at = datetime({epochMillis: $eventTs})
                `, {
                    eventTs,
                    trackId,
                    title: track.title,
                    isrc: track.isrc || null,
                    duration: track.duration || null,
                    recordingDate: track.recording_date || null,
                    location: track.recording_location || null,
                    listenLinks: track.listen_links || [],
                    status: track.track_id ? 'ACTIVE' : 'PROVISIONAL',
                    id_kind: track.track_id ? 'canonical' : 'provisional'
                });

                // ========== CRITICAL: DISTINGUISH GROUPS vs GUESTS ==========

                // Link performing GROUPS (the main bands/orchestras)
                // 3-way fallback: performed_by_groups > groups (legacy) > performed_by (string)
                let performingGroups = [];

                if (Array.isArray(track.performed_by_groups) && track.performed_by_groups.length > 0) {
                    performingGroups = track.performed_by_groups;
                } else if (Array.isArray(track.groups) && track.groups.length > 0) {
                    // Legacy support: frontend/templates may use track.groups
                    performingGroups = track.groups
                        .map(g => ({
                            group_id: g.group_id || g.id || (typeof g === 'string' ? g : undefined),
                            name: g.name || g.group_name || (typeof g === 'string' ? g : undefined),
                        }))
                        .filter(g => g.group_id || g.name);
                } else if (typeof track.performed_by === 'string' && track.performed_by.trim()) {
                    performingGroups = [{ name: track.performed_by.trim() }];
                }

                // Single-artist album fallback: if no per-track performer attribution but bundle has group(s),
                // assume all tracks are performed by the bundle's group(s)
                if (performingGroups.length === 0 && Array.isArray(normalizedBundle.groups) && normalizedBundle.groups.length > 0) {
                    console.log(`    Track "${track.title}" has no performer attribution; using bundle groups as fallback`);
                    performingGroups = normalizedBundle.groups.map(g => ({
                        group_id: g.group_id || g.id,
                        name: g.name,
                        role: 'performer',
                    }));
                }

                for (const performingGroup of performingGroups) {
                    const groupName =
                        performingGroup.name ||
                        performingGroup.group_name ||
                        'Unknown Group';

                    let groupId = null;

                    try {
                        // If group_id exists, resolve it (handles canonical/prov/external via IdentityMap)
                        // If group_id does NOT exist, resolve from name -> deterministic provisional ID
                        groupId = await this.resolveEntityId(tx, 'group', {
                            ...(performingGroup.group_id ? { group_id: performingGroup.group_id } : {}),
                            ...(groupName ? { name: groupName } : {})
                        });
                    } catch (e) {
                        console.warn(`    Warning: Could not resolve performing group for track "${track.title}": ${e.message}`);
                        continue;
                    }

                    if (!groupId) {
                        console.warn(`    Warning: Track "${track.title}" has performing group with no resolvable id/name`, {
                            performingGroup,
                            trackId
                        });
                        continue;
                    }

                    try {
                        await tx.run(`
                            // Ensure group exists even if it wasn't included in bundle.groups
                            MERGE (g:Group {group_id: $groupId})
                            ON CREATE SET
                                g.id = $groupId,
                                g.name = $groupName,
                                g.status = 'PROVISIONAL',
                                g.id_kind = 'provisional',
                                g.created_at = datetime({epochMillis: $eventTs})
                            ON MATCH SET
                                g.name = coalesce(g.name, $groupName)

                            WITH g
                            MATCH (t:Track {track_id: $trackId})
                            MERGE (g)-[p:PERFORMED_ON {claim_id: $claimId}]->(t)
                            SET p.credited_as = $creditedAs,
                                p.role = $role
                        `, {
                            eventTs,
                            trackId,
                            groupId,
                            groupName,
                            creditedAs: performingGroup.credited_as || null,
                            role: normalizeRole(performingGroup.role),
                            claimId: trackOpId
                        });
                        console.log(`    Created PERFORMED_ON: ${groupName} -> ${track.title}`);

                        // ========== PROPAGATE Person -> Track PERFORMED_ON for group members ==========
                        // Option B Semantics:
                        // - Derived edges: derived=true, from release-level group membership
                        // - Explicit edges: derived=false, from track-level member overrides
                        // - When members_are_complete=true: only explicit members, no derivation

                        // Build set of guest person_ids/names to avoid duplicating guests as performers
                        const guestNames = new Set(
                            (track.guests || []).map(g => (g.name || '').toLowerCase().trim())
                        );
                        const guestIds = new Set(
                            (track.guests || []).filter(g => g.person_id).map(g => g.person_id)
                        );

                        // Check for explicit per-track member overrides
                        const explicitMembers = Array.isArray(performingGroup.members) ? performingGroup.members : [];
                        const membersAreComplete = performingGroup.members_are_complete === true;

                        // Step 1: Create explicit (non-derived) edges for per-track member overrides
                        if (explicitMembers.length > 0) {
                            const explicitPayload = [];
                            const explicitIds = new Set();

                            for (const member of explicitMembers) {
                                // Skip guests
                                if (guestNames.has((member.name || '').toLowerCase().trim())) continue;

                                try {
                                    const memberId = await this.resolveEntityId(tx, 'person', member);
                                    explicitIds.add(memberId);

                                    // Normalize roles from member (handles comma-separated strings)
                                    const roles = normalizeRoleInput(member.roles || member.role || []);

                                    explicitPayload.push({
                                        personId: memberId,
                                        name: member.name,
                                        roles: roles,
                                        role: roles[0] || null,  // backward compat
                                        instruments: member.instruments || []
                                    });
                                } catch (memberResolveError) {
                                    console.warn(`    Warning: Could not resolve explicit member "${member.name}": ${memberResolveError.message}`);
                                }
                            }

                            if (explicitPayload.length > 0) {
                                await tx.run(`
                                    UNWIND $members AS m
                                    MERGE (p:Person {person_id: m.personId})
                                    ON CREATE SET
                                        p.id = m.personId,
                                        p.name = m.name,
                                        p.status = 'PROVISIONAL',
                                        p.created_at = datetime({epochMillis: $eventTs})
                                    WITH p, m
                                    MATCH (t:Track {track_id: $trackId})
                                    MERGE (p)-[perf:PERFORMED_ON {claim_id: $claimId, via_group_id: $groupId}]->(t)
                                    SET perf.derived = false,
                                        perf.roles = m.roles,
                                        perf.role = m.role,
                                        perf.instruments = m.instruments,
                                        perf.lineup_source = 'track_explicit'
                                `, {
                                    eventTs,
                                    members: explicitPayload,
                                    trackId,
                                    claimId: trackOpId,
                                    groupId
                                });
                                console.log(`      Created ${explicitPayload.length} explicit PERFORMED_ON edges (derived=false)`);
                            }

                            // If members_are_complete, skip derived propagation for this group
                            if (membersAreComplete) {
                                console.log(`      Skipping derived propagation (members_are_complete=true)`);
                                continue; // Skip to next performingGroup
                            }
                        }

                        // Step 2: Create derived edges for release-level default lineup
                        // (only if not members_are_complete)
                        let derivedMembers = [];
                        let lineupSource = 'none';

                        if (groupMembersById.has(groupId) && groupMembersById.get(groupId).length > 0) {
                            derivedMembers = groupMembersById.get(groupId);
                            lineupSource = 'release_default';
                        } else if (groupMembersByName.has(groupName.toLowerCase()) && groupMembersByName.get(groupName.toLowerCase()).length > 0) {
                            derivedMembers = groupMembersByName.get(groupName.toLowerCase());
                            lineupSource = 'release_default_by_name';
                        }

                        if (derivedMembers.length > 0) {
                            // Build set of explicit member IDs to skip (avoid duplicates)
                            const explicitMemberIds = new Set();
                            for (const m of explicitMembers) {
                                if (m.person_id) explicitMemberIds.add(m.person_id);
                            }

                            const derivedPayload = [];
                            for (const member of derivedMembers) {
                                // Skip guests
                                if (guestNames.has((member.name || '').toLowerCase().trim())) continue;
                                if (member.person_id && guestIds.has(member.person_id)) continue;

                                // Skip if already covered by explicit override
                                if (member.person_id && explicitMemberIds.has(member.person_id)) continue;

                                try {
                                    const memberId = await this.resolveEntityId(tx, 'person', member);

                                    // Double-check resolved ID isn't already explicit
                                    if (explicitMemberIds.has(memberId)) continue;

                                    // Normalize roles from member (handles comma-separated strings)
                                    const roles = normalizeRoleInput(member.roles || member.role || []);

                                    derivedPayload.push({
                                        personId: memberId,
                                        name: member.name,
                                        roles: roles,
                                        role: roles[0] || null,  // backward compat
                                        instruments: member.instruments || []
                                    });
                                } catch (memberResolveError) {
                                    console.warn(`    Warning: Could not resolve member "${member.name}" for derived PERFORMED_ON: ${memberResolveError.message}`);
                                }
                            }

                            if (derivedPayload.length > 0) {
                                await tx.run(`
                                    UNWIND $members AS m
                                    MERGE (p:Person {person_id: m.personId})
                                    ON CREATE SET
                                        p.id = m.personId,
                                        p.name = m.name,
                                        p.status = 'PROVISIONAL',
                                        p.created_at = datetime({epochMillis: $eventTs})
                                    WITH p, m
                                    MATCH (t:Track {track_id: $trackId})
                                    MERGE (p)-[perf:PERFORMED_ON {claim_id: $claimId, via_group_id: $groupId}]->(t)
                                    SET perf.derived = true,
                                        perf.roles = m.roles,
                                        perf.role = m.role,
                                        perf.instruments = m.instruments,
                                        perf.lineup_source = $lineupSource
                                `, {
                                    eventTs,
                                    members: derivedPayload,
                                    trackId,
                                    claimId: trackOpId,
                                    groupId,
                                    lineupSource
                                });
                                console.log(`      Propagated PERFORMED_ON to ${derivedPayload.length} members (derived=true, ${lineupSource})`);
                            }
                        }
                    } catch (performedOnError) {
                        console.error(`    PERFORMED_ON FAILED:`, {
                            groupId,
                            groupName,
                            trackId,
                            trackTitle: track.title,
                            error: performedOnError.message
                        });
                        // Re-throw to fail the transaction rather than silently continue
                        throw performedOnError;
                    }
                }

                // Link GUEST performers (individuals not in the main group)
                for (const guest of track.guests || []) {
                    const guestId = await this.resolveEntityId(tx, 'person', guest);

                    await tx.run(`
                        MERGE (p:Person {person_id: $personId})
                        ON CREATE SET p.id = $personId,
                            p.name = $name,
                                     p.status = $status
                        SET p.origin_city_name = coalesce($originCityName, p.origin_city_name)

                        WITH p
                        MATCH (t:Track {track_id: $trackId})

                        // GUEST_ON relationship for non-members
                        MERGE (p)-[g:GUEST_ON {claim_id: $claimId}]->(t)
                        SET g.roles = $roles,
                            g.role = $role,
                            g.role_detail = $roleDetail,
                            g.instruments = $instruments,
                            g.credited_as = $creditedAs,
                            g.scope = 'track'
                    `, {
                        personId: guestId,
                        name: guest.name,
                        status: guest.person_id ? 'ACTIVE' : 'PROVISIONAL',
                        originCityName: guest.origin_city?.name || null,
                        trackId,
                        roles: normalizeRoles(guest.roles || []),
                        role: normalizeRole(guest.roles?.[0] || guest.role),
                        roleDetail: guest.role_detail || null,
                        instruments: guest.instruments || [],
                        creditedAs: guest.credited_as || null,
                        claimId: trackOpId
                    });
                }

                // Link producers
                for (const producer of track.producers || []) {
                    const producerId = await this.resolveEntityId(tx, 'person', producer);

                    await tx.run(`
                        MERGE (p:Person {person_id: $personId})
                        ON CREATE SET p.id = $personId,
                            p.name = $name,
                                     p.status = $status
                        WITH p
                        MATCH (t:Track {track_id: $trackId})
                        MERGE (p)-[pr:PRODUCED {claim_id: $claimId}]->(t)
                        SET pr.role = $role
                    `, {
                        personId: producerId,
                        name: producer.name,
                        status: producer.person_id ? 'ACTIVE' : 'PROVISIONAL',
                        trackId,
                        role: producer.role || 'producer',
                        claimId: trackOpId
                    });
                }

                // Link arrangers
                for (const arranger of track.arrangers || []) {
                    const arrangerId = await this.resolveEntityId(tx, 'person', arranger);

                    await tx.run(`
                        MERGE (p:Person {person_id: $personId})
                        ON CREATE SET p.id = $personId,
                            p.name = $name,
                                     p.status = $status
                        WITH p
                        MATCH (t:Track {track_id: $trackId})
                        MERGE (p)-[a:ARRANGED {claim_id: $claimId}]->(t)
                        SET a.role = $role
                    `, {
                        personId: arrangerId,
                        name: arranger.name,
                        status: arranger.person_id ? 'ACTIVE' : 'PROVISIONAL',
                        trackId,
                        role: arranger.role || 'arranger',
                        claimId: trackOpId
                    });
                }

                // Link to Song if it's a recording of a composition
                // Uses track.recording_of (string) per canonical JSON schema
                if (track.recording_of) {
                    const ref = track.recording_of;

                    // Treat ref as either an ID-like string OR a title-like string.
                    // If it parses as a real ID, we use it directly.
                    // Otherwise we mint a provisional song ID from the title.
                    let songId = null;
                    let songTitle = null;

                    try {
                        const parsed = IdentityService.parseId(ref);
                        if ((parsed.kind === 'canonical' || parsed.kind === 'provisional') && parsed.valid) {
                            songId = ref;
                        } else if (parsed.kind === 'external' && parsed.valid) {
                            // Resolve external → canonical if known; else mint provisional using track title as a fallback title
                            songId = await this.resolveEntityId(tx, 'song', { song_id: ref, title: track.title });
                        } else {
                            songTitle = ref; // not a usable ID; treat as title
                        }
                    } catch {
                        songTitle = ref;
                    }

                    if (!songId) {
                        songId = await this.resolveEntityId(tx, 'song', { title: songTitle });
                    }

                    await tx.run(`
                        MERGE (s:Song {song_id: $songId})
                        ON CREATE SET
                            s.id = $songId,
                            s.title = $songTitle,
                            s.status = 'PROVISIONAL',
                            s.id_kind = 'provisional',
                            s.created_at = datetime({epochMillis: $eventTs})
                        ON MATCH SET
                            s.title = coalesce(s.title, $songTitle)

                        WITH s
                        MATCH (t:Track {track_id: $trackId})
                        MERGE (t)-[r:RECORDING_OF {claim_id: $claimId}]->(s)
                    `, {
                        eventTs,
                        trackId,
                        songId,
                        songTitle: songTitle || null,
                        claimId: trackOpId
                    });
                }

                // Link cover versions
                if (track.cover_of_song_id) {
                    await tx.run(`
                        MATCH (t:Track {track_id: $trackId})
                        MATCH (s:Song {song_id: $songId})
                        MERGE (t)-[c:COVER_OF {claim_id: $claimId}]->(s)
                    `, {
                        trackId,
                        songId: track.cover_of_song_id,
                        claimId: trackOpId
                    });
                }

                // Link samples (canonical: sampled_track_id, legacy fallback: track_id)
                for (const sample of track.samples || []) {
                    const sampleTrackId = sample.sampled_track_id ?? sample.track_id;
                    if (!sampleTrackId) continue; // skip invalid entries
                    const sampleTitle = sample.sampled_track_title ?? sample.title ?? 'Unknown';
                    const portion = sample.portion_used ?? null;
                    const cleared = sample.cleared ?? false;
                    const sourceUrl = sample.source?.url ?? null;
                    const sourceType = sample.source?.type ?? null;
                    const accessedAt = sample.source?.accessed_at ?? null;

                    await tx.run(`
                        MATCH (t1:Track {track_id: $trackId})
                        MERGE (t2:Track {track_id: $sampleId})
                        ON CREATE SET t2.id = $sampleId,
                                     t2.status = 'PROVISIONAL',
                                     t2.id_kind = 'provisional',
                                     t2.title = $sampleTitle
                        MERGE (t1)-[s:SAMPLES {claim_id: $claimId}]->(t2)
                        SET s.portion_used = $portion,
                            s.cleared = $cleared,
                            s.source_url = $sourceUrl,
                            s.source_type = $sourceType,
                            s.accessed_at = $accessedAt
                    `, {
                        trackId,
                        sampleId: sampleTrackId,
                        sampleTitle,
                        portion,
                        cleared,
                        sourceUrl,
                        sourceType,
                        accessedAt,
                        claimId: trackOpId
                    });
                }

                await this.createClaim(tx, trackOpId, 'Track', trackId,
                                     'created', track, eventHash, eventTs);

                processedTracks.push(trackId);
            }

            // ========== 5. CREATE TRACKLIST ==========
            // Link tracks to the release with order information

            console.log(`  Linking ${normalizedBundle.tracklist?.length || 0} tracks to release...`);

            const tracklist = Array.isArray(normalizedBundle.tracklist) ? normalizedBundle.tracklist : [];
            for (let idx = 0; idx < tracklist.length; idx++) {
                const item = tracklist[idx];

                if (!item.track_id) {
                    throw new Error(
                        `Tracklist item missing track_id after normalization (index=${idx}, position=${item.position}, title=${item.track_title})`
                    );
                }

                // Derive track placement from position string (e.g., "A1" → track 1, side "A")
                const derived = deriveTrackPlacement(item.position, idx);

                // Use explicit values if provided, otherwise use derived values
                const disc = toPositiveIntOrNull(item.disc_number) ?? derived.disc;
                const trackNo = toPositiveIntOrNull(item.track_number) ?? derived.trackNo;
                const side = (item.side ?? derived.side) ?? null;
                const isBonus = Boolean(item.is_bonus);

                await tx.run(`
                    MATCH (t:Track {track_id: $trackId})
                    MATCH (r:Release {release_id: $releaseId})
                    MERGE (t)-[i:IN_RELEASE]->(r)
                    SET i.position = $position,
                        i.disc_number = $disc,
                        i.track_number = $trackNo,
                        i.side = $side,
                        i.is_bonus = $isBonus
                `, {
                    trackId: item.track_id,
                    releaseId,
                    position: derived.position,
                    disc,
                    trackNo,
                    side,
                    isBonus
                });
            }

            // ========== 6. LINK MASTER AND LABELS ==========

            if (normalizedBundle.release.master_id) {
                await tx.run(`
                    MERGE (m:Master {master_id: $masterId})
                    ON CREATE SET m.id = $masterId,
                                 m.name = $masterName,
                                 m.created_at = datetime({epochMillis: $eventTs})
                    WITH m
                    MATCH (r:Release {release_id: $releaseId})
                    MERGE (r)-[:IN_MASTER]->(m)
                `, {
                    eventTs,
                    masterId: normalizedBundle.release.master_id,
                    masterName: normalizedBundle.release.master_name || normalizedBundle.release.name,
                    releaseId
                });
            }

            // Link labels
            for (const label of normalizedBundle.release.labels || []) {
                const labelId = await this.resolveEntityId(tx, 'label', label);

                await tx.run(`
                    MERGE (l:Label {label_id: $labelId})
                    ON CREATE SET l.id = $labelId,
                                 l.name = $labelName,
                                 l.status = $status,
                                 l.id_kind = $id_kind
                    SET l.alt_names = $altNames,
                        l.parent_label_name = $parentLabelName,
                        l.parent_label_id = $parentLabelId

                    WITH l
                    MATCH (r:Release {release_id: $releaseId})
                    MERGE (l)-[:RELEASED]->(r)
                `, {
                    labelId,
                    labelName: label.name,
                    status: label.label_id ? 'ACTIVE' : 'PROVISIONAL',
                    id_kind: label.label_id ? 'canonical' : 'provisional',
                    altNames: label.alt_names || [],
                    parentLabelName: label.parent_label?.name || null,
                    parentLabelId: label.parent_label?.label_id || null,
                    releaseId
                });

                // Link label to city if provided
                if (label.origin_city) {
                    await tx.run(`
                        MATCH (l:Label {label_id: $labelId})
                        MERGE (c:City {city_id: $cityId})
                        ON CREATE SET c.id = $cityId,
                                     c.name = $cityName,
                                     c.lat = $cityLat,
                                     c.lon = $cityLon
                        MERGE (l)-[:ORIGIN]->(c)
                    `, {
                        labelId,
                        cityId: label.origin_city.city_id ||
                               this.generateProvisionalId('city', label.origin_city),
                        cityName: label.origin_city.name,
                        cityLat: label.origin_city.lat,
                        cityLon: label.origin_city.lon
                    });
                }
            }

            // ========== 7. CREATE SOURCE REFERENCES ==========

            for (const source of bundle.sources || []) {
                const sourceId = await this.resolveEntityId(tx, 'source', source);

                await tx.run(`
                    MERGE (s:Source {source_id: $sourceId})
                    SET s.url = $url,
                        s.type = $type,
                        s.retrieved_at = $retrievedAt

                    WITH s
                    MATCH (r:Release {release_id: $releaseId})
                    MERGE (r)-[:SOURCED_FROM]->(s)
                `, {
                    sourceId,
                    url: source.url,
                    type: source.type || 'web',
                    retrievedAt: source.retrieved_at || new Date().toISOString(),
                    releaseId
                });
            }

            // Commit the entire transaction
            await tx.commit();

            const stats = {
                groups_created: processedGroups.length,
                songs_created: processedSongs.size,
                tracks_created: processedTracks.length
            };

            console.log(` Processed release bundle ${releaseId.substring(0, 12)}... successfully`);
            console.log(`  Groups: ${stats.groups_created}, Songs: ${stats.songs_created}, Tracks: ${stats.tracks_created}`);

            return {
                success: true,
                releaseId,
                stats
            };

        } catch (error) {
            // Rollback on any error
            await tx.rollback();
            console.error(' Failed to process release bundle:', error.message);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Process an ADD_CLAIM event to add new information to an existing entity.
     * Claims provide an audit trail for all data changes.
     *
     * @param {string} eventHash - Hash of the event
     * @param {Object} claimData - The claim details
     * @param {Object} claimData.node - Target node information
     * @param {string} claimData.node.type - Node type (Person, Group, etc.)
     * @param {string} claimData.node.id - Node ID
     * @param {string} claimData.field - Field being modified
     * @param {*} claimData.value - New value
     * @param {Object} [claimData.source] - Optional source reference
     * @param {string} author - Account making the claim
     * @returns {Promise<Object>} Result with claimId
     */
    async processAddClaim(eventHash, claimData, author) {
        const session = this.driver.session();
        const tx = session.beginTransaction();

        try {
            const claimId = this.generateOpId(eventHash, 0);
            const { node, field, value, source } = claimData;

            if (!node || !node.type || !node.id || !field) {
                throw new Error('Invalid claim data: missing required fields');
            }

            // Validate node.type against whitelist to prevent Cypher injection
            const key = String(node.type).toLowerCase();
            const mapping = SAFE_NODE_TYPES[key];
            if (!mapping) {
                throw new Error(`Invalid node.type: ${node.type}. Allowed types: ${Object.keys(SAFE_NODE_TYPES).join(', ')}`);
            }

            // Validate field name to prevent corruption of protected/system fields
            // Normalize field name (trim whitespace) for consistent checking
            const normalizedField = String(field).trim();
            if (PROTECTED_FIELDS.has(normalizedField)) {
                throw new Error(
                    `Invalid claim field: "${normalizedField}" is protected. ` +
                    `Protected fields cannot be modified via claims (IDs, audit fields, status, etc.).`
                );
            }

            // Validate field name is safe for Neo4j property syntax
            assertSafePropertyName(normalizedField);

            console.log(`Adding claim to ${mapping.label} ${node.id}: ${normalizedField}`);

            // Normalize value for Neo4j storage (handle objects/complex types)
            const normalizedValue = normalizeValueForNeo4j(value);

            // Update the target node using validated label and idField from whitelist
            // Note: We use backtick-escaped property name instead of $field parameter
            // because Neo4j 5.x doesn't support dynamic property assignment via n[$field]
            const updateRes = await tx.run(`
                MATCH (n:${mapping.label} {${mapping.idField}: $nodeId})
                SET n.\`${normalizedField}\` = $value,
                    n.last_updated = datetime(),
                    n.last_updated_by = $author
                RETURN n
            `, {
                nodeId: node.id,
                value: normalizedValue,
                author
            });

            if (updateRes.records.length === 0) {
                throw new Error(`Target node not found for ADD_CLAIM: ${mapping.label} ${mapping.idField}=${node.id}`);
            }

            // Create claim record (idempotent via MERGE)
            await this.createClaim(tx, claimId, node.type, node.id,
                                 normalizedField, value, eventHash);

            // Link claim to target node (using validated label and idField from whitelist)
            // This creates the CLAIMS_ABOUT relationship for audit trail
            await tx.run(`
                MATCH (c:Claim {claim_id: $claimId})
                MATCH (n:${mapping.label} {${mapping.idField}: $nodeId})
                MERGE (c)-[:CLAIMS_ABOUT]->(n)
            `, {
                claimId,
                nodeId: node.id
            });

            // Link source if provided
            if (source && source.url) {
                const sourceId = await this.resolveEntityId(tx, 'source', source);
                await tx.run(`
                    MERGE (s:Source {source_id: $sourceId})
                    SET s.url = $url,
                        s.type = $type

                    WITH s
                    MATCH (c:Claim {claim_id: $claimId})
                    MERGE (c)-[:SOURCED_FROM]->(s)
                `, {
                    sourceId,
                    url: source.url,
                    type: source.type || 'web',
                    claimId
                });
            }

            await tx.commit();
            console.log(` Added claim ${claimId.substring(0, 12)}...`);

            return { success: true, claimId };

        } catch (error) {
            await tx.rollback();
            console.error(' Failed to process claim:', error.message);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Process an EDIT_CLAIM event to modify an existing claim.
     * Implements immutable claim semantics: creates new claim that supersedes old one.
     *
     * @param {string} eventHash - Hash of the edit event
     * @param {Object} editData - The edit details
     * @param {string} editData.claim_id - ID of claim being edited (required)
     * @param {*} editData.value - New value for the claim
     * @param {Object} [editData.source] - Optional source reference
     * @param {string} author - Account making the edit
     * @returns {Promise<Object>} Result with newClaimId and oldClaimId
     */
    async processEditClaim(eventHash, editData, author) {
        const session = this.driver.session();
        const tx = session.beginTransaction();

        try {
            const { claim_id: oldClaimId, value, source } = editData;

            if (!oldClaimId) {
                throw new Error('Invalid edit data: missing claim_id');
            }

            if (value === undefined) {
                throw new Error('Invalid edit data: missing value');
            }

            console.log(`Editing claim ${oldClaimId.substring(0, 12)}...`);

            // Load the old claim to get node type, node ID, and field name
            const oldClaimResult = await tx.run(`
                MATCH (old:Claim {claim_id: $oldClaimId})
                RETURN old.node_type as nodeType,
                       old.node_id as nodeId,
                       old.field as field,
                       old.value as oldValue
            `, { oldClaimId });

            if (oldClaimResult.records.length === 0) {
                throw new Error(`Claim not found: ${oldClaimId}`);
            }

            const oldClaim = oldClaimResult.records[0];
            const nodeType = oldClaim.get('nodeType');
            const nodeId = oldClaim.get('nodeId');
            const field = oldClaim.get('field');

            // Validate node.type against whitelist to prevent Cypher injection
            const key = String(nodeType).toLowerCase();
            const mapping = SAFE_NODE_TYPES[key];
            if (!mapping) {
                throw new Error(`Invalid node.type from old claim: ${nodeType}. Allowed types: ${Object.keys(SAFE_NODE_TYPES).join(', ')}`);
            }

            // Validate field name to prevent corruption of protected/system fields
            const normalizedField = String(field).trim();
            if (PROTECTED_FIELDS.has(normalizedField)) {
                throw new Error(
                    `Invalid edit: field "${normalizedField}" is protected. ` +
                    `Protected fields cannot be edited via claims (IDs, audit fields, status, etc.).`
                );
            }

            // Validate field name is safe for Neo4j property syntax
            assertSafePropertyName(normalizedField);

            // Generate deterministic new claim ID from edit event hash
            const newClaimId = this.generateOpId(eventHash, 0);

            console.log(`Creating new claim ${newClaimId.substring(0, 12)}... superseding ${oldClaimId.substring(0, 12)}...`);

            // Create new claim (idempotent via MERGE)
            await this.createClaim(tx, newClaimId, nodeType, nodeId,
                                 normalizedField, value, eventHash);

            // Link new claim to target node
            await tx.run(`
                MATCH (newClaim:Claim {claim_id: $newClaimId})
                MATCH (n:${mapping.label} {${mapping.idField}: $nodeId})
                MERGE (newClaim)-[:CLAIMS_ABOUT]->(n)
            `, {
                newClaimId,
                nodeId
            });

            // Create SUPERSEDES relationship and mark old claim as superseded
            await tx.run(`
                MATCH (newClaim:Claim {claim_id: $newClaimId})
                MATCH (oldClaim:Claim {claim_id: $oldClaimId})
                MERGE (newClaim)-[:SUPERSEDES]->(oldClaim)
                SET oldClaim.superseded_by = $newClaimId,
                    oldClaim.superseded_at = datetime()
            `, {
                newClaimId,
                oldClaimId
            });

            // Normalize value for Neo4j storage (handle objects/complex types)
            const normalizedValue = normalizeValueForNeo4j(value);

            // Update the target node's current value
            // Note: We use backtick-escaped property name instead of $field parameter
            // because Neo4j 5.x doesn't support dynamic property assignment via n[$field]
            const updateRes = await tx.run(`
                MATCH (n:${mapping.label} {${mapping.idField}: $nodeId})
                SET n.\`${normalizedField}\` = $value,
                    n.last_updated = datetime(),
                    n.last_updated_by = $author
                RETURN n
            `, {
                nodeId,
                value: normalizedValue,
                author
            });

            if (updateRes.records.length === 0) {
                throw new Error(`Target node not found for EDIT_CLAIM: ${mapping.label} ${mapping.idField}=${nodeId}`);
            }

            // Link source if provided
            if (source && source.url) {
                const sourceId = await this.resolveEntityId(tx, 'source', source);
                await tx.run(`
                    MERGE (s:Source {source_id: $sourceId})
                    SET s.url = $url,
                        s.type = $type

                    WITH s
                    MATCH (c:Claim {claim_id: $newClaimId})
                    MERGE (c)-[:SOURCED_FROM]->(s)
                `, {
                    sourceId,
                    url: source.url,
                    type: source.type || 'web',
                    newClaimId
                });
            }

            await tx.commit();
            console.log(` Edited claim: ${oldClaimId.substring(0, 12)}... → ${newClaimId.substring(0, 12)}...`);

            return { success: true, newClaimId, oldClaimId };

        } catch (error) {
            await tx.rollback();
            console.error(' Failed to process edit claim:', error.message);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Calculate group member participation percentages.
     * Used for the RGraph visualization around Group nodes.
     * Shows what percentage of tracks each member performed on.
     *
     * @param {string} groupId - Group to analyze
     * @returns {Promise<Array>} Member participation data sorted by percentage
     */
    async calculateGroupMemberParticipation(groupId) {
        const session = this.driver.session();

        try {
            console.log(`Calculating member participation for group ${groupId.substring(0, 12)}...`);

            const result = await session.run(`
                MATCH (g:Group {group_id: $groupId})
                MATCH (g)-[:PERFORMED_ON]->(t:Track)
                MATCH (t)-[:IN_RELEASE]->(r:Release)

                // For each track, find which members were active at that time
                OPTIONAL MATCH (p:Person)-[m:MEMBER_OF]->(g)
                WHERE (m.from_date IS NULL OR date(m.from_date) <= date(r.release_date))
                  AND (m.to_date IS NULL OR date(m.to_date) >= date(r.release_date))

                // Count tracks per member
                WITH p, count(DISTINCT t) as track_count,
                     collect(DISTINCT r.release_id) as releases

                // Get total tracks for percentage
                MATCH (g:Group {group_id: $groupId})-[:PERFORMED_ON]->(total:Track)
                WITH p, track_count, releases, count(DISTINCT total) as total_tracks

                WHERE p IS NOT NULL

                RETURN p.person_id as personId,
                       p.name as personName,
                       track_count,
                       total_tracks,
                       toFloat(track_count) / toFloat(total_tracks) * 100 as participationPercentage,
                       size(releases) as releaseCount
                ORDER BY participationPercentage DESC
            `, { groupId });

            const participation = result.records.map(record => ({
                personId: record.get('personId'),
                personName: record.get('personName'),
                trackCount: record.get('track_count').toNumber(),
                totalTracks: record.get('total_tracks').toNumber(),
                participationPercentage: record.get('participationPercentage'),
                releaseCount: record.get('releaseCount').toNumber()
            }));

            console.log(` Found ${participation.length} members`);

            return participation;

        } catch (error) {
            console.error(' Failed to calculate participation:', error.message);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Find potential duplicate entities based on similar names.
     * Uses Levenshtein distance for fuzzy matching.
     * Used for deduplication and MERGE_NODE operations.
     *
     * @param {string} type - Entity type to check (Person, Group, etc.)
     * @param {string} name - Name to match against
     * @param {number} [threshold=3] - Maximum edit distance
     * @returns {Promise<Array>} Potential duplicates
     */
    async findPotentialDuplicates(type, name, threshold = 3) {
        const session = this.driver.session();

        try {
            // Validate type against whitelist to prevent Cypher injection
            const key = String(type).toLowerCase();
            const mapping = SAFE_NODE_TYPES[key];
            if (!mapping) {
                throw new Error(`Invalid type: ${type}. Allowed types: ${Object.keys(SAFE_NODE_TYPES).join(', ')}`);
            }

            console.log(`Searching for duplicates of ${mapping.label}: ${name}`);

            // Simple string matching (Levenshtein requires APOC plugin)
            // In production, you'd use apoc.text.levenshteinDistance
            const result = await session.run(`
                MATCH (n:${mapping.label})
                WHERE toLower(n.name) CONTAINS toLower($name)
                   OR ANY(alt IN n.alt_names WHERE toLower(alt) CONTAINS toLower($name))
                RETURN n.${mapping.idField} as id,
                       n.name as name,
                       n.alt_names as altNames,
                       n.status as status
                LIMIT 10
            `, { name });

            const duplicates = result.records.map(record => ({
                id: record.get('id'),
                name: record.get('name'),
                altNames: record.get('altNames') || [],
                status: record.get('status')
            }));

            console.log(` Found ${duplicates.length} potential duplicates`);

            return duplicates;

        } catch (error) {
            console.error(' Failed to find duplicates:', error.message);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Merge duplicate nodes into a canonical entity.
     * Preserves all relationships and claims from both nodes.
     *
     * @param {string} sourceId - Provisional/duplicate node ID
     * @param {string} targetId - Canonical node ID to merge into
     * @param {string} nodeType - Type of nodes being merged
     * @param {string} reason - Reason for merge (for audit trail)
     * @returns {Promise<Object>} Result with mergeId
     */
    async mergeNodes(sourceId, targetId, nodeType, reason) {
        const session = this.driver.session();
        const tx = session.beginTransaction();

        try {
            // Validate nodeType against whitelist to prevent Cypher injection
            const key = String(nodeType).toLowerCase();
            const mapping = SAFE_NODE_TYPES[key];
            if (!mapping) {
                throw new Error(`Invalid nodeType: ${nodeType}. Allowed types: ${Object.keys(SAFE_NODE_TYPES).join(', ')}`);
            }

            console.log(`Merging ${mapping.label} ${sourceId.substring(0, 12)}... into ${targetId.substring(0, 12)}...`);

            // Copy properties from source to target (if not already set)
            await tx.run(`
                MATCH (source:${mapping.label} {${mapping.idField}: $sourceId})
                MATCH (target:${mapping.label} {${mapping.idField}: $targetId})

                // Combine alt_names
                SET target.alt_names = target.alt_names +
                    [name IN source.alt_names WHERE NOT name IN target.alt_names]

                // Copy any null fields from source
                SET target = CASE
                    WHEN target.bio IS NULL THEN source
                    ELSE target
                END

                SET target.status = 'ACTIVE',
                    target.id_kind = 'canonical'

                RETURN target
            `, { sourceId, targetId });

            // Transfer all incoming relationships
            await tx.run(`
                MATCH (source:${mapping.label} {${mapping.idField}: $sourceId})
                MATCH (target:${mapping.label} {${mapping.idField}: $targetId})
                MATCH (other)-[r]->(source)

                WITH other, type(r) as relType, properties(r) as props, target
                CALL apoc.create.relationship(other, relType, props, target) YIELD rel

                RETURN count(rel) as transferred
            `, { sourceId, targetId });

            // Transfer all outgoing relationships
            await tx.run(`
                MATCH (source:${mapping.label} {${mapping.idField}: $sourceId})
                MATCH (target:${mapping.label} {${mapping.idField}: $targetId})
                MATCH (source)-[r]->(other)

                WITH target, type(r) as relType, properties(r) as props, other
                CALL apoc.create.relationship(target, relType, props, other) YIELD rel

                RETURN count(rel) as transferred
            `, { sourceId, targetId });

            // Delete the source node
            await tx.run(`
                MATCH (source:${mapping.label} {${mapping.idField}: $sourceId})
                DETACH DELETE source
            `, { sourceId });

            // Create merge record for audit trail
            const mergeId = createHash('sha256')
                .update(sourceId + targetId + Date.now())
                .digest('hex');

            await tx.run(`
                CREATE (m:MergeRecord {
                    merge_id: $mergeId,
                    source_id: $sourceId,
                    target_id: $targetId,
                    node_type: $nodeType,
                    reason: $reason,
                    merged_at: datetime()
                })
            `, { mergeId, sourceId, targetId, nodeType, reason });

            await tx.commit();
            console.log(` Merged nodes successfully`);

            return { success: true, mergeId };

        } catch (error) {
            await tx.rollback();
            console.error(' Failed to merge nodes:', error.message);

            // Check if APOC is missing
            if (error.message.includes('apoc')) {
                throw new Error('APOC plugin required for merge operations. Install with: neo4j-admin install apoc');
            }

            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Create an audit trail claim for data changes.
     * Every modification is tracked with source and timestamp.
     * Idempotent: replaying the same claim is a no-op.
     *
     * @private
     * @param {Transaction} tx - Active Neo4j transaction
     * @param {string} claimId - Unique claim identifier
     * @param {string} nodeType - Type of node being claimed about
     * @param {string} nodeId - ID of the node
     * @param {string} field - Field being modified
     * @param {*} value - New value
     * @param {string} eventHash - Hash of the source event
     * @param {number} [eventTs] - Event timestamp in epoch millis (falls back to wall-clock time)
     */
    async createClaim(tx, claimId, nodeType, nodeId, field, value, eventHash, eventTs) {
        const tsExpr = eventTs != null
            ? 'datetime({epochMillis: $eventTs})'
            : 'datetime()';
        await tx.run(`
            MERGE (c:Claim {claim_id: $claimId})
            ON CREATE SET
                c.node_type = $nodeType,
                c.node_id = $nodeId,
                c.field = $field,
                c.value = $value,
                c.event_hash = $eventHash,
                c.created_at = ${tsExpr}
        `, {
            claimId,
            nodeType,
            nodeId,
            field,
            value: JSON.stringify(value),
            eventHash,
            eventTs: eventTs ?? null
        });
    }

    /**
     * Resolve entity ID using the new identity system.
     * Checks for external IDs first, then generates provisional ID.
     *
     * @param {Object} session - Neo4j session
     * @param {string} type - Entity type (person, group, track, etc.)
     * @param {Object} data - Entity data
     * @returns {Promise<string>} Resolved ID (canonical if mapped, provisional otherwise)
     */
    async resolveEntityId(session, type, data) {
        // 1. If explicit canonical or external ID provided, use it
        const explicitIdField = `${type}_id`;
        if (data[explicitIdField]) {
            const parsedId = IdentityService.parseId(data[explicitIdField]);

            // If it's canonical, use directly
            if (parsedId.kind === 'canonical') {
                return data[explicitIdField];
            }

            // If it's external, check IdentityMap
            if (parsedId.kind === 'external') {
                const canonicalId = await MergeOperations.resolveExternalId(
                    session,
                    parsedId.source,
                    parsedId.externalType,
                    parsedId.externalId
                );

                if (canonicalId) {
                    console.log(`    Resolved ${data[explicitIdField]} → ${canonicalId.substring(0, 20)}...`);
                    return canonicalId;
                }

                // External ID not mapped yet, will create provisional
                console.log(`    External ID ${data[explicitIdField]} not mapped, creating provisional`);
            }
        }

        // 2. Check for common external ID fields (Discogs, MusicBrainz, etc.)
        const externalIdFields = {
            discogs_id: 'discogs',
            musicbrainz_id: 'musicbrainz',
            isni: 'isni',
            wikidata_id: 'wikidata',
            spotify_id: 'spotify'
        };

        for (const [field, source] of Object.entries(externalIdFields)) {
            if (data[field]) {
                // Try to resolve via IdentityMap
                const canonicalId = await MergeOperations.resolveExternalId(
                    session,
                    source,
                    type,
                    data[field]
                );

                if (canonicalId) {
                    console.log(`    Resolved ${source}:${type}:${data[field]} → ${canonicalId.substring(0, 20)}...`);
                    return canonicalId;
                }
            }
        }

        // 3. No external ID mapping found, generate provisional ID
        return this.generateProvisionalIdNew(type, data);
    }

    /**
     * Generate deterministic provisional ID using IdentityService.
     * This replaces the old hash-based method with the new fingerprint approach.
     *
     * @param {string} type - Entity type (person, group, track, etc.)
     * @param {Object} data - Entity data
     * @returns {string} Provisional ID (prov:{type}:{hash})
     */
    generateProvisionalIdNew(type, data) {
        let fingerprint;

        switch(type) {
            case 'person':
                fingerprint = IdentityService.personFingerprint({
                    name: data.name || data.person_name,
                    birth_year: data.birth_year
                });
                break;

            case 'group':
                fingerprint = IdentityService.groupFingerprint({
                    name: data.name || data.group_name
                });
                break;

            case 'song':
                fingerprint = IdentityService.songFingerprint({
                    title: data.title || data.song_title,
                    primary_writer: data.primary_writer
                });
                break;

            case 'track':
                fingerprint = IdentityService.trackFingerprint({
                    title: data.title || data.track_title,
                    release_id: data.release_id,
                    position: data.track_number || data.position
                });
                break;

            case 'release':
                fingerprint = IdentityService.releaseFingerprint({
                    title: data.name || data.release_name,
                    date: data.release_date || data.year,
                    catalog_number: data.catalog_number
                });
                break;

            case 'label':
                fingerprint = {
                    type: 'label',
                    name: IdentityService.normalizeName(data.name || data.label_name)
                };
                break;

            case 'city':
                fingerprint = {
                    type: 'city',
                    name: IdentityService.normalizeName(data.name || data.city_name),
                    lat: data.lat,
                    lon: data.lon
                };
                break;

            case 'source':
                fingerprint = {
                    type: 'source',
                    url: data.url
                };
                break;

            default:
                throw new Error(`Unknown entity type: ${type}`);
        }

        return IdentityService.makeProvisionalId(type, fingerprint);
    }

    /**
     * Generate deterministic provisional ID when external ID unavailable.
     * IDs are consistent for the same input data, ensuring idempotency.
     * Format: prov:{type}:{hash}
     *
     * @deprecated Use generateProvisionalIdNew() instead
     * @param {string} type - Entity type (person, group, track, etc.)
     * @param {Object} data - Entity data
     * @returns {string} Provisional ID
     */
    generateProvisionalId(type, data) {
        let normalizedString;

        switch(type) {
            case 'group':
                // Group ID based on name and founding members
                normalizedString = [
                    data.name?.toLowerCase() || '',
                    data.formed_date || '',
                    ...(data.members || []).slice(0, 5).map(m => m.name?.toLowerCase() || '').sort()
                ].filter(Boolean).join('|');
                break;

            case 'person':
                // Person ID based on name (could add birth date if available)
                normalizedString = (data.name?.toLowerCase() || '') + '|person';
                break;

            case 'track':
                // Track ID based on title, duration, and performers
                normalizedString = [
                    data.title?.toLowerCase() || '',
                    data.duration || '',
                    data.performed_by_groups?.[0]?.name?.toLowerCase() || ''
                ].filter(Boolean).join('|');
                break;

            case 'song':
                // Song ID based on title and writers
                normalizedString = [
                    data.title?.toLowerCase() || '',
                    ...(data.writers || []).slice(0, 3).map(w => w.name?.toLowerCase() || '').sort()
                ].filter(Boolean).join('|');
                break;

            case 'release':
                // Release ID based on name, date, and label
                normalizedString = [
                    data.name?.toLowerCase() || '',
                    data.release_date || '',
                    data.labels?.[0]?.name?.toLowerCase() || ''
                ].filter(Boolean).join('|');
                break;

            case 'label':
                // Label ID based on name
                normalizedString = (data.name?.toLowerCase() || '') + '|label';
                break;

            case 'city':
                // City ID based on name and coordinates
                normalizedString = [
                    data.name?.toLowerCase() || '',
                    data.lat?.toString() || '',
                    data.lon?.toString() || ''
                ].filter(Boolean).join('|');
                break;

            case 'source':
                // Source ID based on URL
                normalizedString = data.url || JSON.stringify(data);
                break;

            default:
                // Fallback: stringify entire object
                normalizedString = JSON.stringify(data);
        }

        const hash = createHash('sha256')
            .update(normalizedString)
            .digest('hex')
            .substring(0, 16);

        return `prov:${type}:${hash}`;
    }

    /**
     * Generate operation ID for sub-operations within an event.
     * Ensures deterministic IDs for idempotent event replay.
     *
     * @param {string} eventHash - Parent event hash
     * @param {number} index - Operation index
     * @returns {string} Operation ID
     */
    generateOpId(eventHash, index) {
        return createHash('sha256')
            .update(eventHash + ':' + index.toString())
            .digest('hex');
    }

    /**
     * Test database connectivity.
     *
     * @returns {Promise<boolean>} True if connected
     */
    async testConnection() {
        const session = this.driver.session();
        try {
            await session.run('RETURN 1');
            return true;
        } catch (error) {
            console.error('Database connection test failed:', error.message);
            return false;
        } finally {
            await session.close();
        }
    }

    /**
     * Get database statistics.
     * Only counts ACTIVE entities (excludes MERGED and PROVISIONAL).
     *
     * @returns {Promise<Object>} Node and relationship counts
     */
    async getStats() {
        const session = this.driver.session();
        try {
            const result = await session.run(`
                MATCH (n)
                WHERE n.status = 'ACTIVE' OR n.status IS NULL
                RETURN labels(n)[0] as type, count(*) as count
                ORDER BY count DESC
            `);

            const nodes = {};
            result.records.forEach(record => {
                nodes[record.get('type')] = record.get('count').toNumber();
            });

            return { nodes };
        } finally {
            await session.close();
        }
    }

    /**
     * Clean up and close database connections.
     * Always call this when shutting down the application.
     *
     * @returns {Promise<void>}
     */
    async close() {
        console.log('Closing database connections...');
        await this.driver.close();
        console.log(' Database connections closed');
    }
}

export default MusicGraphDatabase;
