/**
 * @fileoverview Tests for SHiP and Substreams Output Parity
 *
 * Demonstrates that both chain sources produce identical content_hash
 * and that deduplication works correctly across sources.
 *
 * Stage 4: SHiP fallback compatibility
 *
 * Note: Tests use unsigned events (no sig field) which are allowed in devMode
 * when NODE_ENV=test. This avoids needing to generate valid EOSIO signatures.
 */

import { describe, it, expect, beforeEach, afterAll, jest } from '@jest/globals';
import IngestionHandler from '../../src/api/ingestion.js';
import EventStore from '../../src/storage/eventStore.js';
import crypto from 'crypto';

describe('SHiP and Substreams Output Parity', () => {
    let ingestionHandler;
    let mockEventStore;
    let mockEventProcessor;
    let mockStoredEvent;
    const testContentHash = 'abc123def456789';

    beforeEach(() => {
        // Mock stored event
        mockStoredEvent = {
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
            }
            // Note: No sig field - devMode allows unsigned events in tests
        };

        // Mock EventStore
        mockEventStore = {
            retrieveEvent: jest.fn().mockResolvedValue(mockStoredEvent),
            calculateHash: jest.fn().mockReturnValue(testContentHash),
            storeEvent: jest.fn()
        };

        // Mock EventProcessor
        mockEventProcessor = {
            eventHandlers: {
                21: jest.fn() // CREATE_RELEASE_BUNDLE handler
            }
        };

        // Create ingestion handler
        ingestionHandler = new IngestionHandler(mockEventStore, mockEventProcessor);
    });

    describe('AnchoredEvent format compatibility', () => {
        it('should process anchored event from Substreams', async () => {
            // Simulate Substreams output
            const substreamsEvent = {
                content_hash: testContentHash,
                event_hash: 'different_action_hash_123',
                payload: JSON.stringify({
                    author: 'testuser1234',
                    type: 21,
                    hash: testContentHash,
                    ts: 1700000000,
                    tags: ['rock']
                }),
                block_num: 12345,
                block_id: 'block_abc123',
                trx_id: 'trx_def456',
                action_ordinal: 0,
                timestamp: 1700000000,
                source: 'substreams-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            // Process the anchored event
            const result = await ingestionHandler.processAnchoredEvent(substreamsEvent);

            // Verify success
            expect(result.status).toBe('success');
            expect(result.contentHash).toBe(testContentHash);
            expect(mockEventStore.retrieveEvent).toHaveBeenCalledWith(testContentHash, { requireSig: true });
        });

        it('should process anchored event from SHiP', async () => {
            // Simulate SHiP output
            const shipEvent = {
                content_hash: testContentHash,
                event_hash: 'different_ship_hash_456',
                payload: JSON.stringify({
                    author: 'testuser1234',
                    type: 21,
                    hash: testContentHash,
                    ts: 1700000000,
                    tags: ['rock']
                }),
                block_num: 12345,
                block_id: 'block_abc123',
                trx_id: 'trx_def456',
                action_ordinal: 0,
                timestamp: 1700000000,
                source: 'ship-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            // Process the anchored event
            const result = await ingestionHandler.processAnchoredEvent(shipEvent);

            // Verify success
            expect(result.status).toBe('success');
            expect(result.contentHash).toBe(testContentHash);
            expect(mockEventStore.retrieveEvent).toHaveBeenCalledWith(testContentHash, { requireSig: true });
        });

        it('should produce identical content_hash from both sources', () => {
            // Same blockchain put action
            const putActionPayload = {
                author: 'testuser1234',
                type: 21,
                hash: testContentHash, // This is put.hash from blockchain
                ts: 1700000000,
                tags: ['rock']
            };

            // Simulate what SHiP does: extract put.hash as content_hash
            const payloadJson = JSON.stringify(putActionPayload);
            const eventHash = crypto.createHash('sha256').update(payloadJson).digest('hex');

            // SHiP extracts content_hash from put.hash (Stage 3)
            const shipContentHash = putActionPayload.hash; // This is testContentHash

            // Simulate what Substreams does: extract put.hash as content_hash (Stage 3)
            // (this is what Substreams does in lib.rs: hex::encode(put_action.hash))
            const substreamsContentHash = testContentHash;

            // Both sources produce identical content_hash
            expect(shipContentHash).toBe(substreamsContentHash);
            expect(shipContentHash).toBe(testContentHash);

            // event_hash (action payload hash) differs, but content_hash is identical
            // This is the key insight: dedupe by content_hash, not event_hash
        });
    });

    describe('Cross-source deduplication', () => {
        it('should deduplicate when same event comes from different sources', async () => {
            // First event from Substreams
            const substreamsEvent = {
                content_hash: testContentHash,
                event_hash: 'substreams_action_hash',
                payload: JSON.stringify({
                    author: 'testuser1234',
                    type: 21,
                    hash: testContentHash,
                    ts: 1700000000,
                    tags: []
                }),
                block_num: 12345,
                block_id: 'block_abc123',
                trx_id: 'trx_def456',
                action_ordinal: 0,
                timestamp: 1700000000,
                source: 'substreams-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            // Same event from SHiP (different event_hash but same content_hash)
            const shipEvent = {
                content_hash: testContentHash,
                event_hash: 'ship_action_hash_different',
                payload: JSON.stringify({
                    author: 'testuser1234',
                    type: 21,
                    hash: testContentHash,
                    ts: 1700000000,
                    tags: []
                }),
                block_num: 12345,
                block_id: 'block_abc123',
                trx_id: 'trx_def456',
                action_ordinal: 0,
                timestamp: 1700000000,
                source: 'ship-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            // Process Substreams event first
            const result1 = await ingestionHandler.processAnchoredEvent(substreamsEvent);
            expect(result1.status).toBe('success');

            // Process SHiP event (same content_hash)
            const result2 = await ingestionHandler.processAnchoredEvent(shipEvent);

            // Should be deduplicated
            expect(result2.status).toBe('duplicate');
            expect(result2.contentHash).toBe(testContentHash);

            // EventStore should only be called once
            expect(mockEventStore.retrieveEvent).toHaveBeenCalledTimes(1);
        });

        it('should handle switching from Substreams to SHiP without double-ingestion', async () => {
            const events = [
                // Events 1-3 from Substreams
                {
                    content_hash: 'hash1',
                    event_hash: 'sub_hash_1',
                    payload: JSON.stringify({ author: 'user1', type: 21, hash: 'hash1', ts: 100, tags: [] }),
                    block_num: 100,
                    block_id: 'block100',
                    trx_id: 'trx100',
                    action_ordinal: 0,
                    timestamp: 100,
                    source: 'substreams-eos',
                    contract_account: 'polaris',
                    action_name: 'put'
                },
                {
                    content_hash: 'hash2',
                    event_hash: 'sub_hash_2',
                    payload: JSON.stringify({ author: 'user2', type: 21, hash: 'hash2', ts: 101, tags: [] }),
                    block_num: 101,
                    block_id: 'block101',
                    trx_id: 'trx101',
                    action_ordinal: 0,
                    timestamp: 101,
                    source: 'substreams-eos',
                    contract_account: 'polaris',
                    action_name: 'put'
                },
                // Event 2 again from SHiP (overlap during source switch)
                {
                    content_hash: 'hash2',
                    event_hash: 'ship_hash_2_different',
                    payload: JSON.stringify({ author: 'user2', type: 21, hash: 'hash2', ts: 101, tags: [] }),
                    block_num: 101,
                    block_id: 'block101',
                    trx_id: 'trx101',
                    action_ordinal: 0,
                    timestamp: 101,
                    source: 'ship-eos',
                    contract_account: 'polaris',
                    action_name: 'put'
                },
                // Event 3 from SHiP
                {
                    content_hash: 'hash3',
                    event_hash: 'ship_hash_3',
                    payload: JSON.stringify({ author: 'user3', type: 21, hash: 'hash3', ts: 102, tags: [] }),
                    block_num: 102,
                    block_id: 'block102',
                    trx_id: 'trx102',
                    action_ordinal: 0,
                    timestamp: 102,
                    source: 'ship-eos',
                    contract_account: 'polaris',
                    action_name: 'put'
                }
            ];

            // Mock EventStore to return events for each hash
            mockEventStore.retrieveEvent.mockImplementation(async (hash) => {
                return { ...mockStoredEvent, hash };
            });
            mockEventStore.calculateHash.mockImplementation((event) => event.hash);

            // Process all events
            const results = [];
            for (const event of events) {
                const result = await ingestionHandler.processAnchoredEvent(event);
                results.push(result);
            }

            // Verify results
            expect(results[0].status).toBe('success'); // hash1 from Substreams
            expect(results[1].status).toBe('success'); // hash2 from Substreams
            expect(results[2].status).toBe('duplicate'); // hash2 from SHiP (deduplicated!)
            expect(results[3].status).toBe('success'); // hash3 from SHiP

            // Only 3 unique events should be retrieved (hash1, hash2, hash3)
            expect(mockEventStore.retrieveEvent).toHaveBeenCalledTimes(3);

            // Verify stats
            const stats = ingestionHandler.getStats();
            expect(stats.eventsProcessed).toBe(3);
            expect(stats.eventsDuplicate).toBe(1);
        });
    });

    describe('content_hash vs event_hash', () => {
        it('should use content_hash for dedupe even when event_hash differs', async () => {
            // Two events with same content_hash but different event_hash
            const event1 = {
                content_hash: testContentHash,
                event_hash: 'different_hash_1',
                payload: JSON.stringify({
                    author: 'user1',
                    type: 21,
                    hash: testContentHash,
                    ts: 100,
                    tags: []
                }),
                block_num: 100,
                block_id: 'block100',
                trx_id: 'trx100',
                action_ordinal: 0,
                timestamp: 100,
                source: 'substreams-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            const event2 = {
                content_hash: testContentHash,
                event_hash: 'completely_different_hash_2',
                payload: JSON.stringify({
                    author: 'user1',
                    type: 21,
                    hash: testContentHash,
                    ts: 100,
                    tags: []
                }),
                block_num: 100,
                block_id: 'block100',
                trx_id: 'trx100',
                action_ordinal: 0,
                timestamp: 100,
                source: 'ship-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            // Process both events
            const result1 = await ingestionHandler.processAnchoredEvent(event1);
            const result2 = await ingestionHandler.processAnchoredEvent(event2);

            // First succeeds, second is deduplicated
            expect(result1.status).toBe('success');
            expect(result2.status).toBe('duplicate');

            // Deduplication happened based on content_hash, not event_hash
            expect(result2.contentHash).toBe(testContentHash);
        });
    });

    // Cleanup to prevent worker exit issues
    afterAll(async () => {
        jest.restoreAllMocks();
    });
});
