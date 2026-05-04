/**
 * Tests for the safeRollback / safeClose helpers.
 *
 * These wrap Neo4j tx.rollback() and session.close() so that a failure
 * inside cleanup does not mask the original error that caused the
 * cleanup to run.
 */

import { safeRollback, safeClose } from '../../src/graph/safeTx.js';

function makeLog() {
    const calls = [];
    return {
        warn: (msg, fields) => calls.push({ level: 'warn', msg, fields }),
        calls,
    };
}

describe('safeRollback', () => {
    test('rolls back the transaction in the happy path', async () => {
        let called = 0;
        const tx = { rollback: async () => { called++; } };
        await safeRollback(tx);
        expect(called).toBe(1);
    });

    test('swallows rollback errors and logs at warn level', async () => {
        const log = makeLog();
        const tx = { rollback: async () => { throw new Error('boom'); } };
        await expect(safeRollback(tx, log)).resolves.toBeUndefined();
        expect(log.calls).toHaveLength(1);
        expect(log.calls[0].level).toBe('warn');
        expect(log.calls[0].msg).toBe('rollback_failed');
        expect(log.calls[0].fields.error).toBe('boom');
    });

    test('is a no-op for null/undefined tx', async () => {
        await expect(safeRollback(null)).resolves.toBeUndefined();
        await expect(safeRollback(undefined)).resolves.toBeUndefined();
    });

    test('does not require a logger', async () => {
        const tx = { rollback: async () => { throw new Error('boom'); } };
        await expect(safeRollback(tx)).resolves.toBeUndefined();
    });

    test('preserves original error: rethrowing the catch arg still works', async () => {
        // Models the actual call site in schema.js — the original error
        // must escape the catch even if rollback throws.
        const tx = { rollback: async () => { throw new Error('rollback boom'); } };
        const original = new Error('original cause');

        const work = async () => {
            try {
                throw original;
            } catch (err) {
                await safeRollback(tx);
                throw err;
            }
        };

        await expect(work()).rejects.toBe(original);
    });
});

describe('safeClose', () => {
    test('closes the session in the happy path', async () => {
        let called = 0;
        const session = { close: async () => { called++; } };
        await safeClose(session);
        expect(called).toBe(1);
    });

    test('swallows close errors and logs at warn level', async () => {
        const log = makeLog();
        const session = { close: async () => { throw new Error('net blip'); } };
        await expect(safeClose(session, log)).resolves.toBeUndefined();
        expect(log.calls).toHaveLength(1);
        expect(log.calls[0].msg).toBe('session_close_failed');
        expect(log.calls[0].fields.error).toBe('net blip');
    });

    test('is a no-op for null/undefined session', async () => {
        await expect(safeClose(null)).resolves.toBeUndefined();
        await expect(safeClose(undefined)).resolves.toBeUndefined();
    });
});
