/**
 * @fileoverview End-to-end tests for event processing workflow
 *
 * Tests cover:
 * - Event processor initialization
 * - Blockchain polling
 * - Event fetching from storage
 * - Event processing into graph
 * - Error handling and recovery
 */

import { jest } from '@jest/globals';
import EventProcessor from '../../src/indexer/eventProcessor.js';
import { JsonRpc } from 'eosjs';
import MusicGraphDatabase from '../../src/graph/schema.js';
import EventStore from '../../src/storage/eventStore.js';

// Mock dependencies
jest.mock('eosjs');
jest.mock('../../src/graph/schema.js');
jest.mock('../../src/storage/eventStore.js');

describe('EventProcessor', () => {
    let processor;
    let mockDb;
    let mockStore;
    let mockRpc;

    beforeEach(() => {
        // Setup mocks
        mockDb = {
            testConnection: jest.fn().mockResolvedValue(true),
            processReleaseBundle: jest.fn().mockResolvedValue({
                success: true,
                releaseId: 'release:test',
                stats: { groups_created: 1, tracks_created: 5, songs_created: 5 }
            }),
            processAddClaim: jest.fn().mockResolvedValue({ success: true }),
            mergeNodes: jest.fn().mockResolvedValue({ success: true }),
            close: jest.fn().mockResolvedValue(undefined)
        };

        mockStore = {
            testConnectivity: jest.fn().mockResolvedValue({ ipfs: true, s3: true, redis: true }),
            retrieveEvent: jest.fn().mockResolvedValue({
                v: 1,
                type: 'CREATE_RELEASE_BUNDLE',
                author_pubkey: 'test_key',
                created_at: Date.now(),
                parents: [],
                body: {
                    release: { name: 'Test Album' },
                    groups: [],
                    tracks: [],
                    tracklist: []
                },
                sig: 'test_sig'
            }),
            calculateHash: jest.fn().mockReturnValue('abc123'),
            close: jest.fn().mockResolvedValue(undefined)
        };

        mockRpc = {
            get_info: jest.fn().mockResolvedValue({
                head_block_num: 1000,
                last_irreversible_block_num: 990
            }),
            get_block: jest.fn().mockResolvedValue({
                timestamp: '2024-01-01T00:00:00',
                transactions: []
            }),
            history_get_actions: jest.fn().mockResolvedValue({
                actions: []
            })
        };

        MusicGraphDatabase.mockImplementation(() => mockDb);
        EventStore.mockImplementation(() => mockStore);
        JsonRpc.mockImplementation(() => mockRpc);

        // Create processor instance
        processor = new EventProcessor({
            blockchain: {
                rpcUrl: 'http://localhost:8888',
                contractAccount: 'polaris',
                pollInterval: 100 // Fast polling for tests
            },
            database: {
                uri: 'bolt://localhost:7687',
                user: 'neo4j',
                password: 'test'
            },
            storage: {
                ipfs: { url: 'http://localhost:5001' },
                s3: { endpoint: 'http://localhost:9000', bucket: 'test' },
                redis: { host: 'localhost' }
            },
            startBlock: 900
        });
    });

    afterEach(async () => {
        if (processor.isRunning) {
            await processor.stop();
        }
    });

    describe('Initialization', () => {
        test('should create processor with config', () => {
            expect(processor).toBeDefined();
            expect(processor.contractAccount).toBe('polaris');
            expect(processor.pollInterval).toBe(100);
            expect(processor.lastProcessedBlock).toBe(900);
        });

        test('should initialize with default start block if not specified', () => {
            const p = new EventProcessor({
                blockchain: { rpcUrl: 'http://localhost:8888' },
                database: { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'test' },
                storage: {
                    ipfs: { url: 'http://localhost:5001' },
                    s3: { endpoint: 'http://localhost:9000', bucket: 'test' },
                    redis: { host: 'localhost' }
                }
            });

            expect(p.lastProcessedBlock).toBe(0);
        });
    });

    describe('Start and Stop', () => {
        test('should start processor successfully', async () => {
            await processor.start();

            expect(processor.isRunning).toBe(true);
            expect(mockDb.testConnection).toHaveBeenCalled();
            expect(mockStore.testConnectivity).toHaveBeenCalled();
            expect(mockRpc.get_info).toHaveBeenCalled();
        });

        test('should stop processor cleanly', async () => {
            await processor.start();
            await processor.stop();

            expect(processor.isRunning).toBe(false);
            expect(mockDb.close).toHaveBeenCalled();
            expect(mockStore.close).toHaveBeenCalled();
        });

        test('should not start if already running', async () => {
            await processor.start();
            const secondStart = processor.start();

            await expect(secondStart).resolves.not.toThrow();
            expect(processor.isRunning).toBe(true);
        });

        test('should fail to start if database unavailable', async () => {
            mockDb.testConnection.mockResolvedValue(false);

            await expect(processor.start()).rejects.toThrow('Failed to connect to database');
        });
    });

    describe('Event Processing', () => {
        test('should process CREATE_RELEASE_BUNDLE event', async () => {
            const mockAction = {
                action_trace: {
                    act: {
                        account: 'polaris',
                        name: 'put',
                        data: {
                            author: 'testuser',
                            type: 21,
                            hash: 'abc123',
                            ts: Date.now()
                        }
                    },
                    block_num: 1000,
                    block_time: '2024-01-01T00:00:00'
                }
            };

            await processor.processAction(mockAction);

            expect(mockStore.retrieveEvent).toHaveBeenCalledWith('abc123');
            expect(mockStore.calculateHash).toHaveBeenCalled();
            expect(mockDb.processReleaseBundle).toHaveBeenCalled();
            expect(processor.stats.eventsProcessed).toBe(1);
        });

        test('should process ADD_CLAIM event', async () => {
            mockStore.retrieveEvent.mockResolvedValue({
                v: 1,
                type: 'ADD_CLAIM',
                author_pubkey: 'test_key',
                created_at: Date.now(),
                parents: [],
                body: {
                    node: { type: 'Person', id: 'person:test' },
                    field: 'bio',
                    value: 'Updated bio'
                },
                sig: 'test_sig'
            });

            const mockAction = {
                action_trace: {
                    act: {
                        account: 'polaris',
                        name: 'put',
                        data: {
                            author: 'testuser',
                            type: 30,
                            hash: 'def456',
                            ts: Date.now()
                        }
                    },
                    block_num: 1001
                }
            };

            await processor.processAction(mockAction);

            expect(mockDb.processAddClaim).toHaveBeenCalled();
            expect(processor.stats.eventsByType[30]).toBe(1);
        });

        test('should handle hash mismatch error', async () => {
            mockStore.calculateHash.mockReturnValue('wrong_hash');

            const mockAction = {
                action_trace: {
                    act: {
                        data: {
                            author: 'testuser',
                            type: 21,
                            hash: 'abc123',
                            ts: Date.now()
                        }
                    },
                    block_num: 1000
                }
            };

            await processor.processAction(mockAction);

            expect(processor.stats.errors).toBeGreaterThan(0);
            expect(processor.stats.eventsProcessed).toBe(0);
        });

        test('should continue processing after error', async () => {
            mockStore.retrieveEvent.mockRejectedValueOnce(new Error('Event not found'));

            const mockAction = {
                action_trace: {
                    act: {
                        data: {
                            author: 'testuser',
                            type: 21,
                            hash: 'abc123',
                            ts: Date.now()
                        }
                    },
                    block_num: 1000
                }
            };

            await processor.processAction(mockAction);

            expect(processor.stats.errors).toBe(1);

            // Should continue with next event
            mockStore.retrieveEvent.mockResolvedValue({
                v: 1,
                type: 'CREATE_RELEASE_BUNDLE',
                author_pubkey: 'test_key',
                created_at: Date.now(),
                parents: [],
                body: { release: {}, groups: [], tracks: [], tracklist: [] },
                sig: 'test_sig'
            });
            mockStore.calculateHash.mockReturnValue('def456');

            mockAction.action_trace.act.data.hash = 'def456';
            await processor.processAction(mockAction);

            expect(processor.stats.eventsProcessed).toBe(1);
        });
    });

    describe('Statistics', () => {
        test('should track statistics correctly', async () => {
            const mockAction = {
                action_trace: {
                    act: {
                        data: {
                            author: 'testuser',
                            type: 21,
                            hash: 'abc123',
                            ts: Date.now()
                        }
                    },
                    block_num: 1000
                }
            };

            await processor.processAction(mockAction);

            const stats = processor.getStats();

            expect(stats.eventsProcessed).toBe(1);
            expect(stats.eventsByType[21]).toBe(1);
            expect(stats.errors).toBe(0);
        });

        test('should calculate uptime and events per second', async () => {
            processor.stats.startTime = new Date(Date.now() - 60000); // 1 minute ago
            processor.stats.eventsProcessed = 60;

            const stats = processor.getStats();

            expect(stats.uptime).toBeGreaterThan(0);
            expect(stats.uptimeFormatted).toBeDefined();
            expect(parseFloat(stats.eventsPerSecond)).toBeCloseTo(1.0, 1);
        });

        test('should format uptime correctly', () => {
            expect(processor.formatUptime(1000)).toBe('1s');
            expect(processor.formatUptime(65000)).toBe('1m 5s');
            expect(processor.formatUptime(3665000)).toBe('1h 1m');
            expect(processor.formatUptime(90000000)).toBe('1d 1h');
        });
    });

    describe('Reprocessing', () => {
        test('should allow reprocessing from specific block', async () => {
            processor.lastProcessedBlock = 1000;

            await processor.reprocessFrom(900);

            expect(processor.lastProcessedBlock).toBe(899);
        });
    });
});
