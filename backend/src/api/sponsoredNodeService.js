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
import { drawSponsoredNode } from './sponsoredNode.js';
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
     * @private
     */
    async _draw(period, config) {
        const [candidates, seedHex, stakes] = await Promise.all([
            this.graph.getLotteryCandidates(),
            this.chain.getBlockId(period.seedBlock),
            this.chain.getNodeStakes(),
        ]);

        if (!candidates?.length) {
            log.debug('no_eligible_candidates');
            return null;
        }

        const withStakes = candidates.map((candidate) => {
            const chainId = toChainId(candidate.nodeId);
            return { ...candidate, chainId, stakeUnits: stakes.get(chainId) ?? 0n };
        });

        const draw = drawSponsoredNode(withStakes, seedHex, { baseWeight: config.baseWeight });
        if (!draw) return null;

        const staked = withStakes.filter((c) => stakes.has(c.chainId)).length;

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
                // Named rather than implied: these stakes were read now, not
                // as of snapshot_block, because get_table_rows cannot read
                // past state. See §7.1 of the spec. A verifier reading this
                // field knows the snapshot-before-seed ordering is not yet
                // what it will be.
                stake_source: 'current_state',
            },
        };
    }
}
