/**
 * The off-chain projection of curation actions.
 *
 * Votes have only ever lived on chain — eventProcessor's handleVote was a no-op
 * carrying the comment "Vote data is stored on blockchain, not in graph", and
 * ingestion dropped every action that was not `put`, even though the substreams
 * sink has always delivered `vote` and `finalize` too.
 *
 * That is what made reclaim() unsafe to call. The contract's votes, votetally
 * and anchors rows cost roughly 461, 336 and 552 bytes, billed to voters and
 * authors, and nothing releases them while the curation UI is the only reader
 * of the only copy. These tests cover the projection that makes them
 * reclaimable.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { IngestionHandler } from '../../src/api/ingestion.js';

/** A graph stub recording what the projection was asked to write. */
function graphSpy() {
    return {
        recordVote: jest.fn(async () => ({ status: 'recorded' })),
        recordFinalization: jest.fn(async () => ({ status: 'finalized' })),
    };
}

const HASH = 'a'.repeat(64);

/**
 * @param {Object} graph - Graph stub, or null for "no projection available".
 * @returns {IngestionHandler}
 */
function handlerWith(graph) {
    const store = { retrieveEvent: jest.fn(), calculateHash: jest.fn() };
    return new IngestionHandler(store, { db: graph }, { enableBatching: false });
}

/**
 * @param {string} actionName
 * @param {Object} data - Action arguments.
 * @returns {Object} An anchored-event envelope as the sink posts it.
 */
function anchoredAction(actionName, data) {
    return {
        content_hash: HASH,
        payload: JSON.stringify(data),
        block_num: 100,
        block_id: 'b'.repeat(64),
        trx_id: 'c'.repeat(64),
        action_ordinal: 0,
        timestamp: '2026-01-01T00:00:00.000',
        action_name: actionName,
        contract_account: 'polarismusic',
    };
}

describe('vote and finalize traces are projected, not discarded', () => {
    let graph;
    beforeEach(() => { graph = graphSpy(); });

    test('a vote action reaches the graph', async () => {
        const handler = handlerWith(graph);

        const result = await handler.processAnchoredEvent(
            anchoredAction('vote', { voter: 'alice', tx_hash: HASH, val: 1 }));

        expect(result.status).toBe('processed');
        expect(graph.recordVote).toHaveBeenCalledWith(expect.objectContaining({
            eventHash: HASH, voter: 'alice', val: 1, blockNum: 100,
        }));
    });

    test('a finalize action marks the operation finalized', async () => {
        const handler = handlerWith(graph);

        const result = await handler.processAnchoredEvent(
            anchoredAction('finalize', { tx_hash: HASH }));

        expect(result.status).toBe('processed');
        expect(graph.recordFinalization).toHaveBeenCalledWith(
            expect.objectContaining({ eventHash: HASH, blockNum: 100 }));
    });

    test('the vote is keyed on the anchor it targets, not the trace hash', async () => {
        // A vote's content_hash is sha256 of its own action JSON, which is not
        // the anchor's hash. Projecting under that would scatter every vote
        // across unrelated operations.
        const handler = handlerWith(graph);
        const target = 'd'.repeat(64);

        await handler.processAnchoredEvent({
            ...anchoredAction('vote', { voter: 'bob', tx_hash: target, val: -1 }),
            content_hash: 'e'.repeat(64),
        });

        expect(graph.recordVote).toHaveBeenCalledWith(
            expect.objectContaining({ eventHash: target }));
    });

    test('chain time is used, not wall clock', async () => {
        // Replay has to reproduce the same graph, which is why the put path
        // prefers actionData.ts over Date.now().
        const handler = handlerWith(graph);

        await handler.processAnchoredEvent(
            anchoredAction('vote', { voter: 'alice', tx_hash: HASH, val: 1 }));

        expect(graph.recordVote.mock.calls[0][0].ts)
            .toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    });

    test('an action with no tx_hash is skipped rather than throwing', async () => {
        const handler = handlerWith(graph);

        const result = await handler.processAnchoredEvent(anchoredAction('vote', { voter: 'x' }));

        expect(result.status).toBe('skipped');
        expect(graph.recordVote).not.toHaveBeenCalled();
    });

    test('a graph without the projection skips instead of failing', async () => {
        // The chain rows are still authoritative until a reclaim job runs, so
        // this is a safe degradation rather than an error.
        const handler = handlerWith({});

        const result = await handler.processAnchoredEvent(
            anchoredAction('vote', { voter: 'alice', tx_hash: HASH, val: 1 }));

        expect(result.status).toBe('skipped');
    });

    test('a projection failure does not stall the events behind it', async () => {
        const failing = graphSpy();
        failing.recordVote.mockRejectedValue(new Error('neo4j unavailable'));
        const handler = handlerWith(failing);

        const result = await handler.processAnchoredEvent(
            anchoredAction('vote', { voter: 'alice', tx_hash: HASH, val: 1 }));

        // Reported, not thrown: one unwritable vote must not block submissions.
        expect(result.status).toBe('error');
        expect(result.message).toContain('neo4j unavailable');
    });

    test('genuinely unknown actions are still skipped', async () => {
        const handler = handlerWith(graph);

        const result = await handler.processAnchoredEvent(anchoredAction('stake', { account: 'x' }));

        expect(result.status).toBe('skipped');
        expect(graph.recordVote).not.toHaveBeenCalled();
        expect(graph.recordFinalization).not.toHaveBeenCalled();
    });
});

describe('blockTimeToMillis', () => {
    const handler = handlerWith(graphSpy());

    test.each([
        ['a naive chain timestamp is read as UTC', '2026-01-01T00:00:00.000',
            Date.parse('2026-01-01T00:00:00.000Z')],
        ['an explicit Z is not doubled', '2026-01-01T00:00:00.000Z',
            Date.parse('2026-01-01T00:00:00.000Z')],
        ['epoch seconds are scaled', 1767225600, 1767225600000],
        ['epoch millis pass through', 1767225600000, 1767225600000],
    ])('%s', (_label, input, expected) => {
        expect(handler.blockTimeToMillis({ timestamp: input })).toBe(expected);
    });

    test.each([
        ['nothing', {}],
        ['an unparseable string', { timestamp: 'not a date' }],
    ])('returns null for %s', (_label, meta) => {
        expect(handler.blockTimeToMillis(meta)).toBeNull();
    });
});
