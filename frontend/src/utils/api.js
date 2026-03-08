/**
 * API client for Polaris Music Registry backend
 */

import { searchNodes } from './searchClient.js';

/**
 * Normalize API URL to ensure it has the /api prefix
 * @param {string} url - Base URL (with or without /api)
 * @returns {string} URL with /api prefix
 */
function normalizeApiUrl(url) {
    if (!url) return 'http://localhost:3000/api';

    // If it already ends with /api, use as-is
    if (url.endsWith('/api')) {
        return url;
    }

    // If it ends with a slash, remove it before adding /api
    const cleanUrl = url.replace(/\/$/, '');
    return `${cleanUrl}/api`;
}

const API_BASE_URL = normalizeApiUrl(import.meta.env.VITE_API_URL);

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const INGEST_API_KEY = import.meta.env.VITE_INGEST_API_KEY || '';

class APIClient {
    /**
     * Prepare event for signing by normalizing and getting canonical hash
     * @param {Object} event - Event object WITHOUT signature
     * @returns {Promise<Object>} { success: true, hash, normalizedEvent }
     */
    async prepareEvent(event) {
        const response = await fetch(`${API_BASE_URL}/events/prepare`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(event),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || error.message || 'Failed to prepare event');
        }

        return response.json();
    }

    /**
     * Store event to off-chain storage (IPFS + S3 + Redis)
     * @param {Object} event - Complete event object with signature
     * @param {string} expectedHash - Optional expected hash for verification
     * @returns {Promise<Object>} Storage result with hash and locations
     */
    async storeEvent(event, expectedHash = null) {
        const payload = expectedHash ? { ...event, expected_hash: expectedHash } : event;

        const response = await fetch(`${API_BASE_URL}/events/create`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || error.message || 'Failed to store event');
        }

        return response.json();
    }

    /**
     * Store event using anchor-auth flow (no off-chain signature required).
     * The on-chain put() transaction serves as proof of authorship.
     *
     * @param {Object} event - Event object WITHOUT sig
     * @param {string} authorAccount - Blockchain account name
     * @param {string} authorPermission - Permission (e.g. "active")
     * @param {string} [expectedHash] - Expected hash from /api/events/prepare
     * @returns {Promise<Object>} Storage result with hash and locations
     */
    async storeEventForAnchor(event, authorAccount, authorPermission, expectedHash = null) {
        const payload = {
            ...event,
            author_account: authorAccount,
            author_permission: authorPermission
        };
        if (expectedHash) payload.expected_hash = expectedHash;

        const response = await fetch(`${API_BASE_URL}/events/store-for-anchor`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || error.message || 'Failed to store event for anchor');
        }

        return response.json();
    }

    /**
     * Confirm that a stored event has been anchored on-chain.
     * Completes the anchor-auth flow by linking event to blockchain tx.
     *
     * @param {Object} params
     * @param {string} params.hash - Event hash
     * @param {string} params.event_cid - IPFS CID of event
     * @param {string} params.trx_id - Blockchain transaction ID
     * @param {string} params.author_account - Account that submitted the tx
     * @param {string} [params.author_permission] - Permission used
     * @returns {Promise<Object>} Confirmation result
     */
    async confirmAnchor({ hash, event_cid, trx_id, author_account, author_permission }) {
        const response = await fetch(`${API_BASE_URL}/events/confirm-anchor`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ hash, event_cid, trx_id, author_account, author_permission }),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || error.message || 'Failed to confirm anchor');
        }

        return response.json();
    }

    /**
     * Retrieve event from storage by hash
     * @param {string} hash - Event hash
     * @returns {Promise<Object>} Event object
     */
    async retrieveEvent(hash) {
        const response = await fetch(`${API_BASE_URL}/events/${hash}`);

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || error.message || 'Failed to retrieve event');
        }

        const data = await response.json();

        // Unwrap event from response wrapper { success, event }
        if (data && typeof data === 'object' && 'event' in data) {
            if (data.success === false) {
                throw new Error(data.error || 'retrieveEvent failed');
            }
            return data.event;
        }

        // Backward compatibility: if backend returns event directly
        return data;
    }

    /**
     * Resolve which key in an account's permission produced a signature.
     *
     * Used when the wallet does not return the signing public key. The backend
     * tries each key in the specified permission until one verifies.
     *
     * @param {string} account - Blockchain account name
     * @param {string} permission - Permission to inspect (usually "active")
     * @param {string} canonicalPayload - Canonical JSON string that was signed
     * @param {string} signature - SIG_K1_... signature to verify
     * @returns {Promise<string|null>} Matching public key or null
     */
    async resolveSigningKey(account, permission, canonicalPayload, signature) {
        try {
            const response = await fetch(`${API_BASE_URL}/crypto/resolve-signing-key`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    account,
                    permission,
                    canonical_payload: canonicalPayload,
                    signature
                }),
            });

            if (!response.ok) {
                const error = await response.json();
                console.warn('resolve-signing-key failed:', error.error || response.status);
                return null;
            }

            const data = await response.json();
            return data.signing_key || null;
        } catch (error) {
            console.warn('resolve-signing-key request failed:', error.message);
            return null;
        }
    }

    /**
     * Search for existing entities in the database.
     * Delegates to the shared searchClient.
     *
     * @param {string} type - Entity type (person, group, label, city)
     * @param {string} query - Search query
     * @returns {Promise<Array>} Matching entities
     */
    async search(type, query) {
        // Map form field types to Neo4j labels
        const typeMap = {
            person: 'Person',
            group: 'Group',
            label: 'Label',
            city: 'City',
            track: 'Track',
            song: 'Song',
            release: 'Release'
        };
        const mapped = typeMap[type.toLowerCase()] || type;
        return searchNodes(query, { types: [mapped], limit: 10 });
    }

    /**
     * Get details for a specific entity
     * UNIMPLEMENTED: This would fetch full entity details by ID
     *
     * @param {string} type - Entity type
     * @param {string} id - Entity ID
     * @returns {Promise<Object>} Entity details
     */
    async getEntity(type, id) {
        // UNIMPLEMENTED: Would call backend entity endpoint
        // const response = await fetch(`${API_BASE_URL}/${type}/${id}`);
        // if (!response.ok) throw new Error('Entity not found');
        // return response.json();

        console.warn('Entity fetch not implemented');
        return null;
    }

    /**
     * Ingest an anchored event into the graph database (dev mode only).
     *
     * Called after a successful blockchain transaction so the graph is
     * updated immediately without needing Substreams/SHiP running.
     *
     * @param {Object} anchoredEvent - Anchored event payload (sent as request body root)
     * @param {string} anchoredEvent.content_hash - Canonical content hash
     * @param {string} anchoredEvent.payload - JSON-stringified action data
     * @param {string} anchoredEvent.action_name - Action name ("put")
     * @param {string} anchoredEvent.contract_account - Contract account name
     * @param {string} anchoredEvent.trx_id - Blockchain transaction ID
     * @param {number} anchoredEvent.timestamp - Unix epoch seconds
     * @param {number} anchoredEvent.block_num - Block number (0 in dev)
     * @param {string} anchoredEvent.block_id - Block ID (empty in dev)
     * @param {number} anchoredEvent.action_ordinal - Action ordinal (0 in dev)
     * @returns {Promise<Object>} Ingestion result
     */
    async ingestAnchoredEvent(anchoredEvent) {
        const headers = { ...JSON_HEADERS };
        if (INGEST_API_KEY) {
            headers['X-API-Key'] = INGEST_API_KEY;
        }

        const response = await fetch(`${API_BASE_URL}/ingest/anchored-event`, {
            method: 'POST',
            headers,
            body: JSON.stringify(anchoredEvent),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || error.message || 'Failed to ingest anchored event');
        }

        return response.json();
    }

    /**
     * Fetch likes for an account via backend chain reader
     * (Replaces direct browser RPC to chain nodes)
     *
     * @param {string} account - Blockchain account name
     * @param {number} [limit=200] - Max rows
     * @returns {Promise<Array>} Rows from the likes table
     */
    async getAccountLikes(account, limit = 200) {
        const response = await fetch(
            `${API_BASE_URL}/chain/likes/${encodeURIComponent(account)}?limit=${limit}`
        );

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || error.message || 'Failed to fetch likes');
        }

        const data = await response.json();
        return data.rows || [];
    }

    /**
     * Fetch vote tally for an anchor ID via backend chain reader
     * (Replaces direct browser RPC to chain nodes)
     *
     * @param {string|number} anchorId - Anchor ID
     * @returns {Promise<Object|null>} Tally row or null
     */
    async getVoteTally(anchorId) {
        const response = await fetch(
            `${API_BASE_URL}/chain/votetally/${encodeURIComponent(anchorId)}`
        );

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || error.message || 'Failed to fetch vote tally');
        }

        const data = await response.json();
        return data.tally || null;
    }

    /**
     * Health check
     */
    async healthCheck() {
        try {
            const response = await fetch(`${API_BASE_URL.replace('/api', '')}/health`);
            return response.ok;
        } catch (error) {
            return false;
        }
    }
}

export const api = new APIClient();
