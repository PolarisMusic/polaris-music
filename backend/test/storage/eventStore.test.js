/**
 * @fileoverview Tests for the EventStore class
 *
 * Tests cover:
 * - Event validation
 * - Hash calculation
 * - Multi-layer storage (IPFS, S3, Redis)
 * - Retrieval with fallback chain
 * - Pinning management
 * - Error handling
 */

import { jest } from '@jest/globals';

// Mock all external dependencies before importing EventStore
jest.mock('ipfs-http-client', () => ({
    create: jest.fn()
}));

jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn(),
    PutObjectCommand: jest.fn(),
    GetObjectCommand: jest.fn()
}));

jest.mock('ioredis', () => {
    return jest.fn();
});

// Import mocked modules
import { create } from 'ipfs-http-client';
import { S3Client } from '@aws-sdk/client-s3';
import Redis from 'ioredis';

// Import EventStore after mocks are set up
import EventStore from '../../src/storage/eventStore.js';

describe('EventStore', () => {
    let store;
    let mockIPFS;
    let mockS3;
    let mockRedis;

    const mockEvent = {
        v: 1,
        type: 'CREATE_RELEASE_BUNDLE',
        author_pubkey: 'PUB_K1_test123',
        created_at: 1700000000,
        parents: [],
        body: {
            release: {
                name: 'Test Album',
                release_date: '2024-01-01'
            }
        },
        proofs: {
            source_links: ['https://example.com/proof']
        },
        sig: 'SIG_K1_test456'
    };

    beforeEach(() => {
        // Setup IPFS mock
        mockIPFS = {
            add: jest.fn().mockResolvedValue({ cid: { toString: () => 'QmTest123' } }),
            cat: jest.fn().mockImplementation(async function* () {
                yield Buffer.from(JSON.stringify(mockEvent));
            }),
            pin: {
                add: jest.fn().mockResolvedValue(undefined),
                rm: jest.fn().mockResolvedValue(undefined),
                ls: jest.fn().mockImplementation(async function* () {
                    yield { cid: { toString: () => 'QmTest123' } };
                })
            },
            id: jest.fn().mockResolvedValue({ id: 'test-peer' })
        };

        // Setup S3 mock
        mockS3 = {
            send: jest.fn().mockImplementation(async (command) => {
                if (command.constructor.name === 'GetObjectCommand') {
                    return {
                        Body: {
                            [Symbol.asyncIterator]: async function* () {
                                yield Buffer.from(JSON.stringify(mockEvent));
                            }
                        }
                    };
                }
                return {};
            })
        };

        // Setup Redis mock
        mockRedis = {
            setex: jest.fn().mockResolvedValue('OK'),
            get: jest.fn().mockResolvedValue(null),
            del: jest.fn().mockResolvedValue(1),
            keys: jest.fn().mockResolvedValue([]),
            ping: jest.fn().mockResolvedValue('PONG'),
            quit: jest.fn().mockResolvedValue('OK'),
            on: jest.fn()
        };

        // Mock the modules
        create.mockReturnValue(mockIPFS);
        S3Client.mockImplementation(() => mockS3);
        Redis.mockImplementation(() => mockRedis);

        // Create store instance
        store = new EventStore({
            ipfs: {
                url: 'http://localhost:5001'
            },
            s3: {
                endpoint: 'http://localhost:9000',
                region: 'us-east-1',
                bucket: 'test-bucket',
                accessKeyId: 'test-key',
                secretAccessKey: 'test-secret'
            },
            redis: {
                host: 'localhost',
                port: 6379,
                ttl: 3600
            }
        });
    });

    afterEach(async () => {
        await store.close();
        jest.clearAllMocks();
    });

    describe('Constructor', () => {
        test('should initialize with all services enabled', () => {
            expect(store.ipfsEnabled).toBe(true);
            expect(store.s3Enabled).toBe(true);
            expect(store.redisEnabled).toBe(true);
        });

        test('should handle missing IPFS config', () => {
            const partialStore = new EventStore({
                s3: {
                    endpoint: 'http://localhost:9000',
                    bucket: 'test',
                    accessKeyId: 'key',
                    secretAccessKey: 'secret'
                },
                redis: { host: 'localhost' }
            });

            expect(partialStore.ipfsEnabled).toBe(false);
            expect(partialStore.s3Enabled).toBe(true);
            expect(partialStore.redisEnabled).toBe(true);
        });

        test('should handle missing all configs gracefully', () => {
            const minimalStore = new EventStore({});

            expect(minimalStore.ipfsEnabled).toBe(false);
            expect(minimalStore.s3Enabled).toBe(false);
            expect(minimalStore.redisEnabled).toBe(false);
        });
    });

    describe('validateEvent()', () => {
        test('should validate correct event', () => {
            expect(() => store.validateEvent(mockEvent)).not.toThrow();
        });

        test('should reject non-object', () => {
            expect(() => store.validateEvent(null)).toThrow('Event must be an object');
            expect(() => store.validateEvent('string')).toThrow('Event must be an object');
        });

        test('should reject missing required fields', () => {
            const required = ['v', 'type', 'author_pubkey', 'created_at', 'body', 'sig'];

            required.forEach(field => {
                const incomplete = { ...mockEvent };
                delete incomplete[field];
                expect(() => store.validateEvent(incomplete)).toThrow(`missing required field: ${field}`);
            });
        });

        test('should reject invalid version', () => {
            expect(() => store.validateEvent({ ...mockEvent, v: 0 })).toThrow('version must be a positive number');
            expect(() => store.validateEvent({ ...mockEvent, v: 'one' })).toThrow('version must be a positive number');
        });

        test('should reject invalid timestamp', () => {
            expect(() => store.validateEvent({ ...mockEvent, created_at: 0 })).toThrow('created_at must be a positive');
            expect(() => store.validateEvent({ ...mockEvent, created_at: -1 })).toThrow('created_at must be a positive');
        });

        test('should reject invalid body', () => {
            expect(() => store.validateEvent({ ...mockEvent, body: null })).toThrow('body must be an object');
            expect(() => store.validateEvent({ ...mockEvent, body: 'string' })).toThrow('body must be an object');
        });
    });

    describe('calculateHash()', () => {
        test('should generate consistent hashes', () => {
            const hash1 = store.calculateHash(mockEvent);
            const hash2 = store.calculateHash(mockEvent);

            expect(hash1).toBe(hash2);
            expect(hash1).toMatch(/^[a-f0-9]{64}$/);
        });

        test('should exclude signature from hash', () => {
            const event1 = { ...mockEvent, sig: 'SIG1' };
            const event2 = { ...mockEvent, sig: 'SIG2' };

            const hash1 = store.calculateHash(event1);
            const hash2 = store.calculateHash(event2);

            expect(hash1).toBe(hash2);
        });

        test('should generate different hashes for different events', () => {
            const event1 = { ...mockEvent };
            const event2 = { ...mockEvent, type: 'ADD_CLAIM' };

            const hash1 = store.calculateHash(event1);
            const hash2 = store.calculateHash(event2);

            expect(hash1).not.toBe(hash2);
        });

        test('should handle object key ordering', () => {
            const event1 = { v: 1, type: 'TEST', body: {}, author_pubkey: 'test', created_at: 1, sig: 'sig' };
            const event2 = { created_at: 1, body: {}, v: 1, author_pubkey: 'test', type: 'TEST', sig: 'sig' };

            const hash1 = store.calculateHash(event1);
            const hash2 = store.calculateHash(event2);

            expect(hash1).toBe(hash2);
        });
    });

    describe('storeEvent()', () => {
        test('should store to all layers successfully', async () => {
            const result = await store.storeEvent(mockEvent);

            expect(result.hash).toBeDefined();
            expect(result.canonical_cid).toBe('QmTest123'); // Canonical CID for verification
            expect(result.event_cid).toBeDefined(); // Full event CID for retrieval
            expect(result.s3).toContain('s3://test-bucket/events/');
            expect(result.redis).toBe(true);
            expect(result.errors).toHaveLength(0);

            expect(mockIPFS.add).toHaveBeenCalled();
            expect(mockS3.send).toHaveBeenCalled();
            expect(mockRedis.setex).toHaveBeenCalled();
        });

        test('should succeed with partial storage failures', async () => {
            mockIPFS.add.mockRejectedValue(new Error('IPFS unavailable'));

            const result = await store.storeEvent(mockEvent);

            expect(result.hash).toBeDefined();
            expect(result.canonical_cid).toBeNull(); // IPFS failed
            expect(result.event_cid).toBeNull(); // IPFS failed
            expect(result.s3).toBeDefined();
            expect(result.redis).toBe(true);
            expect(result.errors.length).toBeGreaterThan(0);
        });

        test('should fail if all storage methods fail', async () => {
            mockIPFS.add.mockRejectedValue(new Error('IPFS down'));
            mockS3.send.mockRejectedValue(new Error('S3 down'));
            mockRedis.setex.mockRejectedValue(new Error('Redis down'));

            await expect(store.storeEvent(mockEvent)).rejects.toThrow('Failed to store event');
        });

        test('should reject invalid events', async () => {
            const invalidEvent = { ...mockEvent };
            delete invalidEvent.v;

            await expect(store.storeEvent(invalidEvent)).rejects.toThrow('missing required field: v');
        });

        test('should update statistics', async () => {
            await store.storeEvent(mockEvent);

            const stats = store.getStats();
            expect(stats.stored).toBe(1);
            expect(stats.ipfsStores).toBe(1);
            expect(stats.s3Stores).toBe(1);
        });
    });

    describe('retrieveEvent()', () => {
        test('should retrieve from Redis cache (cache hit)', async () => {
            const hash = store.calculateHash(mockEvent);
            mockRedis.get.mockResolvedValue(JSON.stringify(mockEvent));

            const retrieved = await store.retrieveEvent(hash);

            expect(retrieved).toEqual(mockEvent);
            expect(mockRedis.get).toHaveBeenCalledWith(`event:${hash}`);
            expect(mockIPFS.cat).not.toHaveBeenCalled();
            expect(store.stats.cacheHits).toBe(1);
        });

        test('should fall back to IPFS if not in cache', async () => {
            const hash = store.calculateHash(mockEvent);
            mockRedis.get.mockResolvedValue(null);

            const retrieved = await store.retrieveEvent(hash);

            expect(retrieved).toEqual(mockEvent);
            expect(mockRedis.get).toHaveBeenCalled();
            expect(mockIPFS.cat).toHaveBeenCalled();
            expect(store.stats.cacheMisses).toBe(1);
        });

        test('should fall back to S3 if IPFS fails', async () => {
            const hash = store.calculateHash(mockEvent);
            mockRedis.get.mockResolvedValue(null);
            mockIPFS.cat.mockRejectedValue(new Error('IPFS error'));

            const retrieved = await store.retrieveEvent(hash);

            expect(retrieved).toEqual(mockEvent);
            expect(mockS3.send).toHaveBeenCalled();
        });

        test('should populate cache after retrieval from slow storage', async () => {
            const hash = store.calculateHash(mockEvent);
            mockRedis.get.mockResolvedValue(null);

            await store.retrieveEvent(hash);

            // Should have tried to cache the result
            expect(mockRedis.setex).toHaveBeenCalled();
        });

        test('should verify hash integrity', async () => {
            const hash = store.calculateHash(mockEvent);
            const tampered = { ...mockEvent, body: { modified: true } };
            mockRedis.get.mockResolvedValue(JSON.stringify(tampered));

            await expect(store.retrieveEvent(hash)).rejects.toThrow('Hash mismatch');
        });

        test('should fail if event not found anywhere', async () => {
            const hash = 'nonexistent123';
            mockRedis.get.mockResolvedValue(null);
            mockIPFS.cat.mockRejectedValue(new Error('Not found'));
            mockS3.send.mockRejectedValue(new Error('Not found'));

            await expect(store.retrieveEvent(hash)).rejects.toThrow('Event not found');
        });
    });

    describe('Pinning Management', () => {
        test('should pin event to IPFS', async () => {
            await store.pinEvent('QmTest123');

            expect(mockIPFS.pin.add).toHaveBeenCalledWith('QmTest123');
        });

        test('should unpin event from IPFS', async () => {
            await store.unpinEvent('QmTest123');

            expect(mockIPFS.pin.rm).toHaveBeenCalledWith('QmTest123');
        });

        test('should list pinned events', async () => {
            const pins = await store.listPinned();

            expect(pins).toContain('QmTest123');
            expect(mockIPFS.pin.ls).toHaveBeenCalled();
        });

        test('should throw if IPFS not enabled', async () => {
            store.ipfsEnabled = false;

            await expect(store.pinEvent('QmTest')).rejects.toThrow('IPFS not enabled');
            await expect(store.unpinEvent('QmTest')).rejects.toThrow('IPFS not enabled');
            await expect(store.listPinned()).rejects.toThrow('IPFS not enabled');
        });
    });

    describe('Cache Management', () => {
        test('should clear specific event from cache', async () => {
            const hash = store.calculateHash(mockEvent);
            mockRedis.del.mockResolvedValue(1);

            const cleared = await store.clearCache(hash);

            expect(cleared).toBe(1);
            expect(mockRedis.del).toHaveBeenCalledWith(`event:${hash}`);
        });

        test('should clear all events from cache', async () => {
            mockRedis.keys.mockResolvedValue(['event:hash1', 'event:hash2', 'event:hash3']);
            mockRedis.del.mockResolvedValue(3);

            const cleared = await store.clearCache();

            expect(cleared).toBe(3);
            expect(mockRedis.keys).toHaveBeenCalledWith('event:*');
            expect(mockRedis.del).toHaveBeenCalledWith('event:hash1', 'event:hash2', 'event:hash3');
        });

        test('should handle empty cache', async () => {
            mockRedis.keys.mockResolvedValue([]);

            const cleared = await store.clearCache();

            expect(cleared).toBe(0);
        });
    });

    describe('Statistics', () => {
        test('should track storage operations', async () => {
            await store.storeEvent(mockEvent);

            const stats = store.getStats();

            expect(stats.stored).toBe(1);
            expect(stats.ipfsStores).toBe(1);
            expect(stats.s3Stores).toBe(1);
            expect(stats.enabled.ipfs).toBe(true);
            expect(stats.enabled.s3).toBe(true);
            expect(stats.enabled.redis).toBe(true);
        });

        test('should calculate cache hit rate', async () => {
            const hash = store.calculateHash(mockEvent);

            // Cache hit
            mockRedis.get.mockResolvedValue(JSON.stringify(mockEvent));
            await store.retrieveEvent(hash);

            // Cache miss
            mockRedis.get.mockResolvedValue(null);
            await store.retrieveEvent(hash);

            const stats = store.getStats();
            expect(stats.cacheHitRate).toBe('50.00%');
        });
    });

    describe('Connectivity Tests', () => {
        test('should test all services', async () => {
            const connectivity = await store.testConnectivity();

            expect(connectivity.ipfs).toBe(true);
            expect(connectivity.s3).toBe(true);
            expect(connectivity.redis).toBe(true);

            expect(mockIPFS.id).toHaveBeenCalled();
            expect(mockRedis.ping).toHaveBeenCalled();
        });

        test('should handle service failures', async () => {
            mockIPFS.id.mockRejectedValue(new Error('IPFS down'));
            mockRedis.ping.mockRejectedValue(new Error('Redis down'));

            const connectivity = await store.testConnectivity();

            expect(connectivity.ipfs).toBe(false);
            expect(connectivity.redis).toBe(false);
        });
    });

    describe('Connection Cleanup', () => {
        test('should close all connections', async () => {
            await store.close();

            expect(mockRedis.quit).toHaveBeenCalled();
        });

        test('should handle close errors gracefully', async () => {
            mockRedis.quit.mockRejectedValue(new Error('Already closed'));

            await expect(store.close()).resolves.not.toThrow();
        });
    });
});

describe('Integration Tests (requires services)', () => {
    const shouldRunIntegration = process.env.TEST_INTEGRATION === 'true';

    if (!shouldRunIntegration) {
        test.skip('Integration tests skipped (set TEST_INTEGRATION=true to run)', () => {});
        return;
    }

    let store;

    beforeAll(() => {
        store = new EventStore({
            ipfs: {
                url: process.env.IPFS_URL || 'http://localhost:5001'
            },
            s3: {
                endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
                region: 'us-east-1',
                bucket: process.env.S3_BUCKET || 'test-bucket',
                accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
                secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin'
            },
            redis: {
                host: process.env.REDIS_HOST || 'localhost',
                port: parseInt(process.env.REDIS_PORT || '6379'),
                ttl: 60 // Short TTL for testing
            }
        });
    });

    afterAll(async () => {
        await store.close();
    });

    test('should connect to all services', async () => {
        const connectivity = await store.testConnectivity();

        expect(connectivity.ipfs).toBe(true);
        expect(connectivity.s3).toBe(true);
        expect(connectivity.redis).toBe(true);
    });

    test('should store and retrieve real event', async () => {
        const testEvent = {
            v: 1,
            type: 'CREATE_RELEASE_BUNDLE',
            author_pubkey: 'test_integration_' + Date.now(),
            created_at: Math.floor(Date.now() / 1000),
            parents: [],
            body: {
                release: {
                    name: 'Integration Test Album',
                    release_date: '2024-01-01'
                }
            },
            proofs: {},
            sig: 'test_sig_' + Date.now()
        };

        // Store event
        const storeResult = await store.storeEvent(testEvent);
        expect(storeResult.hash).toBeDefined();
        expect(storeResult.errors).toHaveLength(0);

        // Retrieve event
        const retrieved = await store.retrieveEvent(storeResult.hash);
        expect(retrieved).toEqual(testEvent);

        // Verify hash
        const computedHash = store.calculateHash(retrieved);
        expect(computedHash).toBe(storeResult.hash);
    });

    test('should use cache on second retrieval', async () => {
        const testEvent = {
            v: 1,
            type: 'ADD_CLAIM',
            author_pubkey: 'test_cache_' + Date.now(),
            created_at: Math.floor(Date.now() / 1000),
            parents: [],
            body: { test: 'cache' },
            sig: 'sig_' + Date.now()
        };

        const storeResult = await store.storeEvent(testEvent);

        // First retrieval (cache miss)
        const stats1 = store.getStats();
        const hits1 = stats1.cacheHits;

        await store.retrieveEvent(storeResult.hash);

        // Second retrieval (cache hit)
        await store.retrieveEvent(storeResult.hash);

        const stats2 = store.getStats();
        expect(stats2.cacheHits).toBeGreaterThan(hits1);
    });
});
