/**
 * Middleware factories for the Polaris API.
 *
 * Extracted from `api/server.js` (Stage I). Each helper returns either
 * an Express middleware function or installs a stack of middleware on
 * a given app. Keeping these as pure factories makes the bootstrap path
 * in server.js trivial to read and test in isolation.
 *
 * @module api/middleware
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { graphqlHTTP } from 'express-graphql';
import { timingSafeEqual } from 'crypto';
import { createLogger, generateRequestId } from '../../utils/logger.js';
import { sanitizeError } from '../../utils/errorSanitizer.js';

/**
 * Install helmet, cors, JSON body parser, and the request-id / structured
 * logging middleware on the given Express app.
 *
 * @param {express.Express} app
 * @param {Object} config - server config (corsOrigin used)
 */
export function installBaseMiddleware(app, config) {
    // Helmet - Security headers (XSS, CSP, etc.)
    // Configure for compatibility with GraphiQL in development
    app.use(helmet({
        contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
        crossOriginEmbedderPolicy: false
    }));
    console.log(' Helmet security headers enabled');

    // CORS - Enable cross-origin requests from frontend
    // Supports comma-separated list of origins for multiple dev environments
    // Example: CORS_ORIGIN=http://localhost:5173,http://localhost:4173
    const corsOriginEnv = config.corsOrigin || process.env.CORS_ORIGIN || 'http://localhost:5173';
    const origins = corsOriginEnv
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    // Pass single string or array to cors() depending on count
    const corsOrigin = origins.length === 1 ? origins[0] : origins;

    app.use(cors({
        origin: corsOrigin,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'X-API-Key'],
        credentials: false
    }));
    console.log(` CORS enabled for origin(s): ${origins.join(', ')}`);

    // Parse JSON bodies
    app.use(express.json({ limit: '10mb' }));

    // Structured request logging with correlation ID
    app.use((req, res, next) => {
        const requestId = req.headers['x-request-id'] || generateRequestId();
        req.requestId = requestId;
        res.setHeader('X-Request-Id', requestId);

        const log = createLogger('api.server', { request_id: requestId });
        const timer = log.startTimer();

        log.info('request_start', {
            method: req.method,
            path: req.path,
            remote_ip: req.ip,
            user_agent: req.get('user-agent')
        });

        const originalEnd = res.end;
        res.end = function(...args) {
            timer.end('request_end', {
                method: req.method,
                path: req.path,
                status: res.statusCode
            });
            originalEnd.apply(res, args);
        };

        next();
    });
}

/**
 * Build a coarse, IP-based write rate limiter.
 *
 * Prevents storage cost blow-up and graph pollution from spammy clients.
 *
 * @returns {express.RequestHandler}
 */
export function buildWriteRateLimiter() {
    return rateLimit({
        windowMs: 60 * 1000, // 1-minute window
        max: 30,             // 30 write requests per minute per IP
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many write requests, please try again later' }
    });
}

/**
 * Build the API-key middleware used for ingestion-only endpoints.
 *
 * Applied to: /api/ingest/anchored-event
 * NOT applied to: /api/events/prepare, /api/events/create (public, signature-verified)
 *
 * When INGEST_API_KEY is set, protected endpoints require X-API-Key header.
 * When unset (local dev), protected endpoints are open.
 *
 * @returns {express.RequestHandler}
 */
export function buildRequireApiKey() {
    return (req, res, next) => {
        const requiredKey = process.env.INGEST_API_KEY;
        if (!requiredKey) {
            // In chain mode / production, missing key is a server misconfiguration
            const ingestMode = process.env.INGEST_MODE || 'chain';
            if (ingestMode === 'chain' || process.env.NODE_ENV === 'production') {
                return res.status(500).json({
                    error: 'Server misconfigured: INGEST_API_KEY is required in chain/production mode'
                });
            }
            return next(); // No key configured — open access (dev mode only)
        }
        const provided = req.headers['x-api-key'];
        if (!provided) {
            return res.status(401).json({ error: 'Missing X-API-Key header' });
        }
        // Constant-time comparison to prevent timing attacks
        if (provided.length !== requiredKey.length ||
            !timingSafeEqual(
                Buffer.from(provided),
                Buffer.from(requiredKey)
            )) {
            return res.status(403).json({ error: 'Invalid API key' });
        }
        next();
    };
}

/**
 * Install the GraphQL endpoint at /graphql with structured logging.
 *
 * @param {express.Express} app
 * @param {Object} schema   - graphql schema (built via buildSchema)
 * @param {Object} rootValue - resolver map
 */
export function installGraphQL(app, schema, rootValue) {
    app.use('/graphql', (req, res, next) => {
        const gqlLog = createLogger('api.graphql', { request_id: req.requestId });
        const timer = gqlLog.startTimer();

        const originalEnd = res._origEnd || res.end;
        res.end = function(...args) {
            const operationName = req.body?.operationName || undefined;
            timer.end('graphql_request', {
                operation_name: operationName,
                status: res.statusCode
            });
            originalEnd.apply(res, args);
        };

        graphqlHTTP({
            schema,
            rootValue,
            graphiql: process.env.NODE_ENV !== 'production',
            customFormatErrorFn: (error) => {
                gqlLog.error('graphql_error', {
                    message: error.message,
                    path: error.path
                });
                return {
                    message: error.message,
                    locations: error.locations,
                    path: error.path
                };
            }
        })(req, res, next);
    });

    console.log(' GraphQL endpoint configured at /graphql');
}

/**
 * Install the 404 + global error handlers. Must be the *last* middleware
 * registered on the app.
 *
 * @param {express.Express} app
 */
export function installErrorHandling(app) {
    // 404 handler
    app.use((req, res) => {
        res.status(404).json({
            success: false,
            error: 'Endpoint not found',
            path: req.path
        });
    });

    // Global error handler
    app.use((err, req, res, next) => {
        console.error('Unhandled error:', err);

        const status = err.status || 500;
        if (status >= 500) {
            // Server errors: sanitize so we don't leak internals to clients
            // even in prod. sanitizeError adds dev-only detail/stack.
            return res.status(status).json(sanitizeError(err, req.requestId, { success: false }));
        }

        // Client errors (4xx): err.message is user-facing by design.
        res.status(status).json({
            success: false,
            error: err.message || 'Bad request'
        });
    });
}
