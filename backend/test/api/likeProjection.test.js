/**
 * Likes, projected from action traces instead of a contract table.
 *
 * The contract's likes table was read by nothing except like() and unlike()
 * checking whether they had already written — ~410 bytes per like, up to 640 of
 * it the discovery path, which the contract itself described as data to
 * understand how users navigate. That is analytics, and it is all in the trace.
 *
 * Removing the table means the toggle has to be reconstructed, and the rule is
 * the thing worth pinning: a repeat by the SAME path is a second button press
 * and unlikes, while a repeat by a DIFFERENT path is arriving somewhere a second
 * way and leaves it liked.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { IngestionHandler } from '../../src/api/ingestion.js';

function graphSpy() {
    return {
        recordLike: jest.fn(async () => ({ status: 'liked' })),
        recordUnlike: jest.fn(async () => ({ status: 'unliked' })),
    };
}

function handlerWith(graph) {
    return new IngestionHandler(
        { retrieveEvent: jest.fn(), calculateHash: jest.fn() },
        { db: graph },
        { enableBatching: false }
    );
}

const NODE = 'n'.repeat(64);

function anchoredAction(actionName, data) {
    return {
        content_hash: 'a'.repeat(64),
        payload: JSON.stringify(data),
        block_num: 500,
        block_id: 'b'.repeat(64),
        trx_id: 'c'.repeat(64),
        action_ordinal: 0,
        timestamp: '2026-01-01T00:00:00.000',
        action_name: actionName,
        contract_account: 'polarismusic',
    };
}

describe('like and unlike traces reach the graph', () => {
    test('a like is projected with its discovery path', async () => {
        const graph = graphSpy();

        const result = await handlerWith(graph).processAnchoredEvent(
            anchoredAction('like', { account: 'alice', node_id: NODE, node_path: ['x', NODE] }));

        expect(result.status).toBe('processed');
        expect(graph.recordLike).toHaveBeenCalledWith(expect.objectContaining({
            account: 'alice', nodeId: NODE, path: ['x', NODE], blockNum: 500,
        }));
    });

    test('an unlike is projected', async () => {
        const graph = graphSpy();

        await handlerWith(graph).processAnchoredEvent(
            anchoredAction('unlike', { account: 'alice', node_id: NODE }));

        expect(graph.recordUnlike).toHaveBeenCalledWith(
            expect.objectContaining({ account: 'alice', nodeId: NODE }));
        expect(graph.recordLike).not.toHaveBeenCalled();
    });

    test('a missing path is an empty list, not undefined', async () => {
        // recordLike compares paths to decide the toggle; undefined would make
        // that comparison meaningless.
        const graph = graphSpy();

        await handlerWith(graph).processAnchoredEvent(
            anchoredAction('like', { account: 'alice', node_id: NODE }));

        expect(graph.recordLike.mock.calls[0][0].path).toEqual([]);
    });

    test('chain time is used, not wall clock', async () => {
        const graph = graphSpy();

        await handlerWith(graph).processAnchoredEvent(
            anchoredAction('like', { account: 'alice', node_id: NODE, node_path: [NODE] }));

        expect(graph.recordLike.mock.calls[0][0].ts)
            .toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    });

    test('an action missing its account or node is skipped, not thrown', async () => {
        const graph = graphSpy();
        const handler = handlerWith(graph);

        for (const data of [{ node_id: NODE }, { account: 'alice' }]) {
            const result = await handler.processAnchoredEvent(anchoredAction('like', data));
            expect(result.status).toBe('skipped');
        }
        expect(graph.recordLike).not.toHaveBeenCalled();
    });

    test('a graph without the projection skips rather than failing', async () => {
        const result = await handlerWith({}).processAnchoredEvent(
            anchoredAction('like', { account: 'alice', node_id: NODE }));

        expect(result.status).toBe('skipped');
    });

    test('a projection failure does not stall the events behind it', async () => {
        const graph = graphSpy();
        graph.recordLike.mockRejectedValue(new Error('neo4j unavailable'));

        const result = await handlerWith(graph).processAnchoredEvent(
            anchoredAction('like', { account: 'alice', node_id: NODE }));

        expect(result.status).toBe('error');
    });
});
