/**
 * ClaimManager - Handles EDIT_CLAIM submissions (type=31) for property edits.
 *
 * Uses anchor-auth pipeline: prepare -> store (no sig) -> anchor on-chain
 * via transact() -> confirm-anchor -> dev-ingest.
 * The on-chain transaction serves as proof of authorship.
 */

import { api } from '../utils/api.js';
import { TransactionBuilder } from '../utils/transactionBuilder.js';
import { INGEST_MODE, CONTRACT_ACCOUNT } from '../config/chain.js';

export class ClaimManager {
    constructor(walletManager) {
        this.walletManager = walletManager;
        this.transactionBuilder = new TransactionBuilder();
    }

    /**
     * Submit a field edit as an EDIT_CLAIM event (type=31).
     *
     * Pipeline (anchor-auth flow):
     *   prepare → store without sig → anchor on-chain via transact()
     *   → confirm anchor → dev-ingest
     *
     * @param {string} nodeType - Entity type ('person', 'group', etc.)
     * @param {string} nodeId   - Entity ID (person_id, group_id, etc.)
     * @param {string} field    - Property name to edit
     * @param {*}      value    - New value
     * @param {Object} [source] - Optional source attribution { url, type? }
     * @returns {Promise<Object>} { success, eventHash, transactionId }
     */
    async submitEdit(nodeType, nodeId, field, value, source) {
        if (!this.walletManager || !this.walletManager.isConnected()) {
            throw new Error('Wallet not connected');
        }

        const session = this.walletManager.getSession();
        const authorAccount = String(session.actor);
        const authorPermission = String(session.permission);

        // 1. Build EDIT_CLAIM event (without sig)
        const body = {
            node: { type: nodeType, id: nodeId },
            field,
            value
        };
        if (source && source.url) {
            body.source = source;
        }

        const event = {
            v: 1,
            type: 'EDIT_CLAIM',
            author_pubkey: authorAccount, // Account name as metadata (not used for signing)
            created_at: Math.floor(Date.now() / 1000),
            parents: [],
            body
        };

        // 2. Prepare (normalize + canonical hash)
        let prepared = await api.prepareEvent(event);

        if (!prepared.normalizedEvent) {
            throw new Error(
                'Backend /api/events/prepare did not return normalizedEvent. ' +
                'This is required for pipeline integrity.'
            );
        }

        let normalizedEvent = prepared.normalizedEvent;
        let eventHash = prepared.hash;

        // 3. Store event using anchor-auth flow (no off-chain signature needed).
        // The on-chain put() transaction serves as proof of authorship.
        const storageResult = await api.storeEventForAnchor(
            normalizedEvent,
            authorAccount,
            authorPermission,
            eventHash
        );
        const eventCid = storageResult?.stored?.event_cid
            || storageResult.cid || storageResult.event_cid || '';

        // 4. Anchor on-chain via put() with type=31
        const action = this.transactionBuilder.buildAnchorAction(
            eventHash, authorAccount, eventCid, {
                type: 31,
                tags: ['claim', 'edit']
            }
        );

        const txResult = await this.walletManager.transact(action);
        const transactionId = txResult?.resolved?.transaction?.id
            || txResult?.transaction_id || '';

        // 5. Confirm anchor with backend
        try {
            await api.confirmAnchor({
                hash: eventHash,
                event_cid: eventCid,
                trx_id: transactionId,
                author_account: authorAccount,
                author_permission: authorPermission
            });
        } catch (confirmErr) {
            console.warn('Anchor confirmation failed (non-fatal):', confirmErr.message);
        }

        // 6. Dev-mode ingestion
        if (INGEST_MODE === 'dev') {
            try {
                const actionData = {
                    author: authorAccount,
                    type: 31,
                    hash: eventHash,
                    event_cid: eventCid,
                    parent: null,
                    ts: Math.floor(Date.now() / 1000),
                    tags: ['claim', 'edit'],
                };

                await api.ingestAnchoredEvent({
                    content_hash: eventHash,
                    payload: JSON.stringify(actionData),
                    contract_account: CONTRACT_ACCOUNT,
                    action_name: 'put',
                    trx_id: transactionId,
                    timestamp: Math.floor(Date.now() / 1000),
                    block_num: txResult?.resolved?.transaction?.block_num || 0,
                    block_id: '',
                    action_ordinal: 0,
                    source: 'ui-dev',
                });
            } catch (ingestError) {
                console.error('Dev-mode edit ingestion failed:', ingestError);
            }
        }

        return { success: true, eventHash, transactionId };
    }
}
