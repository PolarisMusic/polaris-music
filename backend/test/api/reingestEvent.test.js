/**
 * Rebuilding an anchored event from what the first attempt left behind.
 *
 * Ingestion projects the curation row before it fetches the body, so a failed
 * ingestion leaves an Operation node and no graph nodes. The sink does not
 * retry — rightly, since the same event fails the same way — so once the cause
 * is fixed there is nothing that will ever try again. This is the payload that
 * replay re-posts, and everything in it comes from that projection.
 */

import { describe, test, expect } from '@jest/globals';
import { anchoredEventFrom } from '../../scripts/reingestEvent.js';

const OPERATION = {
    eventHash: '3cfdf8d7abfb' + 'a'.repeat(52),
    author: 'polaristest2',
    type: 21,
    eventCid: 'bafy123',
    parentHash: null,
    submittedBlock: 293464583,
    submittedAt: 1_761_000_000_000,
};

describe('anchoredEventFrom', () => {
    test('it rebuilds what the sink would have posted', () => {
        const event = anchoredEventFrom(OPERATION);

        expect(event).toMatchObject({
            content_hash: OPERATION.eventHash,
            action_name: 'put',
            block_num: 293464583,
            source: 'reingest-script',
        });

        const payload = JSON.parse(event.payload);
        expect(payload).toMatchObject({
            author: 'polaristest2', type: 21, hash: OPERATION.eventHash, event_cid: 'bafy123',
        });
    });

    test('the timestamp goes back to seconds, which is what put() carries', () => {
        // The projection stores milliseconds; the action does not.
        const event = anchoredEventFrom(OPERATION);

        expect(JSON.parse(event.payload).ts).toBe(1_761_000_000);
        expect(event.timestamp).toBe(1_761_000_000);
    });

    test('an event with no type cannot be dispatched, and says so', () => {
        // Without a type there is no handler to route to, and posting it would
        // produce an "unknown type code" warning and a silent no-op.
        expect(() => anchoredEventFrom({ ...OPERATION, type: null }))
            .toThrow(/No type recorded/);
    });

    test('a hash is required', () => {
        expect(() => anchoredEventFrom({ ...OPERATION, eventHash: null }))
            .toThrow(/event hash is required/);
    });

    test('a projection missing the optional fields still posts', () => {
        // event_cid is absent for anything submitted before CIDs were carried,
        // and retrieval falls back to the hash. An absent author is a row the
        // projection could not complete; the ingestion path tolerates it.
        const event = anchoredEventFrom({
            eventHash: OPERATION.eventHash, type: 21,
        });

        const payload = JSON.parse(event.payload);
        expect(payload.event_cid).toBeNull();
        expect(payload.author).toBeNull();
        expect(event.block_num).toBe(0);
        // Never undefined: the ingestion endpoint rejects a body with no
        // payload, and JSON.stringify drops undefined keys on the way out.
        for (const [key, value] of Object.entries(event)) {
            expect([key, value]).not.toEqual([key, undefined]);
        }
    });
});
