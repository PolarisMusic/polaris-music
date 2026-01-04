/**
 * @fileoverview SHiP (State History Plugin) Event Source for Chain Ingestion (T6)
 *
 * Provides fallback chain ingestion via Antelope State History Plugin.
 * Produces identical AnchoredEvent format as Substreams for consistency.
 *
 * Features:
 * - WebSocket streaming of action traces
 * - Automatic reconnection on disconnect
 * - Block range tracking and resumption
 * - Same AnchoredEvent schema as Substreams
 * - Feeds into same backend ingestion endpoint
 *
 * Usage:
 *   const ship = new ShipEventSource(config);
 *   await ship.start();
 *   ship.on('anchoredEvent', async (event) => { ... });
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import crypto from 'crypto';

/**
 * SHiP Event Source
 * Connects to Antelope State History Plugin and streams action traces
 */
export class ShipEventSource extends EventEmitter {
    constructor(config) {
        super();

        this.config = {
            shipUrl: config.shipUrl || 'ws://localhost:8080',
            contractAccount: config.contractAccount || 'polaris',
            startBlock: config.startBlock || 0,
            endBlock: config.endBlock || 0xffffffff, // Max uint32
            reconnectDelay: config.reconnectDelay || 3000,
            reconnectMaxAttempts: config.reconnectMaxAttempts || 10,
            ...config
        };

        this.ws = null;
        this.currentBlock = this.config.startBlock;
        this.isRunning = false;
        this.reconnectAttempts = 0;
        this.stats = {
            blocksProcessed: 0,
            eventsExtracted: 0,
            reconnections: 0,
            errors: 0
        };
    }

    /**
     * Start streaming events from SHiP
     */
    async start() {
        if (this.isRunning) {
            throw new Error('ShipEventSource is already running');
        }

        this.isRunning = true;
        console.log(`Starting SHiP event source from block ${this.currentBlock}`);
        await this.connect();
    }

    /**
     * Stop streaming and close connection
     */
    async stop() {
        this.isRunning = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        console.log('SHiP event source stopped');
    }

    /**
     * Connect to SHiP WebSocket
     */
    async connect() {
        try {
            console.log(`Connecting to SHiP at ${this.config.shipUrl}`);

            this.ws = new WebSocket(this.config.shipUrl);

            this.ws.on('open', () => {
                console.log('SHiP WebSocket connected');
                this.reconnectAttempts = 0;
                this.sendGetBlocksRequest();
            });

            this.ws.on('message', (data) => {
                this.handleMessage(data);
            });

            this.ws.on('error', (error) => {
                console.error('SHiP WebSocket error:', error.message);
                this.stats.errors++;
                this.emit('error', error);
            });

            this.ws.on('close', () => {
                console.log('SHiP WebSocket closed');
                if (this.isRunning) {
                    this.handleReconnect();
                }
            });

        } catch (error) {
            console.error('Failed to connect to SHiP:', error);
            this.stats.errors++;
            this.handleReconnect();
        }
    }

    /**
     * Send get_blocks_request to SHiP
     */
    sendGetBlocksRequest() {
        const request = [
            'get_blocks_request_v0',
            {
                start_block_num: this.currentBlock,
                end_block_num: this.config.endBlock,
                max_messages_in_flight: 5,
                have_positions: [],
                irreversible_only: false,
                fetch_block: true,
                fetch_traces: true,
                fetch_deltas: false
            }
        ];

        console.log(`Requesting blocks from ${this.currentBlock} to ${this.config.endBlock}`);
        this.ws.send(JSON.stringify(request));
    }

    /**
     * Handle incoming message from SHiP
     */
    async handleMessage(data) {
        try {
            // Parse message
            let message;
            try {
                const text = data.toString('utf-8');
                message = JSON.parse(text);
            } catch (error) {
                // Binary format - skip for now (would need Antelope serialization)
                console.warn('Received binary message, skipping (implement ABI deserialization)');
                return;
            }

            // Handle different message types
            const [messageType, messageData] = message;

            switch (messageType) {
                case 'get_blocks_result_v0':
                    await this.processBlock(messageData);
                    break;

                case 'get_blocks_ack_request_v0':
                    // Acknowledge receipt
                    this.ws.send(JSON.stringify(['get_blocks_ack_request_v0', { num_messages: 1 }]));
                    break;

                default:
                    console.warn(`Unknown SHiP message type: ${messageType}`);
            }

        } catch (error) {
            console.error('Error handling SHiP message:', error);
            this.stats.errors++;
            this.emit('error', error);
        }
    }

    /**
     * Process block and extract action traces
     */
    async processBlock(blockData) {
        try {
            const { this_block, block, traces } = blockData;

            if (!this_block || !block) {
                return;
            }

            const blockNum = this_block.block_num;
            const blockId = this_block.block_id;
            const timestamp = block.timestamp ? new Date(block.timestamp).getTime() / 1000 : Math.floor(Date.now() / 1000);

            console.log(`Processing block ${blockNum}`);

            // Extract action traces
            if (traces && Array.isArray(traces)) {
                for (const trace of traces) {
                    await this.processTrace(trace, blockNum, blockId, timestamp);
                }
            }

            // Update current block
            this.currentBlock = blockNum + 1;
            this.stats.blocksProcessed++;

            // Emit progress
            if (this.stats.blocksProcessed % 100 === 0) {
                this.emit('progress', {
                    currentBlock: this.currentBlock,
                    blocksProcessed: this.stats.blocksProcessed,
                    eventsExtracted: this.stats.eventsExtracted
                });
            }

        } catch (error) {
            console.error(`Error processing block:`, error);
            this.stats.errors++;
            throw error;
        }
    }

    /**
     * Process transaction trace and extract actions
     */
    async processTrace(trace, blockNum, blockId, timestamp) {
        try {
            // Handle different trace formats
            const [traceType, traceData] = Array.isArray(trace) ? trace : ['transaction_trace_v0', trace];

            if (traceType !== 'transaction_trace_v0') {
                return;
            }

            const transactionId = traceData.id || '';
            const actionTraces = traceData.action_traces || [];

            // Process each action trace
            for (let actionOrdinal = 0; actionOrdinal < actionTraces.length; actionOrdinal++) {
                const actionTrace = actionTraces[actionOrdinal];
                await this.processActionTrace(actionTrace, {
                    blockNum,
                    blockId,
                    transactionId,
                    actionOrdinal,
                    timestamp
                });
            }

        } catch (error) {
            console.error('Error processing trace:', error);
            this.stats.errors++;
        }
    }

    /**
     * Process action trace and emit anchored event
     */
    async processActionTrace(actionTrace, metadata) {
        try {
            const [actionType, actionData] = Array.isArray(actionTrace) ? actionTrace : ['action_trace_v0', actionTrace];

            if (actionType !== 'action_trace_v0') {
                return;
            }

            const action = actionData.act;
            if (!action) {
                return;
            }

            const { account, name, data } = action;

            // Filter by contract account
            if (account !== this.config.contractAccount) {
                return;
            }

            // Filter by action name (same as Substreams: put, vote, finalize)
            if (!['put', 'vote', 'finalize'].includes(name)) {
                return;
            }

            // Extract action data
            const actionPayload = this.extractActionData(data);
            if (!actionPayload) {
                return;
            }

            // Create anchored event (same format as Substreams)
            const anchoredEvent = this.createAnchoredEvent(actionPayload, name, metadata);

            // Emit event
            this.emit('anchoredEvent', anchoredEvent);
            this.stats.eventsExtracted++;

        } catch (error) {
            console.error('Error processing action trace:', error);
            this.stats.errors++;
        }
    }

    /**
     * Extract action data from various formats
     */
    extractActionData(data) {
        try {
            // Data can be:
            // 1. Object (already parsed)
            // 2. Hex string (needs deserialization)
            // 3. Base64 string (needs decoding + deserialization)

            if (typeof data === 'object' && data !== null) {
                // Already parsed
                return data;
            }

            if (typeof data === 'string') {
                // Try parsing as JSON
                try {
                    return JSON.parse(data);
                } catch (e) {
                    // Not JSON - might be hex/base64
                    // For now, return null (would need ABI deserialization)
                    console.warn('Action data is not JSON, skipping (implement ABI deserialization)');
                    return null;
                }
            }

            return null;

        } catch (error) {
            console.error('Error extracting action data:', error);
            return null;
        }
    }

    /**
     * Create AnchoredEvent from action data
     * CRITICAL: Must match Substreams format exactly (T6 requirement)
     *
     * Stage 3 Update: Use put.hash as content_hash (canonical identifier)
     * instead of computing hash from action JSON (unstable across sources)
     */
    createAnchoredEvent(actionPayload, actionName, metadata) {
        // Convert action payload to JSON string
        const payloadJson = JSON.stringify(actionPayload);

        // Compute event hash from action payload (for debugging/trace identity)
        const eventHash = crypto.createHash('sha256').update(payloadJson).digest('hex');

        // Extract content_hash from put.hash (canonical identifier)
        // This is the SHA256 of the off-chain event JSON, anchored on-chain
        let contentHash;
        if (actionName === 'put' && actionPayload.hash) {
            // Use put.hash as canonical content hash
            // This is what was anchored on-chain and matches the off-chain event
            contentHash = actionPayload.hash;
        } else {
            // For non-put actions (vote, finalize), use action payload hash
            contentHash = eventHash;
        }

        // Create anchored event (same schema as Substreams)
        return {
            content_hash: contentHash,
            event_hash: eventHash,
            payload: payloadJson,
            block_num: metadata.blockNum,
            block_id: metadata.blockId,
            trx_id: metadata.transactionId,
            action_ordinal: metadata.actionOrdinal,
            timestamp: metadata.timestamp,
            source: 'ship-eos', // Different source identifier
            contract_account: this.config.contractAccount,
            action_name: actionName
        };
    }

    /**
     * Handle reconnection on disconnect
     */
    handleReconnect() {
        if (!this.isRunning) {
            return;
        }

        this.reconnectAttempts++;

        if (this.reconnectAttempts > this.config.reconnectMaxAttempts) {
            console.error('Max reconnection attempts reached, stopping');
            this.isRunning = false;
            this.emit('error', new Error('Max reconnection attempts reached'));
            return;
        }

        console.log(
            `Reconnecting in ${this.config.reconnectDelay}ms ` +
            `(attempt ${this.reconnectAttempts}/${this.config.reconnectMaxAttempts})`
        );

        setTimeout(() => {
            if (this.isRunning) {
                this.stats.reconnections++;
                this.connect();
            }
        }, this.config.reconnectDelay);
    }

    /**
     * Get current statistics
     */
    getStats() {
        return {
            ...this.stats,
            currentBlock: this.currentBlock,
            isRunning: this.isRunning,
            reconnectAttempts: this.reconnectAttempts
        };
    }
}

export default ShipEventSource;
