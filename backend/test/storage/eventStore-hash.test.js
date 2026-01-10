/**
 * @fileoverview Tests for EventStore hash enforcement
 *
 * Tests the expectedHash parameter in storeEvent() and getEvent() alias.
 * These tests use minimal mocking to focus on hash validation logic.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import EventStore from '../../src/storage/eventStore.js';

describe('EventStore Hash Enforcement', () => {
    let store;
    let mockEvent;

    beforeEach(() => {
        // Create EventStore with no storage backends enabled (for testing logic only)
        store = new EventStore({
            ipfs: { url: null },
            s3: { endpoint: null, bucket: null },
            redis: { host: null }
        });

        // Mock event
        mockEvent = {
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
                source_links: []
            },
            sig: 'SIG_K1_test456'
        };
    });

    describe('storeEvent with expectedHash', () => {
        it('should accept matching expectedHash', async () => {
            // Calculate the actual hash
            const computedHash = store.calculateHash(mockEvent);

            // Mock storage methods to avoid actual storage
            store.storeToIPFS = jest.fn().mockResolvedValue('QmTest123');
            store.storeToS3 = jest.fn().mockResolvedValue('s3://bucket/key');
            store.storeToRedis = jest.fn().mockResolvedValue(undefined);
            store.storeHashCIDMapping = jest.fn().mockResolvedValue(undefined);

            // Enable at least one storage backend for the test
            store.s3Enabled = true;

            // Act: Store with matching expected hash (should succeed)
            const result = await store.storeEvent(mockEvent, computedHash);

            // Assert: Should complete successfully
            expect(result.hash).toBe(computedHash);
            expect(store.storeToS3).toHaveBeenCalled();
        });

        it('should reject mismatched expectedHash', async () => {
            // Calculate the actual hash
            const computedHash = store.calculateHash(mockEvent);
            const wrongHash = 'abc123def456'; // Different hash

            // Act & Assert: Should throw error
            await expect(
                store.storeEvent(mockEvent, wrongHash)
            ).rejects.toThrow(/Hash mismatch/);

            await expect(
                store.storeEvent(mockEvent, wrongHash)
            ).rejects.toThrow(/expected abc123def456, but computed/);
        });

        it('should work without expectedHash (backward compatibility)', async () => {
            // Mock storage methods
            store.storeToS3 = jest.fn().mockResolvedValue('s3://bucket/key');
            store.s3Enabled = true;
            store.storeHashCIDMapping = jest.fn().mockResolvedValue(undefined);

            // Act: Store without expected hash (should work)
            const result = await store.storeEvent(mockEvent);

            // Assert: Should succeed
            expect(result.hash).toBeDefined();
            expect(result.hash.length).toBe(64); // SHA256 hex length
        });

        it('should include helpful error message on mismatch', async () => {
            const wrongHash = 'wrong_hash';

            try {
                await store.storeEvent(mockEvent, wrongHash);
                // Should not reach here
                expect(true).toBe(false);
            } catch (error) {
                expect(error.message).toContain('Hash mismatch');
                expect(error.message).toContain('expected wrong_hash');
                expect(error.message).toContain('blockchain anchor');
            }
        });

        it('should validate hash before attempting storage', async () => {
            const wrongHash = 'wrong_hash';

            // Mock storage methods (should not be called)
            store.storeToIPFS = jest.fn();
            store.storeToS3 = jest.fn();
            store.storeToRedis = jest.fn();

            // Act: Try to store with wrong hash
            try {
                await store.storeEvent(mockEvent, wrongHash);
            } catch (error) {
                // Expected to throw
            }

            // Assert: Storage methods should not have been called
            expect(store.storeToIPFS).not.toHaveBeenCalled();
            expect(store.storeToS3).not.toHaveBeenCalled();
            expect(store.storeToRedis).not.toHaveBeenCalled();
        });
    });

    describe('getEvent alias', () => {
        it('should exist as a method', () => {
            expect(typeof store.getEvent).toBe('function');
        });

        it('should call retrieveEvent', async () => {
            // Mock retrieveEvent
            const mockRetrievedEvent = { ...mockEvent };
            store.retrieveEvent = jest.fn().mockResolvedValue(mockRetrievedEvent);

            const testHash = 'abc123';

            // Act: Call getEvent
            const result = await store.getEvent(testHash);

            // Assert: Should call retrieveEvent with same hash and options passthrough
            expect(store.retrieveEvent).toHaveBeenCalledWith(testHash, undefined);
            expect(result).toBe(mockRetrievedEvent);
        });

        it('should throw same errors as retrieveEvent', async () => {
            // Mock retrieveEvent to throw
            store.retrieveEvent = jest.fn().mockRejectedValue(
                new Error('Event not found: abc123')
            );

            // Act & Assert: Should propagate error
            await expect(
                store.getEvent('abc123')
            ).rejects.toThrow('Event not found: abc123');
        });
    });

    describe('hash calculation consistency', () => {
        it('should produce consistent hash for same event', () => {
            const hash1 = store.calculateHash(mockEvent);
            const hash2 = store.calculateHash(mockEvent);

            expect(hash1).toBe(hash2);
            expect(hash1.length).toBe(64); // SHA256 hex
        });

        it('should produce different hash for different events', () => {
            const modifiedEvent = {
                ...mockEvent,
                body: {
                    release: {
                        name: 'Different Album',
                        release_date: '2024-01-01'
                    }
                }
            };

            const hash1 = store.calculateHash(mockEvent);
            const hash2 = store.calculateHash(modifiedEvent);

            expect(hash1).not.toBe(hash2);
        });

        it('should exclude signature from hash calculation', () => {
            const event1 = { ...mockEvent, sig: 'SIG_1' };
            const event2 = { ...mockEvent, sig: 'SIG_2' };

            const hash1 = store.calculateHash(event1);
            const hash2 = store.calculateHash(event2);

            // Hashes should be the same despite different signatures
            expect(hash1).toBe(hash2);
        });
    });

    describe('integration: store and expectedHash', () => {
        it('should enforce that stored hash matches blockchain anchor', async () => {
            // Scenario: Event was anchored on blockchain with hash X
            const blockchainAnchorHash = store.calculateHash(mockEvent);

            // Someone tries to store the event with that anchor hash
            store.s3Enabled = true;
            store.storeToS3 = jest.fn().mockResolvedValue('s3://bucket/key');
            store.storeHashCIDMapping = jest.fn().mockResolvedValue(undefined);

            // Should succeed
            const result = await store.storeEvent(mockEvent, blockchainAnchorHash);
            expect(result.hash).toBe(blockchainAnchorHash);
        });

        it('should reject if event content differs from anchored hash', async () => {
            // Scenario: Event was anchored with hash X
            const blockchainAnchorHash = 'original_hash_from_blockchain';

            // But the event content has been modified (produces different hash)
            // This would indicate tampering or error

            // Should fail
            await expect(
                store.storeEvent(mockEvent, blockchainAnchorHash)
            ).rejects.toThrow(/Hash mismatch/);
        });
    });
});
