/**
 * Curation must survive a reclaimed anchor.
 *
 * reclaim() erases the anchor, tally and vote rows once curation is settled —
 * that is its whole purpose, and those rows are ~552, ~336 and ~461 bytes each
 * billed to authors and voters. Before this, curate.js answered a missing
 * anchor with a hard 404, so running reclaim() would have made every settled
 * operation vanish from the UI.
 *
 * These cover the read path against the off-chain projection that replaces it.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { loadProjectedOperation } from '../../src/api/routes/curate.js';

const HASH = 'a'.repeat(64);

/**
 * A neo4j driver stub returning one Operation record.
 *
 * @param {Object|null} opProps - Operation node properties, or null for no match.
 * @param {Array} votes - Rows for the collected votes column.
 */
function driverWith(opProps, votes = []) {
    const records = opProps === null ? [] : [{
        get: (key) => (key === 'o' ? { properties: opProps } : votes),
    }];
    const session = { run: jest.fn(async () => ({ records })), close: jest.fn(async () => {}) };
    return { driver: { session: () => session }, _session: session };
}

describe('loadProjectedOperation', () => {
    test('returns the snapshotted tally for a reclaimed operation', async () => {
        // The tally is captured by the reclaim job immediately before it erases
        // the row, which is why these are exact rather than recomputed.
        const db = driverWith({
            event_hash: HASH, finalized: true,
            up_weight: 12, down_weight: 3, up_voter_count: 5, down_voter_count: 2,
        });

        const op = await loadProjectedOperation(db, HASH);

        expect(op.finalized).toBe(true);
        expect(op.tally).toMatchObject({
            up_weight: 12, down_weight: 3, up_voter_count: 5, down_voter_count: 2,
        });
    });

    test('returns the individual voters', async () => {
        const db = driverWith(
            { event_hash: HASH, finalized: true },
            [{ voter: 'alice', val: 1, ts: null }, { voter: 'bob', val: -1, ts: null }]
        );

        const op = await loadProjectedOperation(db, HASH);

        expect(op.votes.map(v => v.voter).sort()).toEqual(['alice', 'bob']);
        expect(op.votes.find(v => v.voter === 'bob').val).toBe(-1);
    });

    test('per-vote weight is null, not invented', async () => {
        // Respect-at-vote-time appears in no action trace, so it cannot be
        // projected. Reporting null is honest; reporting 0 or 1 would not be.
        const db = driverWith({ event_hash: HASH }, [{ voter: 'alice', val: 1, ts: null }]);

        const op = await loadProjectedOperation(db, HASH);

        expect(op.votes[0].weight).toBeNull();
    });

    test('an operation with no votes yields an empty list, not a null entry', async () => {
        // OPTIONAL MATCH collects a null when nothing matched; it must not
        // surface as a phantom voter.
        const db = driverWith({ event_hash: HASH, finalized: true }, [null]);

        const op = await loadProjectedOperation(db, HASH);

        expect(op.votes).toEqual([]);
    });

    test('a hash that was never projected returns null', async () => {
        // Distinct from "reclaimed": the caller should still 404 for this.
        expect(await loadProjectedOperation(driverWith(null), HASH)).toBeNull();
    });

    test('missing tally properties read as zero rather than NaN', async () => {
        const db = driverWith({ event_hash: HASH, finalized: true });

        const op = await loadProjectedOperation(db, HASH);

        expect(op.tally.up_weight).toBe(0);
        expect(Number.isNaN(op.tally.down_weight)).toBe(false);
    });

    test('the session is always closed', async () => {
        const db = driverWith({ event_hash: HASH });
        await loadProjectedOperation(db, HASH);
        expect(db._session.close).toHaveBeenCalled();
    });

    test.each([
        ['no graph', null],
        ['a graph with no driver', {}],
    ])('returns null for %s rather than throwing', async (_label, db) => {
        expect(await loadProjectedOperation(db, HASH)).toBeNull();
    });

    test('returns null for a missing hash', async () => {
        expect(await loadProjectedOperation(driverWith({}), null)).toBeNull();
    });
});
