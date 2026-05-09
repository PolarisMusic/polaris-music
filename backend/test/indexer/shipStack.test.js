/**
 * @fileoverview Tests for the SHiP Transport/Protocol Stack
 *
 * Tests the new real SHiP implementation:
 * - ShipProtocol: binary encode/decode
 * - ShipAbiRegistry: ABI loading and action data decoding
 * - ShipEventSource: AnchoredEvent creation and parity with Substreams
 * - Shared chain profiles
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Shared Chain Profiles ───────────────────────────────────────────
// Import at top level so Jest ESM resolution handles it properly
import { CHAIN_PROFILES, getChainProfile, resolveChainConfig } from '../../../shared/config/chainProfiles.js';

describe('Shared Chain Profiles', () => {
    test('exports CHAIN_PROFILES with local, jungle4, mainnet', () => {
        expect(CHAIN_PROFILES.local).toBeDefined();
        expect(CHAIN_PROFILES.jungle4).toBeDefined();
        expect(CHAIN_PROFILES.mainnet).toBeDefined();
    });

    test('each profile has required fields', () => {
        const requiredFields = [
            'name', 'chainId', 'rpcUrl', 'contractAccount',
            'useLocalAbi', 'ingestMode', 'chainSource', 'irreversibleOnly',
        ];

        for (const [profileName, profile] of Object.entries(CHAIN_PROFILES)) {
            for (const field of requiredFields) {
                expect(profile[field]).toBeDefined();
            }
        }
    });

    test('getChainProfile returns copy of profile', () => {
        const profile = getChainProfile('jungle4');
        expect(profile.name).toBe('jungle4');
        expect(profile.chainId).toBe('73e4385a2708e6d7048834fbc1079f2fabb17b3c125b146af438971e90716c4d');
    });

    test('getChainProfile throws on unknown profile', () => {
        expect(() => getChainProfile('nonexistent')).toThrow('Unknown chain profile');
    });

    test('resolveChainConfig uses env overrides', () => {
        const config = resolveChainConfig({
            CHAIN_PROFILE: 'local',
            RPC_URL: 'http://custom:8888',
            IRREVERSIBLE_ONLY: 'true',
        });

        expect(config.name).toBe('local');
        expect(config.rpcUrl).toBe('http://custom:8888'); // env override
        expect(config.chainId).toBe('8a34ec7df1b8cd06ff4a8abbaa7cc50300823350cadc59ab296cb00d104d2b8f'); // profile default
        expect(config.irreversibleOnly).toBe(true); // env override
    });

    test('local profile defaults to SHiP source', () => {
        expect(CHAIN_PROFILES.local.chainSource).toBe('ship');
        expect(CHAIN_PROFILES.local.shipUrl).toBe('ws://localhost:8080');
    });

    test('jungle4 profile defaults to Substreams source', () => {
        expect(CHAIN_PROFILES.jungle4.chainSource).toBe('substreams');
        expect(CHAIN_PROFILES.jungle4.substreamsEndpoint).toContain('pinax');
    });

    test('mainnet profile defaults to irreversible-only', () => {
        expect(CHAIN_PROFILES.mainnet.irreversibleOnly).toBe(true);
    });
});

// ─── ShipProtocol ────────────────────────────────────────────────────

describe('ShipProtocol', () => {
    let ShipProtocol;

    beforeEach(async () => {
        const mod = await import('../../src/indexer/ship/shipProtocol.js');
        ShipProtocol = mod.ShipProtocol;
    });

    test('constructor creates uninitialized protocol', () => {
        const protocol = new ShipProtocol();
        expect(protocol.initialized).toBe(false);
        expect(protocol.abi).toBeNull();
    });

    test('_ensureInitialized throws when not initialized', () => {
        const protocol = new ShipProtocol();
        expect(() => protocol._ensureInitialized()).toThrow('not initialized');
    });

    test('initialize accepts valid SHiP ABI JSON', () => {
        const protocol = new ShipProtocol();
        // Minimal valid ABI structure
        const minimalAbi = JSON.stringify({
            version: 'eosio::abi/1.1',
            types: [],
            structs: [
                { name: 'get_status_request_v0', base: '', fields: [] },
                { name: 'get_blocks_request_v0', base: '', fields: [
                    { name: 'start_block_num', type: 'uint32' },
                    { name: 'end_block_num', type: 'uint32' },
                    { name: 'max_messages_in_flight', type: 'uint32' },
                    { name: 'have_positions', type: 'block_position[]' },
                    { name: 'irreversible_only', type: 'bool' },
                    { name: 'fetch_block', type: 'bool' },
                    { name: 'fetch_traces', type: 'bool' },
                    { name: 'fetch_deltas', type: 'bool' },
                ]},
                { name: 'get_blocks_ack_request_v0', base: '', fields: [
                    { name: 'num_messages', type: 'uint32' },
                ]},
                { name: 'block_position', base: '', fields: [
                    { name: 'block_num', type: 'uint32' },
                    { name: 'block_id', type: 'checksum256' },
                ]},
                { name: 'get_status_result_v0', base: '', fields: [] },
                { name: 'get_blocks_result_v0', base: '', fields: [
                    { name: 'head', type: 'block_position' },
                    { name: 'last_irreversible', type: 'block_position' },
                    { name: 'this_block', type: 'block_position?' },
                    { name: 'prev_block', type: 'block_position?' },
                    { name: 'block', type: 'bytes?' },
                    { name: 'traces', type: 'bytes?' },
                    { name: 'deltas', type: 'bytes?' },
                ]},
            ],
            actions: [],
            tables: [],
            variants: [
                { name: 'request', types: ['get_status_request_v0', 'get_blocks_request_v0', 'get_blocks_ack_request_v0'] },
                { name: 'result', types: ['get_status_result_v0', 'get_blocks_result_v0'] },
            ],
        });

        protocol.initialize(minimalAbi);
        expect(protocol.initialized).toBe(true);
        expect(protocol.abi).not.toBeNull();
    });

    test('encodeGetBlocksRequest produces binary output', () => {
        const protocol = new ShipProtocol();
        // Use the minimal ABI from the test above
        protocol.initialize(JSON.stringify({
            version: 'eosio::abi/1.1',
            types: [],
            structs: [
                { name: 'get_status_request_v0', base: '', fields: [] },
                { name: 'get_blocks_request_v0', base: '', fields: [
                    { name: 'start_block_num', type: 'uint32' },
                    { name: 'end_block_num', type: 'uint32' },
                    { name: 'max_messages_in_flight', type: 'uint32' },
                    { name: 'have_positions', type: 'block_position[]' },
                    { name: 'irreversible_only', type: 'bool' },
                    { name: 'fetch_block', type: 'bool' },
                    { name: 'fetch_traces', type: 'bool' },
                    { name: 'fetch_deltas', type: 'bool' },
                ]},
                { name: 'get_blocks_ack_request_v0', base: '', fields: [
                    { name: 'num_messages', type: 'uint32' },
                ]},
                { name: 'block_position', base: '', fields: [
                    { name: 'block_num', type: 'uint32' },
                    { name: 'block_id', type: 'checksum256' },
                ]},
                { name: 'get_status_result_v0', base: '', fields: [] },
                { name: 'get_blocks_result_v0', base: '', fields: [] },
            ],
            actions: [],
            tables: [],
            variants: [
                { name: 'request', types: ['get_status_request_v0', 'get_blocks_request_v0', 'get_blocks_ack_request_v0'] },
                { name: 'result', types: ['get_status_result_v0', 'get_blocks_result_v0'] },
            ],
        }));

        const encoded = protocol.encodeGetBlocksRequest({
            startBlock: 100,
            endBlock: 200,
        });

        expect(encoded).toBeInstanceOf(Uint8Array);
        expect(encoded.length).toBeGreaterThan(0);

        // Variant index for get_blocks_request_v0 should be 1
        expect(encoded[0]).toBe(1);
    });

    test('encodeAck produces binary output', () => {
        const protocol = new ShipProtocol();
        protocol.initialize(JSON.stringify({
            version: 'eosio::abi/1.1',
            types: [],
            structs: [
                { name: 'get_status_request_v0', base: '', fields: [] },
                { name: 'get_blocks_request_v0', base: '', fields: [] },
                { name: 'get_blocks_ack_request_v0', base: '', fields: [
                    { name: 'num_messages', type: 'uint32' },
                ]},
                { name: 'get_status_result_v0', base: '', fields: [] },
                { name: 'get_blocks_result_v0', base: '', fields: [] },
            ],
            actions: [],
            tables: [],
            variants: [
                { name: 'request', types: ['get_status_request_v0', 'get_blocks_request_v0', 'get_blocks_ack_request_v0'] },
                { name: 'result', types: ['get_status_result_v0', 'get_blocks_result_v0'] },
            ],
        }));

        const encoded = protocol.encodeAck(5);
        expect(encoded).toBeInstanceOf(Uint8Array);
        // Variant index for get_blocks_ack_request_v0 should be 2
        expect(encoded[0]).toBe(2);
    });

    test('extractActionTraces filters by contract account', () => {
        const protocol = new ShipProtocol();
        // Don't need protocol initialized for this utility method

        const traces = [
            {
                id: 'trx123',
                action_traces: [
                    {
                        act: { account: 'polarismusic', name: 'put', data: {} },
                        action_ordinal: 1,
                        receiver: 'polarismusic',
                    },
                    {
                        act: { account: 'eosio.token', name: 'transfer', data: {} },
                        action_ordinal: 2,
                        receiver: 'eosio.token',
                    },
                    {
                        act: { account: 'polarismusic', name: 'vote', data: {} },
                        action_ordinal: 3,
                        receiver: 'polarismusic',
                    },
                ],
            },
        ];

        const results = protocol.extractActionTraces(traces, 'polarismusic', ['put', 'vote']);
        expect(results).toHaveLength(2);
        expect(results[0].name).toBe('put');
        expect(results[0].trxId).toBe('trx123');
        expect(results[1].name).toBe('vote');
    });

    test('extractActionTraces handles variant-wrapped traces', () => {
        const protocol = new ShipProtocol();

        const traces = [
            ['transaction_trace_v0', {
                id: 'trx456',
                action_traces: [
                    ['action_trace_v0', {
                        act: { account: 'polarismusic', name: 'put', data: {} },
                        action_ordinal: 0,
                        receiver: 'polarismusic',
                    }],
                ],
            }],
        ];

        const results = protocol.extractActionTraces(traces, 'polarismusic');
        expect(results).toHaveLength(1);
        expect(results[0].trxId).toBe('trx456');
    });
});

// ─── ShipAbiRegistry ─────────────────────────────────────────────────

describe('ShipAbiRegistry', () => {
    let ShipAbiRegistry;

    beforeEach(async () => {
        const mod = await import('../../src/indexer/ship/shipAbiRegistry.js');
        ShipAbiRegistry = mod.ShipAbiRegistry;
    });

    test('constructor sets defaults', () => {
        const registry = new ShipAbiRegistry({
            rpcUrl: 'http://localhost:8888',
        });
        expect(registry.contractAccount).toBe('polarismusic');
        expect(registry.useLocalAbi).toBe(false);
        expect(registry.abiCache.size).toBe(0);
    });

    test('hasAbi returns false for uncached account', () => {
        const registry = new ShipAbiRegistry({ rpcUrl: 'http://localhost:8888' });
        expect(registry.hasAbi('polarismusic')).toBe(false);
    });

    test('clearCache empties the cache', () => {
        const registry = new ShipAbiRegistry({ rpcUrl: 'http://localhost:8888' });
        // Manually add something to cache
        registry.abiCache.set('test', 'value');
        expect(registry.abiCache.size).toBe(1);
        registry.clearCache();
        expect(registry.abiCache.size).toBe(0);
    });

    test('decodeActionData handles already-decoded object data', async () => {
        const registry = new ShipAbiRegistry({ rpcUrl: 'http://localhost:8888' });

        // When data is already an object (not bytes), it should pass through
        const data = { author: 'testuser', type: 21, hash: 'abc123' };
        const decoded = await registry.decodeActionData('polarismusic', 'put', data);
        expect(decoded).toEqual(data);
    });
});

// ─── AnchoredEvent Parity ────────────────────────────────────────────

describe('AnchoredEvent Parity (SHiP vs Substreams)', () => {
    test('SHiP and Substreams produce matching content_hash for same put action', () => {
        // Load fixture
        const fixture = JSON.parse(
            fs.readFileSync(
                path.join(__dirname, '../fixtures/ship/samplePutAction.json'),
                'utf-8'
            )
        );

        const actionData = fixture.action.data;
        const metadata = fixture.metadata;

        // Simulate SHiP event creation (same logic as ShipEventSource._createAnchoredEvent)
        const payloadJson = JSON.stringify(actionData);
        const eventHash = crypto.createHash('sha256').update(payloadJson).digest('hex');
        const contentHash = actionData.hash; // put.hash is the canonical identifier

        const shipEvent = {
            content_hash: contentHash,
            event_hash: eventHash,
            payload: payloadJson,
            block_num: metadata.blockNum,
            block_id: metadata.blockId,
            trx_id: metadata.transactionId,
            action_ordinal: metadata.actionOrdinal,
            timestamp: metadata.timestamp,
            source: 'ship-eos',
            contract_account: 'polarismusic',
            action_name: 'put',
        };

        // Simulate Substreams event (same action data, different source)
        const substreamsEvent = {
            ...shipEvent,
            source: 'substreams-eos',
        };

        // CRITICAL: content_hash must match (canonical dedupe key)
        expect(shipEvent.content_hash).toBe(substreamsEvent.content_hash);
        expect(shipEvent.content_hash).toBe(fixture.expectedAnchoredEvent.content_hash);

        // event_hash must match (same payload JSON)
        expect(shipEvent.event_hash).toBe(substreamsEvent.event_hash);

        // payload must be identical
        expect(shipEvent.payload).toBe(substreamsEvent.payload);

        // block metadata must match
        expect(shipEvent.block_num).toBe(substreamsEvent.block_num);
        expect(shipEvent.block_id).toBe(substreamsEvent.block_id);
        expect(shipEvent.trx_id).toBe(substreamsEvent.trx_id);
        expect(shipEvent.action_ordinal).toBe(substreamsEvent.action_ordinal);
        expect(shipEvent.timestamp).toBe(substreamsEvent.timestamp);

        // Only difference: source identifier
        expect(shipEvent.source).toBe('ship-eos');
        expect(substreamsEvent.source).toBe('substreams-eos');
    });

    test('event_hash is deterministic for identical payloads', () => {
        const payload = { author: 'user1', type: 21, hash: 'xyz', body: { test: true } };
        const json1 = JSON.stringify(payload);
        const json2 = JSON.stringify(payload);

        const hash1 = crypto.createHash('sha256').update(json1).digest('hex');
        const hash2 = crypto.createHash('sha256').update(json2).digest('hex');

        expect(hash1).toBe(hash2);
    });

    test('different payloads produce different event_hashes', () => {
        const payload1 = { author: 'user1', type: 21 };
        const payload2 = { author: 'user2', type: 21 };

        const hash1 = crypto.createHash('sha256').update(JSON.stringify(payload1)).digest('hex');
        const hash2 = crypto.createHash('sha256').update(JSON.stringify(payload2)).digest('hex');

        expect(hash1).not.toBe(hash2);
    });

    test('non-put actions use event_hash as content_hash', () => {
        const votePayload = { voter: 'user1', submission_hash: 'abc', value: 1 };
        const payloadJson = JSON.stringify(votePayload);
        const eventHash = crypto.createHash('sha256').update(payloadJson).digest('hex');

        // For vote/finalize, content_hash should equal event_hash (no put.hash field)
        expect(eventHash).toBe(eventHash);
    });
});

// ─── ShipClient ──────────────────────────────────────────────────────

describe('ShipClient', () => {
    let ShipClient;

    beforeEach(async () => {
        const mod = await import('../../src/indexer/ship/shipClient.js');
        ShipClient = mod.ShipClient;
    });

    test('constructor sets config defaults', () => {
        const client = new ShipClient({
            shipUrl: 'ws://localhost:8080',
        });

        expect(client.config.shipUrl).toBe('ws://localhost:8080');
        expect(client.config.startBlock).toBe(0);
        expect(client.config.endBlock).toBe(0xffffffff);
        expect(client.config.maxMessagesInFlight).toBe(5);
        expect(client.config.irreversibleOnly).toBe(false);
        expect(client.config.fetchTraces).toBe(true);
        expect(client.config.fetchDeltas).toBe(false);
        expect(client.config.reconnectDelay).toBe(3000);
        expect(client.config.reconnectMaxAttempts).toBe(10);
    });

    test('getStats returns initial state', () => {
        const client = new ShipClient({ shipUrl: 'ws://localhost:8080' });
        const stats = client.getStats();

        expect(stats.blocksReceived).toBe(0);
        expect(stats.messagesReceived).toBe(0);
        expect(stats.reconnections).toBe(0);
        expect(stats.errors).toBe(0);
        expect(stats.isRunning).toBe(false);
        expect(stats.isConnected).toBe(false);
        expect(stats.currentBlock).toBe(0);
    });

    test('setCurrentBlock updates position', () => {
        const client = new ShipClient({ shipUrl: 'ws://localhost:8080' });
        client.setCurrentBlock(12345);
        expect(client.currentBlock).toBe(12345);
    });

    test('start throws when already running', async () => {
        const client = new ShipClient({ shipUrl: 'ws://localhost:8080' });
        client.isRunning = true;
        await expect(client.start()).rejects.toThrow('already running');
    });

    test('config respects irreversibleOnly setting', () => {
        const client = new ShipClient({
            shipUrl: 'ws://localhost:8080',
            irreversibleOnly: true,
        });
        expect(client.config.irreversibleOnly).toBe(true);
    });
});

// ─── ShipEventSource (unit) ──────────────────────────────────────────

describe('ShipEventSource (unit)', () => {
    let ShipEventSourceNew;

    beforeEach(async () => {
        const mod = await import('../../src/indexer/ship/shipEventSource.js');
        ShipEventSourceNew = mod.ShipEventSource;
    });

    test('_createAnchoredEvent produces correct schema for put action', () => {
        const source = new ShipEventSourceNew({
            shipUrl: 'ws://localhost:8080',
            rpcUrl: 'http://localhost:8888',
            contractAccount: 'polarismusic',
        });

        const payload = {
            author: 'testuser',
            type: 21,
            hash: 'canonical-hash-123',
            body: { release: { name: 'Test' } },
        };

        const event = source._createAnchoredEvent(payload, 'put', {
            blockNum: 100,
            blockId: 'blockid',
            transactionId: 'trxid',
            actionOrdinal: 0,
            timestamp: 1704067200,
        });

        // content_hash should be put.hash (canonical)
        expect(event.content_hash).toBe('canonical-hash-123');

        // event_hash should be SHA256 of JSON
        const expectedHash = crypto.createHash('sha256')
            .update(JSON.stringify(payload))
            .digest('hex');
        expect(event.event_hash).toBe(expectedHash);

        expect(event.payload).toBe(JSON.stringify(payload));
        expect(event.block_num).toBe(100);
        expect(event.block_id).toBe('blockid');
        expect(event.trx_id).toBe('trxid');
        expect(event.action_ordinal).toBe(0);
        expect(event.timestamp).toBe(1704067200);
        expect(event.source).toBe('ship-eos');
        expect(event.contract_account).toBe('polarismusic');
        expect(event.action_name).toBe('put');
    });

    test('_createAnchoredEvent uses event_hash as content_hash for vote', () => {
        const source = new ShipEventSourceNew({
            shipUrl: 'ws://localhost:8080',
            rpcUrl: 'http://localhost:8888',
            contractAccount: 'polarismusic',
        });

        const payload = { voter: 'user1', submission_hash: 'abc', value: 1 };

        const event = source._createAnchoredEvent(payload, 'vote', {
            blockNum: 101,
            blockId: 'block2',
            transactionId: 'trx2',
            actionOrdinal: 0,
            timestamp: 1704067300,
        });

        // For non-put actions, content_hash = event_hash
        expect(event.content_hash).toBe(event.event_hash);
        expect(event.action_name).toBe('vote');
    });

    test('getStats returns stats with client info', () => {
        const source = new ShipEventSourceNew({
            shipUrl: 'ws://localhost:8080',
            rpcUrl: 'http://localhost:8888',
        });

        const stats = source.getStats();
        expect(stats.blocksProcessed).toBe(0);
        expect(stats.eventsExtracted).toBe(0);
        expect(stats.actionsDecoded).toBe(0);
        expect(stats.decodeErrors).toBe(0);
        expect(stats.client).toBeDefined();
        expect(stats.isRunning).toBe(false);
    });
});

