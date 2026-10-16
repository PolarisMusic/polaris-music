/**
 * Type 33 reaching its handler.
 *
 * Worth a test of its own because the failure it guards against is silent.
 * `processAction` looks the type up in `eventHandlers` and, finding nothing,
 * logs "No handler for event type" and returns — so an anchored correction
 * would sit on chain, paid for and voted on, while the graph never changed.
 * That is also exactly what happened to MINT_ENTITY and RESOLVE_ID rows for a
 * while, which is why eventTypes.js exists as one table instead of four
 * partial copies.
 *
 * No database: what is under test is the wiring, so the graph is a spy.
 */

import { describe, test, expect, jest } from '@jest/globals';
import EventProcessor from '../../src/indexer/eventProcessor.js';
import { EVENT_TYPES, TYPE_CODE_TO_EVENT_TYPE } from '../../src/constants/eventTypes.js';

const HASH = 'e'.repeat(64);

const EVENT = {
    v: 1,
    type: 'EDIT_RELATIONSHIP',
    author_pubkey: 'curator',
    created_at: 1700000000,
    body: {
        person: { id: 'per:preston' },
        group: { id: 'grp:beatles' },
        to: 'MEMBER_OF',
        release_id: 'rel:abbey'
    }
};

function processorWithSpy() {
    const db = {
        processRelationshipEdit: jest.fn(async () => ({
            success: true, to: 'MEMBER_OF', removed: {}, created: {}
        })),
    };
    const store = {
        retrieveEvent: jest.fn(async () => EVENT),
        calculateHash: () => HASH,
    };
    return { db, store, processor: new EventProcessor({ db, store }) };
}

const action = (type, overrides = {}) => ({
    action_trace: {
        act: {
            account: 'polarismusic',
            name: 'put',
            data: {
                hash: HASH, type, author: 'curator',
                event_cid: 'bafy', ts: 1700000001, ...overrides
            }
        },
        block_num: 42,
        block_time: '2026-10-16T00:00:00.000'
    }
});

describe('EDIT_RELATIONSHIP dispatch', () => {
    test('33 is the code, and it is not 32', async () => {
        // 32 is DELETE_CLAIM, reserved by docs/03-event-storage.md. Reusing it
        // would have been unfixable: the code is written into an anchor row.
        expect(EVENT_TYPES.EDIT_RELATIONSHIP).toBe(33);
        expect(TYPE_CODE_TO_EVENT_TYPE[33]).toBe('EDIT_RELATIONSHIP');
        expect(TYPE_CODE_TO_EVENT_TYPE[32]).toBeUndefined();
    });

    test('an anchored type 33 reaches processRelationshipEdit', async () => {
        const { db, processor } = processorWithSpy();

        await processor.processAction(action(33));

        expect(db.processRelationshipEdit).toHaveBeenCalledTimes(1);
        const [hash, body, author, ts] = db.processRelationshipEdit.mock.calls[0];
        expect(hash).toBe(HASH);
        expect(body).toEqual(EVENT.body);
        // The chain account, not the event's own author_pubkey field: the
        // transaction is the proof of who submitted it.
        expect(author).toBe('curator');
        expect(ts).toBe(1700000001);
    });

    test('the event counts as processed under its own type', async () => {
        const { processor } = processorWithSpy();

        await processor.processAction(action(33));

        expect(processor.stats.eventsProcessed).toBe(1);
        expect(processor.stats.eventsByType[33]).toBe(1);
        expect(processor.stats.errors).toBe(0);
    });

    test('a failing correction is counted as an error, not swallowed', async () => {
        const { db, processor } = processorWithSpy();
        db.processRelationshipEdit.mockRejectedValueOnce(
            new Error('Relationship edit target not found'));

        await processor.processAction(action(33));

        expect(processor.stats.errors).toBe(1);
        expect(processor.stats.eventsProcessed).toBe(0);
    });

    test('it falls back to the event\'s own timestamp when the action has none', async () => {
        const { db, processor } = processorWithSpy();

        await processor.processAction(action(33, { ts: null }));

        expect(db.processRelationshipEdit.mock.calls[0][3]).toBe(EVENT.created_at);
    });
});
