/**
 * @fileoverview Tests for the MusicGraphDatabase class
 *
 * Tests cover:
 * - Schema initialization
 * - Release bundle processing
 * - Member participation calculations
 * - Duplicate detection
 * - Connection management
 */

import { jest } from '@jest/globals';
import MusicGraphDatabase from '../../src/graph/schema.js';

// No module mocking. jest.mock() does not intercept ESM imports, which is why
// this suite used to be skipped. It is also unnecessary: neo4j.driver() is
// lazy — it opens no socket until a query runs — so the constructor succeeds
// against the real module and we simply swap db.driver for a fake afterwards.
// Everything under test goes through this.driver, so the fake is sufficient.
describe('MusicGraphDatabase', () => {
    let db;
    let mockDriver;
    let mockSession;
    let mockTx;
    let realDriver;

    beforeEach(() => {
        // Setup mocks
        mockTx = {
            // Most queries are writes whose rows nothing reads. IN_RELEASE is
            // the exception: processReleaseBundle RETURNs the linked track and
            // throws when no row comes back, so the fake has to answer it.
            run: jest.fn().mockImplementation((query) => {
                if (typeof query === 'string' && query.includes('IN_RELEASE')) {
                    return Promise.resolve({ records: [{ get: () => 'linked' }] });
                }
                return Promise.resolve({ records: [] });
            }),
            commit: jest.fn().mockResolvedValue(undefined),
            rollback: jest.fn().mockResolvedValue(undefined)
        };

        mockSession = {
            run: jest.fn().mockResolvedValue({ records: [] }),
            beginTransaction: jest.fn().mockReturnValue(mockTx),
            close: jest.fn().mockResolvedValue(undefined)
        };

        mockDriver = {
            session: jest.fn().mockReturnValue(mockSession),
            close: jest.fn().mockResolvedValue(undefined)
        };

        // Create database instance
        db = new MusicGraphDatabase({
            uri: 'bolt://localhost:7687',
            user: 'neo4j',
            password: 'test'
        });

        // Close the real (never-connected) driver, then swap in the fake.
        realDriver = db.driver;
        db.driver = mockDriver;
    });

    afterEach(async () => {
        await db.close();
        await realDriver.close();
        jest.clearAllMocks();
    });

    describe('Constructor', () => {
        // Every variable the constructor consults, in the order schema.js
        // reads them. The constructor resolves each field from config OR the
        // environment, so a test that asserts on config validation has to say
        // what the environment holds — otherwise it passes on a dev machine
        // with nothing set and fails in CI, which exports GRAPH_*.
        const CONFIG_ENV_KEYS = [
            'GRAPH_URI', 'NEO4J_URI', 'NEO4J_URL',
            'GRAPH_USER', 'NEO4J_USER',
            'GRAPH_PASSWORD', 'NEO4J_PASSWORD'
        ];

        /**
         * Run fn with CONFIG_ENV_KEYS forced to the given values.
         * A key mapped to undefined is deleted. Everything is restored
         * afterwards, including on failure, so one test cannot leak
         * environment state into the next.
         */
        const withEnv = async (vars, fn) => {
            const saved = {};
            for (const key of CONFIG_ENV_KEYS) {
                saved[key] = process.env[key];
                if (vars[key] === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = vars[key];
                }
            }
            try {
                return await fn();
            } finally {
                for (const key of CONFIG_ENV_KEYS) {
                    if (saved[key] === undefined) {
                        delete process.env[key];
                    } else {
                        process.env[key] = saved[key];
                    }
                }
            }
        };

        test('should require configuration when the environment supplies none', async () => {
            await withEnv({}, () => {
                expect(() => {
                    new MusicGraphDatabase({});
                }).toThrow('Database configuration requires uri, user, and password');
            });
        });

        test('falls back to the environment when config omits the fields', async () => {
            // Deliberate behavior that CI depends on: the Backend CI job
            // exports GRAPH_* and constructs with no explicit config.
            await withEnv({
                GRAPH_URI: 'bolt://env-host:7687',
                GRAPH_USER: 'env-user',
                GRAPH_PASSWORD: 'env-password'
            }, async () => {
                const database = new MusicGraphDatabase({});

                expect(database.resolved.uri).toBe('bolt://env-host:7687');
                expect(database.resolved.user).toBe('env-user');
                expect(database.resolved.password).toBe('env-password');

                await database.close();
            });
        });

        test('explicit config wins over the environment', async () => {
            await withEnv({
                GRAPH_URI: 'bolt://env-host:7687',
                GRAPH_USER: 'env-user',
                GRAPH_PASSWORD: 'env-password'
            }, async () => {
                const database = new MusicGraphDatabase({
                    uri: 'bolt://explicit:7687',
                    user: 'explicit-user',
                    password: 'explicit-password'
                });

                expect(database.resolved.uri).toBe('bolt://explicit:7687');
                expect(database.resolved.user).toBe('explicit-user');

                await database.close();
            });
        });

        test('should accept valid configuration', () => {
            const database = new MusicGraphDatabase({
                uri: 'bolt://localhost:7687',
                user: 'neo4j',
                password: 'password'
            });

            expect(database.resolved).toBeDefined();
            expect(database.resolved.uri).toBe('bolt://localhost:7687');

            return database.close();
        });
    });

    describe('initializeSchema()', () => {
        test('should create all constraints and indexes', async () => {
            await db.initializeSchema();

            // Verify session was created and closed
            expect(mockDriver.session).toHaveBeenCalled();
            expect(mockSession.close).toHaveBeenCalled();

            // Verify constraint and index creation queries were run
            const calls = mockSession.run.mock.calls;
            expect(calls.length).toBeGreaterThan(0);

            // Check for specific constraints
            const queries = calls.map(call => call[0]);
            expect(queries.some(q => q.includes('person_id'))).toBe(true);
            expect(queries.some(q => q.includes('group_id'))).toBe(true);
            expect(queries.some(q => q.includes('track_id'))).toBe(true);
        });

        test('tolerates individual constraint failures and still closes', async () => {
            // Schema init is deliberately idempotent: each CREATE CONSTRAINT
            // failure is warned about and skipped so a re-run against an
            // already-provisioned database is a no-op. It does not reject.
            mockSession.run.mockRejectedValue(new Error('Connection failed'));

            await expect(db.initializeSchema()).resolves.not.toThrow();
            expect(mockSession.close).toHaveBeenCalled();
        });
    });

    describe('processReleaseBundle()', () => {
        const mockEventHash = 'abc123def456';
        const mockSubmitter = 'testaccount';

        test('should process minimal release bundle', async () => {
            const bundle = {
                release: {
                    name: 'Test Album',
                    release_date: '2024-01-01'
                },
                groups: [],
                tracks: [
                    { track_id: 'prov:track:only', title: 'Only Track' }
                ],
                tracklist: [
                    { track_id: 'prov:track:only', track_number: 1, disc_number: 1 }
                ]
            };

            const result = await db.processReleaseBundle(mockEventHash, bundle, mockSubmitter);

            expect(result.success).toBe(true);
            expect(result.releaseId).toBeDefined();
            expect(mockTx.commit).toHaveBeenCalled();
            expect(mockSession.close).toHaveBeenCalled();
        });

        test('should process full Beatles White Album bundle', async () => {
            const bundle = {
                release: {
                    name: 'The Beatles',
                    alt_names: ['The White Album'],
                    release_date: '1968-11-22',
                    format: 'LP',
                    labels: [{
                        name: 'Apple Records'
                    }]
                },
                groups: [{
                    name: 'The Beatles',
                    members: [
                        { name: 'John Lennon', instruments: ['vocals', 'guitar'] },
                        { name: 'Paul McCartney', instruments: ['vocals', 'bass'] },
                        { name: 'George Harrison', instruments: ['guitar', 'vocals'] },
                        { name: 'Ringo Starr', instruments: ['drums'] }
                    ]
                }],
                tracks: [
                    {
                        track_id: 'prov:track:ussr',
                        title: 'Back in the U.S.S.R.',
                        duration: 163,
                        performed_by_groups: [{ group_id: 'prov:group:beatles' }]
                    },
                    {
                        track_id: 'prov:track:prudence',
                        title: 'Dear Prudence',
                        duration: 234,
                        performed_by_groups: [{ group_id: 'prov:group:beatles' }]
                    }
                ],
                tracklist: [
                    { track_id: 'prov:track:ussr', track_number: 1, disc_number: 1 },
                    { track_id: 'prov:track:prudence', track_number: 2, disc_number: 1 }
                ],
                sources: [
                    { url: 'https://www.discogs.com/release/123456' }
                ]
            };

            const result = await db.processReleaseBundle(mockEventHash, bundle, mockSubmitter);

            expect(result.success).toBe(true);
            expect(result.stats.groups_created).toBe(1);
            expect(result.stats.tracks_created).toBe(2);
            expect(mockTx.commit).toHaveBeenCalled();
        });

        test('should rollback on error', async () => {
            const bundle = {
                release: { name: 'Test' },
                groups: [],
                tracks: [{ track_id: 'prov:track:one', title: 'One' }],
                tracklist: [{ track_id: 'prov:track:one', track_number: 1 }]
            };

            mockTx.run.mockRejectedValue(new Error('Database error'));

            await expect(
                db.processReleaseBundle(mockEventHash, bundle, mockSubmitter)
            ).rejects.toThrow('Database error');

            expect(mockTx.rollback).toHaveBeenCalled();
            expect(mockSession.close).toHaveBeenCalled();
        });

        test('should validate required fields', async () => {
            await expect(
                db.processReleaseBundle(null, {}, mockSubmitter)
            ).rejects.toThrow('Invalid release bundle: missing required fields');
        });

        test('surfaces the validation error even when the event hash is null', async () => {
            // Regression: the failure path logged eventHash.substring(0, 16)
            // unconditionally, so a null hash replaced the real validation
            // message with "Cannot read properties of null".
            await expect(
                db.processReleaseBundle(null, {}, mockSubmitter)
            ).rejects.not.toThrow(/Cannot read properties of null/);
        });

        test('links IN_RELEASE using the resolved track id, not the bundle id', async () => {
            // Regression for the tracklist id mismatch that silently emptied
            // every release orbit. Provisional ids in a bundle are placeholders:
            // resolveEntityId mints a fresh fingerprint id for the Track node,
            // so the tracklist's raw reference matches nothing. The Cypher is a
            // MATCH, and a MATCH that finds nothing yields no rows — the MERGE
            // was skipped without an error, leaving a Release with no tracks.
            const bundle = {
                release: { name: 'Orbit Test', release_date: '2024-01-01' },
                groups: [],
                tracks: [
                    { track_id: 'prov:track:placeholder', title: 'First' }
                ],
                tracklist: [
                    { track_id: 'prov:track:placeholder', track_number: 1, disc_number: 1 }
                ]
            };

            await db.processReleaseBundle(mockEventHash, bundle, mockSubmitter);

            const calls = mockTx.run.mock.calls;

            const trackMerge = calls.find(([q]) => q.includes('MERGE (t:Track {track_id: $trackId})'));
            expect(trackMerge).toBeDefined();
            const createdTrackId = trackMerge[1].trackId;

            const linkCall = calls.find(([q]) => q.includes('IN_RELEASE'));
            expect(linkCall).toBeDefined();

            // The link must target the id the node was actually created under.
            expect(linkCall[1].trackId).toBe(createdTrackId);

            // And that id must differ from the bundle's placeholder — otherwise
            // this test would still pass with the translation removed.
            expect(createdTrackId).not.toBe('prov:track:placeholder');
        });

        test('throws when a tracklist item matches no Track node', async () => {
            // The MATCH returning no rows must be an error, not a silent skip.
            mockTx.run.mockImplementation((query) => {
                if (typeof query === 'string' && query.includes('IN_RELEASE')) {
                    return Promise.resolve({ records: [] });
                }
                return Promise.resolve({ records: [] });
            });

            const bundle = {
                release: { name: 'Orphan Test' },
                groups: [],
                tracks: [{ track_id: 'prov:track:orphan', title: 'Orphan' }],
                tracklist: [{ track_id: 'prov:track:orphan', track_number: 1 }]
            };

            await expect(
                db.processReleaseBundle(mockEventHash, bundle, mockSubmitter)
            ).rejects.toThrow(/could not be linked to a Track node/);

            expect(mockTx.rollback).toHaveBeenCalled();
        });

        test('should handle groups with guests', async () => {
            const bundle = {
                release: {
                    name: 'Test Album'
                },
                groups: [{
                    name: 'Test Group',
                    members: [{ name: 'Member One' }]
                }],
                tracks: [{
                    track_id: 'prov:track:test',
                    title: 'Test Track',
                    performed_by_groups: [{ group_id: 'group:test' }],
                    guests: [
                        { name: 'Guest Musician', instruments: ['saxophone'] }
                    ]
                }],
                tracklist: [{ track_id: 'prov:track:test', track_number: 1 }]
            };

            const result = await db.processReleaseBundle(mockEventHash, bundle, mockSubmitter);

            expect(result.success).toBe(true);

            // Verify GUEST_ON relationships were created
            const queries = mockTx.run.mock.calls.map(call => call[0]);
            expect(queries.some(q => q.includes('GUEST_ON'))).toBe(true);
        });
    });

    describe('calculateGroupMemberParticipation()', () => {
        test('should calculate participation percentages', async () => {
            const mockRecords = [
                {
                    get: (field) => {
                        const data = {
                            personId: 'person:1',
                            personName: 'John Lennon',
                            color: '#E74C3C',
                            trackCount: { toNumber: () => 213 },
                            totalTracks: { toNumber: () => 213 },
                            trackPctOfGroupTracks: 100.0
                        };
                        return data[field];
                    }
                },
                {
                    get: (field) => {
                        const data = {
                            personId: 'person:2',
                            personName: 'Paul McCartney',
                            color: '#3498DB',
                            trackCount: { toNumber: () => 210 },
                            totalTracks: { toNumber: () => 213 },
                            trackPctOfGroupTracks: 98.6
                        };
                        return data[field];
                    }
                }
            ];

            mockSession.run.mockResolvedValue({ records: mockRecords });

            const result = await db.calculateGroupMemberParticipation('group:beatles');

            expect(result).toHaveLength(2);
            expect(result[0].personName).toBe('John Lennon');
            expect(result[0].trackPctOfGroupTracks).toBe(100.0);
            expect(result[0].trackCount).toBe(213);
            expect(result[1].trackPctOfGroupTracks).toBe(98.6);
            expect(result[1].trackCount).toBe(210);
        });

        test('should handle groups with no members', async () => {
            mockSession.run.mockResolvedValue({ records: [] });

            const result = await db.calculateGroupMemberParticipation('group:unknown');

            expect(result).toEqual([]);
        });
    });

    describe('findPotentialDuplicates()', () => {
        test('should find similar names', async () => {
            const mockRecords = [
                {
                    get: (field) => ({
                        id: 'id:1',
                        name: 'The Beatles',
                        altNames: ['Fab Four'],
                        status: 'ACTIVE'
                    }[field])
                }
            ];

            mockSession.run.mockResolvedValue({ records: mockRecords });

            const result = await db.findPotentialDuplicates('Group', 'Beatles');

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('The Beatles');
        });
    });

    describe('generateProvisionalId()', () => {
        test('should generate consistent IDs for groups', () => {
            const group1 = { name: 'The Beatles', members: [{ name: 'John' }] };
            const group2 = { name: 'The Beatles', members: [{ name: 'John' }] };

            const id1 = db.generateProvisionalId('group', group1);
            const id2 = db.generateProvisionalId('group', group2);

            expect(id1).toBe(id2);
            expect(id1).toMatch(/^prov:group:[a-f0-9]{16}$/);
        });

        test('should generate different IDs for different data', () => {
            const group1 = { name: 'The Beatles' };
            const group2 = { name: 'The Rolling Stones' };

            const id1 = db.generateProvisionalId('group', group1);
            const id2 = db.generateProvisionalId('group', group2);

            expect(id1).not.toBe(id2);
        });

        test('should generate IDs for all entity types', () => {
            const types = ['person', 'group', 'track', 'song', 'release', 'label', 'city'];

            types.forEach(type => {
                const id = db.generateProvisionalId(type, { name: 'Test' });
                expect(id).toMatch(new RegExp(`^prov:${type}:[a-f0-9]{16}$`));
            });
        });
    });

    describe('processAddClaim()', () => {
        test('should add claim to existing entity', async () => {
            const claimData = {
                node: { type: 'Person', id: 'person:123' },
                field: 'bio',
                value: 'Updated biography',
                source: { url: 'https://source.com' }
            };

            mockTx.run.mockResolvedValue({ records: [{ get: () => 'person:123' }] });

            const result = await db.processAddClaim('event123', claimData, 'user1');

            expect(result.success).toBe(true);
            expect(result.claimId).toBeDefined();
            expect(mockTx.commit).toHaveBeenCalled();
        });

        test('should validate claim data', async () => {
            await expect(
                db.processAddClaim('event123', {}, 'user1')
            ).rejects.toThrow('Invalid claim data');
        });
    });

    describe('Connection Management', () => {
        test('should test connection successfully', async () => {
            mockSession.run.mockResolvedValue({ records: [] });

            const isConnected = await db.testConnection();

            expect(isConnected).toBe(true);
            expect(mockSession.run).toHaveBeenCalledWith('RETURN 1');
        });

        test('should handle connection failure', async () => {
            mockSession.run.mockRejectedValue(new Error('Connection refused'));

            const isConnected = await db.testConnection();

            expect(isConnected).toBe(false);
        });

        test('should close connections', async () => {
            await db.close();

            expect(mockDriver.close).toHaveBeenCalled();
        });
    });

    describe('getStats()', () => {
        test('should return node statistics', async () => {
            const mockRecords = [
                { get: (f) => f === 'type' ? 'Person' : { toNumber: () => 100 } },
                { get: (f) => f === 'type' ? 'Group' : { toNumber: () => 50 } },
                { get: (f) => f === 'type' ? 'Track' : { toNumber: () => 500 } }
            ];

            mockSession.run.mockResolvedValue({ records: mockRecords });

            const stats = await db.getStats();

            expect(stats.nodes).toBeDefined();
            expect(stats.nodes.Person).toBe(100);
            expect(stats.nodes.Group).toBe(50);
            expect(stats.nodes.Track).toBe(500);
        });
    });
});

describe('Integration Tests (requires Neo4j)', () => {
    // These tests should only run when TEST_INTEGRATION=true
    const shouldRunIntegration = process.env.TEST_INTEGRATION === 'true';

    if (!shouldRunIntegration) {
        test.skip('Integration tests skipped (set TEST_INTEGRATION=true to run)', () => {});
        return;
    }

    let db;

    beforeAll(async () => {
        db = new MusicGraphDatabase({
            uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
            user: process.env.NEO4J_USER || 'neo4j',
            password: process.env.NEO4J_PASSWORD || 'password'
        });

        // Initialize schema
        await db.initializeSchema();
    });

    afterAll(async () => {
        await db.close();
    });

    test('should connect to real database', async () => {
        const isConnected = await db.testConnection();
        expect(isConnected).toBe(true);
    });

    test('should process real release bundle', async () => {
        const bundle = {
            release: {
                name: 'Test Release ' + Date.now(),
                release_date: '2024-01-01'
            },
            groups: [{
                name: 'Test Group ' + Date.now(),
                members: [{ name: 'Test Artist' }]
            }],
            tracks: [{
                title: 'Test Track',
                performed_by_groups: []
            }],
            tracklist: []
        };

        const result = await db.processReleaseBundle(
            'test-event-' + Date.now(),
            bundle,
            'testuser'
        );

        expect(result.success).toBe(true);
        expect(result.releaseId).toBeDefined();
    });
});
