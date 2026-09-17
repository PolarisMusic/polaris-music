/**
 * Stake and balance endpoints.
 *
 * Mounted at /api/stake.
 *
 *   GET /api/stake/node/:nodeId      how much is staked on one node
 *   GET /api/stake/account/:account  liquid, staked, pending, and where
 *
 * @module api/routes/stake
 */

import express from 'express';

/**
 * @param {Object} ctx
 * @param {Object} [ctx.stakeService]
 * @returns {express.Router}
 */
export function createStakeRoutes({ stakeService = null }) {
    const router = express.Router();

    const unavailable = (res) =>
        res.status(503).json({ success: false, error: 'Stake data is unavailable' });

    /**
     * GET /api/stake/node/:nodeId
     *
     * Answers for an unstaked node too. Zero is a real answer: the panel shows
     * this beside every node, not only the ones with backers.
     */
    router.get('/node/:nodeId', async (req, res) => {
        if (!stakeService) return unavailable(res);

        try {
            const stake = await stakeService.getNodeStake(req.params.nodeId);
            res.json({ success: true, ...stake });
        } catch (error) {
            unavailable(res);
        }
    });

    /**
     * GET /api/stake/account/:account
     *
     * The three numbers come from three places and each degrades on its own —
     * an unreachable token contract costs you the liquid figure, not the sight
     * of your staked positions.
     */
    router.get('/account/:account', async (req, res) => {
        if (!stakeService) return unavailable(res);

        // Antelope names: a-z, 1-5, dot, at most 12 characters. Rejected here
        // rather than passed through as a table scope.
        const account = String(req.params.account || '').toLowerCase();
        if (!/^[a-z1-5.]{1,12}$/.test(account)) {
            return res.status(400).json({ success: false, error: 'Not a valid account name' });
        }

        try {
            const balance = await stakeService.getAccountBalance(account);
            res.json({ success: true, ...balance });
        } catch (error) {
            unavailable(res);
        }
    });

    return router;
}
