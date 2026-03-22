/**
 * @fileoverview Entry point for Chain Source Worker (SHiP / Substreams)
 *
 * Initializes the full ingestion pipeline and starts the ChainSourceManager.
 * This worker replaces the legacy runProcessor.js for SHiP-based ingestion
 * and can also coordinate Substreams mode.
 *
 * Dependencies initialized:
 * - Neo4j (MusicGraphDatabase)
 * - EventStore (IPFS + S3 + Redis)
 * - EventProcessor (graph mutations)
 * - IngestionHandler (dedup, verification, dispatch)
 * - ChainSourceManager (SHiP or Substreams transport)
 *
 * @module indexer/runChainSource
 */

import Redis from 'ioredis';
import MusicGraphDatabase from '../graph/schema.js';
import EventStore from '../storage/eventStore.js';
import EventProcessor from './eventProcessor.js';
import { IngestionHandler } from '../api/ingestion.js';
import { ChainSourceManager } from './chainSourceManager.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('indexer.runChainSource');

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const config = {
    database: {
        uri: process.env.GRAPH_URI || 'bolt://localhost:7687',
        user: process.env.GRAPH_USER || 'neo4j',
        password: process.env.GRAPH_PASSWORD || 'password',
    },

    storage: {
        ipfs: {
            url: process.env.IPFS_URL || 'http://localhost:5001',
            urls: process.env.IPFS_URLS || process.env.IPFS_URL || 'http://localhost:5001',
            gateway: process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/',
        },
        s3: {
            endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
            region: process.env.S3_REGION || 'us-east-1',
            bucket: process.env.S3_BUCKET || 'polaris-events',
            accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
            secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin',
        },
        redis: {
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379'),
            password: process.env.REDIS_PASSWORD,
            ttl: parseInt(process.env.REDIS_TTL || '86400'),
        },
    },

    chainSource: process.env.CHAIN_SOURCE || 'ship',
    rpcUrl: process.env.RPC_URL || 'https://jungle4.greymass.com',
    contractAccount: process.env.CONTRACT_ACCOUNT || 'polarismusic',

    // SHiP-specific
    shipUrl: process.env.SHIP_URL || 'ws://localhost:8080',
    startBlock: process.env.START_BLOCK ? parseInt(process.env.START_BLOCK) : 0,
    endBlock: process.env.END_BLOCK ? parseInt(process.env.END_BLOCK) : 0xffffffff,
    irreversibleOnly: process.env.IRREVERSIBLE_ONLY,
    useLocalAbi: process.env.USE_LOCAL_ABI,
    contractAbiPath: process.env.CONTRACT_ABI_PATH || '',
    tlsCaCertPath: process.env.SHIP_CA_CERT_PATH || '',
    tlsRejectUnauthorized: process.env.SHIP_REJECT_UNAUTHORIZED,
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

log.info('chain_source_config', {
    chain_source: config.chainSource,
    rpc_url: config.rpcUrl,
    contract: config.contractAccount,
    ship_url: config.shipUrl,
    start_block: config.startBlock,
    graph_uri: config.database.uri,
});

// Initialize infrastructure
const db = new MusicGraphDatabase(config.database);
const store = new EventStore(config.storage);

// EventProcessor in injection mode (receives pre-initialized db + store)
const eventProcessor = new EventProcessor({ db, store });

// IngestionHandler (dedup, signature verification, event dispatch)
const ingestionHandler = new IngestionHandler(store, eventProcessor, {
    rpcUrl: config.rpcUrl,
    enableBatching: false, // SHiP already streams sequentially
});

// Redis client for checkpoint persistence
let checkpointRedis = null;
try {
    checkpointRedis = new Redis({
        host: config.storage.redis.host,
        port: config.storage.redis.port,
        password: config.storage.redis.password,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
    });
    await checkpointRedis.connect();
    log.info('checkpoint_redis_connected');
} catch (err) {
    log.warn('checkpoint_redis_unavailable', { error: err.message });
    checkpointRedis = null;
}

// Create ChainSourceManager with checkpoint store injected
const manager = new ChainSourceManager(
    {
        ...config,
        checkpointStore: checkpointRedis,
    },
    ingestionHandler
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

manager.start().catch((error) => {
    log.error('chain_source_start_failed', { error: error.message, stack: error.stack });
    process.exit(1);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

const shutdown = async (signal) => {
    log.info('shutdown_signal', { signal });
    try {
        await manager.stop();
        if (ingestionHandler.flushBatch) {
            await ingestionHandler.flushBatch();
        }
        if (checkpointRedis) {
            await checkpointRedis.quit();
        }
        if (db.driver) {
            await db.driver.close();
        }
        process.exit(0);
    } catch (error) {
        log.error('shutdown_error', { signal, error: error.message });
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
    log.error('uncaught_exception', { error: error.message, stack: error.stack });
    shutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
    log.error('unhandled_rejection', { reason: String(reason) });
    shutdown('UNHANDLED_REJECTION');
});

// ---------------------------------------------------------------------------
// Stats monitoring (every 60s)
// ---------------------------------------------------------------------------

setInterval(() => {
    const stats = manager.getStats();
    if (stats.startTime) {
        log.info('chain_source_stats', {
            source: stats.sourceType,
            events_ingested: stats.eventsIngested,
            events_deduped: stats.eventsDeduped,
            errors: stats.errors,
            events_per_second: stats.eventsPerSecond,
            source_stats: stats.sourceStats,
        });
    }
}, 60000);

log.info('chain_source_worker_started');
