/**
 * Structured Pipeline Logger for Polaris Music Registry
 *
 * Provides consistent structured logging across the entire pipeline with:
 * - Correlation IDs (request_id) for end-to-end tracing
 * - Timing (duration_ms) at every boundary
 * - Standard fields: event_hash, event_type, event_cid, block_num, trx_id, source
 * - Log levels: debug, info, warn, error
 *
 * Every log entry is a JSON object written to stdout/stderr so it can be
 * consumed by any log aggregator (ELK, Datadog, CloudWatch, etc.).
 *
 * @module utils/logger
 */

import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';

/**
 * Log levels (numeric for filtering)
 */
const LEVELS = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL || 'info'] || LEVELS.info;

/**
 * Create a structured log entry and write it.
 *
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} component - Source component (e.g. 'api.server', 'storage.eventStore')
 * @param {string} message  - Human-readable message
 * @param {Object} [fields] - Structured key-value fields
 */
function emit(level, component, message, fields = {}) {
    if (LEVELS[level] < CURRENT_LEVEL) return;

    const entry = {
        ts: new Date().toISOString(),
        level,
        component,
        msg: message,
        ...fields,
    };

    // Remove undefined values to keep logs clean
    for (const k of Object.keys(entry)) {
        if (entry[k] === undefined) delete entry[k];
    }

    const line = JSON.stringify(entry);
    if (level === 'error') {
        process.stderr.write(line + '\n');
    } else {
        process.stdout.write(line + '\n');
    }
}

/**
 * Create a scoped logger that carries a fixed component name
 * and optional default fields (e.g. request_id).
 *
 * @param {string} component - Component name
 * @param {Object} [defaults] - Default fields merged into every log entry
 * @returns {Object} Logger with debug/info/warn/error methods + child/timer helpers
 */
export function createLogger(component, defaults = {}) {
    const logger = {
        debug(msg, fields) { emit('debug', component, msg, { ...defaults, ...fields }); },
        info(msg, fields) { emit('info', component, msg, { ...defaults, ...fields }); },
        warn(msg, fields) { emit('warn', component, msg, { ...defaults, ...fields }); },
        error(msg, fields) { emit('error', component, msg, { ...defaults, ...fields }); },

        /**
         * Create a child logger that inherits component + defaults
         * and adds additional default fields.
         */
        child(extraDefaults) {
            return createLogger(component, { ...defaults, ...extraDefaults });
        },

        /**
         * Start a timer. Returns an object with an `end(msg, fields)` method
         * that logs with `duration_ms` automatically.
         */
        startTimer() {
            const start = performance.now();
            return {
                end(msg, fields = {}) {
                    const duration_ms = Math.round(performance.now() - start);
                    logger.info(msg, { ...fields, duration_ms });
                    return duration_ms;
                },
                endWarn(msg, fields = {}) {
                    const duration_ms = Math.round(performance.now() - start);
                    logger.warn(msg, { ...fields, duration_ms });
                    return duration_ms;
                },
                endError(msg, fields = {}) {
                    const duration_ms = Math.round(performance.now() - start);
                    logger.error(msg, { ...fields, duration_ms });
                    return duration_ms;
                },
                elapsed() {
                    return Math.round(performance.now() - start);
                }
            };
        }
    };
    return logger;
}

/**
 * Generate a new request ID (UUID v4 without dashes for compactness).
 */
export function generateRequestId() {
    return randomUUID().replace(/-/g, '');
}

export default createLogger;
