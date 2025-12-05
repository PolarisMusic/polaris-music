/**
 * @fileoverview Entry point for running the Event Processor
 *
 * Loads configuration from environment variables and starts the processor.
 * Handles graceful shutdown and provides status monitoring.
 *
 * @module indexer/runProcessor
 */

import EventProcessor from './eventProcessor.js';

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

// Create processor instance
const processor = new EventProcessor(config);

// Start processor
processor.start().catch((error) => {
    console.error('Failed to start processor:', error);
    process.exit(1);
});

// Graceful shutdown
const shutdown = async (signal) => {
    console.log(`\n${signal} received, shutting down gracefully...`);

    try {
        await processor.stop();
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    shutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
    shutdown('UNHANDLED_REJECTION');
});

// Status monitoring (log stats every minute)
setInterval(() => {
    if (processor.isRunning) {
        const stats = processor.getStats();
        console.log(`\n=Ê Processor Stats:`);
        console.log(`   Uptime: ${stats.uptimeFormatted}`);
        console.log(`   Current block: ${stats.currentBlock}`);
        console.log(`   Last processed: ${stats.lastProcessedBlock}`);
        console.log(`   Blocks behind: ${stats.blocksBehind}`);
        console.log(`   Events processed: ${stats.eventsProcessed}`);
        console.log(`   Events/sec: ${stats.eventsPerSecond}`);
        console.log(`   Errors: ${stats.errors}`);

        if (Object.keys(stats.eventsByType).length > 0) {
            console.log(`   By type:`);
            for (const [type, count] of Object.entries(stats.eventsByType)) {
                console.log(`     Type ${type}: ${count}`);
            }
        }
    }
}, 60000); // Every minute

console.log('\n=á Event Processor monitoring started');
console.log('   Press Ctrl+C to stop\n');
