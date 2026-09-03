/**
 * IPFS calls must be bounded.
 *
 * ipfs-http-client issues these with no deadline of its own, so a block the
 * local node does not already hold sends it into a bitswap/DHT search that may
 * never return. Ingestion is synchronous — the API runs the whole pipeline
 * before it answers — so one unbounded call hangs the HTTP request behind it.
 *
 * That is not hypothetical. A full historical replay found five anchored events
 * and posted none of them: every POST aborted at the sink's 10s client timeout,
 * retried four more times into the same wall, and nothing was ever indexed.
 * Redis only caches for 86400s, so every event older than a day takes this path.
 *
 * These assert the deadline is passed to the client, and that failing over to
 * S3 is still reachable — bounding the whole lookup instead of each call would
 * have cut off the layer that actually holds these bodies.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(here, '../../src/storage/eventStore.js'), 'utf8');

describe('every IPFS call carries a timeout', () => {
    // Source-level, because constructing an EventStore requires IPFS, S3 and
    // Redis clients; the property under test is simply that no call site was
    // missed.
    test.each([
        ['cat, in retrieveByEventCid', /client\.cat\([^)]*timeout: IPFS_CALL_TIMEOUT_MS/],
        ['block.get, the cat fallback', /client\.block\.get\(event_cid, \{ timeout: IPFS_CALL_TIMEOUT_MS \}\)/],
        ['block.get, in retrieveFromIPFS', /client\.block\.get\(cid, \{ timeout: IPFS_CALL_TIMEOUT_MS \}\)/],
    ])('%s', (_label, pattern) => {
        expect(SOURCE).toMatch(pattern);
    });

    test('no IPFS call is left unbounded', () => {
        // Catches a new call site added without a deadline, which is how the
        // first one got in.
        const calls = SOURCE.match(/client\.(cat|block\.get)\([^)]*\)/g) ?? [];
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
            expect(call).toContain('IPFS_CALL_TIMEOUT_MS');
        }
    });

    test('the deadline is overridable but never unset', () => {
        expect(SOURCE).toMatch(
            /const IPFS_CALL_TIMEOUT_MS = Number\(process\.env\.IPFS_CALL_TIMEOUT_MS\) \|\| \d+;/);
    });

    test('the default leaves room for two nodes inside the ingest budget', () => {
        // The sink allows 30s per POST. Two IPFS nodes tried in sequence must
        // not consume it before the graph writes get their turn.
        const [, value] = SOURCE.match(/const IPFS_CALL_TIMEOUT_MS = .*\|\| (\d+);/);
        expect(Number(value) * 2).toBeLessThan(15000);
    });
});

describe('bounding is per call, so S3 stays reachable', () => {
    test('retrieveEvent tries S3 after IPFS rather than giving up', () => {
        // The events that hung during the replay are held in S3. A timeout
        // around the whole lookup would have made IPFS slowness look like the
        // body being absent.
        const body = SOURCE.slice(SOURCE.indexOf('async retrieveEvent('));
        const ipfsAt = body.indexOf('this.ipfsEnabled');
        const s3At = body.indexOf('this.s3Enabled');

        expect(ipfsAt).toBeGreaterThan(-1);
        expect(s3At).toBeGreaterThan(ipfsAt);
    });
});
