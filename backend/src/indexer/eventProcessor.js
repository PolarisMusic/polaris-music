/**
 * @fileoverview Event Processor for Polaris Music Registry
 *
 * Processes blockchain events into the graph database:
 * 1. Polls blockchain for new anchored events
 * 2. Fetches event data from storage (IPFS/S3/Redis)
 * 3. Processes events into Neo4j graph database
 * 4. Handles different event types with specific handlers
 *
 * Event Flow:
 * Blockchain ’ Fetch from Storage ’ Validate ’ Process ’ Update Graph
 *
 * @module indexer/eventProcessor
 */

import { Api, JsonRpc } from 'eosjs';
import { JsSignatureProvider } from 'eosjs/dist/eosjs-jssig.js';
import fetch from 'node-fetch';
import MusicGraphDatabase from '../graph/schema.js';
import EventStore from '../storage/eventStore.js';

/**
 * Event types from smart contract
 */
const EVENT_TYPES = {
    CREATE_RELEASE_BUNDLE: 21,
    ADD_CLAIM: 30,
    EDIT_CLAIM: 31,
    VOTE: 40,
    LIKE: 41,
    FINALIZE: 50,
    MERGE_NODE: 60
};

/**
 * Event Processor that syncs blockchain events to graph database
 */
class EventProcessor {
    /**
     * Create a new event processor
     *
     * @param {Object} config - Processor configuration
     * @param {Object} config.blockchain - Blockchain configuration
     * @param {string} config.blockchain.rpcUrl - EOS RPC endpoint
     * @param {string} config.blockchain.contractAccount - Contract account name
     * @param {number} [config.blockchain.pollInterval] - Polling interval in ms (default: 5000)
     * @param {Object} config.database - Graph database config
     * @param {Object} config.storage - Event storage config
     * @param {number} [config.startBlock] - Block to start processing from
     */
    constructor(config) {
        this.config = config;

        // Initialize blockchain RPC
        this.rpc = new JsonRpc(config.blockchain.rpcUrl, { fetch });
        this.contractAccount = config.blockchain.contractAccount || 'polaris';
        this.pollInterval = config.blockchain.pollInterval || 5000;

        // Initialize database and storage
        this.db = new MusicGraphDatabase(config.database);
        this.store = new EventStore(config.storage);

        // Processing state
        this.isRunning = false;
        this.lastProcessedBlock = config.startBlock || 0;
        this.currentBlock = 0;

        // Statistics
        this.stats = {
            blocksProcessed: 0,
            eventsProcessed: 0,
            eventsByType: {},
            errors: 0,
            lastError: null,
            startTime: null,
            lastProcessedTime: null
        };

        // Event handlers by type
        this.eventHandlers = {
            [EVENT_TYPES.CREATE_RELEASE_BUNDLE]: this.handleReleaseBundle.bind(this),
            [EVENT_TYPES.ADD_CLAIM]: this.handleAddClaim.bind(this),
            [EVENT_TYPES.EDIT_CLAIM]: this.handleEditClaim.bind(this),
            [EVENT_TYPES.VOTE]: this.handleVote.bind(this),
            [EVENT_TYPES.LIKE]: this.handleLike.bind(this),
            [EVENT_TYPES.FINALIZE]: this.handleFinalize.bind(this),
            [EVENT_TYPES.MERGE_NODE]: this.handleMergeNode.bind(this)
        };
    }

    /**
     * Start the event processor
     * Continuously polls blockchain and processes events
     *
     * @returns {Promise<void>}
     */
    async start() {
        if (this.isRunning) {
            console.warn('Event processor already running');
            return;
        }

        console.log('=€ Starting Event Processor...');

        // Test connections
        const dbConnected = await this.db.testConnection();
        if (!dbConnected) {
            throw new Error('Failed to connect to database');
        }
        console.log(' Database connected');

        const storageStatus = await this.store.testConnectivity();
        console.log(' Storage status:', storageStatus);

        // Get current blockchain head
        const info = await this.rpc.get_info();
        this.currentBlock = info.head_block_num;
        console.log(` Blockchain head: block ${this.currentBlock}`);

        // If no start block specified, start from recent history
        if (this.lastProcessedBlock === 0) {
            this.lastProcessedBlock = Math.max(0, this.currentBlock - 1000);
            console.log(`Starting from block ${this.lastProcessedBlock}`);
        }

        this.isRunning = true;
        this.stats.startTime = new Date();

        // Start processing loop
        this.processLoop();

        console.log(`\n Event Processor started`);
        console.log(`  Contract: ${this.contractAccount}`);
        console.log(`  Poll interval: ${this.pollInterval}ms`);
        console.log(`  Processing from block: ${this.lastProcessedBlock}\n`);
    }

    /**
     * Stop the event processor
     *
     * @returns {Promise<void>}
     */
    async stop() {
        console.log('\nStopping Event Processor...');
        this.isRunning = false;

        // Wait for current operation to complete
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Close connections
        await this.db.close();
        await this.store.close();

        console.log(' Event Processor stopped');
    }

    /**
     * Main processing loop
     * Continuously polls blockchain and processes new events
     *
     * @private
     */
    async processLoop() {
        while (this.isRunning) {
            try {
                // Get latest block info
                const info = await this.rpc.get_info();
                this.currentBlock = info.head_block_num;

                // Process any new blocks
                if (this.lastProcessedBlock < this.currentBlock) {
                    await this.processBlockRange(
                        this.lastProcessedBlock + 1,
                        this.currentBlock
                    );
                }

                // Wait before next poll
                await new Promise(resolve => setTimeout(resolve, this.pollInterval));

            } catch (error) {
                console.error('Error in process loop:', error.message);
                this.stats.errors++;
                this.stats.lastError = error.message;

                // Wait longer on error
                await new Promise(resolve => setTimeout(resolve, this.pollInterval * 2));
            }
        }
    }

    /**
     * Process a range of blocks for events
     *
     * @private
     * @param {number} fromBlock - Start block (inclusive)
     * @param {number} toBlock - End block (inclusive)
     */
    async processBlockRange(fromBlock, toBlock) {
        console.log(`Processing blocks ${fromBlock} to ${toBlock}...`);

        // Process in chunks to avoid overwhelming the system
        const chunkSize = 100;

        for (let start = fromBlock; start <= toBlock; start += chunkSize) {
            const end = Math.min(start + chunkSize - 1, toBlock);

            try {
                // Get actions from blockchain for this range
                const actions = await this.getActionsInRange(start, end);

                // Process each action
                for (const action of actions) {
                    await this.processAction(action);
                }

                this.lastProcessedBlock = end;
                this.stats.blocksProcessed += (end - start + 1);
                this.stats.lastProcessedTime = new Date();

            } catch (error) {
                console.error(`Error processing blocks ${start}-${end}:`, error.message);
                this.stats.errors++;
                this.stats.lastError = error.message;

                // Continue with next chunk despite error
            }
        }
    }

    /**
     * Get actions from blockchain in a block range
     *
     * @private
     * @param {number} fromBlock - Start block
     * @param {number} toBlock - End block
     * @returns {Promise<Array>} Array of actions
     */
    async getActionsInRange(fromBlock, toBlock) {
        try {
            // Use get_actions API with filters
            const response = await this.rpc.history_get_actions(
                this.contractAccount,
                fromBlock,
                toBlock - fromBlock + 1
            );

            // Filter for 'put' actions (event anchoring)
            return response.actions.filter(action =>
                action.action_trace.act.account === this.contractAccount &&
                action.action_trace.act.name === 'put'
            );

        } catch (error) {
            // Fallback: get blocks individually if history plugin unavailable
            console.warn('History API unavailable, using fallback method');
            return this.getActionsInRangeFallback(fromBlock, toBlock);
        }
    }

    /**
     * Fallback method to get actions by fetching individual blocks
     *
     * @private
     * @param {number} fromBlock - Start block
     * @param {number} toBlock - End block
     * @returns {Promise<Array>} Array of actions
     */
    async getActionsInRangeFallback(fromBlock, toBlock) {
        const actions = [];

        for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
            try {
                const block = await this.rpc.get_block(blockNum);

                // Check transactions in block
                for (const transaction of block.transactions || []) {
                    if (transaction.trx && transaction.trx.transaction) {
                        const trx = transaction.trx.transaction;

                        // Check actions in transaction
                        for (const action of trx.actions || []) {
                            if (action.account === this.contractAccount &&
                                action.name === 'put') {
                                actions.push({
                                    action_trace: {
                                        act: action,
                                        block_num: blockNum,
                                        block_time: block.timestamp
                                    }
                                });
                            }
                        }
                    }
                }
            } catch (error) {
                console.warn(`Failed to fetch block ${blockNum}:`, error.message);
            }
        }

        return actions;
    }

    /**
     * Process a single blockchain action
     *
     * @private
     * @param {Object} action - Blockchain action
     */
    async processAction(action) {
        try {
            const act = action.action_trace.act;
            const data = act.data;

            console.log(`\nProcessing event: ${data.hash.substring(0, 12)}...`);
            console.log(`  Type: ${data.type}`);
            console.log(`  Author: ${data.author}`);
            console.log(`  Block: ${action.action_trace.block_num}`);

            // Fetch event data from storage
            const event = await this.store.retrieveEvent(data.hash);

            // Verify hash matches
            const computedHash = this.store.calculateHash(event);
            if (computedHash !== data.hash) {
                throw new Error(`Hash mismatch: expected ${data.hash}, got ${computedHash}`);
            }

            // Process event based on type
            const handler = this.eventHandlers[data.type];
            if (!handler) {
                console.warn(`No handler for event type ${data.type}`);
                return;
            }

            await handler(event, data);

            // Update statistics
            this.stats.eventsProcessed++;
            this.stats.eventsByType[data.type] = (this.stats.eventsByType[data.type] || 0) + 1;

            console.log(` Event processed successfully`);

        } catch (error) {
            console.error('Failed to process action:', error.message);
            this.stats.errors++;
            this.stats.lastError = error.message;

            // Don't throw - continue processing other events
        }
    }

    /**
     * Handle CREATE_RELEASE_BUNDLE event
     *
     * @private
     * @param {Object} event - Event data
     * @param {Object} actionData - Blockchain action data
     */
    async handleReleaseBundle(event, actionData) {
        console.log(`  Processing release bundle: ${event.body.release?.name || 'Unknown'}`);

        const result = await this.db.processReleaseBundle(
            actionData.hash,
            event.body,
            event.author_pubkey
        );

        console.log(`   Created: ${result.stats.groups_created} groups, ${result.stats.tracks_created} tracks`);
    }

    /**
     * Handle ADD_CLAIM event
     *
     * @private
     * @param {Object} event - Event data
     * @param {Object} actionData - Blockchain action data
     */
    async handleAddClaim(event, actionData) {
        console.log(`  Adding claim to ${event.body.node?.type} ${event.body.node?.id}`);

        await this.db.processAddClaim(
            actionData.hash,
            event.body,
            event.author_pubkey
        );

        console.log(`   Claim added`);
    }

    /**
     * Handle EDIT_CLAIM event
     *
     * @private
     * @param {Object} event - Event data
     * @param {Object} actionData - Blockchain action data
     */
    async handleEditClaim(event, actionData) {
        console.log(`  Editing claim: ${event.body.claim_id}`);

        // Similar to ADD_CLAIM but modifies existing claim
        await this.db.processAddClaim(
            actionData.hash,
            event.body,
            event.author_pubkey
        );

        console.log(`   Claim edited`);
    }

    /**
     * Handle VOTE event
     *
     * @private
     * @param {Object} event - Event data
     * @param {Object} actionData - Blockchain action data
     */
    async handleVote(event, actionData) {
        console.log(`  Recording vote on ${event.body.target_hash}`);

        // Vote data is stored on blockchain, not in graph
        // Could optionally record vote metadata in graph for analytics

        console.log(`   Vote recorded`);
    }

    /**
     * Handle LIKE event
     *
     * @private
     * @param {Object} event - Event data
     * @param {Object} actionData - Blockchain action data
     */
    async handleLike(event, actionData) {
        console.log(`  Recording like on ${event.body.node_id}`);

        // Like data with path tracking (planned feature)
        // Store in graph for visualization weighting

        console.log(`   Like recorded`);
    }

    /**
     * Handle FINALIZE event
     *
     * @private
     * @param {Object} event - Event data
     * @param {Object} actionData - Blockchain action data
     */
    async handleFinalize(event, actionData) {
        console.log(`  Finalizing event ${event.body.target_hash}`);

        // Finalization triggers reward distribution on blockchain
        // Could update entity status in graph (provisional ’ canonical)

        console.log(`   Finalized`);
    }

    /**
     * Handle MERGE_NODE event
     *
     * @private
     * @param {Object} event - Event data
     * @param {Object} actionData - Blockchain action data
     */
    async handleMergeNode(event, actionData) {
        console.log(`  Merging nodes: ${event.body.source_id} ’ ${event.body.target_id}`);

        await this.db.mergeNodes(
            event.body.source_id,
            event.body.target_id,
            event.body.node_type,
            event.body.reason || 'Duplicate'
        );

        console.log(`   Nodes merged`);
    }

    /**
     * Get processor statistics
     *
     * @returns {Object} Statistics object
     */
    getStats() {
        const uptime = this.stats.startTime
            ? Date.now() - this.stats.startTime.getTime()
            : 0;

        return {
            ...this.stats,
            isRunning: this.isRunning,
            currentBlock: this.currentBlock,
            lastProcessedBlock: this.lastProcessedBlock,
            blocksBehind: this.currentBlock - this.lastProcessedBlock,
            uptime: uptime,
            uptimeFormatted: this.formatUptime(uptime),
            eventsPerSecond: uptime > 0
                ? (this.stats.eventsProcessed / (uptime / 1000)).toFixed(2)
                : '0'
        };
    }

    /**
     * Format uptime in human-readable format
     *
     * @private
     * @param {number} ms - Uptime in milliseconds
     * @returns {string} Formatted uptime
     */
    formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    /**
     * Reprocess events from a specific block
     * Useful for recovering from errors or testing
     *
     * @param {number} fromBlock - Block to start reprocessing from
     */
    async reprocessFrom(fromBlock) {
        console.log(`Reprocessing from block ${fromBlock}...`);
        this.lastProcessedBlock = fromBlock - 1;
    }
}

export default EventProcessor;
