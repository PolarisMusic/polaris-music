/**
 * Crypto helper endpoints used by the frontend's signing pipeline.
 *
 * Mounted at /api/crypto. Extracted from `api/server.js` (Stage I).
 *
 *   POST /api/crypto/resolve-signing-key
 *
 * @module api/routes/crypto
 */

import express from 'express';
import { createHash } from 'crypto';
import { PublicKey, Signature } from 'eosjs/dist/eosjs-key-conversions.js';
import { sanitizeError } from '../../utils/errorSanitizer.js';

/**
 * @param {Object} ctx
 * @param {Object} ctx.ingestionHandler  - exposes fetchAccountData()
 * @param {Object} ctx.config            - server config (rpcUrl, env)
 * @returns {express.Router}
 */
export function createCryptoRoutes({ ingestionHandler, config }) {
    const router = express.Router();

    /**
     * POST /api/crypto/resolve-signing-key
     * Determine which of an account's permission keys produced a given signature.
     *
     * When the wallet does not return the signing public key (signingKey is null
     * on the frontend), the frontend calls this endpoint so the backend can
     * try each key in the permission and return the one that verifies.
     *
     * Request body:
     *   { account, permission, canonical_payload, signature }
     *
     * Response (200): { success: true, signing_key }
     * Response (400): missing/invalid fields
     * Response (404): no matching key found
     */
    router.post('/resolve-signing-key', async (req, res) => {
        try {
            // RPC is required for key resolution — fail clearly if unavailable
            const rpcUrl = process.env.RPC_URL || config.rpcUrl;
            if (!rpcUrl) {
                return res.status(503).json({
                    success: false,
                    error: 'RPC_URL not configured — cannot resolve signing keys'
                });
            }

            const { account, permission, canonical_payload, signature } = req.body;

            if (!account || !permission || !canonical_payload || !signature) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required fields: account, permission, canonical_payload, signature'
                });
            }

            // Hash the canonical payload (same as verifyEventSignature)
            const payloadHash = createHash('sha256')
                .update(canonical_payload)
                .digest();

            let sig;
            try {
                sig = Signature.fromString(signature);
            } catch (parseErr) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid signature format: ${parseErr.message}`
                });
            }

            const accountData = await ingestionHandler.fetchAccountData(account);
            if (!accountData) {
                return res.status(400).json({
                    success: false,
                    error: `Cannot fetch account data for '${account}'`
                });
            }

            const perm = accountData.permissions?.find(p => p.perm_name === permission);
            if (!perm) {
                return res.status(400).json({
                    success: false,
                    error: `Permission '${permission}' not found for account '${account}'`
                });
            }

            const keys = perm.required_auth?.keys || [];
            if (keys.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: `No keys found in permission '${permission}' for account '${account}'`
                });
            }

            // Try each key until one verifies
            for (const keyEntry of keys) {
                try {
                    const pubKey = PublicKey.fromString(keyEntry.key);
                    if (sig.verify(payloadHash, pubKey)) {
                        return res.json({
                            success: true,
                            signing_key: keyEntry.key
                        });
                    }
                } catch {
                    // Key parse/verify failure — skip to next key
                }
            }

            return res.status(404).json({
                success: false,
                error: 'Signature does not match any key in the specified permission'
            });
        } catch (error) {
            console.error('resolve-signing-key failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    return router;
}
