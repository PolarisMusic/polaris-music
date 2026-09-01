/**
 * The reclaim job's policy and its batching loop.
 *
 * reclaim() deletes on-chain state irreversibly and had no coverage at all; a
 * scheduled job is about to call it unattended. The contract-level tests can
 * only cover the guard, because reaching finalization needs a chain with time
 * control (setvwindows clamps the minimum voting window to one hour). These
 * cover the caller, which is the half that decides WHICH anchors get erased and
 * how many times.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { planFor, reclaimSettledAnchors, MAX_RECLAIM_ROWS } from '../../src/chain/reclaimService.js';

const NOW = 1_800_000_000;

/**
 * A chain stub. `votesPerAnchor` drives how many reclaim calls each anchor needs
 * before it disappears, which is the batching behaviour under test.
 */
function chainStub(anchors, { votesPerAnchor = {}, failOn = null } = {}) {
    const remaining = { ...votesPerAnchor };
    const live = new Set(anchors.map(a => a.hash));

    return {
        calls: { finalize: [], reclaim: [] },
        getAnchors: jest.fn(async () => anchors),
        getAnchor: jest.fn(async (hash) => (live.has(hash) ? { hash } : null)),
        getTally: jest.fn(async () => ({ up_weight: 7, down_weight: 1, up_voter_count: 3, down_voter_count: 1 })),
        finalize: jest.fn(async function (hash) {
            if (failOn === 'finalize') throw new Error('cpu limit');
            this.calls.finalize.push(hash);
        }),
        reclaim: jest.fn(async function (hash, maxRows) {
            if (failOn === 'reclaim') throw new Error('Anchor not found');
            this.calls.reclaim.push({ hash, maxRows });
            const left = (remaining[hash] ?? 0) - maxRows;
            remaining[hash] = Math.max(0, left);
            if (remaining[hash] === 0) live.delete(hash);
        }),
    };
}

const settled = (hash) => ({ id: 1, hash, finalized: 1, expires_at: NOW - 100 });
const expired = (hash) => ({ id: 2, hash, finalized: 0, expires_at: NOW - 100 });
const open = (hash) => ({ id: 3, hash, finalized: 0, expires_at: NOW + 100_000 });

describe('planFor', () => {
    test.each([
        ['a finalized anchor is reclaimed', settled('a'), 'reclaim'],
        ['an expired unfinalized anchor is finalized first', expired('b'), 'finalize'],
        ['an open vote is left alone', open('c'), 'wait'],
    ])('%s', (_label, anchor, expected) => {
        expect(planFor(anchor, NOW)).toBe(expected);
    });

    test('an anchor expiring exactly now is ready', () => {
        expect(planFor({ finalized: 0, expires_at: NOW }, NOW)).toBe('finalize');
    });
});

describe('reclaimSettledAnchors', () => {
    test('signs nothing without execute', async () => {
        const chain = chainStub([settled('a'), expired('b')]);

        const out = await reclaimSettledAnchors({ chain, now: () => NOW });

        // Destructive and irreversible, so the default must be inert.
        expect(chain.finalize).not.toHaveBeenCalled();
        expect(chain.reclaim).not.toHaveBeenCalled();
        expect(out.reclaimed).toEqual(['a']);
        expect(out.finalized).toEqual(['b']);
    });

    test('never touches an anchor whose vote is still open', async () => {
        // The guard that matters most: those rows still decide who gets paid.
        const chain = chainStub([open('c')]);

        const out = await reclaimSettledAnchors({ chain, execute: true, now: () => NOW });

        expect(chain.finalize).not.toHaveBeenCalled();
        expect(chain.reclaim).not.toHaveBeenCalled();
        expect(out.waiting).toBe(1);
    });

    test('finalizes before reclaiming, in that order', async () => {
        const chain = chainStub([expired('b')], { votesPerAnchor: { b: 1 } });

        await reclaimSettledAnchors({ chain, execute: true, now: () => NOW });

        // reclaim() refuses before finalization, so the reverse order would
        // simply fail on every anchor.
        expect(chain.calls.finalize).toEqual(['b']);
        expect(chain.calls.reclaim[0].hash).toBe('b');
    });

    test('loops until the anchor is gone, not a fixed number of times', async () => {
        // The untested contract path: MAX_RECLAIM_ROWS caps each call, and the
        // anchor survives until its last vote is erased.
        const chain = chainStub([settled('a')], { votesPerAnchor: { a: 250 } });

        const out = await reclaimSettledAnchors({ chain, execute: true, now: () => NOW });

        expect(chain.calls.reclaim).toHaveLength(3);   // 100, 100, 50
        expect(chain.calls.reclaim.every(c => c.maxRows === MAX_RECLAIM_ROWS)).toBe(true);
        expect(out.reclaimed).toEqual(['a']);
    });

    test('one call suffices for a lightly voted anchor', async () => {
        const chain = chainStub([settled('a')], { votesPerAnchor: { a: 1 } });

        await reclaimSettledAnchors({ chain, execute: true, now: () => NOW });

        expect(chain.calls.reclaim).toHaveLength(1);
    });

    test('gives up rather than looping when the chain stops progressing', async () => {
        // The anchor never disappears — a contract bug, or a silently failing
        // call. Spinning forever against a signing key is the worse outcome.
        const chain = chainStub([settled('a')], { votesPerAnchor: { a: 10_000 } });

        const out = await reclaimSettledAnchors({ chain, execute: true, now: () => NOW });

        expect(out.reclaimed).toEqual([]);
        expect(out.failed[0].stage).toBe('reclaim');
        expect(chain.calls.reclaim.length).toBeLessThan(60);
    });

    test('snapshots the tally before erasing it', async () => {
        // Vote weight is respect-at-vote-time and is in no action trace, so
        // after the row is gone the exact figures cannot be recovered.
        const graph = { recordFinalization: jest.fn(async () => {}) };
        const chain = chainStub([settled('a')], { votesPerAnchor: { a: 1 } });

        await reclaimSettledAnchors({ chain, graph, execute: true, now: () => NOW });

        expect(graph.recordFinalization).toHaveBeenCalledWith(
            expect.objectContaining({
                eventHash: 'a',
                tally: expect.objectContaining({ up_weight: 7 })
            }));
        // Ordering, explicitly: the snapshot is worthless after the erase.
        expect(graph.recordFinalization.mock.invocationCallOrder[0])
            .toBeLessThan(chain.reclaim.mock.invocationCallOrder[0]);
    });

    test('a failed snapshot does not block the reclaim', async () => {
        // Losing the tally costs history; leaving the RAM costs money forever.
        const graph = { recordFinalization: jest.fn(async () => { throw new Error('neo4j down'); }) };
        const chain = chainStub([settled('a')], { votesPerAnchor: { a: 1 } });

        const out = await reclaimSettledAnchors({ chain, graph, execute: true, now: () => NOW });

        expect(out.reclaimed).toEqual(['a']);
    });

    test('one failure does not stop the anchors behind it', async () => {
        const chain = chainStub([settled('a'), settled('b')], { failOn: 'reclaim' });

        const out = await reclaimSettledAnchors({ chain, execute: true, now: () => NOW });

        expect(out.failed).toHaveLength(2);
        expect(out.failed.map(f => f.hash)).toEqual(['a', 'b']);
    });

    test('a finalize failure skips that anchor without reclaiming it', async () => {
        // The CPU limit that bit a manual run. Reclaiming an unfinalized anchor
        // would be refused anyway, but attempting it would mask the real cause.
        const chain = chainStub([expired('b')], { failOn: 'finalize' });

        const out = await reclaimSettledAnchors({ chain, execute: true, now: () => NOW });

        expect(chain.reclaim).not.toHaveBeenCalled();
        expect(out.failed[0]).toMatchObject({ hash: 'b', stage: 'finalize' });
    });

    test('an empty chain is not an error', async () => {
        const out = await reclaimSettledAnchors({ chain: chainStub([]), execute: true, now: () => NOW });
        expect(out).toMatchObject({ finalized: [], reclaimed: [], waiting: 0, failed: [] });
    });
});
