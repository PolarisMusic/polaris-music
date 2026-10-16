/**
 * ClaimManager - Handles correction events for data already in the registry.
 *
 * Two of them, sharing one pipeline:
 *
 *   - EDIT_CLAIM (type 31) sets one property on one node. A misspelled name, a
 *     wrong release date, a missing catalogue number.
 *   - EDIT_RELATIONSHIP (type 33) moves a person between MEMBER_OF and
 *     GUEST_ON. A property edit cannot express this, because membership is not
 *     a property of anybody — it is an edge, and an edge has two ends.
 *
 * Uses anchor-auth pipeline: prepare -> store (no sig) -> anchor on-chain
 * via transact() -> confirm-anchor -> dev-ingest.
 * The on-chain transaction serves as proof of authorship.
 */

import { api } from '../utils/api.js';
import { TransactionBuilder } from '../utils/transactionBuilder.js';
import { INGEST_MODE, CONTRACT_ACCOUNT } from '../config/chain.js';

/**
 * Event type codes, as the contract writes them.
 *
 * Mirrors backend/src/constants/eventTypes.js. 33 and not 32 because 32 is
 * DELETE_CLAIM, reserved but unimplemented — and a type code goes into an
 * anchor row, which nothing can rewrite.
 */
const EDIT_CLAIM = 31;
const EDIT_RELATIONSHIP = 33;

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
        const body = {
            node: { type: nodeType, id: nodeId },
            field,
            value
        };
        if (source && source.url) {
            body.source = source;
        }

        return this._submit({
            typeName: 'EDIT_CLAIM',
            typeCode: EDIT_CLAIM,
            tags: ['claim', 'edit'],
            body
        });
    }

    /**
     * Submit a member/guest correction as an EDIT_RELATIONSHIP event (type=33).
     *
     * Resubmitting a corrected bundle would not do this. The graph keys each
     * MEMBER_OF and GUEST_ON edge by the claim_id of the submission that made
     * it, so a second submission adds an edge rather than replacing the first
     * one's, and bundle processing deletes no relationships — leaving the
     * person both a member and a guest. Hence a correction event, whose whole
     * job is to retire the edge that is wrong.
     *
     * @param {Object} options
     * @param {string} options.personId  - the person being re-credited
     * @param {string} options.groupId   - the group they are or are not in
     * @param {string} options.to        - 'MEMBER_OF' or 'GUEST_ON'
     * @param {string} [options.releaseId] - narrows a promotion to one release
     * @param {string[]} [options.roles]   - carried from the old edge if absent
     * @param {Object} [options.source]    - { url, type? }
     * @returns {Promise<Object>} { success, eventHash, transactionId }
     */
    async submitRelationshipEdit({ personId, groupId, to, releaseId, roles, source }) {
        if (!personId) throw new Error('A relationship correction needs a person');
        if (!groupId) throw new Error('A relationship correction needs a group');
        if (to !== 'MEMBER_OF' && to !== 'GUEST_ON') {
            throw new Error(`Unknown relationship target: ${to}`);
        }

        const body = {
            person: { id: personId },
            group: { id: groupId },
            to
        };
        if (releaseId) body.release_id = releaseId;
        if (roles && roles.length > 0) body.roles = roles;
        if (source && source.url) body.source = source;

        return this._submit({
            typeName: 'EDIT_RELATIONSHIP',
            typeCode: EDIT_RELATIONSHIP,
            tags: ['claim', 'relationship'],
            body
        });
    }

    /**
     * The anchor-auth pipeline, which is the same for every correction type.
     *
     * prepare (canonical hash) -> store without a signature -> anchor on chain
     * with put() -> confirm -> ingest in dev. The on-chain transaction is the
     * proof of authorship, which is why no off-chain signature is needed.
     *
     * @private
     * @param {Object} options
     * @param {string} options.typeName - as the stored event body carries it
     * @param {number} options.typeCode - as put() writes it on chain
     * @param {string[]} options.tags
     * @param {Object} options.body
     * @returns {Promise<Object>} { success, eventHash, transactionId }
     */
    async _submit({ typeName, typeCode, tags, body }) {
        if (!this.walletManager || !this.walletManager.isConnected()) {
            throw new Error('Wallet not connected');
        }

        const session = this.walletManager.getSession();
        const authorAccount = String(session.actor);
        const authorPermission = String(session.permission);

        const event = {
            v: 1,
            type: typeName,
            author_pubkey: authorAccount, // Account name as metadata (not used for signing)
            created_at: Math.floor(Date.now() / 1000),
            parents: [],
            body
        };

        // 1. Prepare (normalize + canonical hash)
        const prepared = await api.prepareEvent(event);

        if (!prepared.normalizedEvent) {
            throw new Error(
                'Backend /api/events/prepare did not return normalizedEvent. ' +
                'This is required for pipeline integrity.'
            );
        }

        const normalizedEvent = prepared.normalizedEvent;
        const eventHash = prepared.hash;

        // 2. Store event using anchor-auth flow (no off-chain signature needed).
        const storageResult = await api.storeEventForAnchor(
            normalizedEvent,
            authorAccount,
            authorPermission,
            eventHash
        );
        const eventCid = storageResult?.stored?.event_cid
            || storageResult.cid || storageResult.event_cid || '';

        // 3. Anchor on-chain via put()
        const action = this.transactionBuilder.buildAnchorAction(
            eventHash, authorAccount, eventCid, {
                type: typeCode,
                tags
            }
        );

        const txResult = await this.walletManager.transact(action);
        const transactionId = txResult?.resolved?.transaction?.id
            || txResult?.transaction_id || '';

        // 4. Confirm anchor with backend
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

        // 5. Dev-mode ingestion
        if (INGEST_MODE === 'dev') {
            try {
                const actionData = {
                    author: authorAccount,
                    type: typeCode,
                    hash: eventHash,
                    event_cid: eventCid,
                    parent: null,
                    ts: Math.floor(Date.now() / 1000),
                    tags,
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
                console.error(`Dev-mode ${typeName} ingestion failed:`, ingestError);
            }
        }

        return { success: true, eventHash, transactionId };
    }
}
