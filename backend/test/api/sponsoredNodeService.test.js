/**
 * Assembling the sponsored-node draw.
 *
 * The draw and the schedule are tested as pure functions elsewhere. What is
 * left here is the wiring, and the wiring's most important property is how it
 * behaves when something is missing: a drawn node is an enhancement, the graph
 * opening at all is not, so every failure has to become "no node" rather than
 * an exception or a 500.
 */

import { createHash } from 'crypto';
import { SponsoredNodeService, toChainId } from '../../src/api/sponsoredNodeService.js';

const CANDIDATES = [
    { nodeId: 'polaris:group:alpha', name: 'Alpha', type: 'group' },
    { nodeId: 'polaris:person:bravo', name: 'Bravo', type: 'person' },
    { nodeId: 'polaris:group:charlie', name: 'Charlie', type: 'group' },
];

/** Well past the first period, and past the seed delay. */
const LIB = 172800 * 5 + 900;

const blockId = (n) => createHash('sha256').update(`blk${n}`).digest('hex');

function makeService({ candidates = CANDIDATES, stakes = new Map(), configRow = null, overrides = {} } = {}) {
    const calls = { candidates: 0, blockId: 0, stakes: 0 };
    const graph = {
        getLotteryCandidates: async () => { calls.candidates++; return candidates; },
    };
    const chain = {
        getLotteryConfig: async () => configRow,
        getChainInfo: async () => ({ lastIrreversibleBlock: LIB }),
        getBlockId: async (n) => { calls.blockId++; return blockId(n); },
        getNodeStakes: async () => { calls.stakes++; return stakes; },
        ...overrides,
    };
    return { service: new SponsoredNodeService({ graph, chain }), calls };
}

describe('the on-chain identity', () => {
    test('a graph id is hashed the way the browser hashes it', () => {
        // Must match LikeManager.nodeIdToChecksum256, or the stake lookup
        // silently misses and every node looks unstaked.
        const expected = createHash('sha256').update('polaris:group:alpha').digest('hex');
        expect(toChainId('polaris:group:alpha')).toBe(expected);
    });

    test('something already in checksum form is passed through, not re-hashed', () => {
        const already = 'a'.repeat(64);
        expect(toChainId(already)).toBe(already);
        expect(toChainId(already.toUpperCase())).toBe(already);
    });
});

describe('drawing', () => {
    test('returns a node from the eligible set', async () => {
        const { service } = makeService();
        const result = await service.getSponsoredNode();
        expect(CANDIDATES.map((c) => c.nodeId)).toContain(result.node.id);
        expect(result.node.name).toBeTruthy();
    });

    test('publishes the inputs, so the result can be recomputed', async () => {
        // The draw is only worth something if a sceptic can check it, and an
        // answer alone cannot be checked.
        const { service } = makeService();
        const { draw } = await service.getSponsoredNode();

        expect(draw.seed).toMatch(/^[0-9a-f]{64}$/);
        expect(draw.seed_block).toBe(172800 * 5 + 120);
        expect(draw.snapshot_block).toBe(172800 * 5);
        expect(draw.period).toBe(5);
        expect(Number(draw.total_weight)).toBe(3);          // three nodes, base 1
        expect(Number(draw.offset)).toBeLessThan(Number(draw.total_weight));
    });

    test('stake reaches the draw and moves the odds', async () => {
        // Guards the join: a mismatch between the graph id and the chain id
        // would leave every node unstaked and nothing would look wrong.
        const stakes = new Map([[toChainId('polaris:group:alpha'), '40.0000 MUS']]);
        const { service } = makeService({ stakes });
        const { draw } = await service.getSponsoredNode();

        expect(Number(draw.total_weight)).toBe(43);   // 41 + 1 + 1
        expect(draw.staked_candidates).toBe(1);
    });

    test('the contract base weight is honoured', async () => {
        const { service } = makeService({
            configRow: { base_weight: '10', period_blocks: 172800, seed_delay_blocks: 120 },
        });
        const { draw } = await service.getSponsoredNode();
        expect(draw.base_weight).toBe('10');
        expect(Number(draw.total_weight)).toBe(30);   // three nodes at 10
    });

    test('the stake read labels itself as current state', async () => {
        // The design says stakes are snapshotted at snapshot_block; this
        // implementation cannot do that yet, and says so in the payload rather
        // than letting a verifier assume the stronger guarantee.
        const { service } = makeService();
        const { draw } = await service.getSponsoredNode();
        expect(draw.stake_source).toBe('current_state');
    });
});

describe('one draw per period', () => {
    test('a second call in the same period does not redraw', async () => {
        const { service, calls } = makeService();
        const first = await service.getSponsoredNode();
        const second = await service.getSponsoredNode();

        expect(second).toEqual(first);
        expect(calls.candidates).toBe(1);
        expect(calls.blockId).toBe(1);
        expect(calls.stakes).toBe(1);
    });

    test('a new period redraws', async () => {
        let lib = LIB;
        const { service } = makeService({
            overrides: { getChainInfo: async () => ({ lastIrreversibleBlock: lib }) },
        });

        const first = await service.getSponsoredNode();
        lib = 172800 * 6 + 900;
        const second = await service.getSponsoredNode();

        expect(second.draw.period).toBe(6);
        expect(first.draw.period).toBe(5);
        expect(second.draw.seed).not.toBe(first.draw.seed);
    });
});

describe('failing softly', () => {
    test('an unreachable chain yields no node rather than an error', async () => {
        const { service } = makeService({
            overrides: { getChainInfo: async () => { throw new Error('ECONNREFUSED'); } },
        });
        await expect(service.getSponsoredNode()).resolves.toBeNull();
    });

    test('a missing seed block yields no node', async () => {
        const { service } = makeService({
            overrides: { getBlockId: async () => { throw new Error('block not found'); } },
        });
        await expect(service.getSponsoredNode()).resolves.toBeNull();
    });

    test('an empty registry yields no node', async () => {
        const { service } = makeService({ candidates: [] });
        await expect(service.getSponsoredNode()).resolves.toBeNull();
    });

    test('a chain too young for a full period yields no node', async () => {
        const { service } = makeService({
            overrides: { getChainInfo: async () => ({ lastIrreversibleBlock: 42 }) },
        });
        await expect(service.getSponsoredNode()).resolves.toBeNull();
    });

    test('a contract row the rules forbid yields no node, not a manipulable draw', async () => {
        // A zero seed delay makes the seed knowable when stakes are fixed.
        // Better to show no sponsored node than to run a draw that can be
        // bought.
        const { service } = makeService({
            configRow: { base_weight: '1', period_blocks: 172800, seed_delay_blocks: 0 },
        });
        await expect(service.getSponsoredNode()).resolves.toBeNull();
    });

    test('an unconfigured contract still draws, on the documented defaults', async () => {
        const { service } = makeService({ configRow: null });
        const result = await service.getSponsoredNode();
        expect(result).not.toBeNull();
        expect(result.draw.period_blocks).toBe(172800);
    });
});
