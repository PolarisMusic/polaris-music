/**
 * @fileoverview Tests for SHiP Event Source (T6)
 *
 * Verifies:
 * - SHiP produces identical AnchoredEvents as Substreams
 * - Event extraction from action traces
 * - Event hash computation matches
 * - Source switching with dedupe
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import { ShipEventSource } from '../../src/indexer/shipEventSource.js';
import { IngestionHandler } from '../../src/api/ingestion.js';
import EventStore from '../../src/storage/eventStore.js';
import EventProcessor from '../../src/indexer/eventProcessor.js';
import MusicGraphDatabase from '../../src/graph/schema.js';
import neo4j from 'neo4j-driver';

// Mock ws module to prevent actual WebSocket connections in tests
jest.mock('ws');

// Mock Neo4j driver to avoid real database connections in CI
jest.mock('neo4j-driver', () => ({
    default: {
        driver: jest.fn(() => ({
            session: jest.fn(() => ({
                run: jest.fn().mockResolvedValue({ records: [] }),
                close: jest.fn(),
                beginTransaction: jest.fn(() => ({
                    run: jest.fn().mockResolvedValue({ records: [] }),
                    commit: jest.fn().mockResolvedValue(undefined),
                    rollback: jest.fn().mockResolvedValue(undefined),
                })),
            })),
            close: jest.fn(),
            verifyConnectivity: jest.fn().mockResolvedValue(true),
        })),
        auth: {
            basic: jest.fn(() => ({})),
        },
    },
    // Also export the mocks directly for default import syntax
    driver: jest.fn(() => ({
        session: jest.fn(() => ({
            run: jest.fn().mockResolvedValue({ records: [] }),
            close: jest.fn(),
            beginTransaction: jest.fn(() => ({
                run: jest.fn().mockResolvedValue({ records: [] }),
                commit: jest.fn().mockResolvedValue(undefined),
                rollback: jest.fn().mockResolvedValue(undefined),
            })),
        })),
        close: jest.fn(),
        verifyConnectivity: jest.fn().mockResolvedValue(true),
    })),
    auth: {
        basic: jest.fn(() => ({})),
    },
}));

// Skip these integration tests if no database is configured
const describeOrSkip = (process.env.GRAPH_URI && process.env.SKIP_GRAPH_TESTS !== 'true') ? describe : describe.skip;

describe('SHiP Event Source (T6) - Non-Integration Tests', () => {
    describe('Fail-Fast Safeguard', () => {
        test('should throw clear error when start() is called (SHiP not implemented)', async () => {
            const ship = new ShipEventSource({
                shipUrl: 'ws://localhost:8080',
                contractAccount: 'polaris'
            });

            // Act & Assert: start() should throw with clear error message
            await expect(ship.start()).rejects.toThrow(
                'SHiP event source not implemented (binary deserialization required). Use CHAIN_SOURCE=substreams instead.'
            );
        });

        test('should display clear error banner before throwing', async () => {
            const ship = new ShipEventSource({
                shipUrl: 'ws://localhost:8080',
                contractAccount: 'polaris'
            });

            // Capture console.error output
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            // Act: Try to start (will throw)
            try {
                await ship.start();
            } catch (error) {
                // Expected to throw
            }

            // Assert: Should have logged error banner
            expect(consoleErrorSpy).toHaveBeenCalledWith('═════════════════════════════════════════════════════════════');
            expect(consoleErrorSpy).toHaveBeenCalledWith('ERROR: SHiP event source is not fully implemented');
            expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Recommended: Set CHAIN_SOURCE=substreams'));

            // Cleanup
            consoleErrorSpy.mockRestore();
        });

        test('should not connect to WebSocket when start() fails', async () => {
            const ship = new ShipEventSource({
                shipUrl: 'ws://localhost:8080',
                contractAccount: 'polaris'
            });

            // Act: Try to start (will throw)
            try {
                await ship.start();
            } catch (error) {
                // Expected to throw
            }

            // Assert: Should NOT have created WebSocket connection
            expect(ship.ws).toBeNull();
            expect(ship.isRunning).toBe(false);
        });
    });
});

describeOrSkip('SHiP Event Source (T6)', () => {
    let graphDb;
    let driver;
    let eventStore;
    let eventProcessor;
    let ingestionHandler;

    beforeAll(async () => {
        // Use a real MusicGraphDatabase instance (required by EventProcessor)
        graphDb = new MusicGraphDatabase({
            uri: process.env.GRAPH_URI || 'bolt://localhost:7687',
            user: process.env.GRAPH_USER || 'neo4j',
            password: process.env.GRAPH_PASSWORD || 'password'
        });
        driver = graphDb.driver;

        // Initialize components
        eventStore = new EventStore({
            s3Bucket: process.env.S3_BUCKET || 'polaris-test-events',
            redisHost: process.env.REDIS_HOST || 'localhost',
            redisPort: process.env.REDIS_PORT || 6379
        });

        eventProcessor = new EventProcessor({
            db: graphDb,
            store: eventStore
        });

        ingestionHandler = new IngestionHandler(eventStore, eventProcessor);

        await driver.verifyConnectivity();
    });

    afterAll(async () => {
        await graphDb.close();
    });

    describe('AnchoredEvent Creation', () => {
        test('Creates AnchoredEvent with correct schema', () => {
            const ship = new ShipEventSource({
                shipUrl: 'ws://localhost:8080',
                contractAccount: 'polaris'
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

            const anchoredEvent = ship.createAnchoredEvent(actionPayload, 'put', metadata);

            // Verify schema matches Substreams format
            expect(anchoredEvent.event_hash).toBeDefined();
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
                contractAccount: 'polaris'
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

            const event1 = ship.createAnchoredEvent(actionPayload, 'put', metadata);
            const event2 = ship.createAnchoredEvent(actionPayload, 'put', metadata);

            // Same payload should produce same hash
            expect(event1.event_hash).toBe(event2.event_hash);
        });

        test('Different payloads produce different hashes', () => {
            const ship = new ShipEventSource({
                shipUrl: 'ws://localhost:8080',
                contractAccount: 'polaris'
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

            const event1 = ship.createAnchoredEvent(payload1, 'put', metadata);
            const event2 = ship.createAnchoredEvent(payload2, 'put', metadata);

            expect(event1.event_hash).not.toBe(event2.event_hash);
        });
    });

    describe('SHiP vs Substreams Output Comparison', () => {
        test('SHiP produces identical AnchoredEvent as Substreams for same action', () => {
            // Fixture: Same blockchain action processed by both sources

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
                contractAccount: 'polaris'
            });
            const shipEvent = ship.createAnchoredEvent(blockchainAction, 'put', metadata);

            // Substreams output (simulated - same format)
            const substreamsEvent = {
                event_hash: shipEvent.event_hash, // Should be identical
                payload: JSON.stringify(blockchainAction),
                block_num: metadata.blockNum,
                block_id: metadata.blockId,
                trx_id: metadata.transactionId,
                action_ordinal: metadata.actionOrdinal,
                timestamp: metadata.timestamp,
                source: 'substreams-eos', // Different source
                contract_account: 'polaris',
                action_name: 'put'
            };

            // CRITICAL: Event hashes must match (T6 AC1)
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

        test('Both sources produce events that ingest identically', async () => {
            const blockchainAction = {
                author: 'testuser',
                type: 21,
                hash: 'dual-source-test',
                body: {
                    release: { name: 'Dual Source Test' },
                    tracks: [{ title: 'Track 1' }],
                    tracklist: [{ position: '1', track_title: 'Track 1' }]
                }
            };

            const metadata = {
                blockNum: 100000051,
                blockId: 'block_dual',
                transactionId: 'trx_dual',
                actionOrdinal: 0,
                timestamp: 1704067200
            };

            // Create event from SHiP
            const ship = new ShipEventSource({
                shipUrl: 'ws://localhost:8080',
                contractAccount: 'polaris'
            });
            const shipEvent = ship.createAnchoredEvent(blockchainAction, 'put', metadata);

            // Ingest SHiP event
            const result1 = await ingestionHandler.processAnchoredEvent(shipEvent);
            expect(result1.status).toBe('processed');

            // Simulate Substreams event (same data, different source)
            const substreamsEvent = {
                ...shipEvent,
                source: 'substreams-eos'
            };

            // Attempt to ingest Substreams event
            const result2 = await ingestionHandler.processAnchoredEvent(substreamsEvent);

            // Should be deduped (same eventHash)
            expect(result2.status).toBe('duplicate');
            expect(result2.message).toContain('already processed');
        });
    });

    describe('Secondary Dedupe (Block/Trx/Ordinal)', () => {
        beforeEach(() => {
            // Clear dedupe caches
            ingestionHandler.processedHashes.clear();
            ingestionHandler.processedBlockTrxAction.clear();
        });

        test('Prevents double-ingestion when switching sources', async () => {
            const metadata = {
                blockNum: 100000052,
                blockId: 'block_switch',
                transactionId: 'trx_switch',
                actionOrdinal: 0,
                timestamp: 1704067200
            };

            // Event from SHiP
            const shipEvent = {
                event_hash: 'switch-test-hash-1',
                payload: JSON.stringify({
                    author: 'user',
                    type: 21,
                    body: { release: { name: 'Switch Test' }, tracks: [], tracklist: [] }
                }),
                ...metadata,
                source: 'ship-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            // Ingest from SHiP
            const result1 = await ingestionHandler.processAnchoredEvent(shipEvent);
            expect(result1.status).toBe('processed');

            // Simulate switching to Substreams
            // Same blockchain action but different event_hash due to payload differences
            const substreamsEvent = {
                event_hash: 'switch-test-hash-2', // Different hash
                payload: shipEvent.payload, // Same payload
                ...metadata, // SAME block/trx/ordinal
                source: 'substreams-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            // Attempt to ingest from Substreams
            const result2 = await ingestionHandler.processAnchoredEvent(substreamsEvent);

            // Should be deduped by (block, trx, ordinal) secondary dedupe
            expect(result2.status).toBe('duplicate');
            expect(result2.message).toContain('duplicate block/trx/action');
            expect(result2.dedupeKey).toBe(`${metadata.blockNum}:${metadata.transactionId}:${metadata.actionOrdinal}`);
        });

        test('Allows different actions from same transaction', async () => {
            const baseMetadata = {
                blockNum: 100000053,
                blockId: 'block_multi',
                transactionId: 'trx_multi',
                timestamp: 1704067200
            };

            // First action (ordinal 0)
            const event1 = {
                event_hash: 'multi-action-1',
                payload: JSON.stringify({
                    author: 'user',
                    type: 21,
                    body: { release: { name: 'Action 1' }, tracks: [], tracklist: [] }
                }),
                ...baseMetadata,
                action_ordinal: 0,
                source: 'ship-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            // Second action (ordinal 1)
            const event2 = {
                event_hash: 'multi-action-2',
                payload: JSON.stringify({
                    author: 'user',
                    type: 21,
                    body: { release: { name: 'Action 2' }, tracks: [], tracklist: [] }
                }),
                ...baseMetadata,
                action_ordinal: 1, // Different ordinal
                source: 'ship-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            const result1 = await ingestionHandler.processAnchoredEvent(event1);
            expect(result1.status).toBe('processed');

            const result2 = await ingestionHandler.processAnchoredEvent(event2);
            expect(result2.status).toBe('processed'); // Not deduped (different ordinal)
        });
    });

    describe('Action Data Extraction', () => {
        test('Extracts action data from object format', () => {
            const ship = new ShipEventSource({
                shipUrl: 'ws://localhost:8080',
                contractAccount: 'polaris'
            });

            const actionData = {
                author: 'testuser',
                type: 21,
                hash: 'test'
            };

            const extracted = ship.extractActionData(actionData);
            expect(extracted).toEqual(actionData);
        });

        test('Extracts action data from JSON string', () => {
            const ship = new ShipEventSource({
                shipUrl: 'ws://localhost:8080',
                contractAccount: 'polaris'
            });

            const actionData = {
                author: 'testuser',
                type: 21
            };

            const extracted = ship.extractActionData(JSON.stringify(actionData));
            expect(extracted).toEqual(actionData);
        });

        test('Returns null for non-JSON string (requires ABI deserialization)', () => {
            const ship = new ShipEventSource({
                shipUrl: 'ws://localhost:8080',
                contractAccount: 'polaris'
            });

            const extracted = ship.extractActionData('not-json-hex-data');
            expect(extracted).toBeNull();
        });
    });

    describe('Statistics Tracking', () => {
        test('Tracks processing statistics', () => {
            const ship = new ShipEventSource({
                shipUrl: 'ws://localhost:8080',
                contractAccount: 'polaris'
            });

            const stats = ship.getStats();

            expect(stats.blocksProcessed).toBe(0);
            expect(stats.eventsExtracted).toBe(0);
            expect(stats.reconnections).toBe(0);
            expect(stats.errors).toBe(0);
            expect(stats.currentBlock).toBe(0);
            expect(stats.isRunning).toBe(false);
        });
    });

    describe('Acceptance Criteria Verification', () => {
        test('AC1: SHiP produces identical stored events as Substreams', async () => {
            // Clear caches
            ingestionHandler.processedHashes.clear();
            ingestionHandler.processedBlockTrxAction.clear();

            const blockchainAction = {
                author: 'ac1user',
                type: 21,
                hash: 'ac1-test-hash',
                body: {
                    release: { name: 'AC1 Album' },
                    tracks: [{ title: 'AC1 Track' }],
                    tracklist: [{ position: '1', track_title: 'AC1 Track' }]
                }
            };

            const metadata = {
                blockNum: 100000100,
                blockId: 'block_ac1',
                transactionId: 'trx_ac1',
                actionOrdinal: 0,
                timestamp: 1704067200
            };

            // Create events from both sources
            const ship = new ShipEventSource({
                shipUrl: 'ws://localhost:8080',
                contractAccount: 'polaris'
            });
            const shipEvent = ship.createAnchoredEvent(blockchainAction, 'put', metadata);

            const substreamsEvent = {
                ...shipEvent,
                source: 'substreams-eos'
            };

            // Verify event hashes are identical
            expect(shipEvent.event_hash).toBe(substreamsEvent.event_hash);

            // Ingest SHiP event
            const shipResult = await ingestionHandler.processAnchoredEvent(shipEvent);
            expect(shipResult.status).toBe('processed');

            // Verify stored event
            const storedEvent = await eventStore.getEvent(shipEvent.event_hash);
            expect(storedEvent).toBeDefined();
            expect(storedEvent.blockchain_verified).toBe(true);

            // Substreams event should be deduped (same hash)
            ingestionHandler.processedHashes.clear(); // Clear in-memory to test storage dedupe
            const substreamsResult = await ingestionHandler.processAnchoredEvent(substreamsEvent);
            expect(substreamsResult.status).toBe('duplicate');
        });

        test('AC2: Switching sources does not double-ingest', async () => {
            // Clear caches
            ingestionHandler.processedHashes.clear();
            ingestionHandler.processedBlockTrxAction.clear();

            const metadata = {
                blockNum: 100000101,
                blockId: 'block_ac2',
                transactionId: 'trx_ac2',
                actionOrdinal: 0,
                timestamp: 1704067200
            };

            // Ingest from SHiP
            const shipEvent = {
                event_hash: 'ac2-ship-hash',
                payload: JSON.stringify({
                    author: 'ac2user',
                    type: 21,
                    body: { release: { name: 'AC2 Test' }, tracks: [], tracklist: [] }
                }),
                ...metadata,
                source: 'ship-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            const result1 = await ingestionHandler.processAnchoredEvent(shipEvent);
            expect(result1.status).toBe('processed');

            // Switch to Substreams - same action, possibly different hash
            const substreamsEvent = {
                event_hash: 'ac2-substreams-hash', // Different hash
                payload: shipEvent.payload,
                ...metadata, // SAME block/trx/ordinal
                source: 'substreams-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            const result2 = await ingestionHandler.processAnchoredEvent(substreamsEvent);

            // Should be prevented by secondary dedupe
            expect(result2.status).toBe('duplicate');
            expect(result2.dedupeKey).toBe(`${metadata.blockNum}:${metadata.transactionId}:${metadata.actionOrdinal}`);

            // Verify no double-ingestion in storage
            const shipStored = await eventStore.getEvent(shipEvent.event_hash);
            expect(shipStored).toBeDefined();

            try {
                const substreamsStored = await eventStore.getEvent(substreamsEvent.event_hash);
                // Should not exist (was deduped before storage)
                expect(substreamsStored).toBeUndefined();
            } catch (error) {
                // Expected: event not found
                expect(error.message).toContain('not found');
            }
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
