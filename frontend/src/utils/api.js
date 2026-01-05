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

class APIClient {
    /**
     * Submit a release bundle event
     */
    async submitRelease(releaseData) {
        const response = await fetch(`${API_BASE_URL}/events/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                type: 'CREATE_RELEASE_BUNDLE',
                body: releaseData,
                // Note: In production, this would come from wallet integration
                author_pubkey: 'PUB_K1_DEMO', // Placeholder
            }),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || 'Failed to submit release');
        }

        return response.json();
    }

    /**
     * Prepare event for signing by normalizing and getting canonical hash
     * @param {Object} event - Event object WITHOUT signature
     * @returns {Promise<Object>} { success: true, hash, normalizedEvent }
     */
    async prepareEvent(event) {
        const response = await fetch(`${API_BASE_URL}/events/prepare`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(event),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || 'Failed to prepare event');
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
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || 'Failed to store event');
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
            throw new Error(error.message || 'Failed to retrieve event');
        }

        return response.json();
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
