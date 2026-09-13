/**
 * Period arithmetic for the sponsored-node lottery.
 *
 * Turns a chain height into the three block numbers a draw is defined by, and
 * decides which period is currently answerable. Pure, integer-only, and
 * deliberately separate from the draw itself (`sponsoredNode.js`) and from
 * anything that talks to a chain — these are the numbers a third party
 * recomputes to check a result, so they must not depend on when or where the
 * code runs.
 *
 * Periods are counted in blocks, not seconds:
 *
 *     period P        = floor(block / period_blocks)
 *     snapshot block  = P * period_blocks          ← stakes are fixed here
 *     seed block      = snapshot + seed_delay      ← its id is the randomness
 *
 * Missed rounds make a period slightly longer than 24h in wall-clock terms.
 * That is the cost of a boundary anyone can recompute from a block number
 * alone, with no clock and no agreement about time zones.
 *
 * @module api/lotteryPeriod
 */

/** Mirrors the contract defaults in `lottery_config` (polaris.music.cpp). */
export const DEFAULT_LOTTERY_CONFIG = Object.freeze({
    baseWeight: 1n,
    periodBlocks: 172800,      // 24h at half-second blocks
    seedDelayBlocks: 120,      // about a minute
});

/**
 * Reject a configuration the contract itself would reject.
 *
 * Mirrored rather than trusted because this runs against whatever the chain
 * returns, including a table written by an older contract version or a
 * hand-crafted local fixture. The two that matter are the seed delay bounds:
 * at zero the seed is knowable at the instant stakes are fixed, so it can be
 * staked against; at or beyond the period length the seed falls into the next
 * period and two periods draw from one seed.
 *
 * @param {{baseWeight: bigint, periodBlocks: number, seedDelayBlocks: number}} config
 * @throws {Error}
 */
export function validateLotteryConfig(config) {
    const { baseWeight, periodBlocks, seedDelayBlocks } = config;

    if (typeof baseWeight !== 'bigint' || baseWeight < 0n || baseWeight > 1000000n) {
        throw new Error(`base_weight must be a bigint in 0..1000000, got ${baseWeight}`);
    }
    if (!Number.isInteger(periodBlocks) || periodBlocks < 120 || periodBlocks > 5184000) {
        throw new Error(`period_blocks must be an integer in 120..5184000, got ${periodBlocks}`);
    }
    if (!Number.isInteger(seedDelayBlocks) || seedDelayBlocks < 1) {
        throw new Error(`seed_delay_blocks must be at least 1, got ${seedDelayBlocks}`);
    }
    if (seedDelayBlocks >= periodBlocks) {
        throw new Error(
            `seed_delay_blocks (${seedDelayBlocks}) must fall inside the period (${periodBlocks})`
        );
    }
}

/**
 * The period a block belongs to.
 *
 * @param {number} blockNum
 * @param {number} periodBlocks
 * @returns {number}
 */
export function periodIndexFor(blockNum, periodBlocks) {
    return Math.floor(blockNum / periodBlocks);
}

/**
 * The block at which stakes are fixed for a period.
 *
 * @param {number} periodIndex
 * @param {number} periodBlocks
 * @returns {number}
 */
export function snapshotBlockFor(periodIndex, periodBlocks) {
    return periodIndex * periodBlocks;
}

/**
 * The block whose id seeds a period's draw.
 *
 * @param {number} periodIndex
 * @param {{periodBlocks: number, seedDelayBlocks: number}} config
 * @returns {number}
 */
export function seedBlockFor(periodIndex, config) {
    return snapshotBlockFor(periodIndex, config.periodBlocks) + config.seedDelayBlocks;
}

/**
 * The most recent period whose draw can actually be computed and will not
 * change under it.
 *
 * Two things decide this. The seed block has to exist — for the first
 * `seed_delay_blocks` of a period it does not, so the answerable period is
 * still the previous one. And it has to be *irreversible*: a seed block that a
 * fork could replace would silently change the winner, so this takes the last
 * irreversible block rather than the head. On a live chain that costs roughly
 * another three minutes at the start of each period, during which the previous
 * period's node stays up.
 *
 * @param {number} lastIrreversibleBlock - from get_info
 * @param {{periodBlocks: number, seedDelayBlocks: number}} config
 * @returns {{index: number, snapshotBlock: number, seedBlock: number} | null}
 *          null before the chain is old enough to have finished a period
 */
export function resolvePeriod(lastIrreversibleBlock, config) {
    if (!Number.isInteger(lastIrreversibleBlock) || lastIrreversibleBlock < 1) return null;

    let index = periodIndexFor(lastIrreversibleBlock, config.periodBlocks);

    // Inside the seed delay the seed block is not irreversible yet, so the
    // answerable period is the one before.
    if (lastIrreversibleBlock < seedBlockFor(index, config)) index -= 1;

    if (index < 0) return null;

    const snapshotBlock = snapshotBlockFor(index, config.periodBlocks);

    // Block numbering starts at 1, so period 0's snapshot block does not
    // exist. Only reachable on a chain younger than one period — a fresh local
    // node — but that is exactly where someone runs this for the first time.
    if (snapshotBlock < 1) return null;

    return { index, snapshotBlock, seedBlock: seedBlockFor(index, config) };
}

/**
 * Read the contract's `lottery` singleton row into the shape used here.
 *
 * Tolerates the row being absent: an un-configured contract should run on the
 * documented defaults rather than disable the feature.
 *
 * @param {object|null|undefined} row - as returned by get_table_rows
 * @returns {{baseWeight: bigint, periodBlocks: number, seedDelayBlocks: number}}
 */
export function lotteryConfigFromRow(row) {
    if (!row) return { ...DEFAULT_LOTTERY_CONFIG };

    const config = {
        baseWeight: row.base_weight == null
            ? DEFAULT_LOTTERY_CONFIG.baseWeight
            : BigInt(row.base_weight),
        periodBlocks: row.period_blocks == null
            ? DEFAULT_LOTTERY_CONFIG.periodBlocks
            : Number(row.period_blocks),
        seedDelayBlocks: row.seed_delay_blocks == null
            ? DEFAULT_LOTTERY_CONFIG.seedDelayBlocks
            : Number(row.seed_delay_blocks),
    };

    validateLotteryConfig(config);
    return config;
}
