/**
 * Safe wrappers for Neo4j transaction cleanup.
 *
 * The pattern these replace:
 *
 *     try {
 *         // ... tx.run(...)
 *     } catch (error) {
 *         await tx.rollback();        // <-- if this throws, original error is lost
 *         throw error;
 *     } finally {
 *         await session.close();      // <-- if this throws inside finally, masks any error
 *     }
 *
 * Both rollback() and close() can fail (network blip, driver state, etc).
 * If they do, we want to preserve the *original* error that prompted the
 * cleanup — that's the one with diagnostic value. The cleanup failure is
 * still worth logging at warn level, but never worth throwing.
 *
 * @module graph/safeTx
 */

/**
 * Roll a transaction back, swallowing any error from rollback itself.
 * Logs cleanup failures at warn level.
 *
 * @param {import('neo4j-driver').Transaction|null|undefined} tx
 * @param {Object} [log] - Optional logger with .warn(msg, fields)
 * @returns {Promise<void>}
 */
export async function safeRollback(tx, log) {
    if (!tx) return;
    try {
        await tx.rollback();
    } catch (rollbackError) {
        if (log && typeof log.warn === 'function') {
            log.warn('rollback_failed', {
                error: rollbackError.message,
                error_class: rollbackError.constructor.name,
            });
        }
    }
}

/**
 * Close a session, swallowing any error from close itself.
 * Logs cleanup failures at warn level.
 *
 * @param {import('neo4j-driver').Session|null|undefined} session
 * @param {Object} [log] - Optional logger with .warn(msg, fields)
 * @returns {Promise<void>}
 */
export async function safeClose(session, log) {
    if (!session) return;
    try {
        await session.close();
    } catch (closeError) {
        if (log && typeof log.warn === 'function') {
            log.warn('session_close_failed', {
                error: closeError.message,
                error_class: closeError.constructor.name,
            });
        }
    }
}
