/**
 * @fileoverview Integration tests for the API server
 *
 * Tests cover:
 * - GraphQL queries and mutations
 * - REST endpoints
 * - Error handling
 * - Database and storage integration
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import APIServer from '../../src/api/server.js';
import MusicGraphDatabase from '../../src/graph/schema.js';
import EventStore from '../../src/storage/eventStore.js';

// Mock dependencies
jest.mock('../../src/graph/schema.js');
jest.mock('../../src/storage/eventStore.js');

describe('API Server Integration Tests', () => {
    let server;
    let app;
    let mockDb;
    let mockStore;

    beforeAll(async () => {
        // Setup mocks
        mockDb = {
            driver: {
                session: jest.fn(() => ({
                    run: jest.fn().mockResolvedValue({ records: [] }),
                    close: jest.fn().mockResolvedValue(undefined)
                }))
            },
            testConnection: jest.fn().mockResolvedValue(true),
            getStats: jest.fn().mockResolvedValue({
                nodes: {
                    Person: 100,
                    Group: 50,
                    Track: 500
                }
            }),
            calculateGroupMemberParticipation: jest.fn().mockResolvedValue([
                {
                    personId: 'person:1',
                    personName: 'John Lennon',
                    participationPercentage: 100.0,
                    trackCount: 213,
                    releaseCount: 13
                }
            ]),
            close: jest.fn().mockResolvedValue(undefined)
        };

        mockStore = {
            storeEvent: jest.fn().mockResolvedValue({
                hash: 'abc123',
                ipfs: 'QmTest',
                s3: 's3://bucket/test',
                redis: true,
                errors: []
            }),
            retrieveEvent: jest.fn().mockResolvedValue({
                v: 1,
                type: 'TEST',
                body: {}
            }),
            testConnectivity: jest.fn().mockResolvedValue({
                ipfs: true,
                s3: true,
                redis: true
            }),
            getStats: jest.fn().mockResolvedValue({
                stored: 10,
                retrieved: 5,
                cacheHits: 3,
                enabled: {
                    ipfs: true,
                    s3: true,
                    redis: true
                }
            }),
            close: jest.fn().mockResolvedValue(undefined)
        };

        MusicGraphDatabase.mockImplementation(() => mockDb);
        EventStore.mockImplementation(() => mockStore);

        // Create server instance
        server = new APIServer({
            port: 0, // Use random port for testing
            database: {
                uri: 'bolt://localhost:7687',
                user: 'neo4j',
                password: 'test'
            },
            storage: {
                ipfs: { url: 'http://localhost:5001' },
                s3: { endpoint: 'http://localhost:9000', bucket: 'test' },
                redis: { host: 'localhost' }
            }
        });

        app = server.app;
    });

    afterAll(async () => {
        await server.stop();
    });

    describe('Health Check', () => {
        test('GET /health should return healthy status', async () => {
            const response = await request(app)
                .get('/health')
                .expect(200);

            expect(response.body.status).toBe('healthy');
            expect(response.body.timestamp).toBeDefined();
            expect(response.body.uptime).toBeGreaterThanOrEqual(0);
        });
    });

    describe('GraphQL Endpoint', () => {
        test('should query person by ID', async () => {
            // Mock database response
            const mockSession = {
                run: jest.fn().mockResolvedValue({
                    records: [{
                        get: () => ({
                            properties: {
                                person_id: 'person:1',
                                name: 'John Lennon',
                                alt_names: ['Johnny'],
                                status: 'canonical'
                            }
                        })
                    }]
                }),
                close: jest.fn()
            };
            mockDb.driver.session.mockReturnValue(mockSession);

            const query = `
                query {
                    person(person_id: "person:1") {
                        person_id
                        name
                        alt_names
                        status
                    }
                }
            `;

            const response = await request(app)
                .post('/graphql')
                .send({ query })
                .expect(200);

            expect(response.body.data.person).toEqual({
                person_id: 'person:1',
                name: 'John Lennon',
                alt_names: ['Johnny'],
                status: 'canonical'
            });
        });

        test('should query group participation', async () => {
            const query = `
                query {
                    groupParticipation(group_id: "group:beatles") {
                        person {
                            person_id
                            name
                        }
                        participation_percentage
                        track_count
                    }
                }
            `;

            const response = await request(app)
                .post('/graphql')
                .send({ query })
                .expect(200);

            expect(response.body.data.groupParticipation).toHaveLength(1);
            expect(response.body.data.groupParticipation[0].person.name).toBe('John Lennon');
            expect(response.body.data.groupParticipation[0].participation_percentage).toBe(100.0);
        });

        test('should query stats', async () => {
            const query = `
                query {
                    stats {
                        nodes {
                            Person
                            Group
                            Track
                            total
                        }
                        enabled_services {
                            ipfs
                            s3
                            redis
                        }
                    }
                }
            `;

            const response = await request(app)
                .post('/graphql')
                .send({ query })
                .expect(200);

            expect(response.body.data.stats.nodes.Person).toBe(100);
            expect(response.body.data.stats.nodes.total).toBe(650);
            expect(response.body.data.stats.enabled_services.ipfs).toBe(true);
        });

        test('should submit event via mutation', async () => {
            const mutation = `
                mutation {
                    submitEvent(event: "{\\"v\\":1,\\"type\\":\\"TEST\\",\\"body\\":{}}")
                }
            `;

            const response = await request(app)
                .post('/graphql')
                .send({ query: mutation })
                .expect(200);

            expect(mockStore.storeEvent).toHaveBeenCalled();
        });

        test('should handle GraphQL errors gracefully', async () => {
            const invalidQuery = `
                query {
                    nonExistentField
                }
            `;

            const response = await request(app)
                .post('/graphql')
                .send({ query: invalidQuery })
                .expect(400);

            expect(response.body.errors).toBeDefined();
        });
    });

    describe('REST Endpoints - Events', () => {
        test('POST /api/events/create should store event', async () => {
            const event = {
                v: 1,
                type: 'CREATE_RELEASE_BUNDLE',
                author_pubkey: 'test',
                created_at: Date.now(),
                parents: [],
                body: { release: { name: 'Test Album' } },
                sig: 'test_sig'
            };

            const response = await request(app)
                .post('/api/events/create')
                .send(event)
                .expect(201);

            expect(response.body.success).toBe(true);
            expect(response.body.hash).toBe('abc123');
            expect(response.body.stored.ipfs).toBe('QmTest');
            expect(mockStore.storeEvent).toHaveBeenCalledWith(event);
        });

        test('POST /api/events/create should handle validation errors', async () => {
            mockStore.storeEvent.mockRejectedValueOnce(new Error('Invalid event'));

            const response = await request(app)
                .post('/api/events/create')
                .send({ invalid: 'event' })
                .expect(400);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toBeDefined();
        });

        test('GET /api/events/:hash should retrieve event', async () => {
            const response = await request(app)
                .get('/api/events/abc123')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.event).toBeDefined();
            expect(mockStore.retrieveEvent).toHaveBeenCalledWith('abc123');
        });

        test('GET /api/events/:hash should handle not found', async () => {
            mockStore.retrieveEvent.mockRejectedValueOnce(new Error('Event not found'));

            const response = await request(app)
                .get('/api/events/nonexistent')
                .expect(404);

            expect(response.body.success).toBe(false);
        });
    });

    describe('REST Endpoints - Groups', () => {
        test('GET /api/groups/:groupId/participation should return participation data', async () => {
            const response = await request(app)
                .get('/api/groups/group:beatles/participation')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.groupId).toBe('group:beatles');
            expect(response.body.members).toHaveLength(1);
            expect(response.body.members[0].personName).toBe('John Lennon');
        });

        test('GET /api/groups/:groupId/details should return full group info', async () => {
            const mockSession = {
                run: jest.fn().mockResolvedValue({
                    records: [{
                        get: (field) => {
                            if (field === 'g') {
                                return {
                                    properties: {
                                        group_id: 'group:beatles',
                                        name: 'The Beatles'
                                    }
                                };
                            }
                            if (field === 'trackCount' || field === 'releaseCount') {
                                return { toNumber: () => 10 };
                            }
                            if (field === 'members') {
                                return [{ person: 'John Lennon', role: 'vocals' }];
                            }
                        }
                    }]
                }),
                close: jest.fn()
            };
            mockDb.driver.session.mockReturnValue(mockSession);

            const response = await request(app)
                .get('/api/groups/group:beatles/details')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.group.name).toBe('The Beatles');
            expect(response.body.group.trackCount).toBe(10);
        });

        test('GET /api/groups/:groupId/details should handle not found', async () => {
            const mockSession = {
                run: jest.fn().mockResolvedValue({ records: [] }),
                close: jest.fn()
            };
            mockDb.driver.session.mockReturnValue(mockSession);

            const response = await request(app)
                .get('/api/groups/nonexistent/details')
                .expect(404);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toBe('Group not found');
        });
    });

    describe('REST Endpoints - Stats', () => {
        test('GET /api/stats should return system statistics', async () => {
            const response = await request(app)
                .get('/api/stats')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.database).toBeDefined();
            expect(response.body.storage).toBeDefined();
            expect(response.body.timestamp).toBeDefined();
        });
    });

    describe('REST Endpoints - Graph Visualization', () => {
        test('GET /api/graph/initial should return initial graph data', async () => {
            const mockSession = {
                run: jest.fn().mockResolvedValue({
                    records: [{
                        get: (field) => {
                            if (field === 'groups') {
                                return [
                                    { id: 'group:1', name: 'The Beatles', type: 'group', trackCount: 100 }
                                ];
                            }
                            if (field === 'persons') {
                                return [
                                    { id: 'person:1', name: 'John Lennon', type: 'person' }
                                ];
                            }
                        }
                    }]
                }),
                close: jest.fn()
            };
            mockDb.driver.session.mockReturnValue(mockSession);

            const response = await request(app)
                .get('/api/graph/initial')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.nodes).toBeDefined();
            expect(response.body.edges).toBeDefined();
        });
    });

    describe('Error Handling', () => {
        test('should return 404 for unknown endpoints', async () => {
            const response = await request(app)
                .get('/api/nonexistent')
                .expect(404);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toBe('Endpoint not found');
        });

        test('should handle internal server errors', async () => {
            mockDb.calculateGroupMemberParticipation.mockRejectedValueOnce(
                new Error('Database error')
            );

            const response = await request(app)
                .get('/api/groups/test/participation')
                .expect(500);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toContain('Database error');
        });
    });

    describe('CORS', () => {
        test('should include CORS headers', async () => {
            const response = await request(app)
                .get('/health')
                .expect(200);

            expect(response.headers['access-control-allow-origin']).toBe('*');
        });

        test('should handle OPTIONS preflight requests', async () => {
            const response = await request(app)
                .options('/api/stats')
                .expect(200);

            expect(response.headers['access-control-allow-methods']).toBeDefined();
        });
    });
});

describe('Server Lifecycle', () => {
    test('should start and stop server cleanly', async () => {
        const mockDb = {
            testConnection: jest.fn().mockResolvedValue(true),
            close: jest.fn().mockResolvedValue(undefined)
        };

        const mockStore = {
            testConnectivity: jest.fn().mockResolvedValue({ ipfs: true, s3: true, redis: true }),
            close: jest.fn().mockResolvedValue(undefined)
        };

        MusicGraphDatabase.mockImplementation(() => mockDb);
        EventStore.mockImplementation(() => mockStore);

        const server = new APIServer({
            port: 0,
            database: { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'test' },
            storage: {
                ipfs: { url: 'http://localhost:5001' },
                s3: { endpoint: 'http://localhost:9000', bucket: 'test' },
                redis: { host: 'localhost' }
            }
        });

        await server.start();
        expect(mockDb.testConnection).toHaveBeenCalled();
        expect(mockStore.testConnectivity).toHaveBeenCalled();

        await server.stop();
        expect(mockDb.close).toHaveBeenCalled();
        expect(mockStore.close).toHaveBeenCalled();
    });

    test('should fail to start if database unavailable', async () => {
        const mockDb = {
            testConnection: jest.fn().mockResolvedValue(false)
        };

        MusicGraphDatabase.mockImplementation(() => mockDb);
        EventStore.mockImplementation(() => ({ testConnectivity: jest.fn() }));

        const server = new APIServer({
            port: 0,
            database: { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'test' },
            storage: {
                ipfs: { url: 'http://localhost:5001' },
                s3: { endpoint: 'http://localhost:9000', bucket: 'test' },
                redis: { host: 'localhost' }
            }
        });

        await expect(server.start()).rejects.toThrow('Database connection failed');
    });
});
