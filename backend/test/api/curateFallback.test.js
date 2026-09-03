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
import { loadProjectedOperation, listProjectedOperations, mergeVotes } from '../../src/api/routes/curate.js';

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

/**
 * A neo4j driver stub returning many Operation records.
 *
 * @param {Array<Object>} ops - Operation node properties, in query order.
 */
function listDriverWith(ops) {
    const records = ops.map(props => ({ get: () => ({ properties: props }) }));
    const session = { run: jest.fn(async () => ({ records })), close: jest.fn(async () => {}) };
    return { driver: { session: () => session }, _session: session };
}

/** A neo4j temporal value, which carries toStandardDate rather than being a Date. */
function neoDateTime(iso) {
    return { toStandardDate: () => new Date(iso) };
}

describe('listProjectedOperations', () => {
    test('shapes a projected row the same way the chain rows are shaped', async () => {
        // The listing merges these into an array of chain rows, so anything
        // that differs in shape shows up in the feed as a broken entry.
        const db = listDriverWith([{
            event_hash: HASH, author: 'alice', type: 21, event_cid: 'bafy1',
            finalized: true, submitted_at: neoDateTime('2026-08-24T22:00:56.000Z'),
            up_weight: 7, down_weight: 2, up_voter_count: 3, down_voter_count: 1,
        }]);

        const [row] = await listProjectedOperations(db, 50);

        expect(row).toMatchObject({
            hash: HASH, author: 'alice', type: 21, event_cid: 'bafy1', finalized: true,
            tally: { up_weight: 7, down_weight: 2, up_voter_count: 3, down_voter_count: 1 },
        });
    });

    test('the timestamp is unix seconds, matching anchors.ts', async () => {
        // The renderer sees one timestamp shape rather than two. Returning a
        // neo4j DateTime, or an ISO string, would render as something else.
        const db = listDriverWith([{
            event_hash: HASH, author: 'alice', type: 21,
            submitted_at: neoDateTime('2026-08-24T22:00:56.000Z'),
        }]);

        const [row] = await listProjectedOperations(db, 50);

        expect(row.ts).toBe(1787608856);
    });

    test('a row projected only by a finalize trace falls back to its finalize time', async () => {
        const db = listDriverWith([{
            event_hash: HASH, author: 'alice', type: 21, finalized: true,
            finalized_at: neoDateTime('2026-08-24T22:00:56.000Z'),
        }]);

        expect((await listProjectedOperations(db, 50))[0].ts).toBe(1787608856);
    });

    test('a row with no timestamp at all is null, not a date at the epoch', async () => {
        const db = listDriverWith([{ event_hash: HASH, author: 'alice', type: 21 }]);

        expect((await listProjectedOperations(db, 50))[0].ts).toBeNull();
    });

    test('anchor_id is null rather than invented', async () => {
        // The chain row these came from may be erased. An id would let the UI
        // link to a table entry that no longer exists.
        const db = listDriverWith([{ event_hash: HASH, author: 'alice', type: 21 }]);

        expect((await listProjectedOperations(db, 50))[0].anchor_id).toBeNull();
    });

    test('rows are marked reclaimed so the UI can say why there is nothing to vote on', async () => {
        const db = listDriverWith([{ event_hash: HASH, author: 'alice', type: 21 }]);

        expect((await listProjectedOperations(db, 50))[0].reclaimed).toBe(true);
    });

    test('the query filters out identity-less nodes', async () => {
        // recordVote and recordFinalization both MERGE an :Operation, so a vote
        // on a hash this host never indexed leaves a node with an outcome and
        // no author. Listing those would put blank rows in the feed.
        const db = listDriverWith([]);

        await listProjectedOperations(db, 50);

        expect(db._session.run.mock.calls[0][0]).toMatch(/o\.author IS NOT NULL/);
    });

    test('a type filter is applied in the query, not after it', async () => {
        // Taking the newest `limit` rows of every type and filtering afterwards
        // would return almost nothing for a narrow type, while the chain half
        // of the same feed returned a full page of it.
        const db = listDriverWith([]);

        await listProjectedOperations(db, 50, 21);

        expect(db._session.run.mock.calls[0][0]).toMatch(/o\.type = toInteger\(\$type\)/);
        expect(db._session.run.mock.calls[0][1].type).toBe(21);
    });

    test('no type filter passes null, which the query treats as unfiltered', async () => {
        const db = listDriverWith([]);

        await listProjectedOperations(db, 50);

        expect(db._session.run.mock.calls[0][1].type).toBeNull();
        expect(db._session.run.mock.calls[0][0]).toMatch(/\$type IS NULL OR/);
    });

    test('an unparseable type is treated as no filter rather than matching nothing', async () => {
        const db = listDriverWith([]);

        await listProjectedOperations(db, 50, parseInt('banana'));

        expect(db._session.run.mock.calls[0][1].type).toBeNull();
    });

    test('the limit is passed as an integer expression', async () => {
        // A JS number arrives as a Float, and LIMIT rejects one.
        const db = listDriverWith([]);

        await listProjectedOperations(db, 25);

        expect(db._session.run.mock.calls[0][0]).toMatch(/LIMIT toInteger\(\$limit\)/);
        expect(db._session.run.mock.calls[0][1].limit).toBe(25);
    });

    test('the session is always closed', async () => {
        const db = listDriverWith([]);
        await listProjectedOperations(db, 50);
        expect(db._session.close).toHaveBeenCalled();
    });

    test.each([
        ['no graph', null],
        ['a graph with no driver', {}],
    ])('returns an empty list for %s rather than throwing', async (_label, db) => {
        expect(await listProjectedOperations(db, 50)).toEqual([]);
    });
});

describe('mergeVotes', () => {
    // Neither source is complete. The chain holds `weight` —
    // respect-at-vote-time, which no action trace carries. The projection holds
    // `memo` — the curator's reason, which the contract validates and never
    // stores, so votes cost no extra RAM. Picking one wholesale loses half the
    // record, and loses it silently.

    test('a chain vote keeps its weight and gains its memo', () => {
        const [vote] = mergeVotes(
            [{ voter: 'alice', val: -1, weight: 12, ts: '2026-05-05T00:00:00' }],
            [{ voter: 'alice', val: -1, weight: null, ts: null, memo: 'track 7 credits the wrong Lennon' }]
        );

        expect(vote).toMatchObject({
            voter: 'alice', val: -1, weight: 12,
            memo: 'track 7 credits the wrong Lennon',
        });
    });

    test('the memo survives while the anchor still exists', () => {
        // The regression this exists for: the route used to take chain rows
        // wholesale whenever any existed, which is the entire period during
        // which anyone is curating.
        const merged = mergeVotes(
            [{ voter: 'bob', val: 1, weight: 3 }],
            [{ voter: 'bob', val: 1, memo: 'verified against the liner notes' }]
        );

        expect(merged[0].memo).toBe('verified against the liner notes');
    });

    test('a chain vote with no projected counterpart has a null memo', () => {
        // Not undefined: the field should be present and empty, so the UI can
        // distinguish "no comment given" from "field missing".
        const [vote] = mergeVotes([{ voter: 'carol', val: 1, weight: 5 }], []);
        expect(vote.memo).toBeNull();
        expect('memo' in vote).toBe(true);
    });

    test('a chain vote with no weight reports null rather than undefined', () => {
        const [vote] = mergeVotes([{ voter: 'dave', val: 1 }], []);
        expect(vote.weight).toBeNull();
    });

    test('projected votes with no chain row are still included', () => {
        // What reclaim() leaves behind: the vote rows are erased on chain and
        // the projection is all that remains.
        const merged = mergeVotes([], [
            { voter: 'erin', val: 1, memo: 'looks right' },
            { voter: 'frank', val: -1, memo: null },
        ]);

        expect(merged.map(v => v.voter).sort()).toEqual(['erin', 'frank']);
        expect(merged.find(v => v.voter === 'erin').memo).toBe('looks right');
    });

    test('a voter present in both sources appears once', () => {
        const merged = mergeVotes(
            [{ voter: 'alice', val: 1, weight: 2 }],
            [{ voter: 'alice', val: 1, memo: 'ok' }]
        );
        expect(merged).toHaveLength(1);
    });

    test('the chain wins on disagreement about the vote itself', () => {
        // While the rows exist they are authoritative about who voted and how;
        // the projection can lag by a block.
        const [vote] = mergeVotes(
            [{ voter: 'alice', val: 1, weight: 2 }],
            [{ voter: 'alice', val: -1, memo: 'changed my mind' }]
        );
        expect(vote.val).toBe(1);
        expect(vote.memo).toBe('changed my mind');
    });

    test.each([
        ['both empty', [], []],
        ['no arguments at all', undefined, undefined],
    ])('%s yields an empty list', (_label, chain, projected) => {
        expect(mergeVotes(chain, projected)).toEqual([]);
    });
});
