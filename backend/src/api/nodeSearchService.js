/**
 * Node Search Service - unified search across user-facing Neo4j entities.
 *
 * Searches Person, Group, Release, Track, Song, Label, City nodes.
 * Excludes internal nodes (Claim, Source, IdentityMap, Account, etc.).
 *
 * Supports two search modes:
 *   1. Text search (name, title, alt_names) via fulltext index
 *   2. ID exact/prefix match on canonical ID fields (person_id, group_id, etc.)
 * Results are merged and ranked: exact ID > prefix name > fulltext score.
 */

// Labels eligible for search
const SEARCHABLE_LABELS = ['Person', 'Group', 'Release', 'Track', 'Song', 'Label', 'City'];

// Canonical ID property per label
const ID_FIELDS = {
    Person: 'person_id',
    Group: 'group_id',
    Release: 'release_id',
    Track: 'track_id',
    Song: 'song_id',
    Label: 'label_id',
    City: 'city_id'
};

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
     * Also searches canonical ID fields for exact/prefix matches.
     * Results are merged and ranked: exact ID match > prefix name > fulltext score.
     *
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
            // Run text search and ID search in parallel
            const [textResults, idResults] = await Promise.all([
                this._fulltextSearch(session, query, types, limit).catch(err => {
                    console.warn('Fulltext search failed, using fallback:', err.message);
                    return this._fallbackSearch(session, query, types, limit);
                }),
                this._idSearch(session, query, types, limit)
            ]);

            return this._mergeResults(idResults, textResults, limit);
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

    /**
     * Search canonical ID fields for exact or prefix matches.
     * Exact matches get score 1000, prefix matches get score 500.
     */
    async _idSearch(session, query, types, limit) {
        const allowedLabels = types.length > 0 ? types : SEARCHABLE_LABELS;
        const trimmed = query.trim();

        // Build UNION queries for each allowed label's ID field
        const unions = [];
        const params = { query: trimmed, limit: parseInt(limit) };

        for (const label of allowedLabels) {
            const idField = ID_FIELDS[label];
            if (!idField) continue;
            unions.push(`
                MATCH (n:${label})
                WHERE n.${idField} = $query
                RETURN n, '${label}' AS label, 1000.0 AS score
                UNION ALL
                MATCH (n:${label})
                WHERE n.${idField} STARTS WITH $query AND n.${idField} <> $query
                RETURN n, '${label}' AS label, 500.0 AS score
            `);
        }

        if (unions.length === 0) return [];

        const cypher = unions.join(' UNION ALL ') + ' ORDER BY score DESC LIMIT $limit';

        try {
            const result = await session.run(cypher, params);
            return result.records.map(r => {
                const props = r.get('n').properties;
                const label = r.get('label');
                const score = r.get('score');
                return normalizeResult(props, label, score);
            });
        } catch (error) {
            console.warn('ID search failed:', error.message);
            return [];
        }
    }

    /**
     * Merge ID results (highest priority) with text results, deduplicating by id.
     */
    _mergeResults(idResults, textResults, limit) {
        const seen = new Set();
        const merged = [];

        // ID results first (higher priority)
        for (const r of idResults) {
            if (r.id && !seen.has(r.id)) {
                seen.add(r.id);
                merged.push(r);
            }
        }

        // Then text results
        for (const r of textResults) {
            if (r.id && !seen.has(r.id)) {
                seen.add(r.id);
                merged.push(r);
            }
        }

        return merged.slice(0, limit);
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
