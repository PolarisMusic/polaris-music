/**
 * @fileoverview Tests for EventStore requireSig retrieval mode
 *
 * Verifies that:
 * 1. requireSig=true fetches full event with signature from S3 when IPFS has only canonical
 * 2. requireSig=true prevents Redis cache poisoning with signature-less events
 * 3. requireSig=true throws clear error when only canonical available and S3 disabled
 * 4. requireSig=false allows canonical events without signature
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import EventStore from '../../src/storage/eventStore.js';

describe('EventStore - requireSig Retrieval Mode', () => {
    let eventStore;
    let mockIPFSRetrieve;
    let mockS3Retrieve;
    let mockRedisRetrieve;
    let mockRedisStore;

    const testEvent = {
        v: 1,
        type: 'CREATE_RELEASE_BUNDLE',
        author_pubkey: 'testkey',
        created_at: 1704067200,
        parents: [],
        body: {
            release: { name: 'Test Album' },
            groups: [],
            tracks: []
        },
        proofs: {},
        sig: 'test_signature_abc123'  // Full event has signature
    };

    const canonicalEvent = {
        ...testEvent
    };
    delete canonicalEvent.sig;  // Canonical event has no signature

    // Computed hash of testEvent (canonical, without sig)
    const testHash = 'a083c992624c1865d2baee5fb87e7dd0bd73da1f53b3e87ffc4cdf5566c982c8';

    beforeEach(() => {
        // Initialize EventStore with mocked storage backends
        eventStore = new EventStore({
            ipfs: null,
            s3: null,
            redis: null
        });

        // Mock IPFS to return canonical (no sig)
        mockIPFSRetrieve = jest.spyOn(eventStore, 'retrieveFromIPFS');
        mockIPFSRetrieve.mockResolvedValue(Buffer.from(JSON.stringify(canonicalEvent)));

        // Mock S3 to return full event (with sig)
        mockS3Retrieve = jest.spyOn(eventStore, 'retrieveFromS3');
        mockS3Retrieve.mockResolvedValue(Buffer.from(JSON.stringify(testEvent)));

        // Mock Redis
        mockRedisRetrieve = jest.spyOn(eventStore, 'retrieveFromRedis');
        mockRedisRetrieve.mockResolvedValue(null);  // Cache miss by default

        mockRedisStore = jest.spyOn(eventStore, 'storeToRedis');
        mockRedisStore.mockResolvedValue(undefined);

        // Enable all storage backends for tests
        eventStore.ipfsEnabled = true;
        eventStore.s3Enabled = true;
        eventStore.redisEnabled = true;
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('requireSig=true behavior', () => {
        test('should fallback to S3 when IPFS returns canonical and S3 has full event', async () => {
            // Act: Retrieve with requireSig=true
            const event = await eventStore.retrieveEvent(testHash, { requireSig: true });

            // Assert: Should return full event from S3 (with sig)
            expect(event.sig).toBe('test_signature_abc123');
            expect(event.v).toBe(1);
            expect(event.type).toBe('CREATE_RELEASE_BUNDLE');

            // Assert: Should have called IPFS first
            expect(mockIPFSRetrieve).toHaveBeenCalledWith(testHash);

            // Assert: Should have called S3 for fallback
            expect(mockS3Retrieve).toHaveBeenCalledWith(testHash);

            // Assert: Should cache full event to Redis (not canonical)
            expect(mockRedisStore).toHaveBeenCalled();
            const cachedEventStr = mockRedisStore.mock.calls[0][0];
            const cachedEvent = JSON.parse(cachedEventStr);
            expect(cachedEvent.sig).toBe('test_signature_abc123');
        });

        test('should throw clear error when only canonical available and S3 disabled', async () => {
            // Setup: Disable S3
            eventStore.s3Enabled = false;

            // Act & Assert: Should throw helpful error
            await expect(
                eventStore.retrieveEvent(testHash, { requireSig: true })
            ).rejects.toThrow('Full event with signature required but only canonical exists in IPFS');
            await expect(
                eventStore.retrieveEvent(testHash, { requireSig: true })
            ).rejects.toThrow('Enable S3 storage or set requireSig=false');
        });

        test('should NOT cache canonical event to Redis when requireSig=true and IPFS returns canonical', async () => {
            // Act: Retrieve with requireSig=true
            await eventStore.retrieveEvent(testHash, { requireSig: true });

            // Assert: Redis should be called to cache the S3 full event, not the IPFS canonical
            expect(mockRedisStore).toHaveBeenCalledTimes(1);
            const cachedEventStr = mockRedisStore.mock.calls[0][0];
            const cachedEvent = JSON.parse(cachedEventStr);

            // Verify cached event has signature (from S3, not from IPFS)
            expect(cachedEvent.sig).toBe('test_signature_abc123');
        });

        test('should throw error if retrieved event still lacks signature', async () => {
            // Setup: Mock S3 to also return canonical (should not happen but test defensive code)
            mockS3Retrieve.mockResolvedValue(Buffer.from(JSON.stringify(canonicalEvent)));

            // Act & Assert: Should throw clear error
            await expect(
                eventStore.retrieveEvent(testHash, { requireSig: true })
            ).rejects.toThrow('Event signature required but event');
            await expect(
                eventStore.retrieveEvent(testHash, { requireSig: true })
            ).rejects.toThrow('has no signature');
        });
    });

    describe('requireSig=false behavior (default)', () => {
        test('should accept canonical event without signature when requireSig=false', async () => {
            // Setup: Disable S3 so only IPFS canonical is available
            eventStore.s3Enabled = false;

            // Act: Retrieve with requireSig=false (default)
            const event = await eventStore.retrieveEvent(testHash, { requireSig: false });

            // Assert: Should return canonical event (no sig)
            expect(event.sig).toBeUndefined();
            expect(event.v).toBe(1);
            expect(event.type).toBe('CREATE_RELEASE_BUNDLE');

            // Assert: Should have called IPFS only
            expect(mockIPFSRetrieve).toHaveBeenCalledWith(testHash);
            expect(mockS3Retrieve).not.toHaveBeenCalled();
        });

        test('should NOT cache canonical event to Redis (prevents cache poisoning)', async () => {
            // Setup: Disable S3 so only IPFS canonical is available
            eventStore.s3Enabled = false;

            // Act: Retrieve with requireSig=false
            await eventStore.retrieveEvent(testHash, { requireSig: false });

            // Assert: Redis store should NOT be called for canonical event
            expect(mockRedisStore).not.toHaveBeenCalled();
        });

        test('should cache full event to Redis when it has signature', async () => {
            // Setup: Mock IPFS to return full event (with sig) directly
            mockIPFSRetrieve.mockResolvedValue(Buffer.from(JSON.stringify(testEvent)));

            // Act: Retrieve with requireSig=false
            await eventStore.retrieveEvent(testHash, { requireSig: false });

            // Assert: Redis should cache the event since it has signature
            expect(mockRedisStore).toHaveBeenCalled();
            const cachedEventStr = mockRedisStore.mock.calls[0][0];
            const cachedEvent = JSON.parse(cachedEventStr);
            expect(cachedEvent.sig).toBe('test_signature_abc123');
        });
    });

    describe('Redis cache behavior', () => {
        test('should return cached event and skip IPFS/S3 when Redis has it', async () => {
            // Setup: Redis cache hit with full event
            mockRedisRetrieve.mockResolvedValue(JSON.stringify(testEvent));

            // Act: Retrieve with requireSig=true
            const event = await eventStore.retrieveEvent(testHash, { requireSig: true });

            // Assert: Should return cached event
            expect(event.sig).toBe('test_signature_abc123');

            // Assert: Should NOT have called IPFS or S3 (cache hit)
            expect(mockIPFSRetrieve).not.toHaveBeenCalled();
            expect(mockS3Retrieve).not.toHaveBeenCalled();
        });

        test('should not populate Redis with canonical event on IPFS retrieval', async () => {
            // Setup: Disable S3, enable only IPFS
            eventStore.s3Enabled = false;

            // Act: Retrieve without requireSig (accepts canonical)
            await eventStore.retrieveEvent(testHash);

            // Assert: Redis should NOT be populated with canonical event
            expect(mockRedisStore).not.toHaveBeenCalled();
        });
    });

    describe('Error handling', () => {
        test('should throw when event not found in any storage', async () => {
            // Setup: All storage returns null
            mockIPFSRetrieve.mockResolvedValue(null);
            mockS3Retrieve.mockResolvedValue(null);
            mockRedisRetrieve.mockResolvedValue(null);

            // Act & Assert
            await expect(
                eventStore.retrieveEvent(testHash, { requireSig: true })
            ).rejects.toThrow('Event not found');
        });

        test('should provide helpful error when requireSig but only IPFS enabled', async () => {
            // Setup: Only IPFS enabled (has canonical)
            eventStore.s3Enabled = false;

            // Act & Assert
            await expect(
                eventStore.retrieveEvent(testHash, { requireSig: true })
            ).rejects.toThrow('only canonical exists in IPFS');
            await expect(
                eventStore.retrieveEvent(testHash, { requireSig: true })
            ).rejects.toThrow('Enable S3 storage');
        });
    });
});
