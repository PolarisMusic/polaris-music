/**
 * ClaimManager - Handles EDIT_CLAIM submissions (type=31) for property edits.
 *
 * Mirrors the proven "prepare -> sign -> store -> anchor -> dev-ingest" pipeline
 * used by release submissions, but for individual field edits.
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
        const authorPubkey = String(session.publicKey || '');

        // 1. Build EDIT_CLAIM event
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
            author_pubkey: authorPubkey,
            created_at: Math.floor(Date.now() / 1000),
            parents: [],
            body
        };

        // 2. Prepare (normalize + canonical hash)
        const prepared = await api.prepareEvent(event);
        const eventHash = prepared.hash;
        const normalizedEvent = prepared.normalizedEvent || event;

        // 3. Sign canonical payload
        const canonical = JSON.stringify(normalizedEvent);
        let signedEvent = { ...normalizedEvent };

        try {
            const sigResult = await this.walletManager.signString(canonical);
            signedEvent.signature = sigResult.signature || sigResult;
            if (sigResult.pubkey) {
                signedEvent.author_pubkey = sigResult.pubkey;
            }
        } catch (signError) {
            console.warn('Signing skipped or failed:', signError.message);
        }

        // 4. Store to off-chain storage
        const storageResult = await api.storeEvent(signedEvent, eventHash);
        const eventCid = storageResult.cid || storageResult.event_cid || '';

        // 5. Anchor on-chain via put() with type=31
        const action = this.transactionBuilder.buildAnchorAction(
            eventHash, authorAccount, eventCid, {
                type: 31,
                tags: ['claim', 'edit']
            }
        );

        const txResult = await this.walletManager.transact(action);
        const transactionId = txResult?.resolved?.transaction?.id
            || txResult?.transaction_id || '';

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
