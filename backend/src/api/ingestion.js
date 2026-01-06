/**
 * @fileoverview Chain Ingestion Handler for Polaris Music Registry
 *
 * This module handles ingestion of blockchain events from external sources
 * (Substreams, SHiP, etc.) into the backend processing pipeline.
 *
 * ## Why this architecture exists
 *
 * The on-chain smart contract (polaris.music.cpp) only stores lightweight anchors:
 *
 * ```cpp
 * ACTION put(name author, uint8_t type, checksum256 hash,
 *            std::optional<checksum256> parent, uint32_t ts,
 *            std::vector<name> tags)
 * ```
 *
 * The `hash` field is a SHA256 of the full off-chain event JSON. This design:
 * - Keeps blockchain storage costs minimal
 * - Allows complex release bundles (100+ KB) to be anchored on-chain
 * - Provides cryptographic proof of data integrity
 * - Enables efficient blockchain indexing
 *
 * The full event content is stored off-chain in:
 * - IPFS (decentralized, content-addressed)
 * - S3 (reliable backup)
 * - Redis (fast cache)
 *
 * ## Ingestion Flow
 *
 * 1. Receive put action payload (contains hash, author, type, etc.)
 * 2. Extract content_hash from payload
 * 3. Fetch full event JSON from EventStore using retrieveEvent(content_hash)
 * 4. Verify hash matches (integrity check)
 * 5. Attach blockchain metadata to event (block_num, trx_id, etc.)
 * 6. Process event through normal validation and graph ingestion
 *
 * This ensures that:
 * - Only blockchain-anchored events are processed
 * - Schema validation runs on complete event data
 * - Blockchain provenance is preserved in the graph
 *
 * @module api/ingestion
 */

import { createHash } from 'crypto';
import stringify from 'fast-json-stable-stringify';

/**
 * Ingestion handler for blockchain events
 *
 * Processes `put` actions by fetching off-chain event content and
 * routing to appropriate event handlers.
 */
export class IngestionHandler {
    /**
     * Create a new ingestion handler
     *
     * @param {EventStore} eventStore - Event storage instance
     * @param {EventProcessor} eventProcessor - Event processor instance
     */
    constructor(eventStore, eventProcessor) {
        this.store = eventStore;
        this.processor = eventProcessor;

        // In-memory deduplication cache
        this.processedHashes = new Set();

        // Statistics
        this.stats = {
            eventsProcessed: 0,
            eventsDuplicate: 0,
            eventsNotFound: 0,
            eventsFailed: 0,
            lastProcessedTime: null
        };
    }

    /**
     * Process a `put` action from the blockchain
     *
     * This is the main entry point for chain ingestion. The action payload
     * contains only metadata and a content hash - we must fetch the full
     * event body from storage.
     *
     * @param {Object} actionData - Put action data
     * @param {string} actionData.author - Author account name
     * @param {number} actionData.type - Event type code
     * @param {string} actionData.hash - SHA256 content hash (hex string)
     * @param {string} [actionData.parent] - Optional parent hash
     * @param {number} actionData.ts - Unix timestamp
     * @param {string[]} [actionData.tags] - Optional tags
     * @param {Object} [blockchainMetadata] - Optional blockchain context
     * @param {number} [blockchainMetadata.block_num] - Block number
     * @param {string} [blockchainMetadata.block_id] - Block ID
     * @param {string} [blockchainMetadata.trx_id] - Transaction ID
     * @param {number} [blockchainMetadata.action_ordinal] - Action index
     * @param {string} [blockchainMetadata.source] - Source (e.g., "substreams-eos")
     * @returns {Promise<Object>} Processing result
     */
    async processPutAction(actionData, blockchainMetadata = {}) {
        const { author, type, hash, parent, ts, tags = [] } = actionData;

        // Step 1: Validate required fields
        if (!hash) {
            throw new Error('Missing required field: hash');
        }

        // Normalize hash to lowercase hex string (do this early for logging)
        const content_hash = this.normalizeHash(hash);

        console.log(`\nProcessing put action:`);
        console.log(`  Hash: ${content_hash.substring(0, 12)}...`);
        console.log(`  Author: ${author}`);
        console.log(`  Type: ${type}`);
        console.log(`  Block: ${blockchainMetadata.block_num || 'N/A'}`);

        // Step 2: Check for duplicates
        if (this.processedHashes.has(content_hash)) {
            console.log(`   Duplicate event (already processed)`);
            this.stats.eventsDuplicate++;
            return {
                status: 'duplicate',
                contentHash: content_hash,
                message: 'Event already processed'
            };
        }

        try {
            // Step 3: Fetch full event from off-chain storage
            console.log(`  Fetching event from storage...`);
            const event = await this.store.retrieveEvent(content_hash);

            if (!event) {
                console.error(`   Event not found in storage: ${content_hash}`);
                this.stats.eventsNotFound++;
                return {
                    status: 'not_found',
                    contentHash: content_hash,
                    message: 'Event not found in storage'
                };
            }

            // Step 4: Verify the fetched event hash matches
            const computedHash = this.store.calculateHash(event);
            if (computedHash !== content_hash) {
                throw new Error(
                    `Hash mismatch: action hash ${content_hash} != computed hash ${computedHash}`
                );
            }

            // Step 5: Attach blockchain metadata to event
            // This enriches the off-chain event with blockchain provenance
            const enrichedEvent = {
                ...event,
                blockchain_verified: true,
                blockchain_metadata: {
                    anchor_hash: content_hash,
                    block_num: blockchainMetadata.block_num,
                    block_id: blockchainMetadata.block_id,
                    trx_id: blockchainMetadata.trx_id,
                    action_ordinal: blockchainMetadata.action_ordinal,
                    source: blockchainMetadata.source || 'unknown',
                    ingested_at: new Date().toISOString()
                }
            };

            // Step 6: Create action metadata (compatible with EventProcessor)
            const actionMetadata = {
                hash: content_hash,
                type,
                author,
                parent,
                ts,
                tags
            };

            // Step 7: Process event by type using EventProcessor handlers
            await this.processEventByType(enrichedEvent, actionMetadata);

            // Mark as processed
            this.processedHashes.add(content_hash);
            this.stats.eventsProcessed++;
            this.stats.lastProcessedTime = new Date();

            console.log(` Event processed successfully`);

            return {
                status: 'success',
                contentHash: content_hash,
                eventType: type
            };

        } catch (error) {
            console.error(` Failed to process event:`, error.message);
            this.stats.eventsFailed++;

            return {
                status: 'failed',
                contentHash: content_hash,
                error: error.message
            };
        }
    }

    /**
     * Process an AnchoredEvent from Substreams or SHiP
     *
     * This method handles the AnchoredEvent format emitted by both
     * Substreams and SHiP chain ingestion sources.
     *
     * Stage 4: Uses content_hash for deduplication (stable across sources)
     *
     * @param {Object} anchoredEvent - Anchored event from chain source
     * @param {string} anchoredEvent.content_hash - Canonical content hash (put.hash)
     * @param {string} anchoredEvent.event_hash - Action payload hash (debugging)
     * @param {string|Buffer} anchoredEvent.payload - Raw action JSON payload
     * @param {number} anchoredEvent.block_num - Block number
     * @param {string} anchoredEvent.block_id - Block ID
     * @param {string} anchoredEvent.trx_id - Transaction ID
     * @param {number} anchoredEvent.action_ordinal - Action index
     * @param {number} anchoredEvent.timestamp - Block timestamp
     * @param {string} anchoredEvent.source - Source (substreams-eos, ship-eos)
     * @param {string} anchoredEvent.action_name - Action name (put, vote, etc.)
     * @returns {Promise<Object>} Processing result
     */
    async processAnchoredEvent(anchoredEvent) {
        const {
            content_hash,
            event_hash,
            payload,
            block_num,
            block_id,
            trx_id,
            action_ordinal,
            timestamp,
            source,
            contract_account,
            action_name
        } = anchoredEvent;

        // Step 1: Validate required fields
        if (!content_hash) {
            throw new Error('Missing required field: content_hash');
        }

        if (!payload) {
            throw new Error('Missing required field: payload');
        }

        // CRITICAL: Normalize content_hash early to handle different formats
        // Substreams may send checksum256 as: string, byte array, or { hex: "..." }
        // This prevents crashes on .substring() and ensures correct deduplication
        const contentHash = this.normalizeHash(content_hash);

        console.log(`\nProcessing anchored event from ${source}:`);
        console.log(`  Content Hash: ${contentHash.substring(0, 12)}...`);
        console.log(`  Action: ${action_name}`);
        console.log(`  Block: ${block_num}`);

        // Step 2: Check for duplicates by content_hash
        if (this.processedHashes.has(contentHash)) {
            console.log(`   Duplicate event (already processed)`);
            this.stats.eventsDuplicate++;
            return {
                status: 'duplicate',
                contentHash: contentHash,
                message: 'Event already processed'
            };
        }

        try {
            // Step 3: Parse payload to extract action data
            const payloadStr = typeof payload === 'string' ? payload : payload.toString('utf-8');
            const actionData = JSON.parse(payloadStr);

            // Step 4: Only process 'put' actions (event anchoring)
            if (action_name !== 'put') {
                console.log(`  Skipping non-put action: ${action_name}`);
                return {
                    status: 'skipped',
                    contentHash,  // Use normalized contentHash
                    message: `Action ${action_name} not supported yet`
                };
            }

            // Step 5: Extract action metadata from payload
            const { author, type, hash, parent, ts, tags = [] } = actionData;

            // Verify payload hash matches content_hash (normalize both for comparison)
            if (hash) {
                const payloadHash = this.normalizeHash(hash);
                if (payloadHash !== contentHash) {
                    console.warn(`  Warning: payload.hash (${payloadHash}) != content_hash (${contentHash})`);
                }
            }

            // Step 6: Use processPutAction for the actual processing
            // This ensures consistent behavior regardless of input format
            const blockchainMetadata = {
                block_num,
                block_id,
                trx_id,
                action_ordinal,
                source
            };

            // Create put action data format
            const putActionData = {
                author,
                type,
                hash: contentHash, // Use normalized content_hash from anchored event
                parent,
                ts,
                tags
            };

            // Process using existing logic
            return await this.processPutAction(putActionData, blockchainMetadata);

        } catch (error) {
            console.error(` Failed to process anchored event:`, error.message);
            this.stats.eventsFailed++;

            return {
                status: 'failed',
                contentHash: contentHash,
                error: error.message
            };
        }
    }

    /**
     * Process an event based on its type
     *
     * Routes the event to the appropriate handler in the EventProcessor.
     * This maintains compatibility with the existing event processing pipeline.
     *
     * @private
     * @param {Object} event - Full event with blockchain metadata
     * @param {Object} actionData - Blockchain action metadata
     */
    async processEventByType(event, actionData) {
        const handler = this.processor.eventHandlers[actionData.type];

        if (!handler) {
            console.warn(`  No handler for event type ${actionData.type}`);
            return;
        }

        // Call the appropriate event handler
        await handler(event, actionData);
    }

    /**
     * Normalize hash to lowercase hex string
     *
     * Handles different hash formats:
     * - Hex string: "abc123..." or "0xabc123..."
     * - Checksum256 array: [1, 2, 3, ...]
     * - Object with hex field: { hex: "abc123..." } or { hex: "0xabc123..." }
     *
     * Always strips 0x prefix and returns lowercase hex.
     *
     * @private
     * @param {string|Array|Object} hash - Hash in any format
     * @returns {string} Lowercase hex string (without 0x prefix)
     */
    normalizeHash(hash) {
        // Already a hex string
        if (typeof hash === 'string') {
            // Strip 0x prefix if present, then lowercase
            return hash.startsWith('0x') ? hash.slice(2).toLowerCase() : hash.toLowerCase();
        }

        // Checksum256 array (convert to hex)
        if (Array.isArray(hash)) {
            return Buffer.from(hash).toString('hex').toLowerCase();
        }

        // Object with hex field
        if (hash && typeof hash === 'object' && hash.hex) {
            const hexStr = hash.hex;
            return hexStr.startsWith('0x') ? hexStr.slice(2).toLowerCase() : hexStr.toLowerCase();
        }

        throw new Error(`Invalid hash format: ${JSON.stringify(hash)}`);
    }

    /**
     * Get ingestion statistics
     *
     * @returns {Object} Statistics object
     */
    getStats() {
        return {
            ...this.stats,
            cacheSize: this.processedHashes.size,
            successRate: this.stats.eventsProcessed > 0
                ? ((this.stats.eventsProcessed /
                    (this.stats.eventsProcessed + this.stats.eventsFailed)) * 100).toFixed(2) + '%'
                : 'N/A'
        };
    }

    /**
     * Clear the deduplication cache
     *
     * Useful for testing or when memory usage is a concern.
     * Events are still deduplicated against storage.
     */
    clearCache() {
        const size = this.processedHashes.size;
        this.processedHashes.clear();
        console.log(`Cleared ingestion cache (${size} hashes)`);
        return size;
    }
}

export default IngestionHandler;
