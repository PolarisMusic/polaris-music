/**
 * Balances and per-node stake totals.
 *
 * Three numbers make up an account's position, and they come from three
 * different places, which is worth stating because it is not obvious:
 *
 *   liquid   the token contract's own `accounts` table, scoped to the account
 *   staked   the graph's stake ledger, which knows the per-node breakdown
 *   pending  the registry contract's `pendingrwd`, scoped to the account —
 *            the table has no account column because the scope *is* the
 *            account
 *
 * @module api/stakeService
 */

import { createLogger } from '../utils/logger.js';
import { toChainId } from './sponsoredNodeService.js';

const log = createLogger('api.stake');

/** How long the node-stake table is reused before being re-read. */
const NODEAGG_TTL_MS = 30_000;

/**
 * Split an Antelope symbol string into its parts.
 *
 * `global_state.token_symbol` serializes as "4,MUS": precision first, then the
 * code.
 *
 * @param {string} symbol
 * @returns {{precision: number, code: string}}
 */
export function parseSymbol(symbol) {
    const [precision, code] = String(symbol ?? '4,MUS').split(',');
    return { precision: Number(precision) || 0, code: code || 'MUS' };
}

/**
 * Render integer units as the asset string a person reads.
 *
 * Done with string surgery rather than division, because dividing by 10^4 puts
 * the value through a double and a large balance would come back subtly wrong
 * in the last place — which is exactly the digit someone checking their own
 * tokens will look at.
 *
 * @param {bigint|string|number} units
 * @param {number} precision
 * @param {string} code
 * @returns {string} e.g. "12.3456 MUS"
 */
export function formatUnits(units, precision, code) {
    const value = BigInt(units ?? 0);
    const negative = value < 0n;
    const digits = (negative ? -value : value).toString().padStart(precision + 1, '0');

    const whole = digits.slice(0, digits.length - precision) || '0';
    const frac = precision > 0 ? `.${digits.slice(digits.length - precision)}` : '';
    return `${negative ? '-' : ''}${whole}${frac} ${code}`;
}

/**
 * Read an asset string back to integer units.
 *
 * Pass the symbol's precision whenever it is known. Without it the scale is
 * taken from the decimal places present, which is right for anything the chain
 * serialized — an asset always renders its full precision, so "7 MUS" is not a
 * string nodeos produces — but silently wrong by a factor of ten thousand for
 * a hand-written "7 MUS" at precision 4. That is a bad way to be wrong about
 * somebody's tokens, so the caller is given a way to be explicit.
 *
 * @param {string} asset
 * @param {number|null} [precision] - the symbol's precision, when known
 * @returns {bigint}
 */
export function assetToUnits(asset, precision = null) {
    const match = String(asset ?? '').trim().match(/^(-?\d+)(?:\.(\d+))?\s+[A-Z]{1,7}$/);
    if (!match) return 0n;

    const [, whole, frac = ''] = match;
    const negative = whole.startsWith('-');

    // Pad or truncate the fraction to the target scale. Truncation only ever
    // discards digits the symbol cannot represent anyway.
    const scale = precision == null ? frac.length : precision;
    const scaled = scale === 0 ? '' : frac.padEnd(scale, '0').slice(0, scale);

    const magnitude = BigInt(negative ? whole.slice(1) : whole) * (10n ** BigInt(scale))
        + (scaled === '' ? 0n : BigInt(scaled));
    return negative ? -magnitude : magnitude;
}

export class StakeService {
    /**
     * @param {object} deps
     * @param {object} deps.graph - MusicGraphDatabase (getAccountStakes)
     * @param {object} deps.chain - ChainReaderService
     */
    constructor({ graph, chain }) {
        this.graph = graph;
        this.chain = chain;

        this._nodeagg = null;
        this._nodeaggAt = 0;
        this._token = null;
    }

    /**
     * The token contract and symbol, from the registry contract's globals.
     *
     * Read from the chain rather than from config so the two cannot drift: the
     * contract is the thing that decides which token it escrows.
     *
     * @private
     */
    async _tokenInfo() {
        if (this._token) return this._token;

        const resp = await this.chain.getTableRows({
            code: this.chain.contractAccount,
            scope: this.chain.contractAccount,
            table: 'globals',
            limit: 1,
        });
        const row = resp?.rows?.[0];

        this._token = {
            contract: row?.token_contract || 'polaristoken',
            ...parseSymbol(row?.token_symbol),
        };
        return this._token;
    }

    /**
     * The whole `nodeagg` table, briefly cached.
     *
     * Cached and read whole rather than looked up per node on purpose.
     * Querying one row means hitting the `bynode` secondary index, and
     * checksum256 index bounds over get_table_rows have byte-order behaviour
     * that is easy to get subtly wrong and impossible to verify without a
     * chain. The table only has a row per *staked* node, so reading it whole
     * is cheap, and a selection-driven UI asks about many nodes in a burst.
     *
     * @private
     */
    async _nodeAggregates() {
        const fresh = this._nodeagg && (Date.now() - this._nodeaggAt) < NODEAGG_TTL_MS;
        if (fresh) return this._nodeagg;

        const rows = new Map();
        let lowerBound;
        for (let page = 0; page < 200; page++) {
            const resp = await this.chain.getTableRows({
                code: this.chain.contractAccount,
                scope: this.chain.contractAccount,
                table: 'nodeagg',
                limit: 500,
                lower_bound: lowerBound,
            });
            for (const row of resp?.rows ?? []) {
                if (row?.node_id) rows.set(String(row.node_id).toLowerCase(), row);
            }
            if (!resp?.more || !resp?.next_key) break;
            lowerBound = resp.next_key;
        }

        this._nodeagg = rows;
        this._nodeaggAt = Date.now();
        return rows;
    }

    /**
     * How much is staked on one node, and by how many accounts.
     *
     * Answers for an unstaked node too — zero is a real answer here, and the
     * UI needs something to show beside every node rather than only the
     * handful that happen to have backers.
     *
     * @param {string} nodeId - graph node id
     * @returns {Promise<{nodeId: string, chainId: string, units: string, formatted: string, stakerCount: number}>}
     */
    async getNodeStake(nodeId) {
        const chainId = toChainId(nodeId);
        const { precision, code } = await this._tokenInfo();

        let row = null;
        try {
            row = (await this._nodeAggregates()).get(chainId) ?? null;
        } catch (error) {
            log.warn('node_stake_unavailable', { nodeId, error: error.message });
        }

        const units = row ? assetToUnits(row.total, precision) : 0n;
        return {
            nodeId,
            chainId,
            units: units.toString(),
            formatted: formatUnits(units, precision, code),
            stakerCount: Number(row?.staker_count ?? 0),
        };
    }

    /**
     * An account's position: what it can spend, what it has staked, and what
     * it can claim.
     *
     * Every part degrades on its own. A token contract that cannot be reached
     * should not cost you the sight of your staked positions, so each read is
     * settled separately and a failure becomes zero plus a warning rather than
     * an error for the whole balance.
     *
     * @param {string} account
     * @returns {Promise<object>}
     */
    async getAccountBalance(account) {
        const { contract, precision, code } = await this._tokenInfo();

        const [liquidUnits, staked, pendingUnits] = await Promise.all([
            this._liquidUnits(account, contract, code, precision),
            this._stakedPositions(account),
            this._pendingUnits(account, precision),
        ]);

        const stakedUnits = BigInt(staked.totalUnits);

        return {
            account,
            symbol: code,
            precision,
            liquid: { units: liquidUnits.toString(), formatted: formatUnits(liquidUnits, precision, code) },
            staked: { units: stakedUnits.toString(), formatted: formatUnits(stakedUnits, precision, code) },
            pending: { units: pendingUnits.toString(), formatted: formatUnits(pendingUnits, precision, code) },
            // Liquid plus staked plus claimable — what the account is worth in
            // this system, which is not a number any single table holds.
            total: {
                units: (liquidUnits + stakedUnits + pendingUnits).toString(),
                formatted: formatUnits(liquidUnits + stakedUnits + pendingUnits, precision, code),
            },
            positions: staked.positions.map((p) => ({
                ...p,
                formatted: formatUnits(BigInt(p.units), precision, code),
            })),
        };
    }

    /** @private */
    async _liquidUnits(account, contract, code, precision) {
        try {
            const resp = await this.chain.getTableRows({
                code: contract, scope: account, table: 'accounts', limit: 20,
            });
            // The table holds one row per symbol the account has ever held.
            const row = (resp?.rows ?? []).find((r) => String(r.balance ?? '').endsWith(` ${code}`));
            return assetToUnits(row?.balance, precision);
        } catch (error) {
            log.warn('liquid_balance_unavailable', { account, error: error.message });
            return 0n;
        }
    }

    /** @private */
    async _stakedPositions(account) {
        try {
            if (!this.graph?.getAccountStakes) return { totalUnits: '0', positions: [] };
            return await this.graph.getAccountStakes(account);
        } catch (error) {
            log.warn('staked_positions_unavailable', { account, error: error.message });
            return { totalUnits: '0', positions: [] };
        }
    }

    /** @private */
    async _pendingUnits(account, precision) {
        try {
            // Scoped to the account: pending_reward has no account column
            // because the scope is the account.
            const resp = await this.chain.getTableRows({
                code: this.chain.contractAccount, scope: account, table: 'pendingrwd', limit: 500,
            });
            return (resp?.rows ?? []).reduce((sum, row) => sum + assetToUnits(row.amount, precision), 0n);
        } catch (error) {
            log.warn('pending_rewards_unavailable', { account, error: error.message });
            return 0n;
        }
    }
}
