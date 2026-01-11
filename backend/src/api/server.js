/**
 * @fileoverview Main API server for Polaris Music Registry
 *
 * Provides both GraphQL and REST endpoints for:
 * - Querying music data from the graph database
 * - Submitting and retrieving events
 * - Getting statistics and metadata
 *
 * Architecture:
 * - GraphQL for flexible queries (groups, persons, releases, tracks)
 * - REST for specific operations (event submission, stats)
 * - Integrates with MusicGraphDatabase and EventStore
 *
 * @module api/server
 */

import express from 'express';
import cors from 'cors';
import { graphqlHTTP } from 'express-graphql';
import { buildSchema } from 'graphql';
import MusicGraphDatabase from '../graph/schema.js';
import EventStore from '../storage/eventStore.js';
import EventProcessor from '../indexer/eventProcessor.js';
import { createIdentityRoutes } from './routes/identity.js';
import { normalizeReleaseBundle } from '../graph/normalizeReleaseBundle.js';
import { validateReleaseBundleOrThrow } from '../schema/validateReleaseBundle.js';
import { MergeOperations } from '../graph/merge.js';
import { IngestionHandler } from './ingestion.js';

/**
 * GraphQL Schema Definition
 * Defines all types, queries, and mutations available via GraphQL
 */
const schema = buildSchema(`
  """
  A person in the music industry (musician, producer, engineer, etc.)
  """
  type Person {
    person_id: String!
    name: String!
    alt_names: [String!]
    bio: String
    status: String!
    groups: [GroupMembership!]
    songsWritten: [Song!]
    tracksProduced: [Track!]
    guestAppearances: [Track!]
  }

  """
  Group membership details with dates and roles
  """
  type GroupMembership {
    group: Group!
    role: String
    from_date: String
    to_date: String
    instruments: [String!]
  }

  """
  A musical group (band, orchestra, ensemble, or solo project)
  """
  type Group {
    group_id: String!
    name: String!
    alt_names: [String!]
    bio: String
    formed_date: String
    disbanded_date: String
    status: String!
    members: [Member!]
    releases: [Release!]
    tracks: [Track!]
  }

  """
  Member participation data for RGraph visualization
  """
  type Member {
    person: Person!
    role: String
    from_date: String
    to_date: String
    instruments: [String!]
    participation_percentage: Float
    track_count: Int
    release_count: Int
  }

  """
  A musical composition (the written work)
  """
  type Song {
    song_id: String!
    title: String!
    alt_titles: [String!]
    iswc: String
    year: Int
    lyrics: String
    writers: [Person!]
    recordings: [Track!]
  }

  """
  A specific recording/performance of a song
  """
  type Track {
    track_id: String!
    title: String!
    isrc: String
    duration: Int
    recording_date: String
    recording_location: String
    listen_links: [String!]
    status: String!
    performedBy: [Group!]
    guests: [Person!]
    recordingOf: Song
    releases: [Release!]
  }

  """
  An album, EP, single, or other release package
  """
  type Release {
    release_id: String!
    name: String!
    alt_names: [String!]
    release_date: String
    format: [String!]
    country: String
    catalog_number: String
    liner_notes: String
    album_art: String
    status: String!
    tracks: [TrackInRelease!]
    labels: [Label!]
    master: Master
  }

  """
  Track position in a release with ordering
  """
  type TrackInRelease {
    track: Track!
    disc_number: Int
    track_number: Int!
    side: String
    is_bonus: Boolean
  }

  """
  Record label
  """
  type Label {
    label_id: String!
    name: String!
    alt_names: [String!]
    status: String!
  }

  """
  Canonical album grouping for re-releases
  """
  type Master {
    master_id: String!
    name: String!
  }

  """
  Search result union type
  """
  union SearchResult = Person | Group | Release | Track | Song

  """
  Statistics about the database
  """
  type Stats {
    nodes: NodeStats!
    enabled_services: EnabledServices!
  }

  type NodeStats {
    Person: Int
    Group: Int
    Track: Int
    Song: Int
    Release: Int
    Label: Int
    total: Int
  }

  type EnabledServices {
    ipfs: Boolean!
    s3: Boolean!
    redis: Boolean!
  }

  """
  Event storage result
  """
  type EventStoreResult {
    hash: String!
    ipfs: String
    s3: String
    redis: Boolean
    errors: [String!]
  }

  """
  Root Query type
  """
  type Query {
    """Get person by ID"""
    person(person_id: String!): Person

    """Get group by ID"""
    group(group_id: String!): Group

    """Get group member participation data (for RGraph)"""
    groupParticipation(group_id: String!): [Member!]

    """Get release by ID"""
    release(release_id: String!): Release

    """Get track by ID"""
    track(track_id: String!): Track

    """Get song by ID"""
    song(song_id: String!): Song

    """Search across all entity types"""
    search(query: String!, limit: Int): [SearchResult!]

    """Get database statistics"""
    stats: Stats!

    """Test database connectivity"""
    testConnectivity: Boolean!
  }

  """
  Root Mutation type
  """
  type Mutation {
    """Submit a new event (returns event hash)"""
    submitEvent(event: String!): EventStoreResult!
  }
`);

/**
 * API Server class that manages Express app with GraphQL and REST endpoints
 */
class APIServer {
    /**
     * Create a new API server
     *
     * @param {Object} config - Server configuration
     * @param {number} config.port - Port to listen on
     * @param {Object} config.database - Graph database config
     * @param {Object} config.storage - Event storage config
     */
    constructor(config) {
        this.config = config;
        this.app = express();
        this.port = config.port || 3000;

        // Initialize database and storage
        this.db = new MusicGraphDatabase(config.database);
        this.store = new EventStore(config.storage);

        // Initialize event processor and ingestion handler (T5)
        this.eventProcessor = new EventProcessor({
            db: this.db,
            store: this.store
        });
        this.ingestionHandler = new IngestionHandler(this.store, this.eventProcessor);

        // Setup middleware and routes
        this.setupMiddleware();
        this.setupGraphQL();
        this.setupRESTEndpoints();
        this.setupErrorHandling();
    }

    /**
     * Setup Express middleware
     */
    setupMiddleware() {
        // CORS - Enable cross-origin requests from frontend
        // Supports comma-separated list of origins for multiple dev environments
        // Example: CORS_ORIGIN=http://localhost:5173,http://localhost:4173
        const corsOriginEnv = this.config.corsOrigin || process.env.CORS_ORIGIN || 'http://localhost:5173';
        const origins = corsOriginEnv
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);

        // Pass single string or array to cors() depending on count
        const corsOrigin = origins.length === 1 ? origins[0] : origins;

        this.app.use(cors({
            origin: corsOrigin,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
            credentials: false
        }));
        console.log(` CORS enabled for origin(s): ${origins.join(', ')}`);

        // Parse JSON bodies
        this.app.use(express.json({ limit: '10mb' }));

        // Request logging
        this.app.use((req, res, next) => {
            console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
            next();
        });
    }

    /**
     * Setup GraphQL endpoint with resolvers
     */
    setupGraphQL() {
        const root = {
            // ========== PERSON QUERIES ==========
            person: async ({ person_id }) => {
                const session = this.db.driver.session();
                try {
                    const result = await session.run(`
                        MATCH (p:Person {person_id: $id})
                        WHERE p.status = 'ACTIVE'
                        OPTIONAL MATCH (p)-[m:MEMBER_OF]->(g:Group)
                        WHERE g.status = 'ACTIVE'
                        OPTIONAL MATCH (p)-[:WROTE]->(s:Song)
                        WHERE s.status = 'ACTIVE'
                        OPTIONAL MATCH (p)-[:PRODUCED]->(t:Track)
                        WHERE t.status = 'ACTIVE'
                        OPTIONAL MATCH (p)-[:GUEST_ON]->(tg:Track)
                        WHERE tg.status = 'ACTIVE'

                        RETURN p,
                               collect(DISTINCT {
                                   group: g,
                                   role: m.role,
                                   from_date: m.from_date,
                                   to_date: m.to_date,
                                   instruments: m.instruments
                               }) as groups,
                               collect(DISTINCT s) as songsWritten,
                               collect(DISTINCT t) as tracksProduced,
                               collect(DISTINCT tg) as guestAppearances
                    `, { id: person_id });

                    if (result.records.length === 0) return null;

                    const record = result.records[0];
                    const person = record.get('p').properties;
                    const groups = record.get('groups')
                        .filter(g => g.group !== null)
                        .map(g => ({
                            group: g.group.properties,
                            role: g.role,
                            from_date: g.from_date,
                            to_date: g.to_date,
                            instruments: g.instruments || []
                        }));
                    const songsWritten = record.get('songsWritten')
                        .filter(s => s !== null)
                        .map(s => s.properties);
                    const tracksProduced = record.get('tracksProduced')
                        .filter(t => t !== null)
                        .map(t => t.properties);
                    const guestAppearances = record.get('guestAppearances')
                        .filter(t => t !== null)
                        .map(t => t.properties);

                    return {
                        ...person,
                        alt_names: person.alt_names || [],
                        groups,
                        songsWritten,
                        tracksProduced,
                        guestAppearances
                    };
                } finally {
                    await session.close();
                }
            },

            // ========== GROUP QUERIES ==========
            group: async ({ group_id }) => {
                const session = this.db.driver.session();
                try {
                    const result = await session.run(`
                        MATCH (g:Group {group_id: $id})
                        WHERE g.status = 'ACTIVE'
                        OPTIONAL MATCH (p:Person)-[m:MEMBER_OF]->(g)
                        WHERE p.status = 'ACTIVE'
                        OPTIONAL MATCH (g)-[:PERFORMED_ON]->(t:Track)
                        WHERE t.status = 'ACTIVE'
                        OPTIONAL MATCH (t)-[:IN_RELEASE]->(r:Release)
                        WHERE r.status = 'ACTIVE'

                        RETURN g,
                               collect(DISTINCT {
                                   person: p,
                                   role: m.role,
                                   from_date: m.from_date,
                                   to_date: m.to_date,
                                   instruments: m.instruments
                               }) as members,
                               collect(DISTINCT t) as tracks,
                               collect(DISTINCT r) as releases
                    `, { id: group_id });

                    if (result.records.length === 0) return null;

                    const record = result.records[0];
                    const group = record.get('g').properties;
                    const members = record.get('members')
                        .filter(m => m.person !== null)
                        .map(m => ({
                            person: m.person.properties,
                            role: m.role,
                            from_date: m.from_date,
                            to_date: m.to_date,
                            instruments: m.instruments || []
                        }));
                    const tracks = record.get('tracks')
                        .filter(t => t !== null)
                        .map(t => t.properties);
                    const releases = record.get('releases')
                        .filter(r => r !== null)
                        .map(r => r.properties);

                    return {
                        ...group,
                        alt_names: group.alt_names || [],
                        members,
                        tracks,
                        releases
                    };
                } finally {
                    await session.close();
                }
            },

            groupParticipation: async ({ group_id }) => {
                const participation = await this.db.calculateGroupMemberParticipation(group_id);
                return participation.map(p => ({
                    person: { person_id: p.personId, name: p.personName },
                    participation_percentage: p.participationPercentage,
                    track_count: p.trackCount,
                    release_count: p.releaseCount
                }));
            },

            // ========== RELEASE QUERIES ==========
            release: async ({ release_id }) => {
                const session = this.db.driver.session();
                try {
                    const result = await session.run(`
                        MATCH (r:Release {release_id: $id})
                        WHERE r.status = 'ACTIVE'
                        OPTIONAL MATCH (t:Track)-[ir:IN_RELEASE]->(r)
                        WHERE t.status = 'ACTIVE'
                        OPTIONAL MATCH (r)-[:RELEASED]->(l:Label)
                        WHERE l.status = 'ACTIVE'
                        OPTIONAL MATCH (r)-[:IN_MASTER]->(m:Master)
                        WHERE m.status = 'ACTIVE'

                        RETURN r,
                               collect(DISTINCT {
                                   track: t,
                                   disc_number: ir.disc_number,
                                   track_number: ir.track_number,
                                   side: ir.side,
                                   is_bonus: ir.is_bonus
                               }) as tracks,
                               collect(DISTINCT l) as labels,
                               m as master
                    `, { id: release_id });

                    if (result.records.length === 0) return null;

                    const record = result.records[0];
                    const release = record.get('r').properties;
                    const tracks = record.get('tracks')
                        .filter(t => t.track !== null)
                        .map(t => ({
                            track: t.track.properties,
                            disc_number: t.disc_number,
                            track_number: t.track_number,
                            side: t.side,
                            is_bonus: t.is_bonus
                        }));
                    const labels = record.get('labels')
                        .filter(l => l !== null)
                        .map(l => l.properties);
                    const master = record.get('master');

                    return {
                        ...release,
                        alt_names: release.alt_names || [],
                        format: release.format || [],
                        tracks,
                        labels,
                        master: master ? master.properties : null
                    };
                } finally {
                    await session.close();
                }
            },

            // ========== TRACK QUERIES ==========
            track: async ({ track_id }) => {
                const session = this.db.driver.session();
                try {
                    const result = await session.run(`
                        MATCH (t:Track {track_id: $id})
                        WHERE t.status = 'ACTIVE'
                        OPTIONAL MATCH (t)-[:RECORDING_OF]->(s:Song)
                        WHERE s.status = 'ACTIVE'
                        OPTIONAL MATCH (g:Group)-[:PERFORMED_ON]->(t)
                        WHERE g.status = 'ACTIVE'
                        OPTIONAL MATCH (p:Person)-[:GUEST_ON]->(t)
                        WHERE p.status = 'ACTIVE'
                        OPTIONAL MATCH (t)-[:IN_RELEASE]->(r:Release)
                        WHERE r.status = 'ACTIVE'

                        RETURN t,
                               s,
                               collect(DISTINCT g) as performedBy,
                               collect(DISTINCT p) as guests,
                               collect(DISTINCT r) as releases
                    `, { id: track_id });

                    if (result.records.length === 0) return null;

                    const record = result.records[0];
                    const track = record.get('t').properties;
                    const song = record.get('s');
                    const performedBy = record.get('performedBy')
                        .filter(g => g !== null)
                        .map(g => g.properties);
                    const guests = record.get('guests')
                        .filter(p => p !== null)
                        .map(p => p.properties);
                    const releases = record.get('releases')
                        .filter(r => r !== null)
                        .map(r => r.properties);

                    return {
                        ...track,
                        listen_links: track.listen_links || [],
                        recordingOf: song ? song.properties : null,
                        performedBy,
                        guests,
                        releases
                    };
                } finally {
                    await session.close();
                }
            },

            // ========== SONG QUERIES ==========
            song: async ({ song_id }) => {
                const session = this.db.driver.session();
                try {
                    const result = await session.run(`
                        MATCH (s:Song {song_id: $id})
                        WHERE s.status = 'ACTIVE'
                        OPTIONAL MATCH (p:Person)-[:WROTE]->(s)
                        WHERE p.status = 'ACTIVE'
                        OPTIONAL MATCH (t:Track)-[:RECORDING_OF]->(s)
                        WHERE t.status = 'ACTIVE'

                        RETURN s,
                               collect(DISTINCT p) as writers,
                               collect(DISTINCT t) as recordings
                    `, { id: song_id });

                    if (result.records.length === 0) return null;

                    const record = result.records[0];
                    const song = record.get('s').properties;
                    const writers = record.get('writers')
                        .filter(p => p !== null)
                        .map(p => p.properties);
                    const recordings = record.get('recordings')
                        .filter(t => t !== null)
                        .map(t => t.properties);

                    return {
                        ...song,
                        alt_titles: song.alt_titles || [],
                        writers,
                        recordings
                    };
                } finally {
                    await session.close();
                }
            },

            // ========== SEARCH ==========
            search: async ({ query, limit = 10 }) => {
                const session = this.db.driver.session();
                try {
                    const result = await session.run(`
                        CALL db.index.fulltext.queryNodes('entitySearch', $query)
                        YIELD node, score
                        WHERE node.status = 'ACTIVE'
                        RETURN node, labels(node)[0] as type, score
                        ORDER BY score DESC
                        LIMIT $limit
                    `, { query, limit });

                    return result.records.map(record => {
                        const node = record.get('node').properties;
                        const type = record.get('type');
                        return { __typename: type, ...node };
                    });
                } catch (error) {
                    // Fallback to simple name matching if fulltext index doesn't exist
                    console.warn('Fulltext search failed, using fallback:', error.message);
                    const result = await session.run(`
                        MATCH (n)
                        WHERE n.name CONTAINS $query
                          AND n.status = 'ACTIVE'
                        RETURN n, labels(n)[0] as type
                        LIMIT $limit
                    `, { query, limit });

                    return result.records.map(record => {
                        const node = record.get('n').properties;
                        const type = record.get('type');
                        return { __typename: type, ...node };
                    });
                }
            },

            // ========== STATS ==========
            stats: async () => {
                const dbStats = await this.db.getStats();
                const storageStats = this.store.getStats();

                const total = Object.values(dbStats.nodes).reduce((sum, count) => sum + count, 0);

                return {
                    nodes: {
                        ...dbStats.nodes,
                        total
                    },
                    enabled_services: storageStats.enabled
                };
            },

            testConnectivity: async () => {
                const dbConnected = await this.db.testConnection();
                return dbConnected;
            },

            // ========== MUTATIONS ==========
            submitEvent: async ({ event }) => {
                const eventObj = JSON.parse(event);
                const result = await this.store.storeEvent(eventObj);
                return result;
            }
        };

        // Setup GraphQL endpoint
        this.app.use('/graphql', graphqlHTTP({
            schema: schema,
            rootValue: root,
            graphiql: true, // Enable GraphiQL interface in development
            customFormatErrorFn: (error) => ({
                message: error.message,
                locations: error.locations,
                path: error.path
            })
        }));

        console.log(' GraphQL endpoint configured at /graphql');
    }

    /**
     * Setup REST endpoints for specific operations
     */
    setupRESTEndpoints() {
        // ========== IDENTITY MANAGEMENT ==========
        // Mount identity routes
        const identityRouter = createIdentityRoutes(this.db, this.store);
        this.app.use('/api/identity', identityRouter);
        console.log(' Identity management endpoints mounted at /api/identity');

        // ========== HEALTH CHECK ==========
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                uptime: process.uptime()
            });
        });

        // ========== EVENT ENDPOINTS ==========

        /**
         * POST /api/events/prepare
         * Prepare an event for signing/anchoring by normalizing and returning canonical hash
         *
         * This endpoint allows the frontend to get the canonical hash that will be used
         * for storage BEFORE signing, ensuring the hash anchored on-chain matches
         * the hash the backend will store.
         *
         * Flow:
         * 1. Frontend builds event (without sig)
         * 2. Calls /api/events/prepare to get canonical hash
         * 3. Signs the returned hash
         * 4. Adds sig to event
         * 5. Calls /api/events/create to store
         *
         * @returns {Object} { success: true, hash, normalizedEvent }
         */
        this.app.post('/api/events/prepare', async (req, res) => {
            try {
                const event = req.body;

                // Clone event to avoid mutating the original
                const preparedEvent = JSON.parse(JSON.stringify(event));

                // Normalize CREATE_RELEASE_BUNDLE events
                if (preparedEvent.type === 'CREATE_RELEASE_BUNDLE' && preparedEvent.body) {
                    // Step 1: Normalize legacy field names → canonical format
                    const normalizedBundle = normalizeReleaseBundle(preparedEvent.body);

                    // Step 2: Validate against canonical schema
                    validateReleaseBundleOrThrow(normalizedBundle);

                    // Replace event body with normalized+validated version
                    preparedEvent.body = normalizedBundle;
                }

                // Calculate canonical hash (using same logic as EventStore)
                // Exclude sig field to match storage hash calculation
                const hash = this.store.calculateHash(preparedEvent);

                res.json({
                    success: true,
                    hash,
                    normalizedEvent: preparedEvent
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
         * POST /api/events/create
         * Submit a new event to storage and blockchain
         *
         * Validates CREATE_RELEASE_BUNDLE events against canonical schema
         * to ensure no partial writes and deterministic error messages.
         *
         * @param {string} req.body.expected_hash - Optional. Expected hash from /api/events/prepare.
         *                                          If provided and doesn't match computed hash, returns 400.
         */
        this.app.post('/api/events/create', async (req, res) => {
            try {
                const { expected_hash, ...event } = req.body;

                // Validate CREATE_RELEASE_BUNDLE events at ingress
                if (event.type === 'CREATE_RELEASE_BUNDLE' && event.body) {
                    // Step 1: Normalize legacy field names → canonical format
                    const normalizedBundle = normalizeReleaseBundle(event.body);

                    // Step 2: Validate against canonical schema
                    // This ensures deterministic validation and prevents partial writes
                    validateReleaseBundleOrThrow(normalizedBundle);

                    // Replace event body with normalized+validated version
                    event.body = normalizedBundle;
                }

                // Store validated event (pass expectedHash for verification)
                const result = await this.store.storeEvent(event, expected_hash || null);

                res.status(201).json({
                    success: true,
                    hash: result.hash,
                    stored: {
                        canonical_cid: result.canonical_cid,
                        event_cid: result.event_cid,
                        s3: result.s3,
                        redis: result.redis
                    },
                    errors: result.errors
                });
            } catch (error) {
                console.error('Event creation failed:', error);
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
        this.app.get('/api/events/:hash', async (req, res) => {
            try {
                const event = await this.store.retrieveEvent(req.params.hash);

                res.json({
                    success: true,
                    event
                });
            } catch (error) {
                console.error('Event retrieval failed:', error);
                res.status(404).json({
                    success: false,
                    error: error.message
                });
            }
        });

        /**
         * POST /api/merge
         * Merge duplicate entities (event-sourced)
         *
         * Creates a MERGE_ENTITY event, stores it, and performs the merge operation.
         * Returns the event hash for provenance tracking and replay.
         */
        this.app.post('/api/merge', async (req, res) => {
            try {
                const { survivorId, absorbedIds, evidence, submitter } = req.body;

                // Validate inputs
                if (!survivorId || !absorbedIds || !Array.isArray(absorbedIds) || absorbedIds.length === 0) {
                    return res.status(400).json({
                        success: false,
                        error: 'survivorId and absorbedIds (non-empty array) are required'
                    });
                }

                // Create MERGE_ENTITY event
                const mergeEvent = {
                    v: 1,
                    type: 'MERGE_ENTITY',
                    author_pubkey: submitter || 'system',
                    created_at: Math.floor(Date.now() / 1000),
                    parents: [],
                    body: {
                        survivor_id: survivorId,
                        absorbed_ids: absorbedIds,
                        evidence: evidence || '',
                        merged_at: new Date().toISOString()
                    },
                    proofs: {
                        source_links: []
                    },
                    sig: '' // In production, should be signed by submitter
                };

                // Store event (creates hash)
                const storeResult = await this.store.storeEvent(mergeEvent);
                const eventHash = storeResult.hash;

                console.log(`Merge event created: ${eventHash}`);

                // Perform merge operation with event hash
                const session = this.db.driver.session();
                try {
                    const mergeStats = await MergeOperations.mergeEntities(
                        session,
                        survivorId,
                        absorbedIds,
                        {
                            submitter: submitter || 'system',
                            eventHash: eventHash,
                            evidence: evidence || '',
                            rewireEdges: true,
                            moveClaims: true
                        }
                    );

                    res.status(200).json({
                        success: true,
                        eventHash: eventHash,
                        merge: mergeStats
                    });
                } finally {
                    await session.close();
                }
            } catch (error) {
                console.error('Merge operation failed:', error);
                res.status(400).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // ========== CHAIN INGESTION ENDPOINT (T5) ==========

        /**
         * POST /api/ingest/anchored-event
         * Ingest anchored event from Substreams chain ingestion
         *
         * Request body: AnchoredEvent
         * {
         *   content_hash: string,        // REQUIRED: Canonical content hash from put.hash
         *   payload: string | Buffer,    // REQUIRED: Raw action JSON payload
         *   event_hash: string,          // OPTIONAL: Action payload hash (debugging only)
         *   block_num: number,
         *   block_id: string,
         *   trx_id: string,
         *   action_ordinal: number,
         *   timestamp: number,
         *   source: string,
         *   contract_account: string,
         *   action_name: string
         * }
         *
         * Response:
         * {
         *   status: "processed" | "duplicate" | "error",
         *   eventHash: string,
         *   eventType?: string,
         *   blockNum?: number,
         *   trxId?: string,
         *   processing?: Object
         * }
         */
        this.app.post('/api/ingest/anchored-event', async (req, res) => {
            try {
                const anchoredEvent = req.body;

                // Validate required fields (content_hash is canonical, event_hash is optional)
                if (!anchoredEvent.content_hash || !anchoredEvent.payload) {
                    return res.status(400).json({
                        status: 'error',
                        error: 'Missing required fields: content_hash and payload'
                    });
                }

                // Process anchored event
                const result = await this.ingestionHandler.processAnchoredEvent(anchoredEvent);

                // Return appropriate status code
                const statusCode = result.status === 'duplicate' ? 200 : 201;

                res.status(statusCode).json(result);

            } catch (error) {
                console.error('Chain ingestion error:', error);
                res.status(500).json({
                    status: 'error',
                    error: error.message,
                    stack: this.config.env === 'development' ? error.stack : undefined
                });
            }
        });

        // ========== GROUP ENDPOINTS ==========

        /**
         * GET /api/groups/:groupId/participation
         * Get member participation data for RGraph visualization
         */
        this.app.get('/api/groups/:groupId/participation', async (req, res) => {
            try {
                const participation = await this.db.calculateGroupMemberParticipation(req.params.groupId);

                res.json({
                    success: true,
                    groupId: req.params.groupId,
                    members: participation
                });
            } catch (error) {
                console.error('Participation calculation failed:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        /**
         * GET /api/person/:personId
         * Get person details
         */
        this.app.get('/api/person/:personId', async (req, res) => {
            try {
                const session = this.db.driver.session();
                try {
                    const result = await session.run(`
                        MATCH (p:Person {person_id: $personId})
                        OPTIONAL MATCH (p)-[m:MEMBER_OF]->(g:Group)
                        OPTIONAL MATCH (p)-[:WROTE]->(s:Song)
                        OPTIONAL MATCH (p)-[:GUEST_ON]->(t:Track)

                        RETURN p,
                               collect(DISTINCT {
                                   group: g.name,
                                   group_id: g.group_id,
                                   role: m.role,
                                   from_date: m.from_date,
                                   to_date: m.to_date
                               }) as groups,
                               count(DISTINCT s) as songsWritten,
                               count(DISTINCT t) as guestAppearances
                    `, { personId: req.params.personId });

                    if (result.records.length === 0) {
                        return res.status(404).json({
                            success: false,
                            error: 'Person not found'
                        });
                    }

                    const record = result.records[0];
                    const person = record.get('p').properties;

                    res.json({
                        success: true,
                        data: {
                            ...person,
                            groups: record.get('groups').filter(g => g.group !== null),
                            songsWritten: record.get('songsWritten').toNumber(),
                            guestAppearances: record.get('guestAppearances').toNumber()
                        }
                    });
                } finally {
                    await session.close();
                }
            } catch (error) {
                console.error('Person details failed:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        /**
         * GET /api/group/:groupId
         * Get group details
         */
        this.app.get('/api/group/:groupId', async (req, res) => {
            try {
                const session = this.db.driver.session();
                try {
                    const result = await session.run(`
                        MATCH (g:Group {group_id: $groupId})
                        OPTIONAL MATCH (g)-[:PERFORMED_ON]->(t:Track)
                        OPTIONAL MATCH (t)-[:IN_RELEASE]->(r:Release)
                        OPTIONAL MATCH (p:Person)-[m:MEMBER_OF]->(g)

                        RETURN g,
                               count(DISTINCT t) as trackCount,
                               count(DISTINCT r) as releaseCount,
                               collect(DISTINCT {
                                   person: p.name,
                                   person_id: p.person_id,
                                   role: m.role,
                                   from_date: m.from_date,
                                   to_date: m.to_date
                               }) as members
                    `, { groupId: req.params.groupId });

                    if (result.records.length === 0) {
                        return res.status(404).json({
                            success: false,
                            error: 'Group not found'
                        });
                    }

                    const record = result.records[0];
                    const group = record.get('g').properties;

                    res.json({
                        success: true,
                        data: {
                            ...group,
                            trackCount: record.get('trackCount').toNumber(),
                            releaseCount: record.get('releaseCount').toNumber(),
                            members: record.get('members').filter(m => m.person !== null)
                        }
                    });
                } finally {
                    await session.close();
                }
            } catch (error) {
                console.error('Group details failed:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        /**
         * GET /api/release/:releaseId
         * Get release details
         */
        this.app.get('/api/release/:releaseId', async (req, res) => {
            try {
                const session = this.db.driver.session();
                try {
                    const result = await session.run(`
                        MATCH (r:Release {release_id: $releaseId})
                        OPTIONAL MATCH (t:Track)-[ir:IN_RELEASE]->(r)
                        OPTIONAL MATCH (r)-[:RELEASED]->(l:Label)

                        RETURN r,
                               collect(DISTINCT {
                                   track: t.title,
                                   track_id: t.track_id,
                                   disc_number: ir.disc_number,
                                   track_number: ir.track_number,
                                   side: ir.side
                               }) as tracks,
                               collect(DISTINCT {
                                   label: l.name,
                                   label_id: l.label_id
                               }) as labels
                    `, { releaseId: req.params.releaseId });

                    if (result.records.length === 0) {
                        return res.status(404).json({
                            success: false,
                            error: 'Release not found'
                        });
                    }

                    const record = result.records[0];
                    const release = record.get('r').properties;

                    res.json({
                        success: true,
                        data: {
                            ...release,
                            tracks: record.get('tracks').filter(t => t.track !== null),
                            labels: record.get('labels').filter(l => l.label !== null)
                        }
                    });
                } finally {
                    await session.close();
                }
            } catch (error) {
                console.error('Release details failed:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        /**
         * GET /api/track/:trackId
         * Get track details
         */
        this.app.get('/api/track/:trackId', async (req, res) => {
            try {
                const session = this.db.driver.session();
                try {
                    const result = await session.run(`
                        MATCH (t:Track {track_id: $trackId})
                        OPTIONAL MATCH (t)-[:RECORDING_OF]->(s:Song)
                        OPTIONAL MATCH (g:Group)-[:PERFORMED_ON]->(t)
                        OPTIONAL MATCH (p:Person)-[:GUEST_ON]->(t)
                        OPTIONAL MATCH (t)-[:IN_RELEASE]->(r:Release)

                        RETURN t,
                               s,
                               collect(DISTINCT {
                                   group: g.name,
                                   group_id: g.group_id
                               }) as performedBy,
                               collect(DISTINCT {
                                   guest: p.name,
                                   person_id: p.person_id
                               }) as guests,
                               collect(DISTINCT {
                                   release: r.name,
                                   release_id: r.release_id
                               }) as releases
                    `, { trackId: req.params.trackId });

                    if (result.records.length === 0) {
                        return res.status(404).json({
                            success: false,
                            error: 'Track not found'
                        });
                    }

                    const record = result.records[0];
                    const track = record.get('t').properties;
                    const song = record.get('s');

                    res.json({
                        success: true,
                        data: {
                            ...track,
                            song: song ? song.properties : null,
                            performedBy: record.get('performedBy').filter(g => g.group !== null),
                            guests: record.get('guests').filter(g => g.guest !== null),
                            releases: record.get('releases').filter(r => r.release !== null)
                        }
                    });
                } finally {
                    await session.close();
                }
            } catch (error) {
                console.error('Track details failed:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        /**
         * GET /api/song/:songId
         * Get song details
         */
        this.app.get('/api/song/:songId', async (req, res) => {
            try {
                const session = this.db.driver.session();
                try {
                    const result = await session.run(`
                        MATCH (s:Song {song_id: $songId})
                        OPTIONAL MATCH (p:Person)-[:WROTE]->(s)
                        OPTIONAL MATCH (t:Track)-[:RECORDING_OF]->(s)

                        RETURN s,
                               collect(DISTINCT {
                                   writer: p.name,
                                   person_id: p.person_id
                               }) as writers,
                               collect(DISTINCT {
                                   track: t.title,
                                   track_id: t.track_id
                               }) as recordings
                    `, { songId: req.params.songId });

                    if (result.records.length === 0) {
                        return res.status(404).json({
                            success: false,
                            error: 'Song not found'
                        });
                    }

                    const record = result.records[0];
                    const song = record.get('s').properties;

                    res.json({
                        success: true,
                        data: {
                            ...song,
                            writers: record.get('writers').filter(w => w.writer !== null),
                            recordings: record.get('recordings').filter(r => r.track !== null)
                        }
                    });
                } finally {
                    await session.close();
                }
            } catch (error) {
                console.error('Song details failed:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        /**
         * GET /api/label/:labelId
         * Get label details
         */
        this.app.get('/api/label/:labelId', async (req, res) => {
            try {
                const session = this.db.driver.session();
                try {
                    const result = await session.run(`
                        MATCH (l:Label {label_id: $labelId})
                        OPTIONAL MATCH (l)<-[:RELEASED]-(r:Release)

                        RETURN l,
                               collect(DISTINCT {
                                   release: r.name,
                                   release_id: r.release_id,
                                   release_date: r.release_date
                               }) as releases,
                               count(r) as releaseCount
                    `, { labelId: req.params.labelId });

                    if (result.records.length === 0) {
                        return res.status(404).json({
                            success: false,
                            error: 'Label not found'
                        });
                    }

                    const record = result.records[0];
                    const label = record.get('l').properties;

                    res.json({
                        success: true,
                        data: {
                            ...label,
                            releases: record.get('releases').filter(r => r.release !== null),
                            releaseCount: record.get('releaseCount').toNumber()
                        }
                    });
                } finally {
                    await session.close();
                }
            } catch (error) {
                console.error('Label details failed:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        /**
         * GET /api/groups/:groupId/details
         * Get comprehensive group information
         */
        this.app.get('/api/groups/:groupId/details', async (req, res) => {
            try {
                const session = this.db.driver.session();
                try {
                    const result = await session.run(`
                        MATCH (g:Group {group_id: $groupId})
                        OPTIONAL MATCH (g)-[:PERFORMED_ON]->(t:Track)
                        OPTIONAL MATCH (t)-[:IN_RELEASE]->(r:Release)
                        OPTIONAL MATCH (p:Person)-[m:MEMBER_OF]->(g)

                        RETURN g,
                               count(DISTINCT t) as trackCount,
                               count(DISTINCT r) as releaseCount,
                               collect(DISTINCT {
                                   person: p.name,
                                   role: m.role,
                                   from: m.from_date,
                                   to: m.to_date
                               }) as members
                    `, { groupId: req.params.groupId });

                    if (result.records.length === 0) {
                        return res.status(404).json({
                            success: false,
                            error: 'Group not found'
                        });
                    }

                    const record = result.records[0];
                    const group = record.get('g').properties;

                    res.json({
                        success: true,
                        group: {
                            ...group,
                            trackCount: record.get('trackCount').toNumber(),
                            releaseCount: record.get('releaseCount').toNumber(),
                            members: record.get('members')
                        }
                    });
                } finally {
                    await session.close();
                }
            } catch (error) {
                console.error('Group details failed:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // ========== STATS ENDPOINTS ==========

        /**
         * GET /api/stats
         * Get overall system statistics
         */
        this.app.get('/api/stats', async (req, res) => {
            try {
                const dbStats = await this.db.getStats();
                const storageStats = this.store.getStats();

                res.json({
                    success: true,
                    database: dbStats,
                    storage: storageStats,
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                console.error('Stats retrieval failed:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        /**
         * GET /api/graph/initial
         * Get initial graph data for visualization
         */
        this.app.get('/api/graph/initial', async (req, res) => {
            try {
                const session = this.db.driver.session();
                try {
                    // Get top groups by track count for initial load
                    const result = await session.run(`
                        MATCH (g:Group)-[:PERFORMED_ON]->(t:Track)
                        WITH g, count(t) as trackCount
                        ORDER BY trackCount DESC
                        LIMIT 20

                        MATCH (g)-[:PERFORMED_ON]->(t:Track)
                        MATCH (p:Person)-[m:MEMBER_OF]->(g)

                        RETURN collect(DISTINCT {
                            id: g.group_id,
                            name: g.name,
                            type: 'group',
                            trackCount: trackCount
                        }) as groups,
                        collect(DISTINCT {
                            id: p.person_id,
                            name: p.name,
                            type: 'person'
                        }) as persons,
                        collect(DISTINCT {
                            source: p.person_id,
                            target: g.group_id,
                            type: 'MEMBER_OF',
                            role: m.role,
                            from_date: m.from_date,
                            to_date: m.to_date,
                            instruments: m.instruments
                        }) as edges
                    `);

                    if (result.records.length === 0) {
                        return res.json({
                            success: true,
                            nodes: [],
                            edges: []
                        });
                    }

                    const groups = result.records[0].get('groups');
                    const persons = result.records[0].get('persons');
                    const edges = result.records[0].get('edges');

                    res.json({
                        success: true,
                        nodes: [...groups, ...persons],
                        edges: edges
                    });
                } finally {
                    await session.close();
                }
            } catch (error) {
                console.error('Initial graph failed:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        console.log(' REST endpoints configured');
    }

    /**
     * Setup error handling middleware
     */
    setupErrorHandling() {
        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({
                success: false,
                error: 'Endpoint not found',
                path: req.path
            });
        });

        // Global error handler
        this.app.use((err, req, res, next) => {
            console.error('Unhandled error:', err);

            res.status(err.status || 500).json({
                success: false,
                error: err.message || 'Internal server error',
                ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
            });
        });
    }

    /**
     * Start the server
     *
     * @returns {Promise<void>}
     */
    async start() {
        // Test database connection
        const dbConnected = await this.db.testConnection();
        if (!dbConnected) {
            console.error(' Failed to connect to database');
            throw new Error('Database connection failed');
        }
        console.log(' Database connected');

        // Initialize database schema (constraints, indexes)
        // Controlled by GRAPH_INIT_SCHEMA env var (default: true in dev, configurable in prod)
        const shouldInitSchema = process.env.GRAPH_INIT_SCHEMA !== 'false';
        if (shouldInitSchema) {
            try {
                await this.db.initializeSchema();
                console.log(' Database schema initialized');
            } catch (error) {
                console.error(' Schema initialization failed:', error.message);
                // Don't throw - allow server to start even if schema init fails
                // This is safe because queries will still work, just without constraints
                console.warn('  Continuing without schema initialization');
            }
        } else {
            console.log(' Schema initialization skipped (GRAPH_INIT_SCHEMA=false)');
        }

        // Run pending migrations (optional, controlled by env var)
        const shouldRunMigrations = process.env.GRAPH_RUN_MIGRATIONS === 'true';
        if (shouldRunMigrations) {
            try {
                const { runPendingMigrations } = await import('../graph/migrationRunner.js');
                await runPendingMigrations(this.db.driver);
                console.log(' Migrations completed');
            } catch (error) {
                console.error(' Migration failed:', error.message);
                console.warn('  Continuing despite migration failure');
            }
        }

        // Test storage connectivity
        const storageStatus = await this.store.testConnectivity();
        console.log(' Storage status:', storageStatus);

        // Start listening
        return new Promise((resolve) => {
            this.server = this.app.listen(this.port, () => {
                console.log(`\n=� Polaris Music Registry API Server`);
                console.log(`   GraphQL: http://localhost:${this.port}/graphql`);
                console.log(`   REST:    http://localhost:${this.port}/api`);
                console.log(`   Health:  http://localhost:${this.port}/health`);
                console.log(`\n Server ready\n`);
                resolve();
            });
        });
    }

    /**
     * Stop the server and cleanup
     *
     * @returns {Promise<void>}
     */
    async stop() {
        console.log('\nShutting down server...');

        // Close database connections
        await this.db.close();

        // Close storage connections
        await this.store.close();

        // Close HTTP server
        if (this.server) {
            await new Promise((resolve) => {
                this.server.close(resolve);
            });
        }

        console.log(' Server stopped');
    }
}

export default APIServer;
