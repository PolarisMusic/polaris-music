/**
 * API client for Polaris Music Registry backend
 */

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
     * Search for existing entities in the database
     * UNIMPLEMENTED: This would query the backend for matching entities
     * TODO: Implement autocomplete search functionality
     *
     * @param {string} type - Entity type (person, group, label, city, role)
     * @param {string} query - Search query
     * @returns {Promise<Array>} Matching entities
     */
    async search(type, query) {
        // UNIMPLEMENTED: Would call backend search endpoint
        // const response = await fetch(`${API_BASE_URL}/search?type=${type}&q=${encodeURIComponent(query)}`);
        // if (!response.ok) throw new Error('Search failed');
        // return response.json();

        console.warn('Search not implemented - returning empty results');
        return [];
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
