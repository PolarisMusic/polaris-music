/**
 * @fileoverview Chain Source Manager (T6)
 *
 * Manages switching between Substreams and SHiP chain ingestion sources.
 * Ensures only one source runs at a time and handles graceful transitions.
 *
 * Configuration:
 *   CHAIN_SOURCE=substreams|ship
 *
 * Features:
 * - Source selection via config
 * - Graceful source switching
 * - Unified event handling
 * - Statistics tracking
 */

import ShipEventSource from './shipEventSource.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('indexer.chainSourceManager');

/**
 * Chain Source Manager
 * Coordinates between different chain ingestion sources
 */
export class ChainSourceManager {
    constructor(config, ingestionHandler) {
        this.config = config;
        this.ingestionHandler = ingestionHandler;
        this.currentSource = null;
        this.sourceType = config.chainSource || 'substreams'; // Default to Substreams

        this.stats = {
            eventsIngested: 0,
            eventsDeduped: 0,
            errors: 0,
            startTime: null
        };
    }

    /**
     * Start the configured chain source
     */
    async start() {
        log.info('Starting chain source', { source_type: this.sourceType });
        this.stats.startTime = new Date();

        switch (this.sourceType) {
            case 'ship':
                await this.startShipSource();
                break;

            case 'substreams':
                await this.startSubstreamsSource();
                break;

            default:
                throw new Error(`Unknown chain source: ${this.sourceType}`);
        }
    }

    /**
     * Stop the current chain source
     */
    async stop() {
        if (!this.currentSource) {
            return;
        }

        log.info('Stopping chain source', { source_type: this.sourceType });

        if (this.sourceType === 'ship' && this.currentSource.stop) {
            await this.currentSource.stop();
        }

        // For Substreams, the HTTP sink handles stopping externally

        this.currentSource = null;
    }

    /**
     * Start SHiP event source
     */
    async startShipSource() {
        const shipConfig = {
            shipUrl: this.config.shipUrl || process.env.SHIP_URL || 'ws://localhost:8080',
            contractAccount: this.config.contractAccount || process.env.CONTRACT_ACCOUNT || 'polaris',
            startBlock: parseInt(this.config.startBlock || process.env.START_BLOCK || '0', 10),
            endBlock: parseInt(this.config.endBlock || process.env.END_BLOCK || '0xffffffff', 10),
            reconnectDelay: 3000,
            reconnectMaxAttempts: 10,
            // TLS/SSL options for wss:// connections
            tlsCaCertPath: this.config.tlsCaCertPath || process.env.SHIP_CA_CERT_PATH || '',
            tlsRejectUnauthorized: this.config.tlsRejectUnauthorized ?? (process.env.SHIP_REJECT_UNAUTHORIZED !== 'false'),
        };

        log.info('Initializing SHiP event source', {
            url: shipConfig.shipUrl,
            contract: shipConfig.contractAccount,
            start_block: shipConfig.startBlock
        });

        const ship = new ShipEventSource(shipConfig);

        // Handle anchored events
        ship.on('anchoredEvent', async (anchoredEvent) => {
            await this.handleAnchoredEvent(anchoredEvent);
        });

        // Handle progress updates
        ship.on('progress', (progress) => {
            log.info('SHiP progress', {
                current_block: progress.currentBlock,
                blocks_processed: progress.blocksProcessed,
                events_extracted: progress.eventsExtracted
            });
        });

        // Handle errors
        ship.on('error', (error) => {
            log.error('SHiP error', { error: error.message || String(error) });
            this.stats.errors++;
        });

        // Start streaming
        await ship.start();

        this.currentSource = ship;
    }

    /**
     * Start Substreams source
     * Note: Substreams runs externally via HTTP sink
     */
    async startSubstreamsSource() {
        log.info('Substreams mode active, events received via HTTP sink', {});

        // For Substreams, we just log instructions
        // The HTTP sink POSTs directly to the ingestion endpoint
        // No active source object needed here

        this.currentSource = {
            type: 'substreams',
            external: true
        };
    }

    /**
     * Handle anchored event from any source
     */
    async handleAnchoredEvent(anchoredEvent) {
        try {
            // Process through ingestion handler
            const result = await this.ingestionHandler.processAnchoredEvent(anchoredEvent);

            // Track stats based on actual ingestion return values
            // IngestionHandler returns: 'processed', 'duplicate', 'error', or 'not_found'
            if (result.status === 'processed') {
                this.stats.eventsIngested++;
            } else if (result.status === 'duplicate') {
                this.stats.eventsDeduped++;
            } else if (result.status === 'error' || result.status === 'not_found') {
                this.stats.errors++;
            }

            // Log progress periodically
            if ((this.stats.eventsIngested + this.stats.eventsDeduped) % 100 === 0) {
                log.info('Ingestion stats', {
                    events_ingested: this.stats.eventsIngested,
                    events_deduped: this.stats.eventsDeduped,
                    errors: this.stats.errors
                });
            }

        } catch (error) {
            log.error('Error handling anchored event', { error: error.message });
            this.stats.errors++;
        }
    }

    /**
     * Switch to a different source
     *
     * @param {string} newSource - 'substreams' or 'ship'
     */
    async switchSource(newSource) {
        if (newSource === this.sourceType) {
            log.info('Already using requested source', { source_type: newSource });
            return;
        }

        log.info('Switching chain source', {
            from_source: this.sourceType,
            to_source: newSource
        });

        // Stop current source
        await this.stop();

        // Update source type
        this.sourceType = newSource;

        // Start new source
        await this.start();

        log.info('Chain source switched successfully', { source_type: newSource });
    }

    /**
     * Get statistics
     */
    getStats() {
        const uptime = this.stats.startTime
            ? Date.now() - this.stats.startTime.getTime()
            : 0;

        return {
            ...this.stats,
            sourceType: this.sourceType,
            uptime,
            eventsPerSecond: uptime > 0
                ? ((this.stats.eventsIngested / (uptime / 1000))).toFixed(2)
                : '0'
        };
    }
}

export default ChainSourceManager;
