/**
 * @fileoverview Entry point for running the Event Processor
 *
 * Loads configuration from environment variables and starts the processor.
 * Handles graceful shutdown and provides status monitoring.
 *
 * @module indexer/runProcessor
 */

import EventProcessor from './eventProcessor.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('indexer.runProcessor');

// Load configuration from environment variables
const config = {
    blockchain: {
        rpcUrl: process.env.RPC_URL || 'https://eos.greymass.com',
        contractAccount: process.env.CONTRACT_ACCOUNT || 'polaris',
        pollInterval: parseInt(process.env.POLL_INTERVAL || '5000')
    },

    database: {
        uri: process.env.GRAPH_URI || 'bolt://localhost:7687',
        user: process.env.GRAPH_USER || 'neo4j',
        password: process.env.GRAPH_PASSWORD || 'password'
    },

    storage: {
        ipfs: {
            url: process.env.IPFS_URL || 'http://localhost:5001',
            gateway: process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/'
        },
        s3: {
            endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
            region: process.env.S3_REGION || 'us-east-1',
            bucket: process.env.S3_BUCKET || 'polaris-events',
            accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
            secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin'
        },
        redis: {
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379'),
            password: process.env.REDIS_PASSWORD,
            ttl: parseInt(process.env.REDIS_TTL || '86400')
        }
    },

    // Optional: specify start block
    startBlock: process.env.START_BLOCK
        ? parseInt(process.env.START_BLOCK)
        : undefined
};

// Log config summary at startup (redact secrets)
log.info('Processor configuration loaded', {
    rpc_url_host: new URL(config.blockchain.rpcUrl).host,
    contract: config.blockchain.contractAccount,
    poll_interval_ms: config.blockchain.pollInterval,
    start_block: config.startBlock || '(auto)',
    graph_uri: config.database.uri
});

// Create processor instance
const processor = new EventProcessor(config);

// Start processor
processor.start().catch((error) => {
    log.error('Failed to start processor', { error: error.message });
    process.exit(1);
});

// Graceful shutdown
const shutdown = async (signal) => {
    log.info('Shutdown signal received', { signal });

    try {
        await processor.stop();
        process.exit(0);
    } catch (error) {
        log.error('Error during shutdown', { signal, error: error.message });
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    log.error('Uncaught exception', { error: error.message, stack: error.stack });
    shutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
    log.error('Unhandled rejection', { reason: String(reason) });
    shutdown('UNHANDLED_REJECTION');
});

// Status monitoring (log stats every minute)
setInterval(() => {
    if (processor.isRunning) {
        const stats = processor.getStats();
        log.info('Processor stats', {
            uptime: stats.uptimeFormatted,
            current_block: stats.currentBlock,
            last_processed_block: stats.lastProcessedBlock,
            blocks_behind: stats.blocksBehind,
            events_processed: stats.eventsProcessed,
            events_per_second: stats.eventsPerSecond,
            errors: stats.errors,
            events_by_type: stats.eventsByType
        });
    }
}, 60000); // Every minute

log.info('Event processor monitoring started', {});
