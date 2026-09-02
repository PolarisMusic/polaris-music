/**
 * Projecting submissions so the curation feed survives reclamation.
 *
 * The feed read the chain's `anchors` table and nothing else, so an operation
 * whose anchor had been reclaimed vanished from it — while fetching the same
 * hash by URL still worked, because the detail route already consulted the
 * off-chain projection. The projection existed; nothing wrote the half of it a
 * listing needs.
 *
 * recordVote() and recordFinalization() both MERGE an :Operation, but they set
 * only curation outcome. A node born from a finalize trace has no author, no
 * type and no timestamp, which is enough to fetch and not enough to list. So
 * the identity half is written at ingest, from the put action itself.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { IngestionHandler } from '../../src/api/ingestion.js';

const HASH = 'd'.repeat(64);
const ZERO_HASH = '0'.repeat(64);

/** A graph stub recording what the projection was asked to write. */
function graphSpy(overrides = {}) {
    return {
        recordOperation: jest.fn(async () => ({ status: 'recorded' })),
        recordVote: jest.fn(async () => ({ status: 'recorded' })),
        recordFinalization: jest.fn(async () => ({ status: 'finalized' })),
        ...overrides
    };
}

/**
 * A store that holds nothing. Deliberate: the projection must not depend on
 * this host having the body, and the tests below assert exactly that.
 *
 * @returns {Object}
 */
function emptyStore() {
    return {
        retrieveEvent: jest.fn(async () => null),
        retrieveByEventCid: jest.fn(async () => null),
        calculateHash: jest.fn(() => HASH)
    };
}

function handlerWith(graph, store = emptyStore()) {
    return new IngestionHandler(store, { db: graph }, { enableBatching: false });
}

/**
 * @param {Object} data - put() arguments.
 * @returns {Object} An anchored-event envelope as the sink posts it.
 */
function anchoredPut(data) {
    return {
        content_hash: HASH,
        payload: JSON.stringify({ hash: HASH, ...data }),
        block_num: 4242,
        block_id: 'b'.repeat(64),
        trx_id: 'c'.repeat(64),
        action_ordinal: 0,
        timestamp: '2026-01-01T00:00:00.000',
        action_name: 'put',
        contract_account: 'polarismusic'
    };
}

describe('every anchored submission is projected at ingest', () => {
    let graph;
    beforeEach(() => { graph = graphSpy(); });

    test('a release bundle is projected with the fields a feed row needs', async () => {
        await handlerWith(graph).processAnchoredEvent(anchoredPut({
            author: 'alice', type: 21, event_cid: 'bafyrelease', ts: 1787608856
        }));

        expect(graph.recordOperation).toHaveBeenCalledWith(expect.objectContaining({
            eventHash: HASH,
            author: 'alice',
            type: 21,
            eventCid: 'bafyrelease',
            blockNum: 4242
        }));
    });

    test('block time dates the row, not the author-supplied ts', () => {
        // put()'s `ts` is whatever the submitter put in the action; block time
        // is the chain's own record. A replay must reproduce the same feed.
        return handlerWith(graph)
            .processAnchoredEvent(anchoredPut({ author: 'alice', type: 21, ts: 1 }))
            .then(() => {
                const { ts } = graph.recordOperation.mock.calls[0][0];
                expect(new Date(ts).toISOString()).toBe('2026-01-01T00:00:00.000Z');
            });
    });

    test('the projection is written even when the body is not held here', async () => {
        // The whole point: the row describes what was anchored on chain, which
        // is true whether or not this host can retrieve the payload. Ingestion
        // reports not_found and the feed still has something to list.
        const result = await handlerWith(graph).processAnchoredEvent(anchoredPut({
            author: 'alice', type: 21, ts: 1787608856
        }));

        expect(result.status).toBe('not_found');
        expect(graph.recordOperation).toHaveBeenCalledTimes(1);
    });

    test('a redelivery after a successful ingest does not re-project', async () => {
        const handler = handlerWith(graph);
        // Stand in for a prior successful ingest: processedHashes is only
        // populated once an event has been processed end to end.
        handler.processedHashes.add(HASH);

        const result = await handler.processAnchoredEvent(
            anchoredPut({ author: 'alice', type: 21, ts: 1787608856 }));

        // The envelope dedup short-circuits before any work is done, and there
        // is nothing to repair: the row was written the first time through.
        expect(result.status).toBe('duplicate');
        expect(graph.recordOperation).not.toHaveBeenCalled();
    });

    test('an event whose body has not arrived yet is projected on every attempt', async () => {
        const handler = handlerWith(graph);
        const event = anchoredPut({ author: 'alice', type: 21, ts: 1787608856 });

        await handler.processAnchoredEvent(event);
        await handler.processAnchoredEvent(event);

        // A not_found does not enter the dedup cache, so the sink retries. That
        // is safe here because recordOperation is a MERGE keyed on the hash:
        // the second write converges on the same node rather than adding one.
        expect(graph.recordOperation).toHaveBeenCalledTimes(2);
        expect(graph.recordOperation.mock.calls[0][0])
            .toEqual(graph.recordOperation.mock.calls[1][0]);
    });

    test('an all-zero parent is read as "no parent", not as a hash', async () => {
        await handlerWith(graph).processAnchoredEvent(anchoredPut({
            author: 'alice', type: 31, parent: ZERO_HASH, ts: 1787608856
        }));

        expect(graph.recordOperation.mock.calls[0][0].parent).toBeNull();
    });

    test('a real parent is normalized and kept', async () => {
        await handlerWith(graph).processAnchoredEvent(anchoredPut({
            author: 'alice', type: 31, parent: 'E'.repeat(64), ts: 1787608856
        }));

        expect(graph.recordOperation.mock.calls[0][0].parent).toBe('e'.repeat(64));
    });
});

describe('only curatable content types become feed rows', () => {
    let graph;
    beforeEach(() => { graph = graphSpy(); });

    // put() anchors types 20-39 and nothing else (polaris.music.cpp:101), so
    // anything outside that range has no anchor, no tally and no curation to
    // show. Projecting one would add a row the chain never backed.
    test.each([
        ['a vote', 40],
        ['a like', 41],
        ['a finalize', 50],
        ['a merge', 60],
        ['just below the range', 19],
        ['just above the range', 40]
    ])('%s is not projected', async (_label, type) => {
        await handlerWith(graph).processAnchoredEvent(anchoredPut({
            author: 'alice', type, ts: 1787608856
        }));

        expect(graph.recordOperation).not.toHaveBeenCalled();
    });

    test.each([
        ['the first content type', 20],
        ['a release bundle', 21],
        ['the last content type', 39]
    ])('%s is projected', async (_label, type) => {
        await handlerWith(graph).processAnchoredEvent(anchoredPut({
            author: 'alice', type, ts: 1787608856
        }));

        expect(graph.recordOperation).toHaveBeenCalledTimes(1);
    });
});

describe('the projection never blocks ingestion', () => {
    test('a graph without recordOperation is skipped, not an error', async () => {
        const graph = graphSpy();
        delete graph.recordOperation;

        const result = await handlerWith(graph).processAnchoredEvent(anchoredPut({
            author: 'alice', type: 21, ts: 1787608856
        }));

        // Older graph instances and the unit tests that stub the processor have
        // no projection to write to; that is a missing feature, not a failure.
        expect(result.status).toBe('not_found');
    });

    test('a projection failure does not fail the event behind it', async () => {
        const graph = graphSpy({
            recordOperation: jest.fn(async () => { throw new Error('neo4j is down'); })
        });

        const result = await handlerWith(graph).processAnchoredEvent(anchoredPut({
            author: 'alice', type: 21, ts: 1787608856
        }));

        // A feed row that cannot be written is not a reason to lose the graph
        // data behind it.
        expect(result.status).toBe('not_found');
        expect(result.error).toBeUndefined();
    });

    test('no graph at all is tolerated', async () => {
        const result = await handlerWith(null).processAnchoredEvent(anchoredPut({
            author: 'alice', type: 21, ts: 1787608856
        }));

        expect(result.status).toBe('not_found');
    });
});
