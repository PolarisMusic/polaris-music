/**
 * GraphQL root resolvers for the Polaris API.
 *
 * Extracted from `api/server.js` (Stage I). The resolvers receive their
 * dependencies (db, store, NodeSearchService) via a factory closure rather
 * than `this`, so the module is testable in isolation.
 *
 * @module api/resolvers
 */

import { NodeSearchService } from '../nodeSearchService.js';

/**
 * Build the GraphQL root resolver object.
 *
 * @param {Object} ctx
 * @param {Object} ctx.db    - MusicGraphDatabase instance (with .driver)
 * @param {Object} ctx.store - EventStore instance
 * @returns {Object} root resolver map
 */
export function createResolvers({ db, store }) {
    return {
        // ========== PERSON QUERIES ==========
        person: async ({ person_id }) => {
            const session = db.driver.session();
            try {
                const result = await session.run(`
                    MATCH (p:Person {person_id: $id})
                    WHERE p.status = 'ACTIVE'
                    OPTIONAL MATCH (p)-[m:MEMBER_OF]->(g:Group)
                    WHERE g.status = 'ACTIVE'
                    OPTIONAL MATCH (p)-[:WROTE]->(s:Song)
                    WHERE s.status = 'ACTIVE'
                    OPTIONAL MATCH (p)-[:PRODUCED]->(t:Track)
                    WHERE t.status = 'ACTIVE'
                    OPTIONAL MATCH (p)-[:GUEST_ON]->(tg:Track)
                    WHERE tg.status = 'ACTIVE'

                    RETURN p,
                           collect(DISTINCT {
                               group: g,
                               role: m.role,
                               from_date: m.from_date,
                               to_date: m.to_date,
                               instruments: m.instruments
                           }) as groups,
                           collect(DISTINCT s) as songsWritten,
                           collect(DISTINCT t) as tracksProduced,
                           collect(DISTINCT tg) as guestAppearances
                `, { id: person_id });

                if (result.records.length === 0) return null;

                const record = result.records[0];
                const person = record.get('p').properties;
                const groups = record.get('groups')
                    .filter(g => g.group !== null)
                    .map(g => ({
                        group: g.group.properties,
                        role: g.role,
                        from_date: g.from_date,
                        to_date: g.to_date,
                        instruments: g.instruments || []
                    }));
                const songsWritten = record.get('songsWritten')
                    .filter(s => s !== null)
                    .map(s => s.properties);
                const tracksProduced = record.get('tracksProduced')
                    .filter(t => t !== null)
                    .map(t => t.properties);
                const guestAppearances = record.get('guestAppearances')
                    .filter(t => t !== null)
                    .map(t => t.properties);

                return {
                    ...person,
                    alt_names: person.alt_names || [],
                    groups,
                    songsWritten,
                    tracksProduced,
                    guestAppearances
                };
            } finally {
                await session.close();
            }
        },

        // ========== GROUP QUERIES ==========
        group: async ({ group_id }) => {
            const session = db.driver.session();
            try {
                const result = await session.run(`
                    MATCH (g:Group {group_id: $id})
                    WHERE g.status = 'ACTIVE'
                    OPTIONAL MATCH (p:Person)-[m:MEMBER_OF]->(g)
                    WHERE p.status = 'ACTIVE'
                    OPTIONAL MATCH (g)-[:PERFORMED_ON]->(t:Track)
                    WHERE t.status = 'ACTIVE'
                    OPTIONAL MATCH (t)-[:IN_RELEASE]->(r:Release)
                    WHERE r.status = 'ACTIVE'

                    RETURN g,
                           collect(DISTINCT {
                               person: p,
                               role: m.role,
                               from_date: m.from_date,
                               to_date: m.to_date,
                               instruments: m.instruments
                           }) as members,
                           collect(DISTINCT t) as tracks,
                           collect(DISTINCT r) as releases
                `, { id: group_id });

                if (result.records.length === 0) return null;

                const record = result.records[0];
                const group = record.get('g').properties;
                const members = record.get('members')
                    .filter(m => m.person !== null)
                    .map(m => ({
                        person: m.person.properties,
                        role: m.role,
                        from_date: m.from_date,
                        to_date: m.to_date,
                        instruments: m.instruments || []
                    }));
                const tracks = record.get('tracks')
                    .filter(t => t !== null)
                    .map(t => t.properties);
                const releases = record.get('releases')
                    .filter(r => r !== null)
                    .map(r => r.properties);

                // Compute inferred active dates from release dates
                const releaseDates = releases
                    .map(r => r.release_date)
                    .filter(d => d != null && d !== '');
                const inferred_first_release_date = releaseDates.length > 0
                    ? releaseDates.reduce((a, b) => a < b ? a : b)
                    : null;
                const inferred_last_release_date = releaseDates.length > 0
                    ? releaseDates.reduce((a, b) => a > b ? a : b)
                    : null;

                return {
                    ...group,
                    alt_names: group.alt_names || [],
                    inferred_first_release_date,
                    inferred_last_release_date,
                    members,
                    tracks,
                    releases
                };
            } finally {
                await session.close();
            }
        },

        groupParticipation: async ({ group_id }) => {
            const participation = await db.calculateGroupMemberParticipation(group_id);
            return participation.map(p => ({
                person: { person_id: p.personId, name: p.personName },
                participation_percentage: p.trackPctOfGroupTracks,
                track_count: p.trackCount,
                release_count: null
            }));
        },

        // ========== RELEASE QUERIES ==========
        release: async ({ release_id }) => {
            const session = db.driver.session();
            try {
                const result = await session.run(`
                    MATCH (r:Release {release_id: $id})
                    WHERE r.status = 'ACTIVE'
                    OPTIONAL MATCH (t:Track)-[ir:IN_RELEASE]->(r)
                    WHERE t.status = 'ACTIVE'
                    OPTIONAL MATCH (r)-[:RELEASED]->(l:Label)
                    WHERE l.status = 'ACTIVE'
                    OPTIONAL MATCH (r)-[:IN_MASTER]->(m:Master)
                    WHERE m.status = 'ACTIVE'

                    RETURN r,
                           collect(DISTINCT {
                               track: t,
                               disc_number: ir.disc_number,
                               track_number: ir.track_number,
                               side: ir.side,
                               is_bonus: ir.is_bonus
                           }) as tracks,
                           collect(DISTINCT l) as labels,
                           m as master
                `, { id: release_id });

                if (result.records.length === 0) return null;

                const record = result.records[0];
                const release = record.get('r').properties;
                const tracks = record.get('tracks')
                    .filter(t => t.track !== null)
                    .map(t => ({
                        track: t.track.properties,
                        disc_number: t.disc_number,
                        track_number: t.track_number,
                        side: t.side,
                        is_bonus: t.is_bonus
                    }));
                const labels = record.get('labels')
                    .filter(l => l !== null)
                    .map(l => l.properties);
                const master = record.get('master');

                return {
                    ...release,
                    alt_names: release.alt_names || [],
                    format: release.format || [],
                    tracks,
                    labels,
                    master: master ? master.properties : null
                };
            } finally {
                await session.close();
            }
        },

        // ========== TRACK QUERIES ==========
        track: async ({ track_id }) => {
            const session = db.driver.session();
            try {
                const result = await session.run(`
                    MATCH (t:Track {track_id: $id})
                    WHERE t.status = 'ACTIVE'
                    OPTIONAL MATCH (t)-[:RECORDING_OF]->(s:Song)
                    WHERE s.status = 'ACTIVE'
                    OPTIONAL MATCH (g:Group)-[:PERFORMED_ON]->(t)
                    WHERE g.status = 'ACTIVE'
                    OPTIONAL MATCH (p:Person)-[:GUEST_ON]->(t)
                    WHERE p.status = 'ACTIVE'
                    OPTIONAL MATCH (t)-[:IN_RELEASE]->(r:Release)
                    WHERE r.status = 'ACTIVE'

                    RETURN t,
                           s,
                           collect(DISTINCT g) as performedBy,
                           collect(DISTINCT p) as guests,
                           collect(DISTINCT r) as releases
                `, { id: track_id });

                if (result.records.length === 0) return null;

                const record = result.records[0];
                const track = record.get('t').properties;
                const song = record.get('s');
                const performedBy = record.get('performedBy')
                    .filter(g => g !== null)
                    .map(g => g.properties);
                const guests = record.get('guests')
                    .filter(p => p !== null)
                    .map(p => p.properties);
                const releases = record.get('releases')
                    .filter(r => r !== null)
                    .map(r => r.properties);

                return {
                    ...track,
                    listen_links: track.listen_links || [],
                    recordingOf: song ? song.properties : null,
                    performedBy,
                    guests,
                    releases
                };
            } finally {
                await session.close();
            }
        },

        // ========== SONG QUERIES ==========
        song: async ({ song_id }) => {
            const session = db.driver.session();
            try {
                const result = await session.run(`
                    MATCH (s:Song {song_id: $id})
                    WHERE s.status = 'ACTIVE'
                    OPTIONAL MATCH (p:Person)-[:WROTE]->(s)
                    WHERE p.status = 'ACTIVE'
                    OPTIONAL MATCH (t:Track)-[:RECORDING_OF]->(s)
                    WHERE t.status = 'ACTIVE'

                    RETURN s,
                           collect(DISTINCT p) as writers,
                           collect(DISTINCT t) as recordings
                `, { id: song_id });

                if (result.records.length === 0) return null;

                const record = result.records[0];
                const song = record.get('s').properties;
                const writers = record.get('writers')
                    .filter(p => p !== null)
                    .map(p => p.properties);
                const recordings = record.get('recordings')
                    .filter(t => t !== null)
                    .map(t => t.properties);

                return {
                    ...song,
                    alt_titles: song.alt_titles || [],
                    writers,
                    recordings
                };
            } finally {
                await session.close();
            }
        },

        // ========== SEARCH ==========
        search: async ({ query, limit = 10 }) => {
            const searchService = new NodeSearchService(db.driver);
            const results = await searchService.search(query, { limit });
            return results.map(r => ({
                __typename: r.type,
                id: r.id,
                name: r.display_name,
                type: r.type,
                ...r
            }));
        },

        // ========== STATS ==========
        stats: async () => {
            const dbStats = await db.getStats();
            const storageStats = store.getStats();

            const total = Object.values(dbStats.nodes).reduce((sum, count) => sum + count, 0);

            return {
                nodes: {
                    ...dbStats.nodes,
                    total
                },
                enabled_services: storageStats.enabled
            };
        },

        testConnectivity: async () => {
            const dbConnected = await db.testConnection();
            return dbConnected;
        }
    };
}
