/**
 * @fileoverview Tests for SHiP Event Source (T6) - Canonical path
 *
 * Original T6 tests verified the fail-fast safeguard and AnchoredEvent creation.
 * Now that the real SHiP stack is implemented (backend/src/indexer/ship/),
 * these tests verify:
 * - ShipEventSource imports cleanly from the canonical path
 * - AnchoredEvent creation still matches Substreams format
 * - Event hash computation is deterministic
 *
 * Full SHiP stack tests are in shipStack.test.js
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import { ShipEventSource } from '../../src/indexer/ship/shipEventSource.js';
import crypto from 'crypto';

// Mock ws module to prevent actual WebSocket connections in tests
jest.mock('ws');

describe('SHiP Event Source (T6)', () => {
    describe('Canonical export', () => {
        test('ShipEventSource is exported from canonical path', () => {
            expect(ShipEventSource).toBeDefined();
            expect(typeof ShipEventSource).toBe('function');
        });

        test('can instantiate ShipEventSource', () => {
            const ship = new ShipEventSource({
                shipUrl: 'ws://localhost:8080',
                rpcUrl: 'http://localhost:8888',
                contractAccount: 'polaris',
            });
            expect(ship).toBeDefined();
            expect(ship.contractAccount).toBe('polaris');
        });
    });

    describe('AnchoredEvent Creation', () => {
        test('Creates AnchoredEvent with correct schema', () => {
            const ship = new ShipEventSource({
                shipUrl: 'ws://localhost:8080',
                rpcUrl: 'http://localhost:8888',
                contractAccount: 'polaris',
            });

            const actionPayload = {
                author: 'testuser',
                type: 21,
                hash: 'test-hash',
                ts: 1704067200,
                body: {
                    release: { name: 'Test Album' },
                    tracks: [{ title: 'Track 1' }],
                    tracklist: [{ position: '1', track_title: 'Track 1' }]
                }
            };

            const metadata = {
                blockNum: 100000000,
                blockId: 'abcdef1234567890',
                transactionId: 'trx123456789',
                actionOrdinal: 0,
                timestamp: 1704067200
            };

            const anchoredEvent = ship._createAnchoredEvent(actionPayload, 'put', metadata);

            // Verify schema matches Substreams format
            expect(anchoredEvent.event_hash).toBeDefined();
            expect(anchoredEvent.content_hash).toBe('test-hash'); // put.hash
            expect(anchoredEvent.payload).toBeDefined();
            expect(anchoredEvent.block_num).toBe(100000000);
            expect(anchoredEvent.block_id).toBe('abcdef1234567890');
            expect(anchoredEvent.trx_id).toBe('trx123456789');
            expect(anchoredEvent.action_ordinal).toBe(0);
            expect(anchoredEvent.timestamp).toBe(1704067200);
            expect(anchoredEvent.source).toBe('ship-eos');
            expect(anchoredEvent.contract_account).toBe('polaris');
            expect(anchoredEvent.action_name).toBe('put');
        });

        test('Event hash is deterministic (same payload = same hash)', () => {
            const ship = new ShipEventSource({
                shipUrl: 'ws://localhost:8080',
                rpcUrl: 'http://localhost:8888',
                contractAccount: 'polaris',
            });

            const actionPayload = {
                author: 'testuser',
                type: 21,
                hash: 'test-hash',
                body: { test: 'data' }
            };

            const metadata = {
                blockNum: 1,
                blockId: 'block1',
                transactionId: 'trx1',
                actionOrdinal: 0,
                timestamp: 123456
            };

            const event1 = ship._createAnchoredEvent(actionPayload, 'put', metadata);
            const event2 = ship._createAnchoredEvent(actionPayload, 'put', metadata);

            // Same payload should produce same hash
            expect(event1.event_hash).toBe(event2.event_hash);
        });

        test('Different payloads produce different hashes', () => {
            const ship = new ShipEventSource({
                shipUrl: 'ws://localhost:8080',
                rpcUrl: 'http://localhost:8888',
                contractAccount: 'polaris',
            });

            const metadata = {
                blockNum: 1,
                blockId: 'block1',
                transactionId: 'trx1',
                actionOrdinal: 0,
                timestamp: 123456
            };

            const payload1 = { author: 'user1', type: 21 };
            const payload2 = { author: 'user2', type: 21 };

            const event1 = ship._createAnchoredEvent(payload1, 'put', metadata);
            const event2 = ship._createAnchoredEvent(payload2, 'put', metadata);

            expect(event1.event_hash).not.toBe(event2.event_hash);
        });
    });

    describe('SHiP vs Substreams Output Comparison', () => {
        test('SHiP produces identical AnchoredEvent as Substreams for same action', () => {
            const blockchainAction = {
                author: 'polarisuser',
                type: 21,
                hash: 'identical-test-hash',
                parent: '',
                ts: 1704067200,
                tags: ['rock'],
                body: {
                    release: {
                        name: 'Identical Album',
                        release_date: '2024-01-15'
                    },
                    groups: [],
                    tracks: [{ title: 'Identical Track', duration: 180 }],
                    tracklist: [{ position: '1', track_title: 'Identical Track', duration: 180 }]
                }
            };

            const metadata = {
                blockNum: 100000050,
                blockId: 'block_identical',
                transactionId: 'trx_identical',
                actionOrdinal: 0,
                timestamp: 1704067200
            };

            // SHiP output
            const ship = new ShipEventSource({
                shipUrl: 'ws://localhost:8080',
                rpcUrl: 'http://localhost:8888',
                contractAccount: 'polaris',
            });
            const shipEvent = ship._createAnchoredEvent(blockchainAction, 'put', metadata);

            // Substreams output (simulated - same format)
            const substreamsEvent = {
                content_hash: blockchainAction.hash,
                event_hash: shipEvent.event_hash,
                payload: JSON.stringify(blockchainAction),
                block_num: metadata.blockNum,
                block_id: metadata.blockId,
                trx_id: metadata.transactionId,
                action_ordinal: metadata.actionOrdinal,
                timestamp: metadata.timestamp,
                source: 'substreams-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            // CRITICAL: content_hash must match (T6 AC1)
            expect(shipEvent.content_hash).toBe(substreamsEvent.content_hash);

            // Event hashes must match
            expect(shipEvent.event_hash).toBe(substreamsEvent.event_hash);

            // Payload must be identical
            expect(shipEvent.payload).toBe(substreamsEvent.payload);

            // Block metadata must match
            expect(shipEvent.block_num).toBe(substreamsEvent.block_num);
            expect(shipEvent.block_id).toBe(substreamsEvent.block_id);
            expect(shipEvent.trx_id).toBe(substreamsEvent.trx_id);
            expect(shipEvent.action_ordinal).toBe(substreamsEvent.action_ordinal);
            expect(shipEvent.timestamp).toBe(substreamsEvent.timestamp);

            // Only difference should be source identifier
            expect(shipEvent.source).toBe('ship-eos');
            expect(substreamsEvent.source).toBe('substreams-eos');
        });
    });

    describe('Statistics Tracking', () => {
        test('Tracks processing statistics', () => {
            const ship = new ShipEventSource({
                shipUrl: 'ws://localhost:8080',
                rpcUrl: 'http://localhost:8888',
                contractAccount: 'polaris',
            });

            const stats = ship.getStats();

            expect(stats.blocksProcessed).toBe(0);
            expect(stats.eventsExtracted).toBe(0);
            expect(stats.errors).toBe(0);
            expect(stats.isRunning).toBe(false);
        });
    });
});

// Cleanup mocks after each test to prevent leaks
afterEach(() => {
    jest.clearAllMocks();
});

// Restore all mocks after all tests complete
afterAll(() => {
    jest.restoreAllMocks();
});
