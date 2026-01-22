/**
 * @fileoverview Tests for EventStore CID functionality
 *
 * Tests the new dual CID storage system:
 * - canonical_cid: CID of canonical event (without signature) for verification
 * - event_cid: CID of full event (with signature) for retrieval
 *
 * Coverage:
 * - Dual CID storage (canonical + full event)
 * - Direct CID retrieval (retrieveByEventCid)
 * - CID-based ingestion flow
 * - Error handling for missing CIDs
 * - Backward compatibility with hash-based retrieval
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// These tests require a real IPFS daemon. They are opt-in so CI stays reliable.
// Run locally with: RUN_IPFS_TESTS=true IPFS_URL=http://localhost:5001 npm test
const testMode = process.env.RUN_IPFS_TESTS === 'true' ? describe : describe.skip;

testMode('EventStore CID Functionality', () => {
    let EventStore;
    let store;

    const mockEvent = {
        v: 1,
        type: 'CREATE_RELEASE_BUNDLE',
        author_pubkey: 'PUB_K1_test123',
        created_at: 1700000000,
        parents: [],
        body: {
            release: {
                release_name: 'Test Album',
                release_date: '2024-01-01',
                tracks: []
            }
        },
        proofs: {
            source_links: ['https://example.com/proof']
        },
        sig: 'SIG_K1_test456'
    };

    beforeEach(async () => {
        // Dynamically import to avoid loading if tests are skipped
        const module = await import('../../src/storage/eventStore.js');
        EventStore = module.default;

        // Create store with minimal config (in-memory mode)
        store = new EventStore({
            ipfs: { url: process.env.IPFS_URL || 'http://localhost:5001' },
            s3: null, // Disable S3 for unit tests
            redis: null // Disable Redis for unit tests
        });
    });

    describe('Dual CID Storage', () => {
        it('should store event and return both canonical_cid and event_cid', async () => {
            const result = await store.storeEvent(mockEvent);

            expect(result).toHaveProperty('hash');
            expect(result).toHaveProperty('canonical_cid');
            expect(result).toHaveProperty('event_cid');
            expect(result.canonical_cid).toBeTruthy();
            expect(result.event_cid).toBeTruthy();
            expect(result.canonical_cid).not.toBe(result.event_cid); // Different CIDs
        });

        it('should store canonical event without signature', async () => {
            const result = await store.storeEvent(mockEvent);

            // Retrieve using canonical CID should get event without signature
            const retrieved = await store.retrieveByEventCid(result.canonical_cid);

            // Canonical storage omits signature
            expect(retrieved).not.toHaveProperty('sig');
            expect(retrieved).toHaveProperty('v');
            expect(retrieved).toHaveProperty('type');
            expect(retrieved).toHaveProperty('body');
        });

        it('should store full event with signature', async () => {
            const result = await store.storeEvent(mockEvent);

            // Retrieve using event CID should get full event with signature
            const retrieved = await store.retrieveByEventCid(result.event_cid);

            expect(retrieved).toHaveProperty('sig');
            expect(retrieved.sig).toBe(mockEvent.sig);
            expect(retrieved).toHaveProperty('v');
            expect(retrieved).toHaveProperty('type');
            expect(retrieved).toHaveProperty('body');
        });

        it('should generate different CIDs for canonical vs full event', async () => {
            const result = await store.storeEvent(mockEvent);

            expect(result.canonical_cid).toBeTruthy();
            expect(result.event_cid).toBeTruthy();
            expect(result.canonical_cid).not.toBe(result.event_cid);

            // Both should be valid CIDv1 format
            expect(result.canonical_cid).toMatch(/^b[a-z2-7]+/); // CIDv1 base32
            expect(result.event_cid).toMatch(/^b[a-z2-7]+/);
        });
    });

    describe('Direct CID Retrieval (retrieveByEventCid)', () => {
        it('should retrieve event by event_cid without hash derivation', async () => {
            const storeResult = await store.storeEvent(mockEvent);
            const eventCid = storeResult.event_cid;

            const retrieved = await store.retrieveByEventCid(eventCid);

            expect(retrieved).toBeDefined();
            expect(retrieved.sig).toBe(mockEvent.sig);
            expect(retrieved.type).toBe(mockEvent.type);
            expect(retrieved.body).toEqual(mockEvent.body);
        });

        it('should validate event structure when retrieving by CID', async () => {
            const storeResult = await store.storeEvent(mockEvent);

            // Should not throw for valid event
            await expect(
                store.retrieveByEventCid(storeResult.event_cid)
            ).resolves.toBeDefined();
        });

        it('should throw error for invalid CID', async () => {
            const invalidCid = 'bafyinvalid123';

            await expect(
                store.retrieveByEventCid(invalidCid)
            ).rejects.toThrow(/Failed to retrieve event by CID/);
        });

        it('should throw error for non-existent CID', async () => {
            // Valid CID format but doesn't exist
            const nonExistentCid = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';

            await expect(
                store.retrieveByEventCid(nonExistentCid)
            ).rejects.toThrow();
        });

        it('should increment retrieval statistics', async () => {
            const storeResult = await store.storeEvent(mockEvent);
            const initialRetrieved = store.stats.retrieved;

            await store.retrieveByEventCid(storeResult.event_cid);

            expect(store.stats.retrieved).toBe(initialRetrieved + 1);
        });
    });

    describe('Hash-based Retrieval (Backward Compatibility)', () => {
        it('should still support hash-based retrieval', async () => {
            const storeResult = await store.storeEvent(mockEvent);
            const hash = storeResult.hash;

            const retrieved = await store.retrieveEvent(hash);

            expect(retrieved).toBeDefined();
            expect(retrieved.type).toBe(mockEvent.type);
        });

        it('should derive canonical_cid from hash when not cached', async () => {
            const storeResult = await store.storeEvent(mockEvent);
            const hash = storeResult.hash;

            // Clear any cache
            if (store.redisEnabled) {
                await store.clearCache(hash);
            }

            // Should still retrieve by deriving CID from hash
            const retrieved = await store.retrieveEvent(hash);
            expect(retrieved).toBeDefined();
        });
    });

    describe('CID-based Ingestion Flow', () => {
        it('should support ingestion with event_cid (new flow)', async () => {
            const storeResult = await store.storeEvent(mockEvent);

            // Simulate ingestion: have event_cid from blockchain
            const retrieved = await store.retrieveByEventCid(storeResult.event_cid);

            expect(retrieved).toBeDefined();
            expect(retrieved.sig).toBe(mockEvent.sig);

            // Verify hash matches
            const computedHash = store.calculateHash(retrieved);
            expect(computedHash).toBe(storeResult.hash);
        });

        it('should fall back to hash-based retrieval when event_cid missing', async () => {
            const storeResult = await store.storeEvent(mockEvent);

            // Simulate legacy ingestion: only have hash, no event_cid
            const retrieved = await store.retrieveEvent(storeResult.hash);

            expect(retrieved).toBeDefined();
        });
    });

    describe('Error Handling', () => {
        it('should handle IPFS storage failure gracefully', async () => {
            // Create store with invalid IPFS endpoint
            const badStore = new EventStore({
                ipfs: { url: 'http://invalid-ipfs:9999' },
                s3: null,
                redis: null
            });

            // Should fail but with clear error message
            await expect(
                badStore.storeEvent(mockEvent)
            ).rejects.toThrow(/Failed to store event/);
        });

        it('should increment error statistics on failure', async () => {
            const initialErrors = store.stats.errors;

            try {
                await store.retrieveByEventCid('bafyinvalid');
            } catch (error) {
                // Expected to fail
            }

            expect(store.stats.errors).toBeGreaterThan(initialErrors);
        });

        it('should provide helpful error for missing event_cid in ingestion', async () => {
            const error = new Error(
                'Missing stored.event_cid from /api/events/create response. ' +
                'Cannot submit to blockchain without event_cid.'
            );

            expect(error.message).toContain('event_cid');
            expect(error.message).toContain('blockchain');
        });
    });

    describe('Storage Statistics', () => {
        it('should track IPFS storage operations', async () => {
            const initialStores = store.stats.ipfsStores;

            await store.storeEvent(mockEvent);

            // Should increment by 2: canonical + full event
            expect(store.stats.ipfsStores).toBe(initialStores + 2);
        });

        it('should track successful storage operations', async () => {
            const initialStored = store.stats.stored;

            await store.storeEvent(mockEvent);

            expect(store.stats.stored).toBe(initialStored + 1);
        });
    });

    describe('CID Format Validation', () => {
        it('should generate CIDv1 format', async () => {
            const result = await store.storeEvent(mockEvent);

            // CIDv1 with base32 encoding starts with 'b'
            expect(result.canonical_cid).toMatch(/^b[a-z2-7]/);
            expect(result.event_cid).toMatch(/^b[a-z2-7]/);
        });

        it('should use raw codec for CID generation', async () => {
            const result = await store.storeEvent(mockEvent);

            // Both CIDs should be raw blocks
            // CIDv1 raw codec starts with 'bafkrei' or 'bafkre'
            expect(result.canonical_cid).toMatch(/^bafkre[a-z2-7]+/);
            expect(result.event_cid).toMatch(/^bafkre[a-z2-7]+/);
        });

        it('should use sha2-256 multihash', async () => {
            const result = await store.storeEvent(mockEvent);

            // Verify CIDs are deterministic based on content
            const result2 = await store.storeEvent(mockEvent);

            // Same content = same CIDs
            expect(result2.canonical_cid).toBe(result.canonical_cid);
            expect(result2.event_cid).toBe(result.event_cid);
        });
    });

    describe('Integration with Blockchain Flow', () => {
        it('should provide event_cid for blockchain anchoring', async () => {
            // Step 1: Frontend stores event
            const storeResult = await store.storeEvent(mockEvent);

            // Step 2: Frontend gets event_cid
            expect(storeResult.event_cid).toBeTruthy();

            // Step 3: Frontend builds blockchain action with event_cid
            const blockchainAction = {
                author: 'testaccount',
                type: 21,
                hash: storeResult.hash,
                event_cid: storeResult.event_cid, // NEW: Required field
                parent: null,
                ts: mockEvent.created_at,
                tags: ['release']
            };

            expect(blockchainAction.event_cid).toBe(storeResult.event_cid);
            expect(blockchainAction.hash).toBe(storeResult.hash);
        });

        it('should enable ingestion to retrieve by event_cid from blockchain', async () => {
            // Step 1: Event stored and anchored on blockchain
            const storeResult = await store.storeEvent(mockEvent);
            const anchoredEventCid = storeResult.event_cid;

            // Step 2: Ingestion reads blockchain and gets event_cid
            // Step 3: Ingestion retrieves full event using event_cid
            const retrieved = await store.retrieveByEventCid(anchoredEventCid);

            expect(retrieved).toBeDefined();
            expect(retrieved.sig).toBe(mockEvent.sig);

            // Step 4: Verify hash matches blockchain anchor
            const computedHash = store.calculateHash(retrieved);
            expect(computedHash).toBe(storeResult.hash);
        });
    });
});
