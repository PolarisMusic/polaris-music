/**
 * The sponsored-node draw.
 *
 * These lean on the property that makes the feature trustworthy rather than on
 * fixed expected winners: the draw is a pure function of published inputs, so
 * the same inputs must always produce the same node, and the weighting must
 * actually shift the odds in the direction the economics claim.
 *
 * The distribution tests sweep many seeds rather than asserting one outcome.
 * A single-seed assertion passes on an implementation that ignores stake
 * entirely — which is precisely the bug that would make sponsorship worthless
 * while looking correct.
 */

import { createHash } from 'crypto';
import {
    drawSponsoredNode,
    orderCandidates,
    seedToBigInt,
    toUnits,
    weightOf,
    UNITS_PER_TOKEN,
    DEFAULT_BASE_WEIGHT,
} from '../../src/api/sponsoredNode.js';

/** The join key the contract stakes against: sha256 of the graph node id. */
const chainId = (nodeId) => createHash('sha256').update(nodeId).digest('hex');

/** A candidate, as the selection service will assemble it. */
const node = (nodeId, stakeUnits) => ({ nodeId, chainId: chainId(nodeId), stakeUnits });

/** A 256-bit seed derived from a counter, standing in for a block id. */
const seed = (n) => createHash('sha256').update(`seed-${n}`).digest('hex');

/** Run the draw over many seeds and tally the winners. */
function tally(candidates, draws = 4000, options = {}) {
    const counts = new Map();
    for (let i = 0; i < draws; i++) {
        const result = drawSponsoredNode(candidates, seed(i), options);
        counts.set(result.winner.nodeId, (counts.get(result.winner.nodeId) ?? 0) + 1);
    }
    return counts;
}

describe('reading stake amounts', () => {
    test('an asset string is read as fixed point, not through a float', () => {
        expect(toUnits('12.3456 MUS')).toBe(123456n);
        expect(toUnits('0.0003 MUS')).toBe(3n);
        expect(toUnits('7 MUS')).toBe(70000n);
    });

    test('integers, bigints and missing values all land somewhere sane', () => {
        expect(toUnits(50000n)).toBe(50000n);
        expect(toUnits(50000)).toBe(50000n);
        expect(toUnits('50000')).toBe(50000n);
        expect(toUnits(null)).toBe(0n);
        expect(toUnits(undefined)).toBe(0n);
        expect(toUnits('')).toBe(0n);
    });

    test('a negative stake cannot subtract weight', () => {
        // Not reachable through the contract, which rejects non-positive
        // amounts — but a draw that could be pushed toward a node by a
        // malformed row is worth refusing structurally.
        expect(toUnits(-5n)).toBe(0n);
        expect(toUnits('-5')).toBe(0n);
        expect(toUnits('-1.0000 MUS')).toBe(0n);
    });
});

describe('weighting', () => {
    test('an unstaked node still carries the base weight', () => {
        expect(weightOf(0n)).toBe(DEFAULT_BASE_WEIGHT);
    });

    test('each whole token adds exactly one', () => {
        expect(weightOf(10n * UNITS_PER_TOKEN)).toBe(DEFAULT_BASE_WEIGHT + 10n);
    });

    test('a part token buys nothing until it is whole', () => {
        expect(weightOf(UNITS_PER_TOKEN - 1n)).toBe(DEFAULT_BASE_WEIGHT);
        expect(weightOf(UNITS_PER_TOKEN)).toBe(DEFAULT_BASE_WEIGHT + 1n);
    });
});

describe('determinism', () => {
    const candidates = [node('grp:a', 0), node('grp:b', 5n * UNITS_PER_TOKEN), node('per:c', 0)];

    test('the same seed and stakes always pick the same node', () => {
        const first = drawSponsoredNode(candidates, seed(1));
        const second = drawSponsoredNode(candidates, seed(1));
        expect(second.winner.nodeId).toBe(first.winner.nodeId);
        expect(second.offset).toBe(first.offset);
    });

    test('the order the candidates arrive in does not change the winner', () => {
        // The load-bearing one: Neo4j promises no row order without an ORDER
        // BY, so a draw that depended on arrival order would be unverifiable
        // and would drift between runs of the same query.
        //
        // Swept over many seeds, and over EQUAL weights, both deliberately.
        // The first version of this test used one seed against weights of
        // 1/6/1 and passed against an implementation that did no sorting at
        // all: the heavy candidate covered three quarters of the number line,
        // so reversing the array left it winning anyway. Equal weights make
        // every position matter, and a sweep makes one lucky seed worthless.
        const equal = [node('grp:a', 0), node('grp:b', 0), node('grp:c', 0), node('grp:d', 0)];
        const rotate = (xs, n) => [...xs.slice(n), ...xs.slice(0, n)];

        for (let i = 0; i < 200; i++) {
            const expected = drawSponsoredNode(equal, seed(i)).winner.nodeId;
            expect(drawSponsoredNode([...equal].reverse(), seed(i)).winner.nodeId).toBe(expected);
            expect(drawSponsoredNode(rotate(equal, 1), seed(i)).winner.nodeId).toBe(expected);
            expect(drawSponsoredNode(rotate(equal, 3), seed(i)).winner.nodeId).toBe(expected);
        }
    });

    test('candidates are ordered by on-chain id, not by graph id', () => {
        const ordered = orderCandidates(candidates);
        const ids = ordered.map((c) => c.chainId);
        expect([...ids].sort()).toEqual(ids);
    });

    test('a different seed can pick a different node', () => {
        // Guards against a draw that ignores the seed and always returns the
        // first or heaviest candidate.
        const winners = new Set();
        for (let i = 0; i < 50; i++) {
            winners.add(drawSponsoredNode(candidates, seed(i)).winner.nodeId);
        }
        expect(winners.size).toBeGreaterThan(1);
    });
});

describe('the odds behave as the economics claim', () => {
    test('an unstaked node wins sometimes', () => {
        // The requirement stated outright: staking buys better odds, not
        // exclusivity.
        const candidates = [node('grp:rich', 50n * UNITS_PER_TOKEN), node('grp:poor', 0)];
        const counts = tally(candidates, 2000);
        expect(counts.get('grp:poor') ?? 0).toBeGreaterThan(0);
    });

    test('more stake wins more often', () => {
        const candidates = [
            node('grp:none', 0),
            node('grp:some', 5n * UNITS_PER_TOKEN),
            node('grp:lots', 20n * UNITS_PER_TOKEN),
        ];
        const counts = tally(candidates);
        const none = counts.get('grp:none') ?? 0;
        const some = counts.get('grp:some') ?? 0;
        const lots = counts.get('grp:lots') ?? 0;

        expect(some).toBeGreaterThan(none);
        expect(lots).toBeGreaterThan(some);
    });

    test('the split matches the weights, within sampling noise', () => {
        // The worked example from the design: twelve nodes, one holding ten
        // tokens, so twenty-two chunks and 10/22 ≈ 45% for the staked node.
        const candidates = [
            node('grp:staked', 10n * UNITS_PER_TOKEN),
            ...Array.from({ length: 11 }, (_, i) => node(`grp:plain-${i}`, 0)),
        ];

        const draws = 8000;
        const counts = tally(candidates, draws);
        const share = (counts.get('grp:staked') ?? 0) / draws;

        // Expected 11/22 = 0.5 (the staked node's own base chunk counts too).
        expect(share).toBeGreaterThan(0.45);
        expect(share).toBeLessThan(0.55);
    });

    test('every eligible node is reachable', () => {
        const candidates = Array.from({ length: 8 }, (_, i) => node(`grp:${i}`, 0));
        const counts = tally(candidates, 3000);
        expect(counts.size).toBe(8);
    });
});

describe('the ranges partition the number line', () => {
    test('runs are contiguous, start at zero, and sum to the total', () => {
        // If the ranges left a gap the draw could land nowhere and throw; if
        // they overlapped, two nodes would share odds.
        const candidates = [
            node('grp:a', 3n * UNITS_PER_TOKEN),
            node('grp:b', 0),
            node('grp:c', 1n * UNITS_PER_TOKEN),
        ];
        const { weights, totalWeight } = drawSponsoredNode(candidates, seed(9));

        expect(weights[0].start).toBe(0n);
        for (let i = 1; i < weights.length; i++) {
            expect(weights[i].start).toBe(weights[i - 1].end);
        }
        expect(weights.at(-1).end).toBe(totalWeight);
        expect(weights.reduce((sum, w) => sum + w.weight, 0n)).toBe(totalWeight);
    });
});

describe('edges', () => {
    test('no candidates means no draw rather than a throw', () => {
        expect(drawSponsoredNode([], seed(1))).toBeNull();
        expect(drawSponsoredNode(null, seed(1))).toBeNull();
    });

    test('a single candidate always wins', () => {
        const only = [node('grp:solo', 0)];
        expect(drawSponsoredNode(only, seed(3)).winner.nodeId).toBe('grp:solo');
        expect(drawSponsoredNode(only, seed(4)).winner.nodeId).toBe('grp:solo');
    });

    test('a malformed seed is refused rather than silently coerced', () => {
        // A seed that quietly became 0 would hand the front page to whichever
        // node sorts first, every period, forever.
        expect(() => seedToBigInt('')).toThrow(/64 hex/);
        expect(() => seedToBigInt('abc')).toThrow(/64 hex/);
        expect(() => seedToBigInt(null)).toThrow(/64 hex/);
        expect(() => seedToBigInt('z'.repeat(64))).toThrow(/64 hex/);
    });

    test('a 0x prefix and upper case are both accepted', () => {
        const bare = 'f'.repeat(64);
        expect(seedToBigInt(`0x${bare}`)).toBe(seedToBigInt(bare));
        expect(seedToBigInt(bare.toUpperCase())).toBe(seedToBigInt(bare));
    });

    test('base weight zero drops unstaked nodes out of the draw entirely', () => {
        // Not the shipped policy, but the knob has to mean something coherent
        // if it is ever turned: at zero, only stake buys a chance.
        const candidates = [node('grp:none', 0), node('grp:some', 2n * UNITS_PER_TOKEN)];
        const counts = tally(candidates, 500, { baseWeight: 0n });
        expect(counts.get('grp:none')).toBeUndefined();
        expect(counts.get('grp:some')).toBe(500);
    });

    test('base weight zero with nothing staked anywhere is no draw, not a crash', () => {
        const candidates = [node('grp:none', 0), node('grp:also-none', 0)];
        expect(drawSponsoredNode(candidates, seed(1), { baseWeight: 0n })).toBeNull();
    });
});
