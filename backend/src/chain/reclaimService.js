/**
 * @fileoverview Release on-chain RAM for settled curation operations.
 *
 * `reclaim()` has existed in the contract since it was added and had never been
 * called. Its own docstring states the case: once voting has closed and rewards
 * are distributed, the votes, tally and anchor rows decide nothing, yet they sit
 * there at roughly 461, 336 and 552 bytes each, billed to voters and authors.
 *
 * This drives it. The order matters and is not arbitrary:
 *
 *   1. finalize()  — settles escrow. reclaim() refuses before this, because
 *                    while a vote is open its rows still determine who is paid.
 *   2. snapshot    — copy the tally off-chain BEFORE erasing it. Vote weight is
 *                    respect-at-vote-time, which appears in no action trace, so
 *                    this is the only moment the exact figures are available.
 *   3. reclaim()   — erase, in batches, until the anchor is gone.
 *
 * The batching in step 3 is the part worth care. The contract caps each call at
 * MAX_RECLAIM_ROWS vote rows and drops the tally and anchor only once every vote
 * is gone, so an anchor with more votes than the cap needs repeated calls — and
 * the anchor is how a later call finds those votes at all, which is why the
 * contract refuses to erase it early.
 *
 * @module chain/reclaimService
 */

/** The contract's own per-call cap (polaris.music.cpp:1356). */
export const MAX_RECLAIM_ROWS = 100;

/** Refuse to loop forever if the chain stops making progress. */
const MAX_CALLS_PER_ANCHOR = 50;

/**
 * Decide what should happen to an anchor right now.
 *
 * Split out from the doing so the policy is testable without a chain.
 *
 * @param {Object} anchor - Row from the `anchors` table.
 * @param {number} nowSeconds - Current time, Unix seconds.
 * @returns {'finalize'|'reclaim'|'wait'}
 */
export function planFor(anchor, nowSeconds) {
    if (anchor.finalized) return 'reclaim';
    if (Number(anchor.expires_at) <= nowSeconds) return 'finalize';
    return 'wait';
}

/**
 * Reclaim every settled anchor.
 *
 * @param {Object} deps
 * @param {Object} deps.chain - { getAnchors(), getAnchor(hash), getTally(id),
 *   finalize(hash), reclaim(hash, maxRows) }.
 * @param {Object} [deps.graph] - Exposes recordFinalization(); optional so a dry
 *   run needs no database.
 * @param {boolean} [deps.execute=false] - False reports what it would do and
 *   signs nothing. Destructive and irreversible, so this is opt-in.
 * @param {(msg: string, data?: Object) => void} [deps.log]
 * @param {() => number} [deps.now] - Injectable clock, Unix seconds.
 * @returns {Promise<{finalized: string[], reclaimed: string[], waiting: number,
 *   failed: {hash: string, stage: string, error: string}[], calls: number}>}
 */
export async function reclaimSettledAnchors({
    chain, graph = null, execute = false, log = () => {},
    now = () => Math.floor(Date.now() / 1000)
}) {
    const result = { finalized: [], reclaimed: [], waiting: 0, failed: [], calls: 0 };
    const anchors = await chain.getAnchors();
    const nowSeconds = now();

    for (const anchor of anchors) {
        const hash = anchor.hash;
        let plan = planFor(anchor, nowSeconds);

        if (plan === 'wait') {
            result.waiting++;
            continue;
        }

        if (plan === 'finalize') {
            if (!execute) {
                log('would_finalize', { hash });
                result.finalized.push(hash);
                // Reclaiming needs the finalize to have actually landed, so a
                // dry run reports the first step only rather than pretending
                // it can see past it.
                continue;
            }
            try {
                await chain.finalize(hash);
                result.calls++;
                result.finalized.push(hash);
                plan = 'reclaim';
            } catch (error) {
                result.failed.push({ hash, stage: 'finalize', error: error.message });
                continue;
            }
        }

        if (execute && graph?.recordFinalization) {
            try {
                const tally = await chain.getTally(anchor.id);
                await graph.recordFinalization({
                    eventHash: hash, blockNum: 0, tally: tally ?? null
                });
            } catch (error) {
                // A missing snapshot loses the tally but not the operation, so
                // it must not stop the reclaim that frees the RAM.
                log('snapshot_failed', { hash, error: error.message });
            }
        }

        if (!execute) {
            log('would_reclaim', { hash });
            result.reclaimed.push(hash);
            continue;
        }

        try {
            await reclaimUntilGone(chain, hash, result);
            result.reclaimed.push(hash);
        } catch (error) {
            result.failed.push({ hash, stage: 'reclaim', error: error.message });
        }
    }

    return result;
}

/**
 * Call reclaim() until the anchor no longer exists.
 *
 * Termination is by the anchor disappearing, not by a predicted vote count: the
 * contract decides when it is done, and asking it is more reliable than
 * modelling it.
 *
 * @param {Object} chain
 * @param {string} hash
 * @param {Object} result - Mutated to count calls.
 * @private
 */
async function reclaimUntilGone(chain, hash, result) {
    for (let attempt = 0; attempt < MAX_CALLS_PER_ANCHOR; attempt++) {
        await chain.reclaim(hash, MAX_RECLAIM_ROWS);
        result.calls++;

        if (!await chain.getAnchor(hash)) return;
    }
    throw new Error(
        `anchor still present after ${MAX_CALLS_PER_ANCHOR} reclaim calls — ` +
        'stopping rather than looping, since this means the contract is not ' +
        'making progress');
}
