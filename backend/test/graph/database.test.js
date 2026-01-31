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
import neo4j from 'neo4j-driver';

// Mock Neo4j driver for unit testing
// In integration tests, use real Neo4j instance
jest.mock('neo4j-driver');

// TODO: These tests need to be restructured for Jest ESM module mocking
// The current approach of setting neo4j.auth and using mockImplementation
// doesn't work in ESM mode. See: https://jestjs.io/docs/ecmascript-modules
describe.skip('MusicGraphDatabase', () => {
    let db;
    let mockDriver;
    let mockSession;
    let mockTx;

    beforeEach(() => {
        // Setup mocks
        mockTx = {
            run: jest.fn().mockResolvedValue({ records: [] }),
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

        // Mock the neo4j module functions
        neo4j.driver = jest.fn().mockReturnValue(mockDriver);
        neo4j.auth = {
            basic: jest.fn().mockReturnValue({})
        };

        // Create database instance
        db = new MusicGraphDatabase({
            uri: 'bolt://localhost:7687',
            user: 'neo4j',
            password: 'test'
        });

        // Replace driver with our mock
        db.driver = mockDriver;
    });

    afterEach(async () => {
        await db.close();
        jest.clearAllMocks();
    });

    describe('Constructor', () => {
        test('should require configuration', () => {
            expect(() => {
                new MusicGraphDatabase({});
            }).toThrow('Database configuration requires uri, user, and password');
        });

        test('should accept valid configuration', () => {
            const database = new MusicGraphDatabase({
                uri: 'bolt://localhost:7687',
                user: 'neo4j',
                password: 'password'
            });

            expect(database.config).toBeDefined();
            expect(database.config.uri).toBe('bolt://localhost:7687');
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

        test('should handle errors gracefully', async () => {
            mockSession.run.mockRejectedValue(new Error('Connection failed'));

            await expect(db.initializeSchema()).rejects.toThrow('Connection failed');
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
                tracks: [],
                tracklist: []
            };

            mockTx.run.mockResolvedValue({ records: [{ get: () => 'test-id' }] });

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
                    format: ['LP'],
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
                        title: 'Back in the U.S.S.R.',
                        duration: 163,
                        performed_by_groups: [{ group_id: 'prov:group:beatles' }]
                    },
                    {
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

            mockTx.run.mockResolvedValue({ records: [] });

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
                tracks: [],
                tracklist: []
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
            ).rejects.toThrow('Invalid release bundle');
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
                    title: 'Test Track',
                    performed_by_groups: [{ group_id: 'group:test' }],
                    guests: [
                        { name: 'Guest Musician', instruments: ['saxophone'] }
                    ]
                }],
                tracklist: [{ track_id: 'track:test', track_number: 1 }]
            };

            mockTx.run.mockResolvedValue({ records: [] });

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
                            track_count: { toNumber: () => 213 },
                            total_tracks: { toNumber: () => 213 },
                            participationPercentage: 100.0,
                            releaseCount: { toNumber: () => 13 }
                        };
                        return data[field];
                    }
                },
                {
                    get: (field) => {
                        const data = {
                            personId: 'person:2',
                            personName: 'Paul McCartney',
                            track_count: { toNumber: () => 210 },
                            total_tracks: { toNumber: () => 213 },
                            participationPercentage: 98.6,
                            releaseCount: { toNumber: () => 13 }
                        };
                        return data[field];
                    }
                }
            ];

            mockSession.run.mockResolvedValue({ records: mockRecords });

            const result = await db.calculateGroupMemberParticipation('group:beatles');

            expect(result).toHaveLength(2);
            expect(result[0].personName).toBe('John Lennon');
            expect(result[0].participationPercentage).toBe(100.0);
            expect(result[1].participationPercentage).toBe(98.6);
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

            mockTx.run.mockResolvedValue({ records: [] });

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
