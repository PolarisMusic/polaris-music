/**
 * Error sanitization for HTTP 5xx responses.
 *
 * Internal server errors should not leak stack traces, file paths, third-
 * party library messages, or any other implementation detail to the
 * caller. We replace the body with a generic message + correlation id,
 * and log the full error server-side under that same id so operators
 * can still match a user-reported failure to a stack trace.
 *
 * In development we DO include `detail` and `stack` in the response
 * so the developer can see what broke without tailing the log.
 *
 * Stage A audit (docs/canonicalization-divergence.md) confirmed that
 * no client (frontend, tools/import) parses the error string content —
 * every consumer either logs or displays it — so changing the wording
 * is safe.
 *
 * @module utils/errorSanitizer
 */

/**
 * Build a sanitized 5xx response body.
 *
 * @param {Error|string|*} err - The error that was caught.
 * @param {string} [requestId] - Correlation id (req.requestId) for tracing.
 * @param {Object} [opts]
 * @param {string} [opts.env] - Environment name. When 'development', the
 *     response also carries `detail` and `stack` for local debugging.
 *     Defaults to process.env.NODE_ENV.
 * @param {string} [opts.message] - Override the user-facing message.
 *     Defaults to 'Internal server error'.
 * @param {boolean} [opts.success] - Include `success: false` in the body
 *     to match endpoints that already use that envelope shape.
 * @returns {Object} Body to pass to res.json().
 */
export function sanitizeError(err, requestId, opts = {}) {
    const env = opts.env || process.env.NODE_ENV;
    const message = opts.message || 'Internal server error';

    const body = { error: message };

    if (opts.success === false) {
        body.success = false;
    }

    if (requestId) {
        body.errorId = requestId;
    }

    if (env === 'development') {
        // Include diagnostic detail only in dev. Coerce non-Error inputs
        // (strings, numbers, undefined) to a stable shape.
        if (err && typeof err === 'object') {
            if (typeof err.message === 'string') body.detail = err.message;
            if (typeof err.stack === 'string') body.stack = err.stack;
        } else if (err !== undefined && err !== null) {
            body.detail = String(err);
        }
    }

    return body;
}
