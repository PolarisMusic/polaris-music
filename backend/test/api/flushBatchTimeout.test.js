/**
 * Tests for IngestionHandler.flushBatch() timeout behaviour.
 *
 * Before Stage B, flushBatch() polled `this.batchProcessing` in an
 * unbounded `while` loop, which would hang shutdown forever if a batch
 * got stuck. flushBatch() is now bounded by `timeoutMs` (default 30s)
 * and throws on expiry. The shutdown handler in runChainSource.js
 * already catches this and exits non-zero.
 */

import { IngestionHandler } from '../../src/api/ingestion.js';

function makeHandler() {
    // The handler doesn't touch eventStore / eventProcessor in flushBatch
    // when batchQueue is empty, so we can pass minimal stubs.
    const eventStore = {};
    const eventProcessor = {};
    return new IngestionHandler(eventStore, eventProcessor, {});
}

describe('flushBatch timeout', () => {
    test('returns promptly when batchProcessing is false (no work)', async () => {
        const h = makeHandler();
        h.batchProcessing = false;
        const start = Date.now();
        await h.flushBatch();
        expect(Date.now() - start).toBeLessThan(500);
    });

    test('throws when batchProcessing stays true past timeoutMs', async () => {
        const h = makeHandler();
        // Stub processBatch to a no-op so it doesn't try to process the
        // (empty) queue or touch a real Neo4j session.
        h.processBatch = async () => {};
        // Simulate an in-flight batch that never completes.
        h.batchProcessing = true;

        const start = Date.now();
        await expect(h.flushBatch({ timeoutMs: 250 })).rejects.toThrow(
            /flushBatch timed out after 250ms/
        );
        const elapsed = Date.now() - start;
        // Should fire within a poll-interval (~100ms) of the bound,
        // not run forever. Allow generous slack for CI jitter.
        expect(elapsed).toBeGreaterThanOrEqual(200);
        expect(elapsed).toBeLessThan(2000);
    });

    test('returns once batchProcessing clears mid-wait', async () => {
        const h = makeHandler();
        h.processBatch = async () => {};
        h.batchProcessing = true;

        // Clear the flag well before the timeout so the wait loop exits cleanly.
        setTimeout(() => { h.batchProcessing = false; }, 150);

        const start = Date.now();
        await h.flushBatch({ timeoutMs: 5000 });
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(100);
        expect(elapsed).toBeLessThan(2000);
    });

    test('timeoutMs: 0 disables the bound (legacy behaviour)', async () => {
        const h = makeHandler();
        h.processBatch = async () => {};
        h.batchProcessing = true;

        // Schedule a clear so the test does eventually finish.
        setTimeout(() => { h.batchProcessing = false; }, 200);

        await expect(h.flushBatch({ timeoutMs: 0 })).resolves.toBeUndefined();
    });

    test('clears the batchTimer before waiting', async () => {
        const h = makeHandler();
        h.processBatch = async () => {};
        h.batchTimer = setTimeout(() => {}, 60_000);
        const before = h.batchTimer;
        await h.flushBatch();
        expect(h.batchTimer).toBeNull();
        // Original handle should no longer be referenced; nothing to assert
        // beyond the nulled field, since clearTimeout doesn't mark the handle.
        expect(before).not.toBeNull();
    });
});
