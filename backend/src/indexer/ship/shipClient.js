/**
 * @fileoverview SHiP WebSocket Transport Client
 *
 * Manages the WebSocket connection to Antelope's state_history_plugin.
 * Handles connect, reconnect, protocol handshake, binary messaging,
 * and flow control (ack management).
 *
 * Lifecycle:
 * 1. connect() -> WebSocket opens
 * 2. First message: JSON ABI -> protocol.initialize()
 * 3. Send get_blocks_request (binary)
 * 4. Receive get_blocks_result (binary) -> emit 'block'
 * 5. Send ack after processing -> flow control
 * 6. Repeat 4-5 until stopped or disconnected
 *
 * @module indexer/ship/shipClient
 */

import WebSocket from 'ws';
import https from 'https';
import fs from 'fs';
import { EventEmitter } from 'events';
import { ShipProtocol } from './shipProtocol.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('indexer.ship.client');

export class ShipClient extends EventEmitter {
    /**
     * @param {Object} config
     * @param {string} config.shipUrl - WebSocket URL (ws:// or wss://)
     * @param {number} [config.startBlock=0] - Block to start streaming from
     * @param {number} [config.endBlock=0xffffffff] - Block to stop at
     * @param {number} [config.maxMessagesInFlight=5] - Flow control window
     * @param {boolean} [config.irreversibleOnly=false] - Only irreversible blocks
     * @param {boolean} [config.fetchTraces=true] - Include action traces
     * @param {boolean} [config.fetchDeltas=false] - Include table deltas
     * @param {number} [config.reconnectDelay=3000] - Base reconnect delay (ms)
     * @param {number} [config.reconnectMaxAttempts=10] - Max reconnect attempts
     * @param {string} [config.tlsCaCertPath] - CA cert for wss://
     * @param {boolean} [config.tlsRejectUnauthorized=true] - Verify TLS certs
     */
    constructor(config) {
        super();

        this.config = {
            shipUrl: config.shipUrl || 'ws://localhost:8080',
            startBlock: config.startBlock ?? 0,
            endBlock: config.endBlock ?? 0xffffffff,
            maxMessagesInFlight: config.maxMessagesInFlight ?? 5,
            irreversibleOnly: config.irreversibleOnly ?? false,
            fetchTraces: config.fetchTraces ?? true,
            fetchDeltas: config.fetchDeltas ?? false,
            reconnectDelay: config.reconnectDelay ?? 3000,
            reconnectMaxAttempts: config.reconnectMaxAttempts ?? 10,
            tlsCaCertPath: config.tlsCaCertPath || '',
            tlsRejectUnauthorized: config.tlsRejectUnauthorized ?? true,
        };

        this.protocol = new ShipProtocol();
        this.ws = null;
        this.isRunning = false;
        this.currentBlock = this.config.startBlock;
        this.reconnectAttempts = 0;
        this.inFlightCount = 0;

        this.stats = {
            blocksReceived: 0,
            messagesReceived: 0,
            reconnections: 0,
            errors: 0,
            lastBlockTime: null,
        };
    }

    /**
     * Start the SHiP client. Connects to the WebSocket and begins streaming.
     */
    async start() {
        if (this.isRunning) {
            throw new Error('ShipClient is already running');
        }

        this.isRunning = true;
        this.reconnectAttempts = 0;

        log.info('ship_client_starting', {
            url: this.config.shipUrl,
            start_block: this.config.startBlock,
            end_block: this.config.endBlock,
            irreversible_only: this.config.irreversibleOnly,
        });

        await this._connect();
    }

    /**
     * Stop the client and close the WebSocket.
     */
    async stop() {
        this.isRunning = false;

        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close();
            }
            this.ws = null;
        }

        log.info('ship_client_stopped', { blocks_received: this.stats.blocksReceived });
    }

    /**
     * Acknowledge processed messages for flow control.
     * Call this after processing a block to allow SHiP to send more.
     *
     * @param {number} [count=1] - Number of messages to acknowledge
     */
    ack(count = 1) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.protocol.initialized) {
            return;
        }

        try {
            const ackData = this.protocol.encodeAck(count);
            this.ws.send(ackData);
            this.inFlightCount = Math.max(0, this.inFlightCount - count);
        } catch (error) {
            log.error('ship_ack_error', { error: error.message });
        }
    }

    /**
     * Update the current block position (for checkpoint resume).
     *
     * @param {number} blockNum
     */
    setCurrentBlock(blockNum) {
        this.currentBlock = blockNum;
    }

    /**
     * Get current client statistics.
     */
    getStats() {
        return {
            ...this.stats,
            currentBlock: this.currentBlock,
            isRunning: this.isRunning,
            isConnected: this.ws?.readyState === WebSocket.OPEN,
            inFlightCount: this.inFlightCount,
            reconnectAttempts: this.reconnectAttempts,
        };
    }

    /**
     * Internal: establish WebSocket connection.
     */
    async _connect() {
        return new Promise((resolve, reject) => {
            try {
                log.info('ship_connecting', { url: this.config.shipUrl });

                const wsOptions = this._buildWsOptions();
                this.ws = new WebSocket(this.config.shipUrl, { ...wsOptions });
                this.ws.binaryType = 'arraybuffer';

                let firstMessage = true;

                this.ws.on('open', () => {
                    log.info('ship_connected');
                    this.reconnectAttempts = 0;
                });

                this.ws.on('message', (data) => {
                    try {
                        if (firstMessage) {
                            // First message is the protocol ABI (JSON text)
                            firstMessage = false;
                            const abiText = typeof data === 'string'
                                ? data
                                : Buffer.from(data).toString('utf-8');
                            this.protocol.initialize(abiText);
                            log.info('ship_protocol_initialized');

                            // Now send the blocks request
                            this._sendBlocksRequest();
                            resolve();
                            return;
                        }

                        // All subsequent messages are binary
                        this._handleBinaryMessage(data);
                    } catch (error) {
                        log.error('ship_message_error', { error: error.message });
                        this.stats.errors++;
                        this.emit('error', error);
                    }
                });

                this.ws.on('error', (error) => {
                    log.error('ship_ws_error', { error: error.message });
                    this.stats.errors++;
                    this.emit('error', error);
                    if (firstMessage) {
                        reject(error);
                    }
                });

                this.ws.on('close', (code, reason) => {
                    log.info('ship_ws_closed', { code, reason: reason?.toString() });
                    if (this.isRunning) {
                        this._handleReconnect();
                    }
                    if (firstMessage) {
                        reject(new Error(`WebSocket closed before handshake (code: ${code})`));
                    }
                });

            } catch (error) {
                log.error('ship_connect_fail', { error: error.message });
                this.stats.errors++;
                reject(error);
            }
        });
    }

    /**
     * Build WebSocket options including TLS configuration.
     */
    _buildWsOptions() {
        const options = {};

        if (this.config.shipUrl.startsWith('wss://')) {
            const tlsConfig = {
                rejectUnauthorized: this.config.tlsRejectUnauthorized,
            };

            if (this.config.tlsCaCertPath) {
                try {
                    if (fs.existsSync(this.config.tlsCaCertPath)) {
                        tlsConfig.ca = fs.readFileSync(this.config.tlsCaCertPath);
                        log.info('ship_tls_ca_loaded', { path: this.config.tlsCaCertPath });
                    }
                } catch (error) {
                    log.warn('ship_tls_ca_error', { error: error.message });
                }
            }

            options.agent = new https.Agent(tlsConfig);

            if (!tlsConfig.rejectUnauthorized) {
                log.warn('ship_tls_verify_disabled');
            }
        }

        return options;
    }

    /**
     * Send the initial get_blocks_request after protocol handshake.
     */
    _sendBlocksRequest() {
        const requestData = this.protocol.encodeGetBlocksRequest({
            startBlock: this.currentBlock,
            endBlock: this.config.endBlock,
            maxMessagesInFlight: this.config.maxMessagesInFlight,
            irreversibleOnly: this.config.irreversibleOnly,
            fetchTraces: this.config.fetchTraces,
            fetchDeltas: this.config.fetchDeltas,
        });

        log.info('ship_request_blocks', {
            start: this.currentBlock,
            end: this.config.endBlock,
            irreversible_only: this.config.irreversibleOnly,
        });

        this.ws.send(requestData);
        this.inFlightCount = this.config.maxMessagesInFlight;
    }

    /**
     * Handle a binary protocol message from SHiP.
     *
     * @param {ArrayBuffer|Buffer} rawData
     */
    _handleBinaryMessage(rawData) {
        let data;
        if (rawData instanceof ArrayBuffer) {
            data = new Uint8Array(rawData);
        } else if (Buffer.isBuffer(rawData)) {
            // Buffer.buffer may be larger than the slice — use byteOffset/byteLength
            data = new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength);
        } else {
            data = new Uint8Array(rawData);
        }

        const result = this.protocol.decodeResult(data);
        this.stats.messagesReceived++;

        switch (result.type) {
            case 'get_blocks_result_v0':
                this._handleBlockResult(result.data);
                break;

            case 'get_status_result_v0':
                this.emit('status', result.data);
                break;

            default:
                log.warn('ship_unknown_result', { type: result.type });
        }
    }

    /**
     * Handle a decoded get_blocks_result_v0.
     *
     * @param {Object} blockResult
     */
    _handleBlockResult(blockResult) {
        const blockData = this.protocol.extractBlockData(blockResult);

        if (!blockData) {
            // Empty block result (can happen near head)
            this.ack(1);
            return;
        }

        this.currentBlock = blockData.blockNum + 1;
        this.stats.blocksReceived++;
        this.stats.lastBlockTime = new Date();

        // Emit the decoded block for the event source to process
        this.emit('block', blockData);

        // Log progress periodically
        if (this.stats.blocksReceived % 1000 === 0) {
            log.info('ship_progress', {
                block: blockData.blockNum,
                blocks_received: this.stats.blocksReceived,
                last_irreversible: blockData.lastIrreversible,
            });
        }
    }

    /**
     * Handle reconnection after disconnect.
     */
    _handleReconnect() {
        if (!this.isRunning) return;

        this.reconnectAttempts++;

        if (this.reconnectAttempts > this.config.reconnectMaxAttempts) {
            log.error('ship_max_reconnects', {
                attempts: this.reconnectAttempts,
                max: this.config.reconnectMaxAttempts,
            });
            this.isRunning = false;
            this.emit('error', new Error('Max reconnection attempts reached'));
            return;
        }

        // Exponential backoff: delay * 2^(attempt-1), capped at 30s
        const delay = Math.min(
            this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
            30000
        );

        log.warn('ship_reconnecting', {
            delay_ms: delay,
            attempt: this.reconnectAttempts,
            max: this.config.reconnectMaxAttempts,
            resume_block: this.currentBlock,
        });

        setTimeout(async () => {
            if (!this.isRunning) return;
            this.stats.reconnections++;
            try {
                await this._connect();
            } catch (error) {
                log.error('ship_reconnect_failed', { error: error.message });
                this._handleReconnect();
            }
        }, delay);
    }
}

export default ShipClient;
