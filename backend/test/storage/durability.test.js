/**
 * Event Store Durability Tests
 *
 * Tests that events can be retrieved even when Redis cache is empty,
 * using S3 sidecar files as the source of truth for hash→CID mappings.
 */

import { jest } from '@jest/globals';

// Mock all external dependencies before importing EventStore
jest.mock('ipfs-http-client', () => ({
    create: jest.fn()
}));

jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn(),
    PutObjectCommand: jest.fn((params) => ({
        constructor: { name: 'PutObjectCommand' },
        input: params
    })),
    GetObjectCommand: jest.fn((params) => ({
        constructor: { name: 'GetObjectCommand' },
        input: params
    }))
}));

jest.mock('ioredis', () => {
    return jest.fn();
});

// Import mocked modules
import { create } from 'ipfs-http-client';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import Redis from 'ioredis';

// Import EventStore after mocks are set up
import EventStore from '../../src/storage/eventStore.js';

describe('Event Store Durability - S3 Fallback', () => {
    let eventStore;
    let mockIPFS;
    let mockS3;
    let mockRedis;

    // Track what's stored in "S3" and "IPFS"
    const s3Storage = new Map();
    const ipfsStorage = new Map();

    beforeEach(() => {
        // Clear mock storage
        s3Storage.clear();
        ipfsStorage.clear();

        // Mock IPFS client
        mockIPFS = {
            add: jest.fn(async (content) => {
                const cid = `Qm${Math.random().toString(36).substring(2, 15)}`;
                ipfsStorage.set(cid, content);
                return { cid: { toString: () => cid } };
            }),
            cat: jest.fn(async (cid) => {
                const content = ipfsStorage.get(cid);
                if (!content) {
                    throw new Error(`IPFS: CID not found: ${cid}`);
                }
                return [content];
            })
        };

        // Mock S3 client with sidecar file storage
        mockS3 = {
            send: jest.fn(async (command) => {
                if (command.constructor.name === 'PutObjectCommand') {
                    // Store to "S3"
                    const key = command.input.Key;
                    const body = command.input.Body;
                    s3Storage.set(key, body);
                    return {};
                } else if (command.constructor.name === 'GetObjectCommand') {
                    // Retrieve from "S3"
                    const key = command.input.Key;
                    const body = s3Storage.get(key);

                    if (!body) {
                        const error = new Error('NoSuchKey');
                        error.name = 'NoSuchKey';
                        throw error;
                    }

                    // Simulate S3 response stream
                    const stream = {
                        async *[Symbol.asyncIterator]() {
                            yield Buffer.from(body);
                        }
                    };

                    return { Body: stream };
                }
            })
        };

        // Mock Redis client
        mockRedis = {
            set: jest.fn(async () => 'OK'),
            get: jest.fn(async () => null), // Redis is empty by default
            setex: jest.fn(async () => 'OK'),
            quit: jest.fn(async () => 'OK'),
            on: jest.fn()
        };

        // Configure module mocks to return our test implementations
        create.mockReturnValue(mockIPFS);
        S3Client.mockImplementation(() => mockS3);
        Redis.mockImplementation(() => mockRedis);

        // Create EventStore - it will use the mocked clients
        eventStore = new EventStore({
            ipfs: {
                url: 'http://localhost:5001'
            },
            s3: {
                endpoint: 'http://localhost:9000',
                bucket: 'test-bucket',
                region: 'us-east-1',
                accessKeyId: 'test-key',
                secretAccessKey: 'test-secret'
            },
            redis: {
                host: 'localhost',
                port: 6379
            }
        });
    });

    afterEach(async () => {
        if (eventStore) {
            await eventStore.close();
        }
    });

    describe('S3 Sidecar Durability', () => {
        test('Stores hash→CID mapping to S3 sidecar file', async () => {
            const event = {
                v: 1,
                type: 'TEST_EVENT',
                author_pubkey: 'test_pubkey',
                created_at: 1234567890,
                parents: [],
                body: { message: 'Test event' },
                sig: 'test_signature'
            };

            const result = await eventStore.storeEvent(event);

            // Verify S3 sidecar file was created
            const sidcarKey = `mappings/${result.hash.substring(0, 2)}/${result.hash}.json`;
            expect(s3Storage.has(sidcarKey)).toBe(true);

            // Verify sidecar file content
            const sidecarData = JSON.parse(s3Storage.get(sidcarKey));
            expect(sidecarData.hash).toBe(result.hash);
            expect(sidecarData.cid).toBe(result.event_cid); // Full event CID for retrieval
            expect(sidecarData.stored_at).toBeDefined();
        });

        test('Retrieves event when Redis is empty but S3 sidecar exists', async () => {
            const event = {
                v: 1,
                type: 'TEST_EVENT',
                author_pubkey: 'test_pubkey',
                created_at: 1234567890,
                parents: [],
                body: { message: 'Test for Redis failure' },
                sig: 'test_signature'
            };

            // Store event (creates S3 sidecar and stores in IPFS)
            const storeResult = await eventStore.storeEvent(event);
            const hash = storeResult.hash;
            const cid = storeResult.event_cid; // Full event CID for retrieval

            // Verify sidecar was created
            const sidecarKey = `mappings/${hash.substring(0, 2)}/${hash}.json`;
            expect(s3Storage.has(sidecarKey)).toBe(true);

            // Clear Redis (simulate cache loss)
            mockRedis.get = jest.fn(async () => null);

            // Retrieve event - should fall back to S3 sidecar
            const retrievedEvent = await eventStore.retrieveEvent(hash);

            // Verify event was retrieved correctly
            expect(retrievedEvent).toEqual(event);

            // Verify Redis was checked first (cache miss)
            expect(mockRedis.get).toHaveBeenCalledWith(`ipfs:hash:${hash}`);

            // Verify S3 sidecar was used as fallback
            expect(mockS3.send).toHaveBeenCalled();

            // Verify IPFS was fetched using CID from sidecar
            expect(mockIPFS.cat).toHaveBeenCalledWith(cid);
        });

        test('Repopulates Redis cache after S3 fallback retrieval', async () => {
            const event = {
                v: 1,
                type: 'TEST_EVENT',
                author_pubkey: 'test_pubkey',
                created_at: 1234567890,
                parents: [],
                body: { message: 'Cache repopulation test' },
                sig: 'test_signature'
            };

            // Store event
            const storeResult = await eventStore.storeEvent(event);
            const hash = storeResult.hash;
            const cid = storeResult.event_cid; // Full event CID for retrieval

            // Clear Redis
            mockRedis.get = jest.fn(async () => null);
            mockRedis.set = jest.fn(async () => 'OK');

            // Retrieve event (triggers S3 fallback)
            await eventStore.retrieveEvent(hash);

            // Verify Redis was repopulated with CID
            expect(mockRedis.set).toHaveBeenCalledWith(
                `ipfs:hash:${hash}`,
                cid
            );
        });

        test('Handles missing S3 sidecar gracefully', async () => {
            const nonExistentHash = 'abc123nonexistent';

            // Attempt to retrieve non-existent event
            await expect(
                eventStore.retrieveEvent(nonExistentHash)
            ).rejects.toThrow('Event not found');

            // Verify both Redis and S3 were checked
            expect(mockRedis.get).toHaveBeenCalled();
            expect(mockS3.send).toHaveBeenCalled();
        });
    });

    describe('Multi-Layer Fallback Chain', () => {
        test('Retrieval priority: Redis → S3 sidecar → IPFS', async () => {
            const event = {
                v: 1,
                type: 'TEST_EVENT',
                author_pubkey: 'test_pubkey',
                created_at: 1234567890,
                parents: [],
                body: { message: 'Fallback chain test' },
                sig: 'test_signature'
            };

            // Store event
            const storeResult = await eventStore.storeEvent(event);
            const hash = storeResult.hash;
            const cid = storeResult.event_cid; // Full event CID for retrieval

            // Test 1: Redis has CID (fast path)
            mockRedis.get = jest.fn(async (key) => {
                if (key === `ipfs:hash:${hash}`) return cid;
                return null;
            });

            await eventStore.retrieveEvent(hash);
            expect(mockRedis.get).toHaveBeenCalled();
            expect(mockIPFS.cat).toHaveBeenCalledWith(cid);

            // Reset mocks
            jest.clearAllMocks();

            // Test 2: Redis empty, S3 sidecar has mapping (fallback path)
            mockRedis.get = jest.fn(async () => null);

            await eventStore.retrieveEvent(hash);
            expect(mockRedis.get).toHaveBeenCalled();
            expect(mockS3.send).toHaveBeenCalled();
            expect(mockIPFS.cat).toHaveBeenCalledWith(cid);
        });

        test('S3 sidecar prevents data loss when Redis is cleared', async () => {
            const events = [
                { v: 1, type: 'EVENT_1', author_pubkey: 'pk1', created_at: 1, parents: [], body: { id: 1 }, sig: 's1' },
                { v: 1, type: 'EVENT_2', author_pubkey: 'pk2', created_at: 2, parents: [], body: { id: 2 }, sig: 's2' },
                { v: 1, type: 'EVENT_3', author_pubkey: 'pk3', created_at: 3, parents: [], body: { id: 3 }, sig: 's3' }
            ];

            // Store multiple events
            const hashes = [];
            for (const event of events) {
                const result = await eventStore.storeEvent(event);
                hashes.push(result.hash);
            }

            // Simulate Redis cache completely cleared (disaster scenario)
            mockRedis.get = jest.fn(async () => null);

            // Verify all events can still be retrieved via S3 fallback
            for (let i = 0; i < events.length; i++) {
                const retrievedEvent = await eventStore.retrieveEvent(hashes[i]);
                expect(retrievedEvent).toEqual(events[i]);
            }

            // Verify S3 sidecar was used for all retrievals
            expect(mockS3.send).toHaveBeenCalled();
        });
    });

    describe('Sidecar File Format', () => {
        test('Sidecar file contains correct metadata', async () => {
            const event = {
                v: 1,
                type: 'TEST_EVENT',
                author_pubkey: 'test_pubkey',
                created_at: 1234567890,
                parents: [],
                body: { test: 'data' },
                sig: 'sig'
            };

            const result = await eventStore.storeEvent(event);

            // Read sidecar file
            const sidecarKey = `mappings/${result.hash.substring(0, 2)}/${result.hash}.json`;
            const sidecarData = JSON.parse(s3Storage.get(sidecarKey));

            // Verify structure
            expect(sidecarData).toHaveProperty('hash');
            expect(sidecarData).toHaveProperty('cid');
            expect(sidecarData).toHaveProperty('stored_at');

            // Verify values
            expect(sidecarData.hash).toBe(result.hash);
            expect(sidecarData.cid).toBe(result.event_cid); // Full event CID for retrieval
            expect(new Date(sidecarData.stored_at)).toBeInstanceOf(Date);
        });

        test('Sidecar file uses hash prefix for partitioning', async () => {
            const events = [
                { v: 1, type: 'E1', author_pubkey: 'pk', created_at: 1, parents: [], body: { a: 1 }, sig: 's' },
                { v: 1, type: 'E2', author_pubkey: 'pk', created_at: 2, parents: [], body: { b: 2 }, sig: 's' },
                { v: 1, type: 'E3', author_pubkey: 'pk', created_at: 3, parents: [], body: { c: 3 }, sig: 's' }
            ];

            for (const event of events) {
                const result = await eventStore.storeEvent(event);

                // Verify sidecar key uses first 2 chars of hash as prefix
                const expectedPrefix = result.hash.substring(0, 2);
                const sidecarKey = `mappings/${expectedPrefix}/${result.hash}.json`;

                expect(s3Storage.has(sidecarKey)).toBe(true);
            }
        });
    });
});
