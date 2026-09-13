/**
 * Chain Reader Service
 *
 * Proxies blockchain table reads through the backend so the browser
 * never needs direct RPC access to chain nodes. This eliminates
 * CSP/CORS issues and prevents config drift between frontend chain
 * mode and allowed RPC hosts.
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('api.chainReader');

export class ChainReaderService {
    constructor(config = {}) {
        this.rpcUrl = config.rpcUrl || process.env.RPC_URL || 'https://jungle4.greymass.com';
        this.contractAccount = config.contractAccount || process.env.CONTRACT_ACCOUNT || 'polarismusic';
        // Likes are no longer a contract table, so this reads them from the
        // graph projection instead of the chain. Optional: without it the
        // endpoint reports an empty list rather than failing.
        this.graph = config.graph || null;
    }

    /**
     * Generic get_table_rows proxy
     */
    async getTableRows({ code, scope, table, limit = 200, lower_bound, upper_bound, index_position, key_type, reverse = false }) {
        const body = {
            json: true,
            code,
            scope,
            table,
            limit,
            reverse
        };
        if (lower_bound !== undefined) body.lower_bound = lower_bound;
        if (upper_bound !== undefined) body.upper_bound = upper_bound;
        if (index_position !== undefined) body.index_position = index_position;
        if (key_type !== undefined) body.key_type = key_type;

        const resp = await fetch(`${this.rpcUrl}/v1/chain/get_table_rows`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`get_table_rows failed: ${resp.status} ${resp.statusText} ${text}`);
        }

        return resp.json();
    }

    /**
     * Chain head and, more importantly, the last irreversible block.
     *
     * The lottery resolves its period against irreversibility rather than the
     * head: a seed block a fork could still replace would silently change
     * which node the front page opens on.
     *
     * @returns {Promise<{headBlock: number, lastIrreversibleBlock: number}>}
     */
    async getChainInfo() {
        const resp = await fetch(`${this.rpcUrl}/v1/chain/get_info`);
        if (!resp.ok) {
            throw new Error(`get_info failed: ${resp.status} ${resp.statusText}`);
        }
        const info = await resp.json();
        return {
            headBlock: Number(info.head_block_num),
            lastIrreversibleBlock: Number(info.last_irreversible_block_num),
        };
    }

    /**
     * The id of one block — the lottery's source of randomness.
     *
     * get_block_info rather than get_block: the id is all that is wanted and
     * the header-only endpoint does not carry the transactions.
     *
     * @param {number} blockNum
     * @returns {Promise<string>} 64-character block id
     */
    async getBlockId(blockNum) {
        const resp = await fetch(`${this.rpcUrl}/v1/chain/get_block_info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ block_num: blockNum }),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`get_block_info(${blockNum}) failed: ${resp.status} ${text}`);
        }
        const block = await resp.json();
        if (!block?.id) throw new Error(`get_block_info(${blockNum}) returned no id`);
        return String(block.id).toLowerCase();
    }

    /**
     * The lottery rules, from the contract's `lottery` singleton.
     *
     * Absent row means the contract has never been configured, which is not an
     * error — the caller falls back to the documented defaults.
     *
     * @returns {Promise<object|null>}
     */
    async getLotteryConfig() {
        const resp = await this.getTableRows({
            code: this.contractAccount,
            scope: this.contractAccount,
            table: 'lottery',
            limit: 1,
        });
        return resp?.rows?.[0] ?? null;
    }

    /**
     * Every node with stake on it, from `nodeagg`.
     *
     * Paged because the table grows with the registry and get_table_rows caps
     * a single response; `more`/`next_key` is the chain's own cursor.
     *
     * NOTE ON CORRECTNESS: this is a *current state* read. A plain nodeos
     * cannot answer "what did nodeagg hold at block B", so this cannot give
     * the stake snapshot the design calls for — see §7.1 of
     * docs/15-sponsored-node-lottery.md. The caller labels results read this
     * way so the weaker guarantee is visible in the response rather than
     * buried here.
     *
     * @param {number} [pageLimit]
     * @returns {Promise<Map<string, string>>} chain node id -> staked asset
     */
    async getNodeStakes(pageLimit = 500) {
        const stakes = new Map();
        let lowerBound;

        for (let page = 0; page < 200; page++) {
            const resp = await this.getTableRows({
                code: this.contractAccount,
                scope: this.contractAccount,
                table: 'nodeagg',
                limit: pageLimit,
                lower_bound: lowerBound,
            });

            for (const row of resp?.rows ?? []) {
                if (row?.node_id) stakes.set(String(row.node_id).toLowerCase(), row.total);
            }

            if (!resp?.more || !resp?.next_key) break;
            lowerBound = resp.next_key;
        }

        return stakes;
    }

    /**
     * Fetch likes for a specific account from the contract table
     * @param {string} account - Blockchain account name
     * @param {number} [limit=200] - Max rows
     * @returns {Promise<Array>} Rows from the likes table
     */
    async getAccountLikes(account, limit = 200) {
        // The contract stopped writing its likes table — nothing on chain ever
        // read it except like()/unlike() checking their own prior write, at
        // ~410 bytes per like. The record is now the action trace, projected
        // into the graph by the indexer.
        if (this.graph?.getAccountLikes) {
            return this.graph.getAccountLikes(account, limit);
        }

        console.warn('getAccountLikes: no graph projection available, returning empty');
        return [];
    }

    /**
     * Fetch vote tally for a specific anchor ID
     * @param {string|number} anchorId - Anchor ID to look up
     * @returns {Promise<Object|null>} Tally row or null
     */
    async getVoteTally(anchorId) {
        const result = await this.getTableRows({
            code: this.contractAccount,
            scope: this.contractAccount,
            table: 'votetally',
            lower_bound: String(anchorId),
            upper_bound: String(anchorId),
            limit: 1
        });
        return (result.rows && result.rows[0]) || null;
    }

    /**
     * Register Express routes for chain reading endpoints
     * @param {express.Router} app - Express app or router
     */
    registerRoutes(app) {
        // GET /api/chain/likes/:account
        app.get('/api/chain/likes/:account', async (req, res) => {
            try {
                const { account } = req.params;
                const limit = parseInt(req.query.limit) || 200;

                if (!account || !/^[a-z1-5.]{1,13}$/.test(account)) {
                    return res.status(400).json({ error: 'Invalid account name' });
                }

                const rows = await this.getAccountLikes(account, limit);
                res.json({ success: true, rows });
            } catch (error) {
                log.error('chain_likes_error', { error: error.message, account: req.params.account });
                res.status(502).json({ success: false, error: 'Failed to fetch likes from chain: ' + error.message });
            }
        });

        // GET /api/chain/votetally/:anchorId
        app.get('/api/chain/votetally/:anchorId', async (req, res) => {
            try {
                const { anchorId } = req.params;
                const tally = await this.getVoteTally(anchorId);
                res.json({ success: true, tally });
            } catch (error) {
                log.error('chain_votetally_error', { error: error.message, anchorId: req.params.anchorId });
                res.status(502).json({ success: false, error: 'Failed to fetch vote tally from chain: ' + error.message });
            }
        });
    }
}
