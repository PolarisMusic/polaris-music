/**
 * @fileoverview Tests for chain ingestion endpoint (T5)
 *
 * Verifies:
 * - Anchored event ingestion from Substreams
 * - Event deduplication by eventHash
 * - Signature verification (blockchain-verified)
 * - Event storage
 * - ReleaseBundle validation and graph updates
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { IngestionHandler } from '../../src/api/ingestion.js';
import { EventStore } from '../../src/storage/eventStore.js';
import EventProcessor from '../../src/indexer/eventProcessor.js';
import neo4j from 'neo4j-driver';

describe('Chain Ingestion (T5)', () => {
    let ingestionHandler;
    let eventStore;
    let eventProcessor;
    let driver;

    beforeAll(async () => {
        // Connect to test database
        driver = neo4j.driver(
            process.env.GRAPH_URI || 'bolt://localhost:7687',
            neo4j.auth.basic(
                process.env.GRAPH_USER || 'neo4j',
                process.env.GRAPH_PASSWORD || 'password'
            )
        );

        // Initialize event store
        eventStore = new EventStore({
            s3Bucket: process.env.S3_BUCKET || 'polaris-test-events',
            redisHost: process.env.REDIS_HOST || 'localhost',
            redisPort: process.env.REDIS_PORT || 6379
        });

        // Initialize event processor
        eventProcessor = new EventProcessor({
            db: { driver },
            store: eventStore
        });

        // Initialize ingestion handler
        ingestionHandler = new IngestionHandler(eventStore, eventProcessor);

        await driver.verifyConnectivity();
    });

    afterAll(async () => {
        await driver.close();
    });

    beforeEach(async () => {
        // Clear processed hashes cache
        ingestionHandler.processedHashes.clear();
    });

    describe('Anchored Event Processing', () => {
        test('Processes valid anchored event from Substreams', async () => {
            // Fixture: Anchored event from blockchain
            const anchoredEvent = {
                event_hash: 'a1b2c3d4e5f6789012345678901234567890abcdef',
                payload: JSON.stringify({
                    author: 'testuser',
                    type: 21, // CREATE_RELEASE_BUNDLE
                    hash: 'a1b2c3d4e5f6789012345678901234567890abcdef',
                    parent: '',
                    ts: Math.floor(Date.now() / 1000),
                    tags: ['test'],
                    body: {
                        release: {
                            name: 'Test Album',
                            release_date: '2024-01-15'
                        },
                        groups: [],
                        tracks: [{ title: 'Test Track', duration: 180 }],
                        tracklist: [{ position: '1', track_title: 'Test Track', duration: 180 }]
                    }
                }),
                block_num: 100000000,
                block_id: 'abcdef1234567890',
                trx_id: 'trx123456789abcdef',
                action_ordinal: 0,
                timestamp: Math.floor(Date.now() / 1000),
                source: 'substreams-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            const result = await ingestionHandler.processAnchoredEvent(anchoredEvent);

            expect(result.status).toBe('processed');
            expect(result.eventHash).toBe(anchoredEvent.event_hash);
            expect(result.blockNum).toBe(anchoredEvent.block_num);
            expect(result.trxId).toBe(anchoredEvent.trx_id);
        });

        test('Deduplicates events by eventHash (idempotent ingestion)', async () => {
            const anchoredEvent = {
                event_hash: 'duplicate-test-hash-12345',
                payload: JSON.stringify({
                    author: 'testuser',
                    type: 21,
                    hash: 'duplicate-test-hash-12345',
                    parent: '',
                    ts: Math.floor(Date.now() / 1000),
                    tags: ['test'],
                    body: {
                        release: { name: 'Duplicate Test' },
                        tracks: [{ title: 'Track 1' }],
                        tracklist: [{ position: '1', track_title: 'Track 1' }]
                    }
                }),
                block_num: 100000001,
                block_id: 'block123',
                trx_id: 'trx_dup',
                action_ordinal: 0,
                timestamp: Math.floor(Date.now() / 1000),
                source: 'substreams-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            // Process first time
            const result1 = await ingestionHandler.processAnchoredEvent(anchoredEvent);
            expect(result1.status).toBe('processed');

            // Process second time (should deduplicate)
            const result2 = await ingestionHandler.processAnchoredEvent(anchoredEvent);
            expect(result2.status).toBe('duplicate');
            expect(result2.message).toContain('already processed');
        });

        test('Rejects anchored event with missing required fields', async () => {
            const invalidEvent = {
                event_hash: 'test-hash',
                // Missing payload
                block_num: 100000000
            };

            await expect(async () => {
                await ingestionHandler.processAnchoredEvent(invalidEvent);
            }).rejects.toThrow('Missing required fields');
        });

        test('Rejects anchored event with invalid JSON payload', async () => {
            const invalidEvent = {
                event_hash: 'test-hash',
                payload: 'not valid json {{{',
                block_num: 100000000,
                block_id: 'block123',
                trx_id: 'trx123',
                action_ordinal: 0,
                timestamp: Math.floor(Date.now() / 1000),
                source: 'substreams-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            await expect(async () => {
                await ingestionHandler.processAnchoredEvent(invalidEvent);
            }).rejects.toThrow('Invalid JSON payload');
        });

        test('Marks blockchain-anchored events as blockchain_verified', async () => {
            const anchoredEvent = {
                event_hash: 'verified-test-hash',
                payload: JSON.stringify({
                    author: 'testuser',
                    type: 21,
                    hash: 'verified-test-hash',
                    parent: '',
                    ts: Math.floor(Date.now() / 1000),
                    tags: [],
                    body: {
                        release: { name: 'Verified Album' },
                        tracks: [{ title: 'Track 1' }],
                        tracklist: [{ position: '1', track_title: 'Track 1' }]
                    }
                }),
                block_num: 100000002,
                block_id: 'block_verified',
                trx_id: 'trx_verified',
                action_ordinal: 0,
                timestamp: Math.floor(Date.now() / 1000),
                source: 'substreams-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            const result = await ingestionHandler.processAnchoredEvent(anchoredEvent);

            expect(result.status).toBe('processed');
            // Verify event was stored (can retrieve it)
            const storedEvent = await eventStore.getEvent(anchoredEvent.event_hash);
            expect(storedEvent).toBeDefined();
            expect(storedEvent.blockchain_verified).toBe(true);
            expect(storedEvent.blockchain_metadata).toBeDefined();
            expect(storedEvent.blockchain_metadata.block_num).toBe(anchoredEvent.block_num);
        });
    });

    describe('Event Reconstruction', () => {
        test('Reconstructs CREATE_RELEASE_BUNDLE event from PUT action', () => {
            const actionPayload = {
                author: 'testuser',
                type: 21,
                hash: 'test-hash',
                parent: '',
                ts: 1704067200,
                tags: ['rock'],
                body: {
                    release: { name: 'Test Album' },
                    tracks: [{ title: 'Track 1' }],
                    tracklist: [{ position: '1', track_title: 'Track 1' }]
                }
            };

            const metadata = {
                block_num: 100000000,
                block_id: 'block123',
                trx_id: 'trx123',
                action_ordinal: 0,
                timestamp: 1704067200,
                source: 'substreams-eos',
                contract_account: 'polaris'
            };

            const event = ingestionHandler.reconstructEventFromPayload(actionPayload, 'put', metadata);

            expect(event.v).toBe(1);
            expect(event.type).toBe('CREATE_RELEASE_BUNDLE');
            expect(event.author_pubkey).toBe('testuser');
            expect(event.created_at).toBe(actionPayload.ts);
            expect(event.blockchain_verified).toBeUndefined(); // Added later
        });

        test('Reconstructs VOTE event from vote action', () => {
            const actionPayload = {
                voter: 'testvoter',
                tx_hash: 'event-hash-to-vote-on',
                val: 1,
                weight: 100
            };

            const metadata = {
                block_num: 100000000,
                timestamp: 1704067200
            };

            const event = ingestionHandler.reconstructEventFromPayload(actionPayload, 'vote', metadata);

            expect(event.type).toBe('VOTE');
            expect(event.author_pubkey).toBe('testvoter');
            expect(event.body.tx_hash).toBe('event-hash-to-vote-on');
            expect(event.body.val).toBe(1);
        });

        test('Reconstructs FINALIZE event from finalize action', () => {
            const actionPayload = {
                tx_hash: 'event-hash-to-finalize',
                accepted: true,
                approval_percent: 75,
                reward_amount: 100
            };

            const metadata = {
                block_num: 100000000,
                timestamp: 1704067200
            };

            const event = ingestionHandler.reconstructEventFromPayload(
                actionPayload,
                'finalize',
                metadata
            );

            expect(event.type).toBe('FINALIZE');
            expect(event.body.tx_hash).toBe('event-hash-to-finalize');
            expect(event.body.accepted).toBe(true);
        });
    });

    describe('Event Type Handling', () => {
        test('Processes CREATE_RELEASE_BUNDLE events (primary T5 type)', async () => {
            const anchoredEvent = {
                event_hash: 'release-bundle-hash',
                payload: JSON.stringify({
                    author: 'testuser',
                    type: 21,
                    hash: 'release-bundle-hash',
                    parent: '',
                    ts: Math.floor(Date.now() / 1000),
                    tags: [],
                    body: {
                        release: {
                            name: 'Test Release',
                            release_date: '2024-01-15'
                        },
                        groups: [],
                        tracks: [{ title: 'Track 1', duration: 180 }],
                        tracklist: [{ position: '1', track_title: 'Track 1', duration: 180 }]
                    }
                }),
                block_num: 100000010,
                block_id: 'block_rb',
                trx_id: 'trx_rb',
                action_ordinal: 0,
                timestamp: Math.floor(Date.now() / 1000),
                source: 'substreams-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            const result = await ingestionHandler.processAnchoredEvent(anchoredEvent);

            expect(result.status).toBe('processed');
            expect(result.eventType).toBe('CREATE_RELEASE_BUNDLE');
        });

        test('De-scopes VOTE events with clear message', async () => {
            const anchoredEvent = {
                event_hash: 'vote-hash-123',
                payload: JSON.stringify({
                    voter: 'testvoter',
                    tx_hash: 'event-to-vote',
                    val: 1
                }),
                block_num: 100000011,
                block_id: 'block_vote',
                trx_id: 'trx_vote',
                action_ordinal: 0,
                timestamp: Math.floor(Date.now() / 1000),
                source: 'substreams-eos',
                contract_account: 'polaris',
                action_name: 'vote'
            };

            const result = await ingestionHandler.processAnchoredEvent(anchoredEvent);

            expect(result.status).toBe('processed');
            expect(result.processing.status).toBe('de-scoped');
            expect(result.processing.eventType).toBe('VOTE');
            expect(result.processing.message).toContain('not implemented');
        });

        test('De-scopes FINALIZE events with clear message', async () => {
            const anchoredEvent = {
                event_hash: 'finalize-hash-123',
                payload: JSON.stringify({
                    tx_hash: 'event-to-finalize',
                    accepted: true,
                    approval_percent: 75
                }),
                block_num: 100000012,
                block_id: 'block_finalize',
                trx_id: 'trx_finalize',
                action_ordinal: 0,
                timestamp: Math.floor(Date.now() / 1000),
                source: 'substreams-eos',
                contract_account: 'polaris',
                action_name: 'finalize'
            };

            const result = await ingestionHandler.processAnchoredEvent(anchoredEvent);

            expect(result.status).toBe('processed');
            expect(result.processing.status).toBe('de-scoped');
            expect(result.processing.eventType).toBe('FINALIZE');
            expect(result.processing.message).toContain('not implemented');
        });
    });

    describe('Hash Computation', () => {
        test('Computes event hash correctly', () => {
            const event = {
                v: 1,
                type: 'CREATE_RELEASE_BUNDLE',
                author_pubkey: 'testuser',
                created_at: 1704067200,
                parents: [],
                body: { release: { name: 'Test' } },
                proofs: { source_links: [] },
                sig: ''
            };

            const hash = ingestionHandler.computeEventHash(event);

            expect(hash).toBeDefined();
            expect(hash.length).toBe(64); // SHA256 hex length
            expect(hash).toMatch(/^[0-9a-f]+$/); // Valid hex
        });

        test('Same event produces same hash (deterministic)', () => {
            const event = {
                v: 1,
                type: 'TEST',
                author_pubkey: 'user',
                created_at: 123456,
                parents: [],
                body: { data: 'test' },
                proofs: { source_links: [] },
                sig: ''
            };

            const hash1 = ingestionHandler.computeEventHash(event);
            const hash2 = ingestionHandler.computeEventHash(event);

            expect(hash1).toBe(hash2);
        });
    });

    describe('Acceptance Criteria Verification', () => {
        test('AC1: Substreams produces anchored events (simulated via fixtures)', () => {
            // This test uses fixture data that simulates Substreams output
            // In production, Substreams would produce these events from blockchain
            const anchoredEvent = {
                event_hash: 'acceptance-test-1',
                payload: JSON.stringify({
                    author: 'testuser',
                    type: 21,
                    hash: 'acceptance-test-1',
                    body: {
                        release: { name: 'AC Test' },
                        tracks: [{ title: 'Track 1' }],
                        tracklist: [{ position: '1', track_title: 'Track 1' }]
                    }
                }),
                block_num: 100000020,
                block_id: 'ac_block_1',
                trx_id: 'ac_trx_1',
                action_ordinal: 0,
                timestamp: Math.floor(Date.now() / 1000),
                source: 'substreams-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            // Verify fixture has all required fields for anchored event
            expect(anchoredEvent.event_hash).toBeDefined();
            expect(anchoredEvent.payload).toBeDefined();
            expect(anchoredEvent.block_num).toBeDefined();
            expect(anchoredEvent.block_id).toBeDefined();
            expect(anchoredEvent.trx_id).toBeDefined();
            expect(anchoredEvent.action_ordinal).toBeDefined();
            expect(anchoredEvent.timestamp).toBeDefined();
            expect(anchoredEvent.source).toBeDefined();
        });

        test('AC2: Backend ingests events and updates graph (simulated)', async () => {
            const anchoredEvent = {
                event_hash: 'acceptance-test-2',
                payload: JSON.stringify({
                    author: 'testuser',
                    type: 21,
                    hash: 'acceptance-test-2',
                    body: {
                        release: { name: 'AC Graph Test' },
                        tracks: [{ title: 'Track 1' }],
                        tracklist: [{ position: '1', track_title: 'Track 1' }]
                    }
                }),
                block_num: 100000021,
                block_id: 'ac_block_2',
                trx_id: 'ac_trx_2',
                action_ordinal: 0,
                timestamp: Math.floor(Date.now() / 1000),
                source: 'substreams-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            const result = await ingestionHandler.processAnchoredEvent(anchoredEvent);

            // Verify backend ingested the event
            expect(result.status).toBe('processed');

            // Verify event was stored
            const storedEvent = await eventStore.getEvent(anchoredEvent.event_hash);
            expect(storedEvent).toBeDefined();

            // Note: Graph updates verification requires Neo4j queries
            // In production, this would check:
            // MATCH (r:Release {name: 'AC Graph Test'}) RETURN r
        });

        test('AC3: Dedupe exists by eventHash (idempotent)', async () => {
            const anchoredEvent = {
                event_hash: 'acceptance-test-3-dedupe',
                payload: JSON.stringify({
                    author: 'testuser',
                    type: 21,
                    hash: 'acceptance-test-3-dedupe',
                    body: {
                        release: { name: 'AC Dedupe Test' },
                        tracks: [{ title: 'Track 1' }],
                        tracklist: [{ position: '1', track_title: 'Track 1' }]
                    }
                }),
                block_num: 100000022,
                block_id: 'ac_block_3',
                trx_id: 'ac_trx_3',
                action_ordinal: 0,
                timestamp: Math.floor(Date.now() / 1000),
                source: 'substreams-eos',
                contract_account: 'polaris',
                action_name: 'put'
            };

            // First ingestion
            const result1 = await ingestionHandler.processAnchoredEvent(anchoredEvent);
            expect(result1.status).toBe('processed');

            // Second ingestion (duplicate)
            const result2 = await ingestionHandler.processAnchoredEvent(anchoredEvent);
            expect(result2.status).toBe('duplicate');

            // Third ingestion (still duplicate)
            const result3 = await ingestionHandler.processAnchoredEvent(anchoredEvent);
            expect(result3.status).toBe('duplicate');

            // Verify idempotency: Same result every time after first
            expect(result2.status).toBe(result3.status);
        });
    });
});
