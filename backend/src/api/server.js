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
import { graphqlHTTP } from 'express-graphql';
import { buildSchema } from 'graphql';
import MusicGraphDatabase from '../graph/schema.js';
import EventStore from '../storage/eventStore.js';

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
        // Parse JSON bodies
        this.app.use(express.json({ limit: '10mb' }));

        // CORS headers
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

            if (req.method === 'OPTIONS') {
                return res.sendStatus(200);
            }

            next();
        });

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
                        RETURN p
                    `, { id: person_id });

                    if (result.records.length === 0) return null;

                    const person = result.records[0].get('p').properties;
                    return {
                        ...person,
                        alt_names: person.alt_names || []
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
                        RETURN g
                    `, { id: group_id });

                    if (result.records.length === 0) return null;

                    const group = result.records[0].get('g').properties;
                    return {
                        ...group,
                        alt_names: group.alt_names || []
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
                        RETURN r
                    `, { id: release_id });

                    if (result.records.length === 0) return null;

                    const release = result.records[0].get('r').properties;
                    return {
                        ...release,
                        alt_names: release.alt_names || [],
                        format: release.format || []
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
                        RETURN t
                    `, { id: track_id });

                    if (result.records.length === 0) return null;

                    const track = result.records[0].get('t').properties;
                    return {
                        ...track,
                        listen_links: track.listen_links || []
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
                        RETURN s
                    `, { id: song_id });

                    if (result.records.length === 0) return null;

                    const song = result.records[0].get('s').properties;
                    return {
                        ...song,
                        alt_titles: song.alt_titles || []
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
         * POST /api/events/create
         * Submit a new event to storage and blockchain
         */
        this.app.post('/api/events/create', async (req, res) => {
            try {
                const event = req.body;

                // Validate and store event
                const result = await this.store.storeEvent(event);

                res.status(201).json({
                    success: true,
                    hash: result.hash,
                    stored: {
                        ipfs: result.ipfs,
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
                        MATCH (p:Person)-[:MEMBER_OF]->(g)

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
                        }) as persons
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

                    res.json({
                        success: true,
                        nodes: [...groups, ...persons],
                        edges: [] // TODO: Add edges in future
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

        // Test storage connectivity
        const storageStatus = await this.store.testConnectivity();
        console.log(' Storage status:', storageStatus);

        // Start listening
        return new Promise((resolve) => {
            this.server = this.app.listen(this.port, () => {
                console.log(`\n=€ Polaris Music Registry API Server`);
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
