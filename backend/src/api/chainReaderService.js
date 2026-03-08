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
     * Fetch likes for a specific account from the contract table
     * @param {string} account - Blockchain account name
     * @param {number} [limit=200] - Max rows
     * @returns {Promise<Array>} Rows from the likes table
     */
    async getAccountLikes(account, limit = 200) {
        const result = await this.getTableRows({
            code: this.contractAccount,
            scope: account,
            table: 'likes',
            limit,
            reverse: true
        });
        return result.rows || [];
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
