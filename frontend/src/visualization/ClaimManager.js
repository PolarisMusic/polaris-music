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
     * Pipeline mirrors index.js submitRelease():
     *   prepare → sign canonical_payload → resolve key → re-prepare if key differs
     *   → store with sig → anchor on-chain → dev-ingest
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
            author_pubkey: authorPubkey,
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
        let canonicalPayload = prepared.canonical_payload;

        // 3. Sign the canonical_payload (NOT JSON.stringify of the event)
        const signResult = await this.walletManager.signMessage(canonicalPayload);
        let signature = signResult.signature;

        // 4. Resolve signing key if wallet didn't return it
        const sessionInfo = this.walletManager.getSessionInfo();
        let actualSigningKey = signResult.signingKey;

        if (!actualSigningKey) {
            actualSigningKey = await api.resolveSigningKey(
                sessionInfo.accountName,
                sessionInfo.permission,
                canonicalPayload,
                signature
            );
        }

        // 5. If signing key differs from pre-fetched key, re-prepare and re-sign
        if (actualSigningKey && actualSigningKey !== authorPubkey) {
            console.warn(
                'Signing key differs from pre-fetched key. ' +
                `Pre-fetched: ${authorPubkey}, Actual: ${actualSigningKey}. ` +
                'Re-preparing event with actual signing key...'
            );

            normalizedEvent.author_pubkey = actualSigningKey;

            const rePrepared = await api.prepareEvent(normalizedEvent);
            normalizedEvent = rePrepared.normalizedEvent;
            eventHash = rePrepared.hash;
            canonicalPayload = rePrepared.canonical_payload;

            const reSignResult = await this.walletManager.signMessage(canonicalPayload);
            signature = reSignResult.signature;
        }

        // 6. Build signed event with `sig` field (NOT `signature`)
        const eventWithSig = {
            ...normalizedEvent,
            sig: signature
        };

        // 7. Store to off-chain storage
        const storageResult = await api.storeEvent(eventWithSig, eventHash);
        const eventCid = storageResult.cid || storageResult.event_cid || '';

        // 8. Anchor on-chain via put() with type=31
        const action = this.transactionBuilder.buildAnchorAction(
            eventHash, authorAccount, eventCid, {
                type: 31,
                tags: ['claim', 'edit']
            }
        );

        const txResult = await this.walletManager.transact(action);
        const transactionId = txResult?.resolved?.transaction?.id
            || txResult?.transaction_id || '';

        // 9. Dev-mode ingestion
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
