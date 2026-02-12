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
import https from 'https';
import fs from 'fs';
import { createLogger } from '../utils/logger.js';

/**
 * SHiP Event Source
 * Connects to Antelope State History Plugin and streams action traces
 */
export class ShipEventSource extends EventEmitter {
    constructor(config) {
        super();

        // Determine default SHiP URL based on environment
        const nodeEnv = process.env.NODE_ENV || 'development';
        const defaultShipUrl = nodeEnv === 'testnet'
            ? (process.env.CHAIN_WS_URL || 'wss://jungle4.greymass.com')
            : 'ws://localhost:8080';

        this.config = {
            shipUrl: config.shipUrl || defaultShipUrl,
            contractAccount: config.contractAccount || process.env.CONTRACT_ACCOUNT || 'polaris',
            startBlock: config.startBlock || parseInt(process.env.START_BLOCK || '0', 10),
            endBlock: config.endBlock || 0xffffffff, // Max uint32
            reconnectDelay: config.reconnectDelay || 3000,
            reconnectMaxAttempts: config.reconnectMaxAttempts || 10,
            // TLS/SSL options for wss:// connections
            tlsCaCertPath: config.tlsCaCertPath || process.env.SHIP_CA_CERT_PATH || '',
            tlsRejectUnauthorized: config.tlsRejectUnauthorized ?? (process.env.SHIP_REJECT_UNAUTHORIZED !== 'false'),
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
        this.log = createLogger('indexer.ship');
    }

    /**
     * Start streaming events from SHiP
     */
    async start() {
        if (this.isRunning) {
            throw new Error('ShipEventSource is already running');
        }

        // CRITICAL LIMITATION: SHiP binary deserialization not implemented
        // SHiP streams binary frames that require Antelope ABI deserialization
        // Current implementation drops binary messages (see handleMessage)
        // Recommended: Use CHAIN_SOURCE=substreams instead
        // If SHiP support needed: Use library like eosio-ship-reader or @greymass/eosio
        // Structured log for pipeline tracing
        this.log.error('ship_not_implemented', { message: 'SHiP binary deserialization not implemented, use CHAIN_SOURCE=substreams' });

        // Console banner for operator visibility (tested by shipEventSource.test.js)
        console.error('═════════════════════════════════════════════════════════════');
        console.error('ERROR: SHiP event source is not fully implemented');
        console.error('Recommended: Set CHAIN_SOURCE=substreams in your environment');
        console.error('═════════════════════════════════════════════════════════════');

        throw new Error('SHiP event source not implemented (binary deserialization required). Use CHAIN_SOURCE=substreams instead.');
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
        this.log.info('ship_stopped');
    }

    /**
     * Connect to SHiP WebSocket
     */
    async connect() {
        try {
            this.log.info('ship_connecting', { url: this.config.shipUrl });

            // Build WebSocket options with TLS support for wss:// URLs
            const wsOptions = {};
            if (this.config.shipUrl.startsWith('wss://')) {
                const tlsConfig = {
                    rejectUnauthorized: this.config.tlsRejectUnauthorized,
                };

                // Load custom CA certificate for SSL pinning
                if (this.config.tlsCaCertPath) {
                    try {
                        if (fs.existsSync(this.config.tlsCaCertPath)) {
                            tlsConfig.ca = fs.readFileSync(this.config.tlsCaCertPath);
                            this.log.info('ship_tls_ca_loaded', { cert_path: this.config.tlsCaCertPath });
                        } else {
                            this.log.warn('ship_tls_ca_not_found', { cert_path: this.config.tlsCaCertPath });
                        }
                    } catch (certError) {
                        this.log.error('ship_tls_ca_load_failed', { error: certError.message });
                    }
                }

                wsOptions.agent = new https.Agent(tlsConfig);

                if (!tlsConfig.rejectUnauthorized) {
                    this.log.warn('ship_tls_verification_disabled', { message: 'USE ONLY FOR DEVELOPMENT' });
                }
            }

            this.ws = new WebSocket(this.config.shipUrl, wsOptions);

            this.ws.on('open', () => {
                this.log.info('ship_connected');
                this.reconnectAttempts = 0;
                this.sendGetBlocksRequest();
            });

            this.ws.on('message', (data) => {
                this.handleMessage(data);
            });

            this.ws.on('error', (error) => {
                this.log.error('ship_ws_error', { error: error.message });
                this.stats.errors++;
                this.emit('error', error);
            });

            this.ws.on('close', () => {
                this.log.info('ship_ws_closed');
                if (this.isRunning) {
                    this.handleReconnect();
                }
            });

        } catch (error) {
            this.log.error('ship_connect_fail', { error: error.message });
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

        this.log.info('ship_request_blocks', { start_block: this.currentBlock, end_block: this.config.endBlock });
        this.ws.send(JSON.stringify(request));
    }

    /**
     * Handle incoming message from SHiP
     *
     * NOTE: This method is non-functional for production use.
     * SHiP normally streams binary frames that require Antelope ABI deserialization.
     * This code attempts JSON parsing and drops all binary messages.
     *
     * To implement properly:
     * 1. Use library like eosio-ship-reader or @greymass/eosio
     * 2. Deserialize binary frames using Antelope ABI
     * 3. Extract action traces from get_blocks_result_v0 messages
     *
     * Current recommendation: Use CHAIN_SOURCE=substreams instead
     */
    async handleMessage(data) {
        try {
            // Parse message
            let message;
            try {
                const text = data.toString('utf-8');
                message = JSON.parse(text);
            } catch (error) {
                // Binary format (normal SHiP behavior) - drops message (NON-FUNCTIONAL)
                // This causes SHiP mode to ingest almost nothing
                this.log.warn('ship_binary_message_dropped');
                this.stats.errors++;
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
                    this.log.warn('ship_unknown_message', { type: messageType });
            }

        } catch (error) {
            this.log.error('ship_message_error', { error: error.message });
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

            this.log.debug('ship_block', { block_num: blockNum });

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
            this.log.error('ship_block_error', { error: error.message });
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
            this.log.error('ship_trace_error', { error: error.message });
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
            this.log.error('ship_action_error', { error: error.message });
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
                    this.log.warn('ship_action_data_not_json');
                    return null;
                }
            }

            return null;

        } catch (error) {
            this.log.error('ship_extract_error', { error: error.message });
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
            this.log.error('ship_max_reconnects', { attempts: this.reconnectAttempts, max: this.config.reconnectMaxAttempts });
            this.isRunning = false;
            this.emit('error', new Error('Max reconnection attempts reached'));
            return;
        }

        this.log.warn('ship_reconnecting', { delay_ms: this.config.reconnectDelay, attempt: this.reconnectAttempts, max: this.config.reconnectMaxAttempts });

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
