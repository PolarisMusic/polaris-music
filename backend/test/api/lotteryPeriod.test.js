/**
 * Period arithmetic for the sponsored-node lottery.
 *
 * These are the numbers a sceptic recomputes to check a draw, so the tests are
 * about reproducibility and about the two ordering rules that keep the draw
 * honest: stakes are fixed before the seed exists, and the seed must be
 * irreversible before it is used.
 */

import {
    DEFAULT_LOTTERY_CONFIG,
    lotteryConfigFromRow,
    periodIndexFor,
    resolvePeriod,
    seedBlockFor,
    snapshotBlockFor,
    validateLotteryConfig,
} from '../../src/api/lotteryPeriod.js';

const CONFIG = { periodBlocks: 172800, seedDelayBlocks: 120 };

describe('period boundaries', () => {
    test('a block maps to the period containing it', () => {
        expect(periodIndexFor(0, 172800)).toBe(0);
        expect(periodIndexFor(172799, 172800)).toBe(0);
        expect(periodIndexFor(172800, 172800)).toBe(1);
        expect(periodIndexFor(345600, 172800)).toBe(2);
    });

    test('the snapshot block is the period\'s first block', () => {
        expect(snapshotBlockFor(3, 172800)).toBe(518400);
        expect(periodIndexFor(snapshotBlockFor(3, 172800), 172800)).toBe(3);
    });

    test('the seed block sits inside its own period', () => {
        // If it did not, two periods would draw from one seed — which is why
        // the contract refuses a delay at or beyond the period length.
        for (const index of [0, 1, 7, 1000]) {
            const seed = seedBlockFor(index, CONFIG);
            expect(periodIndexFor(seed, CONFIG.periodBlocks)).toBe(index);
        }
    });

    test('the seed block is strictly after the stake snapshot', () => {
        // The ordering the whole design rests on: stakes are fixed at a block
        // whose successor's id nobody knows yet.
        const index = 12;
        expect(seedBlockFor(index, CONFIG))
            .toBeGreaterThan(snapshotBlockFor(index, CONFIG.periodBlocks));
    });
});

describe('which period is answerable', () => {
    test('a block well inside a period resolves to that period', () => {
        const lib = 172800 * 5 + 50000;
        expect(resolvePeriod(lib, CONFIG).index).toBe(5);
    });

    test('inside the seed delay it is still the previous period', () => {
        // The seed block is not irreversible yet, so the draw for this period
        // cannot be computed and the previous node stays up.
        const periodStart = 172800 * 5;
        const resolved = resolvePeriod(periodStart + 10, CONFIG);
        expect(resolved.index).toBe(4);
    });

    test('the switch happens exactly at the seed block, not before', () => {
        const periodStart = 172800 * 5;
        const seed = seedBlockFor(5, CONFIG);

        expect(resolvePeriod(seed - 1, CONFIG).index).toBe(4);
        expect(resolvePeriod(seed, CONFIG).index).toBe(5);
        expect(periodStart + CONFIG.seedDelayBlocks).toBe(seed);
    });

    test('the resolved period always has an irreversible seed', () => {
        // Swept rather than spot-checked: an off-by-one here would serve a
        // winner computed from a block that could still be forked away.
        for (let lib = 172800 * 3; lib < 172800 * 3 + 500; lib++) {
            const resolved = resolvePeriod(lib, CONFIG);
            expect(resolved.seedBlock).toBeLessThanOrEqual(lib);
        }
    });

    test('a chain younger than one period has no answerable draw', () => {
        // Period 0's snapshot block is 0, which does not exist — blocks start
        // at 1. A fresh local node hits this on the first request.
        expect(resolvePeriod(50, CONFIG)).toBeNull();
        expect(resolvePeriod(172800 + 119, CONFIG)).toBeNull();
        expect(resolvePeriod(172800 + 120, CONFIG).index).toBe(1);
    });

    test('nonsense heights return no period rather than a negative one', () => {
        expect(resolvePeriod(0, CONFIG)).toBeNull();
        expect(resolvePeriod(-1, CONFIG)).toBeNull();
        expect(resolvePeriod(null, CONFIG)).toBeNull();
        expect(resolvePeriod(1.5, CONFIG)).toBeNull();
    });

    test('every block in a period resolves to the same draw', () => {
        // What makes the node stable for a whole period rather than flickering
        // between two as blocks arrive.
        const first = resolvePeriod(seedBlockFor(9, CONFIG), CONFIG);
        const last = resolvePeriod(172800 * 10 + CONFIG.seedDelayBlocks - 1, CONFIG);
        expect(last.index).toBe(first.index);
        expect(last.seedBlock).toBe(first.seedBlock);
    });
});

describe('configuration', () => {
    test('the defaults are the contract\'s defaults', () => {
        expect(DEFAULT_LOTTERY_CONFIG.periodBlocks).toBe(172800);   // 24h at 0.5s
        expect(DEFAULT_LOTTERY_CONFIG.seedDelayBlocks).toBe(120);
        expect(DEFAULT_LOTTERY_CONFIG.baseWeight).toBe(1n);
        expect(() => validateLotteryConfig(DEFAULT_LOTTERY_CONFIG)).not.toThrow();
    });

    test('a zero seed delay is refused', () => {
        // At zero the seed is the snapshot block: its id is known at the exact
        // moment stakes are fixed, so a staker can read it and buy the win.
        expect(() => validateLotteryConfig({ ...DEFAULT_LOTTERY_CONFIG, seedDelayBlocks: 0 }))
            .toThrow(/at least 1/);
    });

    test('a seed delay past the period end is refused', () => {
        expect(() => validateLotteryConfig({
            ...DEFAULT_LOTTERY_CONFIG, seedDelayBlocks: 172800,
        })).toThrow(/inside the period/);
    });

    test('out-of-range periods and weights are refused', () => {
        expect(() => validateLotteryConfig({ ...DEFAULT_LOTTERY_CONFIG, periodBlocks: 10 }))
            .toThrow(/period_blocks/);
        expect(() => validateLotteryConfig({ ...DEFAULT_LOTTERY_CONFIG, periodBlocks: 99999999 }))
            .toThrow(/period_blocks/);
        expect(() => validateLotteryConfig({ ...DEFAULT_LOTTERY_CONFIG, baseWeight: -1n }))
            .toThrow(/base_weight/);
        expect(() => validateLotteryConfig({ ...DEFAULT_LOTTERY_CONFIG, baseWeight: 2000000n }))
            .toThrow(/base_weight/);
    });

    test('base weight zero is allowed — it is a policy, not a mistake', () => {
        expect(() => validateLotteryConfig({ ...DEFAULT_LOTTERY_CONFIG, baseWeight: 0n }))
            .not.toThrow();
    });

    test('an absent contract row falls back to the documented defaults', () => {
        // An un-configured contract should run the feature on defaults rather
        // than disable it.
        expect(lotteryConfigFromRow(null)).toEqual({ ...DEFAULT_LOTTERY_CONFIG });
        expect(lotteryConfigFromRow(undefined)).toEqual({ ...DEFAULT_LOTTERY_CONFIG });
    });

    test('a contract row is read, including the numeric strings RPC returns', () => {
        // get_table_rows renders uint64 as a string; BigInt(string) is exact
        // where Number would lose precision at the top of the range.
        const config = lotteryConfigFromRow({
            base_weight: '7', period_blocks: 1200, seed_delay_blocks: 60,
        });
        expect(config).toEqual({ baseWeight: 7n, periodBlocks: 1200, seedDelayBlocks: 60 });
    });

    test('a row the contract would have refused is refused here too', () => {
        // Guards against an older contract version, or a hand-made fixture,
        // quietly producing a manipulable draw.
        expect(() => lotteryConfigFromRow({
            base_weight: '1', period_blocks: 172800, seed_delay_blocks: 0,
        })).toThrow(/at least 1/);
    });

    test('a shorter period still produces a coherent schedule', () => {
        const short = { baseWeight: 1n, periodBlocks: 1200, seedDelayBlocks: 60 };
        expect(() => validateLotteryConfig(short)).not.toThrow();

        const resolved = resolvePeriod(1200 * 4 + 60, short);
        expect(resolved.index).toBe(4);
        expect(resolved.snapshotBlock).toBe(4800);
        expect(resolved.seedBlock).toBe(4860);
    });
});
