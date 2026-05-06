/**
 * @fileoverview Main API server for Polaris Music Registry.
 *
 * Bootstraps the Express app and wires together:
 *   - Domain services (graph database, event store, indexer/ingestion,
 *     player, chain reader)
 *   - Middleware (security headers, CORS, JSON, request logging,
 *     write rate limiter, ingestion API-key)
 *   - GraphQL endpoint at /graphql
 *   - REST endpoints under /health, /api/...
 *
 * The route handlers and resolvers themselves live in sibling modules
 * (see ./schema, ./resolvers, ./middleware, ./routes/*) — this file is
 * intentionally thin so adding a new endpoint never requires editing a
 * 3000-line file again.
 *
 * @module api/server
 */

import express from 'express';
import MusicGraphDatabase from '../graph/schema.js';
import EventStore from '../storage/eventStore.js';
import EventProcessor from '../indexer/eventProcessor.js';
import { IngestionHandler } from './ingestion.js';
import { PlayerService } from './playerService.js';
import { ChainReaderService } from './chainReaderService.js';
import { getDevSigner } from '../crypto/devSigner.js';

import { schema } from './schema/sdl.js';
import { createResolvers } from './resolvers/index.js';
import {
    installBaseMiddleware,
    buildWriteRateLimiter,
    buildRequireApiKey,
    installGraphQL,
    installErrorHandling,
} from './middleware/index.js';

import { createIdentityRoutes } from './routes/identity.js';
import { createHealthRoutes } from './routes/health.js';
import { createEventsRoutes } from './routes/events.js';
import { createIngestRoutes } from './routes/ingest.js';
import { createCryptoRoutes } from './routes/crypto.js';
import { createEntityRoutes } from './routes/entities.js';
import { createSearchRoutes } from './routes/search.js';
import { createCurateRoutes } from './routes/curate.js';
import { createPlayerRoutes } from './routes/player.js';
import { createGraphRoutes } from './routes/graph.js';

/**
 * API Server class that manages an Express app with GraphQL and REST endpoints.
 */
class APIServer {
    /**
     * @param {Object} config
     * @param {number} [config.port=3000]
     * @param {Object} config.database - Graph database config
     * @param {Object} config.storage  - Event storage config
     * @param {string} [config.corsOrigin]
     * @param {string} [config.rpcUrl]
     * @param {string} [config.contractAccount]
     * @param {string} [config.env]
     */
    constructor(config) {
        this.config = config;
        this.app = express();
        this.port = config.port || 3000;

        // Domain services
        this.db = new MusicGraphDatabase(config.database);
        this.store = new EventStore(config.storage);
        this.eventProcessor = new EventProcessor({
            db: this.db,
            store: this.store
        });
        this.ingestionHandler = new IngestionHandler(this.store, this.eventProcessor, {
            rpcUrl: process.env.RPC_URL || config.rpcUrl
        });
        this.playerService = new PlayerService(this.db.driver);
        this.chainReader = new ChainReaderService({
            rpcUrl: process.env.RPC_URL || config.rpcUrl,
            contractAccount: process.env.CONTRACT_ACCOUNT || config.contractAccount || 'polarismusic'
        });

        // Wire middleware, GraphQL, and routes synchronously so that
        // `new APIServer(...)` is enough to make `this.app` testable
        // without awaiting start().
        this._setup();
    }

    _setup() {
        // 1. Base middleware (helmet, cors, json, request-id logger)
        installBaseMiddleware(this.app, this.config);

        // 2. Shared per-request guards used by multiple routers
        this.writeRateLimiter = buildWriteRateLimiter();
        this.requireApiKey = buildRequireApiKey();

        // 3. GraphQL endpoint
        const rootValue = createResolvers({ db: this.db, store: this.store });
        installGraphQL(this.app, schema, rootValue);

        // 4. REST endpoints
        this._installRESTRoutes();

        // 5. 404 + global error handlers (must be last)
        installErrorHandling(this.app);
    }

    _installRESTRoutes() {
        const ctx = {
            db: this.db,
            store: this.store,
            ingestionHandler: this.ingestionHandler,
            playerService: this.playerService,
            config: this.config,
            writeRateLimiter: this.writeRateLimiter,
            requireApiKey: this.requireApiKey,
        };

        // Identity management
        this.app.use(
            '/api/identity',
            createIdentityRoutes(this.db, this.store, this.eventProcessor)
        );
        console.log(' Identity management endpoints mounted at /api/identity');

        // Health, status, stats — three separate paths sharing a factory
        const { healthRouter, statusRouter, statsRouter } = createHealthRoutes(ctx);
        this.app.use('/health', healthRouter);
        this.app.use('/api/status', statusRouter);
        this.app.use('/api/stats', statsRouter);

        // Event preparation, creation, retrieval, dev-signing helpers
        this.app.use('/api/events', createEventsRoutes(ctx));

        // Crypto helpers (resolve signing key)
        this.app.use('/api/crypto', createCryptoRoutes(ctx));

        // Chain reader (likes, vote tallies). Registers its own routes on app.
        this.chainReader.registerRoutes(this.app);

        // Chain ingestion endpoint
        this.app.use('/api/ingest', createIngestRoutes(ctx));

        // Entity-detail endpoints (group, person, track, release, song, label).
        // Each route inside the router carries its own /<entity>/:id prefix,
        // so we mount the router at /api.
        this.app.use('/api', createEntityRoutes(ctx));

        // Node search
        this.app.use('/api/search', createSearchRoutes(ctx));

        // Curation
        this.app.use('/api/curate', createCurateRoutes(ctx));

        // Player queue
        this.app.use('/api/player', createPlayerRoutes(ctx));

        // Graph data (initial + neighborhood)
        this.app.use('/api/graph', createGraphRoutes(ctx));

        console.log(' REST endpoints configured');
    }

    /**
     * Start the server.
     *
     * @returns {Promise<void>}
     */
    async start() {
        // Test database connection
        const dbConnected = await this.db.testConnection();
        if (!dbConnected) {
            console.error(' Failed to connect to database');
            throw new Error('Database connection failed');
        }
        console.log(' Database connected');

        // Initialize database schema (constraints, indexes).
        // Controlled by GRAPH_INIT_SCHEMA env var (default: true).
        const shouldInitSchema = process.env.GRAPH_INIT_SCHEMA !== 'false';
        if (shouldInitSchema) {
            try {
                await this.db.initializeSchema();
                console.log(' Database schema initialized');
            } catch (error) {
                console.error(' Schema initialization failed:', error.message);
                // Don't throw - allow server to start even if schema init fails.
                // Queries will still work, just without constraints.
                console.warn('  Continuing without schema initialization');
            }
        } else {
            console.log(' Schema initialization skipped (GRAPH_INIT_SCHEMA=false)');
        }

        // Run pending migrations (optional, controlled by env var)
        const shouldRunMigrations = process.env.GRAPH_RUN_MIGRATIONS === 'true';
        if (shouldRunMigrations) {
            try {
                const { runPendingMigrations } = await import('../graph/migrationRunner.js');
                await runPendingMigrations(this.db.driver);
                console.log(' Migrations completed');
            } catch (error) {
                console.error(' Migration failed:', error.message);
                console.warn('  Continuing despite migration failure');
            }
        }

        // Backfill deterministic Person colors (idempotent, safe to run every boot)
        try {
            const updated = await this.db.backfillPersonColors();
            if (updated > 0) {
                console.log(` Backfilled ${updated} person colors`);
            }
        } catch (error) {
            console.warn('  Person color backfill failed:', error.message);
        }

        // Fail fast: if account auth is required but RPC is not configured,
        // the server cannot verify signing keys and should not start.
        const requireAuth = process.env.REQUIRE_ACCOUNT_AUTH !== 'false';
        const rpcUrl = process.env.RPC_URL || this.config.rpcUrl;
        if (requireAuth && !rpcUrl) {
            throw new Error(
                'REQUIRE_ACCOUNT_AUTH is enabled but RPC_URL is not configured. ' +
                'Set RPC_URL to a blockchain RPC endpoint, or set REQUIRE_ACCOUNT_AUTH=false for development.'
            );
        }
        if (!rpcUrl) {
            console.warn('Warning: RPC_URL not configured - account auth and signing-key resolution disabled');
        }

        // Fail fast: if in chain mode / production and INGEST_API_KEY is not set,
        // the ingestion endpoint would be unprotected — refuse to start.
        const ingestMode = process.env.INGEST_MODE || 'chain';
        const hasIngestKey = !!process.env.INGEST_API_KEY;
        if (!hasIngestKey && (ingestMode === 'chain' || process.env.NODE_ENV === 'production')) {
            throw new Error(
                'INGEST_API_KEY is required in chain/production mode to protect ingestion endpoints. ' +
                'Set INGEST_API_KEY to a strong random value (e.g., openssl rand -hex 32), ' +
                'or set INGEST_MODE=dev for local development.'
            );
        }

        // Fail fast: block ALLOW_UNSIGNED_EVENTS=true in production
        if (process.env.ALLOW_UNSIGNED_EVENTS === 'true' && process.env.NODE_ENV === 'production') {
            throw new Error(
                'ALLOW_UNSIGNED_EVENTS=true is forbidden in production. ' +
                'This bypasses cryptographic signature verification and undermines event integrity. ' +
                'Remove ALLOW_UNSIGNED_EVENTS or set NODE_ENV to a non-production value.'
            );
        }

        // Test storage connectivity
        const storageStatus = await this.store.testConnectivity();
        console.log(' Storage status:', storageStatus);

        // Start listening
        return new Promise((resolve) => {
            this.server = this.app.listen(this.port, () => {
                console.log(`\n== Polaris Music Registry API Server`);
                console.log(`   GraphQL: http://localhost:${this.port}/graphql`);
                console.log(`   REST:    http://localhost:${this.port}/api`);
                console.log(`   Health:  http://localhost:${this.port}/health`);

                // Log DevSigner status for development visibility
                const devSigner = getDevSigner();
                const devSignerEnabled = devSigner?.isEnabled?.() || false;
                const hasDevKey = !!process.env.DEV_SIGNER_PRIVATE_KEY;
                const nodeEnv = process.env.NODE_ENV || 'development';
                console.log(`\n   DevSigner: ${devSignerEnabled ? '✓ enabled' : '✗ disabled'}`);
                console.log(`     NODE_ENV: ${nodeEnv}`);
                console.log(`     DEV_SIGNER_PRIVATE_KEY: ${hasDevKey ? 'set' : 'not set'}`);

                console.log(`\n Server ready\n`);
                resolve();
            });
        });
    }

    /**
     * Stop the server and cleanup.
     *
     * @returns {Promise<void>}
     */
    async stop() {
        console.log('\nShutting down server...');

        // Close database connections
        await this.db.close();

        // Close storage connections
        await this.store.close();

        // Close HTTP server
        if (this.server) {
            await new Promise((resolve) => {
                this.server.close(resolve);
            });
        }

        console.log(' Server stopped');
    }
}

export default APIServer;
