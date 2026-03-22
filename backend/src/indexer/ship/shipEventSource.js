/**
 * @fileoverview SHiP Event Source - Action Filtering and AnchoredEvent Emission
 *
 * Top-level SHiP ingestion module that orchestrates:
 * - ShipClient for WebSocket transport
 * - ShipAbiRegistry for action data decoding
 * - ShipProtocol (via ShipClient) for binary protocol handling
 *
 * Filters relevant contract actions (put, vote, finalize), decodes them
 * using the contract ABI, and emits canonical AnchoredEvent objects
 * identical to those produced by the Substreams path.
 *
 * @module indexer/ship/shipEventSource
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { ShipClient } from './shipClient.js';
import { ShipAbiRegistry } from './shipAbiRegistry.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('indexer.ship.eventSource');

/** Actions we care about from the Polaris contract */
const POLARIS_ACTIONS = ['put', 'vote', 'finalize'];

/** eosio::setabi action for tracking ABI updates */
const SETABI_ACCOUNT = 'eosio';
const SETABI_ACTION = 'setabi';

export class ShipEventSource extends EventEmitter {
    /**
     * @param {Object} config
     * @param {string} config.shipUrl - SHiP WebSocket URL
     * @param {string} config.rpcUrl - RPC endpoint for ABI fetching
     * @param {string} config.contractAccount - Contract to filter actions for
     * @param {number} [config.startBlock=0] - Start block
     * @param {number} [config.endBlock=0xffffffff] - End block
     * @param {boolean} [config.irreversibleOnly=false] - Only irreversible blocks
     * @param {boolean} [config.useLocalAbi=false] - Prefer local ABI files
     * @param {string} [config.localAbiDir] - Directory for local ABI files
     * @param {number} [config.reconnectDelay=3000] - Reconnect delay (ms)
     * @param {number} [config.reconnectMaxAttempts=10] - Max reconnect attempts
     * @param {string} [config.tlsCaCertPath] - CA cert path for wss://
     * @param {boolean} [config.tlsRejectUnauthorized=true] - Verify TLS
     * @param {Object} [config.checkpointStore] - Redis client for checkpoints (optional)
     * @param {string} [config.checkpointKey] - Redis key for checkpoints
     */
    constructor(config) {
        super();

        this.contractAccount = config.contractAccount || 'polarismusic';

        // ABI Registry
        this.abiRegistry = new ShipAbiRegistry({
            rpcUrl: config.rpcUrl,
            useLocalAbi: config.useLocalAbi || false,
            localAbiDir: config.localAbiDir,
            contractAccount: this.contractAccount,
        });

        // SHiP Client
        this.client = new ShipClient({
            shipUrl: config.shipUrl,
            startBlock: config.startBlock ?? 0,
            endBlock: config.endBlock ?? 0xffffffff,
            irreversibleOnly: config.irreversibleOnly ?? false,
            reconnectDelay: config.reconnectDelay ?? 3000,
            reconnectMaxAttempts: config.reconnectMaxAttempts ?? 10,
            tlsCaCertPath: config.tlsCaCertPath,
            tlsRejectUnauthorized: config.tlsRejectUnauthorized,
            fetchTraces: true,
            fetchDeltas: false,
        });

        // Checkpoint store (optional Redis client)
        this.checkpointStore = config.checkpointStore || null;
        this.checkpointKey = config.checkpointKey ||
            `ship:checkpoint:${this.contractAccount}`;

        this.stats = {
            blocksProcessed: 0,
            eventsExtracted: 0,
            actionsDecoded: 0,
            decodeErrors: 0,
            errors: 0,
        };

        // Wire up client events
        this._setupClientHandlers();
    }

    /**
     * Start the SHiP event source.
     * Bootstraps the ABI registry, restores checkpoint if available,
     * then starts the SHiP client.
     */
    async start() {
        log.info('ship_event_source_starting', {
            contract: this.contractAccount,
            ship_url: this.client.config.shipUrl,
        });

        // Bootstrap ABI registry
        await this.abiRegistry.bootstrap();

        // Restore checkpoint if available
        await this._restoreCheckpoint();

        // Start streaming
        await this.client.start();

        log.info('ship_event_source_started', {
            start_block: this.client.currentBlock,
            irreversible_only: this.client.config.irreversibleOnly,
        });
    }

    /**
     * Stop the event source and save checkpoint.
     */
    async stop() {
        await this._saveCheckpoint();
        await this.client.stop();
        log.info('ship_event_source_stopped', { stats: this.getStats() });
    }

    /**
     * Get current statistics.
     */
    getStats() {
        return {
            ...this.stats,
            client: this.client.getStats(),
            currentBlock: this.client.currentBlock,
            isRunning: this.client.isRunning,
        };
    }

    /**
     * Set up event handlers on the SHiP client.
     */
    _setupClientHandlers() {
        this.client.on('block', async (blockData) => {
            try {
                await this._processBlock(blockData);
                // Ack after processing to maintain flow control
                this.client.ack(1);
            } catch (error) {
                log.error('ship_block_process_error', {
                    block: blockData.blockNum,
                    error: error.message,
                });
                this.stats.errors++;
                this.emit('error', error);
                // Still ack to avoid stalling
                this.client.ack(1);
            }
        });

        this.client.on('error', (error) => {
            this.stats.errors++;
            this.emit('error', error);
        });

        this.client.on('status', (status) => {
            this.emit('status', status);
        });
    }

    /**
     * Process a decoded block and extract relevant actions.
     *
     * @param {Object} blockData - From ShipClient 'block' event
     */
    async _processBlock(blockData) {
        const { blockNum, blockId, timestamp, traces } = blockData;

        if (!traces || traces.length === 0) {
            this.stats.blocksProcessed++;
            return;
        }

        // Extract actions matching our contract
        const actions = this.client.protocol.extractActionTraces(
            traces,
            this.contractAccount,
            POLARIS_ACTIONS
        );

        // Also check for setabi on our contract (to refresh ABI)
        const setabiActions = this.client.protocol.extractActionTraces(
            traces,
            SETABI_ACCOUNT,
            [SETABI_ACTION]
        );

        // Handle ABI updates
        for (const setabi of setabiActions) {
            try {
                const decoded = await this.abiRegistry.decodeActionData(
                    SETABI_ACCOUNT, SETABI_ACTION, setabi.data
                );
                if (decoded && String(decoded.account) === this.contractAccount) {
                    await this.abiRegistry.handleSetAbi(this.contractAccount);
                }
            } catch {
                // Non-critical: setabi decode failure
            }
        }

        // Process relevant actions
        for (const action of actions) {
            try {
                const anchoredEvent = await this._processAction(action, {
                    blockNum,
                    blockId,
                    timestamp,
                });

                if (anchoredEvent) {
                    this.emit('anchoredEvent', anchoredEvent);
                    this.stats.eventsExtracted++;
                }
            } catch (error) {
                log.error('ship_action_decode_error', {
                    block: blockNum,
                    action: action.name,
                    trx: action.trxId,
                    error: error.message,
                });
                this.stats.decodeErrors++;
            }
        }

        this.stats.blocksProcessed++;

        // Periodic checkpoint save
        if (this.stats.blocksProcessed % 1000 === 0) {
            await this._saveCheckpoint();
        }

        // Emit progress
        if (this.stats.blocksProcessed % 100 === 0) {
            this.emit('progress', {
                currentBlock: blockNum,
                blocksProcessed: this.stats.blocksProcessed,
                eventsExtracted: this.stats.eventsExtracted,
            });
        }
    }

    /**
     * Process a single action trace and create an AnchoredEvent.
     *
     * @param {Object} action - Extracted action trace
     * @param {Object} blockMeta - Block metadata
     * @returns {Object|null} AnchoredEvent or null if decode fails
     */
    async _processAction(action, blockMeta) {
        // Decode action data using contract ABI
        const actionPayload = await this.abiRegistry.decodeActionData(
            action.account,
            action.name,
            action.data
        );

        if (!actionPayload) {
            log.warn('ship_action_data_null', {
                action: action.name,
                trx: action.trxId,
            });
            return null;
        }

        this.stats.actionsDecoded++;

        // Parse timestamp
        const ts = blockMeta.timestamp
            ? Math.floor(new Date(blockMeta.timestamp + 'Z').getTime() / 1000)
            : Math.floor(Date.now() / 1000);

        // Create canonical AnchoredEvent (same format as Substreams)
        return this._createAnchoredEvent(actionPayload, action.name, {
            blockNum: blockMeta.blockNum,
            blockId: blockMeta.blockId,
            transactionId: action.trxId,
            actionOrdinal: action.actionOrdinal,
            timestamp: ts,
        });
    }

    /**
     * Create AnchoredEvent from decoded action data.
     * CRITICAL: Must match Substreams format exactly for source parity.
     *
     * Uses put.hash as content_hash (canonical identifier) for put actions.
     * This keeps dedupe stable across SHiP and Substreams.
     *
     * @param {Object} actionPayload - Decoded action data
     * @param {string} actionName - Action name (put, vote, finalize)
     * @param {Object} metadata - Block/transaction metadata
     * @returns {Object} AnchoredEvent
     */
    _createAnchoredEvent(actionPayload, actionName, metadata) {
        const payloadJson = JSON.stringify(actionPayload);

        // event_hash: SHA256 of the JSON payload (for debug/trace identity)
        const eventHash = crypto
            .createHash('sha256')
            .update(payloadJson)
            .digest('hex');

        // content_hash: canonical identifier for dedupe
        // For 'put' actions, use the on-chain hash field (matches off-chain event)
        // For other actions, fall back to event_hash
        let contentHash;
        if (actionName === 'put' && actionPayload.hash) {
            contentHash = String(actionPayload.hash);
        } else {
            contentHash = eventHash;
        }

        return {
            content_hash: contentHash,
            event_hash: eventHash,
            payload: payloadJson,
            block_num: metadata.blockNum,
            block_id: metadata.blockId,
            trx_id: metadata.transactionId,
            action_ordinal: metadata.actionOrdinal,
            timestamp: metadata.timestamp,
            source: 'ship-eos',
            contract_account: this.contractAccount,
            action_name: actionName,
        };
    }

    /**
     * Restore checkpoint from persistent storage (Redis).
     */
    async _restoreCheckpoint() {
        if (!this.checkpointStore) return;

        try {
            const checkpoint = await this.checkpointStore.get(this.checkpointKey);
            if (checkpoint) {
                const data = JSON.parse(checkpoint);
                if (data.lastProcessedBlock && data.lastProcessedBlock > this.client.currentBlock) {
                    log.info('ship_checkpoint_restored', {
                        block: data.lastProcessedBlock,
                        saved_at: data.savedAt,
                    });
                    this.client.setCurrentBlock(data.lastProcessedBlock + 1);
                }
            }
        } catch (error) {
            log.warn('ship_checkpoint_restore_failed', { error: error.message });
        }
    }

    /**
     * Save checkpoint to persistent storage (Redis).
     */
    async _saveCheckpoint() {
        if (!this.checkpointStore) return;

        try {
            const data = {
                lastProcessedBlock: this.client.currentBlock - 1,
                eventsExtracted: this.stats.eventsExtracted,
                savedAt: new Date().toISOString(),
            };
            await this.checkpointStore.set(
                this.checkpointKey,
                JSON.stringify(data)
            );
        } catch (error) {
            log.warn('ship_checkpoint_save_failed', { error: error.message });
        }
    }
}

export default ShipEventSource;
