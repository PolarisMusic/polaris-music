/**
 * @fileoverview Entry point for the Polaris Music Registry API server
 *
 * Loads configuration from environment variables and starts the server.
 * Verifies chain-id at startup to prevent misconfiguration.
 * Handles graceful shutdown on SIGTERM/SIGINT.
 *
 * @module api/index
 */

import APIServer from './server.js';
import { resolveChainConfig } from '../../../shared/config/chainProfiles.js';

/**
 * Verify that the configured CHAIN_ID matches the chain we connect to.
 * Prevents accidental mainnet/testnet/local mismatches.
 * Only runs when RPC_URL and CHAIN_ID are both configured.
 */
async function verifyChainId() {
    const chainConfig = resolveChainConfig();
    const { rpcUrl, chainId, name: profileName } = chainConfig;

    // Skip verification if no RPC URL or chain ID configured
    if (!rpcUrl || !chainId) return;

    // Skip for dev mode without explicit chain config
    const ingestMode = process.env.INGEST_MODE || chainConfig.ingestMode;
    if (ingestMode === 'dev' && !process.env.CHAIN_ID && !process.env.CHAIN_PROFILE) return;

    console.log(`[startup] Chain profile: ${profileName}`);
    console.log(`[startup] RPC: ${rpcUrl}`);
    console.log(`[startup] Expected chain ID: ${chainId.substring(0, 16)}...`);

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(`${rpcUrl}/v1/chain/get_info`, {
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
            console.warn(`[startup] Chain ID verification skipped: RPC returned ${response.status}`);
            return;
        }

        const info = await response.json();
        const remoteChainId = info.chain_id;

        if (remoteChainId !== chainId) {
            console.error('═══════════════════════════════════════════════════════════════');
            console.error('FATAL: Chain ID mismatch!');
            console.error(`  Configured: ${chainId}`);
            console.error(`  RPC reports: ${remoteChainId}`);
            console.error(`  Profile: ${profileName}, RPC: ${rpcUrl}`);
            console.error('  Check CHAIN_PROFILE, CHAIN_ID, and RPC_URL in your environment.');
            console.error('═══════════════════════════════════════════════════════════════');
            process.exit(1);
        }

        console.log(`[startup] Chain ID verified: ${remoteChainId.substring(0, 16)}... (${profileName})`);
        console.log(`[startup] Head block: ${info.head_block_num}, LIB: ${info.last_irreversible_block_num}`);
    } catch (error) {
        if (error.name === 'AbortError') {
            console.warn('[startup] Chain ID verification skipped: RPC timeout');
        } else {
            console.warn(`[startup] Chain ID verification skipped: ${error.message}`);
        }
    }
}

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

// Verify chain configuration, then create and start server
const server = new APIServer(config);

(async () => {
    await verifyChainId();
    await server.start();
})().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
});

// Graceful shutdown
const shutdown = async (signal) => {
    console.log(`\n${signal} received, shutting down gracefully...`);

    try {
        await server.stop();
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
