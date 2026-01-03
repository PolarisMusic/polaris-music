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
        console.log(`Starting chain source: ${this.sourceType}`);
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

        console.log(`Stopping chain source: ${this.sourceType}`);

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
            reconnectMaxAttempts: 10
        };

        console.log('Initializing SHiP event source:', {
            url: shipConfig.shipUrl,
            contract: shipConfig.contractAccount,
            startBlock: shipConfig.startBlock
        });

        const ship = new ShipEventSource(shipConfig);

        // Handle anchored events
        ship.on('anchoredEvent', async (anchoredEvent) => {
            await this.handleAnchoredEvent(anchoredEvent);
        });

        // Handle progress updates
        ship.on('progress', (progress) => {
            console.log(
                `SHiP Progress: Block ${progress.currentBlock}, ` +
                `Blocks: ${progress.blocksProcessed}, Events: ${progress.eventsExtracted}`
            );
        });

        // Handle errors
        ship.on('error', (error) => {
            console.error('SHiP error:', error);
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
        console.log('Substreams mode: Events will be received via HTTP sink');
        console.log('Run: cd substreams/sink && node http-sink.js');

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

            if (result.status === 'processed') {
                this.stats.eventsIngested++;
            } else if (result.status === 'duplicate') {
                this.stats.eventsDeduped++;
            }

            // Log progress periodically
            if ((this.stats.eventsIngested + this.stats.eventsDeduped) % 100 === 0) {
                console.log(
                    `Ingestion stats: ${this.stats.eventsIngested} processed, ` +
                    `${this.stats.eventsDeduped} deduped, ${this.stats.errors} errors`
                );
            }

        } catch (error) {
            console.error('Error handling anchored event:', error);
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
            console.log(`Already using source: ${newSource}`);
            return;
        }

        console.log(`Switching from ${this.sourceType} to ${newSource}`);

        // Stop current source
        await this.stop();

        // Update source type
        this.sourceType = newSource;

        // Start new source
        await this.start();

        console.log(`Switched to ${newSource} successfully`);
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
