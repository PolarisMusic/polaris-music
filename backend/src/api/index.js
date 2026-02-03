/**
 * @fileoverview Entry point for the Polaris Music Registry API server
 *
 * Loads configuration from environment variables and starts the server.
 * Handles graceful shutdown on SIGTERM/SIGINT.
 *
 * @module api/index
 */

import APIServer from './server.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('api.bootstrap');

// Load configuration from environment variables
const config = {
    port: parseInt(process.env.PORT || '3000'),

    database: {
        uri: process.env.GRAPH_URI || 'bolt://localhost:7687',
        user: process.env.GRAPH_USER || 'neo4j',
        password: process.env.GRAPH_PASSWORD || 'password'
    },

    storage: {
        ipfs: {
            // Support both IPFS_URLS (multi-node, preferred) and IPFS_URL (single node, legacy)
            urls: process.env.IPFS_URLS
                ? process.env.IPFS_URLS.split(',').map(url => url.trim())
                : null,
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
            ttl: parseInt(process.env.REDIS_TTL || '86400') // 24 hours default
        },
        pinning: {
            provider: process.env.PIN_PROVIDER || 'none',
            token: process.env.PIN_PROVIDER_TOKEN,
            endpoint: process.env.PIN_PROVIDER_ENDPOINT,
            timeout: parseInt(process.env.PIN_PROVIDER_TIMEOUT_MS || '8000')
        }
    }
};

// Create and start server
const server = new APIServer(config);

log.info('boot_start', {
    port: config.port,
    node_env: process.env.NODE_ENV || 'development',
    ingest_mode: process.env.INGEST_MODE || 'chain'
});

server.start()
    .then(() => {
        log.info('boot_success', { port: config.port });
    })
    .catch((error) => {
        log.error('boot_fail', { error: error.message, error_class: error.constructor.name, stack: error.stack });
        process.exit(1);
    });

// Graceful shutdown
const shutdown = async (signal) => {
    log.info('shutdown_start', { signal });

    try {
        await server.stop();
        log.info('shutdown_end', { signal });
        process.exit(0);
    } catch (error) {
        log.error('shutdown_error', { signal, error: error.message, error_class: error.constructor.name, stack: error.stack });
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    log.error('uncaught_exception', { error: error.message, error_class: error.constructor.name, stack: error.stack });
    shutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
    log.error('unhandled_rejection', { error: reason?.message || String(reason), error_class: reason?.constructor?.name });
    shutdown('UNHANDLED_REJECTION');
});
