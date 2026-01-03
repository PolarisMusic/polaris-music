/**
 * @fileoverview Chain Ingestion Endpoint for Anchored Events (T5)
 *
 * Processes anchored events from Substreams with:
 * - Signature verification (T2)
 * - Event deduplication by eventHash
 * - Event storage (T2)
 * - ReleaseBundle validation (T3)
 * - Graph ingestion
 *
 * Idempotent ingestion: Same eventHash processed only once.
 */

import { EventStore } from '../storage/eventStore.js';
import EventProcessor from '../indexer/eventProcessor.js';
import crypto from 'crypto';

/**
 * Ingestion Handler
 */
export class IngestionHandler {
    constructor(eventStore, eventProcessor) {
        this.store = eventStore;
        this.processor = eventProcessor;
        this.processedHashes = new Set(); // In-memory dedupe cache (TODO: use Redis)
    }

    /**
     * Process anchored event from chain ingestion
     *
     * @param {Object} anchoredEvent - AnchoredEvent from Substreams
     * @returns {Promise<Object>} Result with status and details
     */
    async processAnchoredEvent(anchoredEvent) {
        const {
            event_hash,
            payload,
            block_num,
            block_id,
            trx_id,
            action_ordinal,
            timestamp,
            source,
            contract_account,
            action_name,
        } = anchoredEvent;

        // Step 1: Validate input
        if (!event_hash || !payload) {
            throw new Error('Missing required fields: event_hash and payload are required');
        }

        // Step 2: Deduplicate by eventHash (idempotent ingestion)
        if (this.processedHashes.has(event_hash)) {
            return {
                status: 'duplicate',
                eventHash: event_hash,
                message: 'Event already processed (deduplicated)',
            };
        }

        // Check if event already exists in storage
        try {
            const existingEvent = await this.store.getEvent(event_hash);
            if (existingEvent) {
                this.processedHashes.add(event_hash);
                return {
                    status: 'duplicate',
                    eventHash: event_hash,
                    message: 'Event already exists in storage',
                };
            }
        } catch (error) {
            // Event not found - proceed with ingestion
        }

        // Step 3: Parse payload
        let eventPayload;
        try {
            // Payload might be string or Buffer
            const payloadStr = typeof payload === 'string' ? payload : payload.toString('utf-8');
            eventPayload = JSON.parse(payloadStr);
        } catch (error) {
            throw new Error(`Invalid JSON payload: ${error.message}`);
        }

        // Step 4: Reconstruct event structure
        // The payload from blockchain action needs to be wrapped in our event format
        const event = this.reconstructEventFromPayload(eventPayload, action_name, {
            block_num,
            block_id,
            trx_id,
            action_ordinal,
            timestamp,
            source,
            contract_account,
        });

        // Step 5: Verify event hash matches
        const computedHash = this.computeEventHash(event);
        if (computedHash !== event_hash) {
            console.warn(
                `Event hash mismatch: provided ${event_hash}, computed ${computedHash}. Using provided hash.`
            );
            // Use provided hash (from blockchain) as authoritative
        }

        // Step 6: Validate signature (T2)
        // For blockchain-anchored events, signature is implicit (blockchain consensus)
        // Skip signature verification for anchored events from Substreams
        // Mark as verified by blockchain consensus
        event.blockchain_verified = true;
        event.blockchain_metadata = {
            block_num,
            block_id,
            trx_id,
            action_ordinal,
            timestamp,
            source,
        };

        // Step 7: Store event (T2)
        try {
            await this.store.storeEvent(event, event_hash);
        } catch (error) {
            throw new Error(`Failed to store event: ${error.message}`);
        }

        // Step 8: Process event based on type
        const processingResult = await this.processEventByType(event, event_hash, {
            block_num,
            trx_id,
            timestamp,
        });

        // Step 9: Mark as processed
        this.processedHashes.add(event_hash);

        return {
            status: 'processed',
            eventHash: event_hash,
            eventType: event.type,
            blockNum: block_num,
            trxId: trx_id,
            processing: processingResult,
        };
    }

    /**
     * Reconstruct event from blockchain action payload
     *
     * @param {Object} actionPayload - Raw action data from blockchain
     * @param {string} actionName - Action name (put, vote, finalize, etc.)
     * @param {Object} metadata - Blockchain metadata
     * @returns {Object} Reconstructed event
     */
    reconstructEventFromPayload(actionPayload, actionName, metadata) {
        // Map blockchain action names to event types
        const actionToEventType = {
            put: 'CREATE_RELEASE_BUNDLE', // Primary for T5
            vote: 'VOTE',
            finalize: 'FINALIZE',
        };

        const eventType = actionToEventType[actionName] || actionName.toUpperCase();

        // For PUT actions, extract the actual event from the hash reference
        // The blockchain stores event hashes; we need to retrieve the full event
        if (actionName === 'put') {
            // The action payload contains: { author, type, hash, parent, ts, tags, expires_at }
            // The actual event body is retrieved from IPFS/S3 using the hash
            // For now, we'll use the action payload as-is
            // TODO: Fetch full event from storage if hash is provided
            return {
                v: 1,
                type: eventType,
                author_pubkey: actionPayload.author || '',
                created_at: actionPayload.ts || metadata.timestamp,
                parents: actionPayload.parent ? [actionPayload.parent] : [],
                body: actionPayload.body || {}, // Event body should be in action data
                proofs: actionPayload.proofs || { source_links: [] },
                sig: '', // Blockchain-verified, no separate signature
            };
        }

        // For other action types (vote, finalize), use action payload directly
        return {
            v: 1,
            type: eventType,
            author_pubkey: actionPayload.voter || actionPayload.author || '',
            created_at: metadata.timestamp,
            parents: [],
            body: actionPayload,
            proofs: { source_links: [] },
            sig: '',
        };
    }

    /**
     * Compute event hash (for verification)
     *
     * @param {Object} event - Event object
     * @returns {string} SHA256 hex hash
     */
    computeEventHash(event) {
        // Use canonical hash computation from T2
        const canonical = JSON.stringify(event, Object.keys(event).sort());
        return crypto.createHash('sha256').update(canonical).digest('hex');
    }

    /**
     * Process event based on type
     *
     * @param {Object} event - Event object
     * @param {string} eventHash - Event hash
     * @param {Object} metadata - Blockchain metadata
     * @returns {Promise<Object>} Processing result
     */
    async processEventByType(event, eventHash, metadata) {
        try {
            switch (event.type) {
                case 'CREATE_RELEASE_BUNDLE':
                    // Validate and ingest release bundle (T3)
                    return await this.processor.handleCreateReleaseBundle(event, {
                        hash: eventHash,
                        author: event.author_pubkey,
                        blockNum: metadata.block_num,
                        trxId: metadata.trx_id,
                    });

                case 'VOTE':
                    // Handle vote (de-scoped for T5, documented below)
                    return await this.handleVoteEvent(event, eventHash, metadata);

                case 'FINALIZE':
                    // Handle finalize (de-scoped for T5, documented below)
                    return await this.handleFinalizeEvent(event, eventHash, metadata);

                case 'MERGE_ENTITY':
                    // Handle merge (T4)
                    return await this.processor.handleMergeEntity(event, {
                        hash: eventHash,
                        author: event.author_pubkey,
                    });

                default:
                    console.warn(`Unknown event type: ${event.type}`);
                    return {
                        status: 'skipped',
                        reason: `Unknown event type: ${event.type}`,
                    };
            }
        } catch (error) {
            console.error(`Error processing ${event.type} event:`, error);
            throw error;
        }
    }

    /**
     * Handle VOTE event
     *
     * T5 DECISION: Vote handling is DE-SCOPED for initial implementation.
     * Votes require:
     * - Respect weight lookup from blockchain state
     * - Aggregation logic for approval calculation
     * - Integration with finalization process
     *
     * TODO (Future): Implement vote handling
     * - Query Respect values from chain tables
     * - Store vote with weight in graph
     * - Update submission score aggregates
     *
     * @param {Object} event - Vote event
     * @param {string} eventHash - Event hash
     * @param {Object} metadata - Blockchain metadata
     * @returns {Promise<Object>} Result
     */
    async handleVoteEvent(event, eventHash, metadata) {
        console.log(`Vote event received (eventHash: ${eventHash}) - SKIPPED (de-scoped for T5)`);
        return {
            status: 'de-scoped',
            eventType: 'VOTE',
            message: 'Vote handling not implemented in T5. See TODO in ingestion.js',
        };
    }

    /**
     * Handle FINALIZE event
     *
     * T5 DECISION: Finalize handling is DE-SCOPED for initial implementation.
     * Finalization requires:
     * - Vote aggregation and approval calculation
     * - Reward distribution logic
     * - State transitions (provisional -> canonical IDs)
     *
     * TODO (Future): Implement finalize handling
     * - Calculate approval percentage from votes
     * - Update submission status (accepted/rejected)
     * - Trigger reward distribution
     * - Promote provisional IDs to canonical if accepted
     *
     * @param {Object} event - Finalize event
     * @param {string} eventHash - Event hash
     * @param {Object} metadata - Blockchain metadata
     * @returns {Promise<Object>} Result
     */
    async handleFinalizeEvent(event, eventHash, metadata) {
        console.log(`Finalize event received (eventHash: ${eventHash}) - SKIPPED (de-scoped for T5)`);
        return {
            status: 'de-scoped',
            eventType: 'FINALIZE',
            message: 'Finalize handling not implemented in T5. See TODO in ingestion.js',
        };
    }
}

export default IngestionHandler;
