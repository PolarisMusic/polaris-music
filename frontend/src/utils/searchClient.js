/**
 * Shared search client for Polaris Music Registry.
 *
 * Provides a single searchNodes() function that calls /api/search/nodes.
 * Used by both the visualization search bar and release submission form.
 */

const API_BASE_URL = (() => {
    const url = import.meta.env.VITE_API_URL;
    if (!url) return 'http://localhost:3000/api';
    return url.endsWith('/api') ? url : url.replace(/\/$/, '') + '/api';
})();

/**
 * Search for nodes in the graph database.
 * @param {string} query - Search term (minimum 2 characters)
 * @param {Object} [opts]
 * @param {string[]} [opts.types] - Label filter (e.g. ['Person', 'Group'])
 * @param {number} [opts.limit=10] - Max results
 * @returns {Promise<Array>} Normalized search results
 */
export async function searchNodes(query, { types = [], limit = 10 } = {}) {
    if (!query || query.trim().length < 2) return [];

    const params = new URLSearchParams({ q: query.trim(), limit: String(limit) });
    if (types.length > 0) params.set('types', types.join(','));

    const response = await fetch(`${API_BASE_URL}/search/nodes?${params}`);
    if (!response.ok) {
        console.error('Search request failed:', response.status);
        return [];
    }

    const data = await response.json();
    return data.success ? data.results : [];
}
