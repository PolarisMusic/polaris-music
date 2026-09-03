/**
 * Timestamps handed to Neo4j must be Integers, not JS numbers.
 *
 * `datetime({epochMillis: $ts})` rejects a Double even when it holds a whole
 * number, and the driver sends any bare JS number as a Double. Every projection
 * write that carried a timestamp was therefore throwing:
 *
 *   operation_projection_failed
 *   "Cannot construct date time from: Double(1.787609e+12)"
 *
 * Silently, into a swallowed warn — so submissions never gained an author or a
 * type, the curation feed correctly filtered those identity-less rows out, and a
 * finalized release simply never appeared. Vote memos would have gone the same
 * way, unrecorded, from the moment they shipped.
 *
 * schema.js:38 has carried `toNeo4jEpochMillis` and a comment explaining exactly
 * this for far longer than the bug existed; the four projection methods each
 * rolled their own `ts ?? null` instead.
 *
 * These run without a database. The graph suites skip themselves when GRAPH_URI
 * is unset, which is why an error on every single call went unseen — so this
 * deliberately does not depend on one.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import neo4j from 'neo4j-driver';
import MusicGraphDatabase from '../../src/graph/schema.js';

/** Captures every query and parameter set sent to the driver. */
function stubbedGraph() {
    const calls = [];
    // The constructor builds a lazy driver, so no connection is attempted and
    // the real one can simply be replaced.
    const db = new MusicGraphDatabase({
        uri: 'bolt://127.0.0.1:7687', user: 'neo4j', password: 'unused'
    });

    const session = {
        run: jest.fn(async (query, params) => {
            calls.push({ query, params });
            return { records: [] };
        }),
        close: jest.fn(async () => {})
    };
    db.driver = { session: () => session, close: jest.fn(async () => {}) };

    return { db, calls };
}

/** The parameter set of the call that actually writes a timestamp. */
function tsCall(calls) {
    return calls.find(c => c.query.includes('epochMillis'));
}

const HASH = 'a'.repeat(64);
const MILLIS = 1787609000000;

describe('every projection write sends a Neo4j Integer timestamp', () => {
    let db, calls;
    beforeEach(() => { ({ db, calls } = stubbedGraph()); });

    test('recordOperation', async () => {
        await db.recordOperation({
            eventHash: HASH, author: 'polaristests', type: 21, ts: MILLIS, blockNum: 283275172
        });

        const { params } = tsCall(calls);
        expect(neo4j.isInt(params.ts)).toBe(true);
        expect(params.ts.toNumber()).toBe(MILLIS);
    });

    test('recordVote', async () => {
        // The one that would have silently dropped every curation comment.
        await db.recordVote({
            eventHash: HASH, voter: 'alice', val: 1, blockNum: 1, ts: MILLIS, memo: 'why'
        });

        expect(neo4j.isInt(tsCall(calls).params.ts)).toBe(true);
    });

    test('recordFinalization', async () => {
        await db.recordFinalization({ eventHash: HASH, blockNum: 1, ts: MILLIS });

        expect(neo4j.isInt(tsCall(calls).params.ts)).toBe(true);
    });

    test('recordLike', async () => {
        await db.recordLike({ account: 'alice', nodeId: HASH, path: [], blockNum: 1, ts: MILLIS });

        expect(neo4j.isInt(tsCall(calls).params.ts)).toBe(true);
    });
});

describe('an absent timestamp still produces an Integer', () => {
    // The old code branched to `datetime()` when ts was null. The helper falls
    // back to the current time instead, so the query needs no branch — but the
    // parameter must still be an Integer, or the null path breaks the same way.
    let db, calls;
    beforeEach(() => { ({ db, calls } = stubbedGraph()); });

    test.each([
        ['null', null],
        ['undefined', undefined],
    ])('recordOperation with %s', async (_label, ts) => {
        await db.recordOperation({ eventHash: HASH, author: 'alice', type: 21, ts });

        const { params } = tsCall(calls);
        expect(neo4j.isInt(params.ts)).toBe(true);
        expect(params.ts.toNumber()).toBeGreaterThan(0);
    });

    test('the query has no conditional left to get wrong', async () => {
        await db.recordOperation({ eventHash: HASH, author: 'alice', type: 21, ts: null });

        // A branch that picks `datetime()` for null is what made the Integer
        // requirement easy to miss on the other path.
        expect(tsCall(calls).query).not.toMatch(/datetime\(\)/);
    });
});

describe('other numeric parameters are Integers too', () => {
    // Same class of failure, different field: a Double block number would be
    // stored as a float and compared as one by the last-write-wins guard.
    let db, calls;
    beforeEach(() => { ({ db, calls } = stubbedGraph()); });

    test('recordOperation block number', async () => {
        await db.recordOperation({
            eventHash: HASH, author: 'alice', type: 21, ts: MILLIS, blockNum: 283275172
        });

        const { params } = tsCall(calls);
        expect(neo4j.isInt(params.blockNum)).toBe(true);
        expect(neo4j.isInt(params.type)).toBe(true);
    });
});
