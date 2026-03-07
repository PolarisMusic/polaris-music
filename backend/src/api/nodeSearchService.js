/**
 * Node Search Service - unified search across user-facing Neo4j entities.
 *
 * Searches Person, Group, Release, Track, Song, Label, City nodes.
 * Excludes internal nodes (Claim, Source, IdentityMap, Account, etc.).
 */

// Labels eligible for search
const SEARCHABLE_LABELS = ['Person', 'Group', 'Release', 'Track', 'Song', 'Label', 'City'];

/**
 * Normalize a Neo4j node into a unified search result shape.
 */
function normalizeResult(properties, label, score) {
    const p = properties;
    switch (label) {
        case 'Person':
            return {
                id: p.person_id || p.id,
                type: 'Person',
                display_name: p.name || 'Unknown Person',
                subtitle: p.city || null,
                image: p.photo || null,
                color: p.color || null,
                score
            };
        case 'Group':
            return {
                id: p.group_id || p.id,
                type: 'Group',
                display_name: p.name || 'Unknown Group',
                subtitle: p.formed_date ? `Formed ${p.formed_date}` : null,
                image: p.photo || null,
                color: null,
                score
            };
        case 'Release':
            return {
                id: p.release_id || p.id,
                type: 'Release',
                display_name: p.name || 'Unknown Release',
                subtitle: p.release_date || null,
                image: p.album_art || null,
                color: null,
                score
            };
        case 'Track':
            return {
                id: p.track_id || p.id,
                type: 'Track',
                display_name: p.title || p.name || 'Unknown Track',
                subtitle: null,
                image: null,
                color: null,
                score
            };
        case 'Song':
            return {
                id: p.song_id || p.id,
                type: 'Song',
                display_name: p.title || p.name || 'Unknown Song',
                subtitle: null,
                image: null,
                color: null,
                score
            };
        case 'Label':
            return {
                id: p.label_id || p.id,
                type: 'Label',
                display_name: p.name || 'Unknown Label',
                subtitle: null,
                image: null,
                color: null,
                score
            };
        case 'City':
            return {
                id: p.city_id || p.id,
                type: 'City',
                display_name: p.name || 'Unknown City',
                subtitle: p.country || null,
                image: null,
                color: null,
                score
            };
        default:
            return {
                id: p.id || null,
                type: label,
                display_name: p.name || p.title || 'Unknown',
                subtitle: null,
                image: null,
                color: null,
                score
            };
    }
}

export class NodeSearchService {
    constructor(driver) {
        this.driver = driver;
    }

    /**
     * Search nodes using fulltext index with fallback to substring matching.
     * @param {string} query - Search term
     * @param {Object} [opts]
     * @param {string[]} [opts.types] - Label filter (e.g. ['Person', 'Group'])
     * @param {number} [opts.limit=20]
     * @returns {Promise<Array>} Normalized search results
     */
    async search(query, { types = [], limit = 20 } = {}) {
        if (!query || query.trim().length < 2) return [];

        const session = this.driver.session();
        try {
            return await this._fulltextSearch(session, query, types, limit);
        } catch (error) {
            console.warn('Fulltext search failed, using fallback:', error.message);
            return await this._fallbackSearch(session, query, types, limit);
        } finally {
            await session.close();
        }
    }

    async _fulltextSearch(session, query, types, limit) {
        // Append wildcard for prefix matching
        const ftQuery = query.trim().replace(/[+\-&|!(){}[\]^"~*?:\\]/g, '\\$&') + '*';

        const result = await session.run(`
            CALL db.index.fulltext.queryNodes('entitySearch', $query)
            YIELD node, score
            WITH node, score, labels(node) AS lbls
            WHERE size([l IN lbls WHERE l IN $allowed | l]) > 0
            RETURN node, lbls[0] AS label, score
            ORDER BY score DESC
            LIMIT $limit
        `, {
            query: ftQuery,
            allowed: types.length > 0 ? types : SEARCHABLE_LABELS,
            limit: parseInt(limit)
        });

        return result.records.map(r => {
            const props = r.get('node').properties;
            const label = r.get('label');
            const score = r.get('score');
            return normalizeResult(props, label, score);
        });
    }

    async _fallbackSearch(session, query, types, limit) {
        const allowedLabels = types.length > 0 ? types : SEARCHABLE_LABELS;
        // Build a label filter clause
        const labelFilter = allowedLabels.map(l => `n:${l}`).join(' OR ');

        const result = await session.run(`
            MATCH (n)
            WHERE (${labelFilter})
              AND (n.name CONTAINS $query OR n.title CONTAINS $query OR n.alt_names CONTAINS $query)
            RETURN n, labels(n)[0] AS label
            ORDER BY
                CASE WHEN n.name STARTS WITH $query THEN 0
                     WHEN n.title STARTS WITH $query THEN 0
                     ELSE 1 END,
                n.name, n.title
            LIMIT $limit
        `, { query: query.trim(), limit: parseInt(limit) });

        return result.records.map(r => {
            const props = r.get('n').properties;
            const label = r.get('label');
            return normalizeResult(props, label, 1.0);
        });
    }
}
