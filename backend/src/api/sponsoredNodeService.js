/**
 * Assembles the sponsored-node draw from its three sources and caches the
 * answer for the period.
 *
 * The draw itself is in `sponsoredNode.js` and the schedule is in
 * `lotteryPeriod.js`; both are pure. This is the part that talks to a chain
 * and a graph, so it is also the part that has to fail softly: the
 * visualization must still open if the chain is unreachable, the contract is
 * unconfigured, or the registry is empty.
 *
 * @module api/sponsoredNodeService
 */

import { createHash } from 'crypto';
import { createLogger } from '../utils/logger.js';
import { drawSponsoredNode, toUnits } from './sponsoredNode.js';
import { lotteryConfigFromRow, resolvePeriod } from './lotteryPeriod.js';

const log = createLogger('api.sponsoredNode');

/**
 * The node's on-chain identity: sha256 of its graph id.
 *
 * The same derivation `LikeManager.nodeIdToChecksum256()` uses in the browser,
 * and the value the contract's `nodeagg` table is keyed by. Anything already
 * in checksum form is passed through, which is what makes the two sides agree
 * for nodes whose graph id is itself a hash.
 *
 * @param {string} nodeId
 * @returns {string} 64 hex characters
 */
export function toChainId(nodeId) {
    const text = String(nodeId);
    if (/^[a-f0-9]{64}$/i.test(text)) return text.toLowerCase();
    return createHash('sha256').update(text).digest('hex');
}

/**
 * A candidate's stake, summed across every identity it has ever had.
 *
 * Stake is keyed on chain by sha256 of the graph id, and a graph id is not
 * permanent: a provisional id becomes canonical when it resolves, and two
 * nodes become one when they merge. Each of those changes the hash. Counting
 * only the current id would quietly strand every token staked before the
 * change — still in `nodeagg`, still the staker's, but attached to a hash no
 * candidate maps to and therefore buying nothing.
 *
 * Summing instead means the stake follows the artist through a rename or a
 * merge, which is the behaviour a staker would assume they were buying.
 *
 * @param {{nodeId: string, aliasIds?: string[]}} candidate
 * @param {Map<string, unknown>} stakes - chain node id -> staked asset
 * @returns {bigint} units
 */
export function sumStakeAcrossIdentities(candidate, stakes) {
    const identities = [candidate.nodeId, ...(candidate.aliasIds ?? [])];

    // Deduplicated: an alias list that repeated the canonical id, or listed the
    // same merged node twice, would otherwise count its stake more than once.
    const seen = new Set();
    let total = 0n;
    for (const id of identities) {
        if (!id) continue;
        const chainId = toChainId(id);
        if (seen.has(chainId)) continue;
        seen.add(chainId);
        total += toUnits(stakes.get(chainId));
    }
    return total;
}

export class SponsoredNodeService {
    /**
     * @param {object} deps
     * @param {object} deps.graph - MusicGraphDatabase (getLotteryCandidates)
     * @param {object} deps.chain - ChainReaderService
     * @param {number} [deps.now] - injectable clock, for tests
     */
    constructor({ graph, chain }) {
        this.graph = graph;
        this.chain = chain;

        // One draw per period. Not Redis: the value is a few hundred bytes,
        // it is derivable from public inputs, and a cold process recomputing
        // it costs three RPC calls. A shared cache would buy consistency
        // between API instances, which the draw already has by construction —
        // same period, same inputs, same winner.
        this._cache = null;
    }

    /**
     * The node the visualization should open on.
     *
     * @returns {Promise<object|null>} null when no draw can be made
     */
    async getSponsoredNode() {
        try {
            const configRow = await this.chain.getLotteryConfig();
            const config = lotteryConfigFromRow(configRow);

            const { lastIrreversibleBlock } = await this.chain.getChainInfo();
            const period = resolvePeriod(lastIrreversibleBlock, config);

            if (!period) {
                log.debug('no_answerable_period', { lastIrreversibleBlock });
                return null;
            }

            if (this._cache?.period === period.index) return this._cache.result;

            const result = await this._draw(period, config);
            this._cache = { period: period.index, result };
            return result;
        } catch (error) {
            // Deliberately swallowed. A drawn node is an enhancement; the
            // graph opening at all is not. The caller falls back to its own
            // default and the visitor sees a working page.
            log.warn('sponsored_node_unavailable', { error: error.message });
            return null;
        }
    }

    /**
     * Stakes as they stood at the snapshot block, or the best available
     * substitute.
     *
     * The ledger is the right answer: it sums indexed stake and unstake
     * actions up to a block, so it reports what was staked a minute before the
     * seed block existed. Nobody can read the random number and then buy the
     * win.
     *
     * The fallback exists because the ledger only knows what the indexer has
     * seen. Before stake actions have been indexed — a fresh deployment, or
     * history not yet backfilled — it is legitimately empty, and an empty
     * ledger is indistinguishable from "nothing is staked". Falling back to
     * the contract's running total keeps the draw weighted in that window;
     * falling back *silently* would be the problem, so the caller is told
     * which one it got.
     *
     * @private
     * @param {number} snapshotBlock
     * @returns {Promise<{stakes: Map<string, unknown>, stakeSource: string}>}
     */
    async _readStakes(snapshotBlock) {
        if (this.graph?.getStakesAsOfBlock) {
            try {
                const stakes = await this.graph.getStakesAsOfBlock(snapshotBlock);
                if (stakes && stakes.size > 0) return { stakes, stakeSource: 'snapshot' };
            } catch (error) {
                log.warn('stake_snapshot_failed', { error: error.message });
            }
        }

        const stakes = await this.chain.getNodeStakes();
        return { stakes, stakeSource: 'current_state' };
    }

    /**
     * @private
     */
    async _draw(period, config) {
        const [candidates, seedHex, { stakes, stakeSource }] = await Promise.all([
            this.graph.getLotteryCandidates(),
            this.chain.getBlockId(period.seedBlock),
            this._readStakes(period.snapshotBlock),
        ]);

        if (!candidates?.length) {
            log.debug('no_eligible_candidates');
            return null;
        }

        const withStakes = candidates.map((candidate) => {
            const chainId = toChainId(candidate.nodeId);
            return {
                ...candidate,
                chainId,
                stakeUnits: sumStakeAcrossIdentities(candidate, stakes),
            };
        });

        const draw = drawSponsoredNode(withStakes, seedHex, { baseWeight: config.baseWeight });
        if (!draw) return null;

        const staked = withStakes.filter((c) => c.stakeUnits > 0n).length;

        log.info('sponsored_node_drawn', {
            period: period.index,
            node: draw.winner.nodeId,
            candidates: withStakes.length,
            staked,
        });

        return {
            node: {
                id: draw.winner.nodeId,
                name: draw.winner.name,
                type: draw.winner.type,
            },
            // Everything a sceptic needs to recompute the result without
            // trusting this service. The draw is only worth anything if it can
            // be checked, and it cannot be checked from an answer alone.
            draw: {
                period: period.index,
                snapshot_block: period.snapshotBlock,
                seed_block: period.seedBlock,
                seed: seedHex,
                base_weight: config.baseWeight.toString(),
                period_blocks: config.periodBlocks,
                seed_delay_blocks: config.seedDelayBlocks,
                total_weight: draw.totalWeight.toString(),
                offset: draw.offset.toString(),
                candidates: withStakes.length,
                staked_candidates: staked,
                // Which read produced these stakes, because the two carry
                // different guarantees. "snapshot" means they were summed from
                // the indexed ledger as of snapshot_block — fixed a minute
                // before the seed existed, which is the property the design
                // claims. "current_state" means the ledger was empty and the
                // contract's running total was read instead, which happens
                // after the seed is public and is therefore weaker. A verifier
                // should not have to guess which they got.
                stake_source: stakeSource,
            },
        };
    }
}
