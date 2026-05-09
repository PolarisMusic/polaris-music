/**
 * Graph visualization endpoints.
 *
 * Mounted at /api/graph. Extracted from `api/server.js` (Stage I).
 *
 *   GET /api/graph/initial
 *   GET /api/graph/neighborhood/:nodeId
 *
 * @module api/routes/graph
 */

import express from 'express';
import neo4j from 'neo4j-driver';
import { sanitizeError } from '../../utils/errorSanitizer.js';
import { safeClose } from '../../graph/safeTx.js';

/**
 * @param {Object} ctx
 * @param {Object} ctx.db
 * @param {Object} ctx.config
 * @returns {express.Router}
 */
export function createGraphRoutes({ db, config }) {
    const router = express.Router();

    /**
     * GET /api/graph/initial
     * Get initial graph data for visualization using all groups with tracks
     * and their member relationships. Includes per-group participation data
     * so the frontend does not need separate per-group fetches.
     */
    router.get('/initial', async (req, res) => {
        try {
            const session = db.driver.session();
            try {
                // Return all groups that have performed on at least one track,
                // along with their MEMBER_OF person relationships and
                // per-member participation counts (for donut visualization).
                // No LIMIT — the full graph is needed for connected visualization.
                const result = await session.run(`
                    MATCH (g:Group)-[:PERFORMED_ON]->(t:Track)
                    WITH g, count(DISTINCT t) as trackCount
                    ORDER BY trackCount DESC
                    OPTIONAL MATCH (p:Person)-[m:MEMBER_OF]->(g)
                    OPTIONAL MATCH (p)-[:PERFORMED_ON {via_group_id: g.group_id}]->(pt:Track)
                    WITH g, trackCount, p, m, count(DISTINCT pt) as memberTrackCount

                    RETURN collect(DISTINCT {
                        id: g.group_id,
                        name: g.name,
                        type: 'group',
                        trackCount: trackCount,
                        photo: g.photo
                    }) as groups,
                    collect(DISTINCT CASE WHEN p IS NOT NULL THEN {
                        id: p.person_id,
                        name: p.name,
                        type: 'person',
                        color: p.color
                    } ELSE null END) as persons,
                    collect(DISTINCT CASE WHEN m IS NOT NULL THEN {
                        source: p.person_id,
                        target: g.group_id,
                        type: 'MEMBER_OF',
                        role: m.role,
                        from_date: m.from_date,
                        to_date: m.to_date,
                        instruments: m.instruments
                    } ELSE null END) as edges,
                    collect(DISTINCT CASE WHEN p IS NOT NULL THEN {
                        groupId: g.group_id,
                        personId: p.person_id,
                        personName: p.name,
                        color: p.color,
                        trackCount: memberTrackCount,
                        totalTracks: trackCount
                    } ELSE null END) as participationRows
                `);

                if (result.records.length === 0) {
                    return res.json({
                        success: true,
                        nodes: [],
                        edges: [],
                        participation: {}
                    });
                }

                const groups = result.records[0].get('groups');
                // Filter out nulls from OPTIONAL MATCH results
                const persons = result.records[0].get('persons').filter(p => p !== null);
                const edges = result.records[0].get('edges').filter(e => e !== null);

                // Build participation map keyed by groupId
                const participationRows = result.records[0].get('participationRows').filter(r => r !== null);
                const participation = {};
                for (const row of participationRows) {
                    const gid = row.groupId;
                    if (!participation[gid]) {
                        participation[gid] = { totalTracks: row.totalTracks, members: [] };
                    }
                    const totalTracks = participation[gid].totalTracks;
                    const tc = typeof row.trackCount === 'object' && row.trackCount.toNumber
                        ? row.trackCount.toNumber() : Number(row.trackCount) || 0;
                    const tt = typeof totalTracks === 'object' && totalTracks.toNumber
                        ? totalTracks.toNumber() : Number(totalTracks) || 0;
                    participation[gid].totalTracks = tt;
                    participation[gid].members.push({
                        personId: row.personId,
                        personName: row.personName,
                        color: row.color || null,
                        trackCount: tc,
                        trackPctOfGroupTracks: tt > 0 ? (tc / tt) * 100.0 : 0.0
                    });
                }

                res.json({
                    success: true,
                    nodes: [...groups, ...persons],
                    edges: edges,
                    participation: participation
                });
            } finally {
                await safeClose(session);
            }
        } catch (error) {
            console.error('Initial graph failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    /**
     * GET /api/graph/neighborhood/:nodeId
     * Fetch a node's neighborhood subgraph for dynamic graph merging.
     * Returns {nodes, edges} in the same shape as /graph/initial.
     */
    router.get('/neighborhood/:nodeId', async (req, res) => {
        const nodeId = req.params.nodeId;
        const limitTracks = Math.min(parseInt(req.query.limitTracks) || 25, 100);
        const limitGroups = Math.min(parseInt(req.query.limitGroups) || 25, 100);
        const limitPersons = Math.min(parseInt(req.query.limitPersons) || 50, 200);

        try {
            const session = db.driver.session();
            try {
                let nodes = [];
                let edges = [];

                if (nodeId.includes(':person:') || nodeId.startsWith('prov:person:')) {
                    // Person neighborhood: person + all groups they're MEMBER_OF
                    const result = await session.run(`
                        MATCH (p:Person {person_id: $nodeId})
                        OPTIONAL MATCH (p)-[m:MEMBER_OF]->(g:Group)
                        RETURN p,
                               collect(DISTINCT {
                                   group: g,
                                   role: m.role,
                                   from_date: m.from_date,
                                   to_date: m.to_date,
                                   instruments: m.instruments
                               }) as memberships
                        LIMIT 1
                    `, { nodeId });

                    if (result.records.length > 0) {
                        const record = result.records[0];
                        const p = record.get('p');
                        if (p) {
                            nodes.push({
                                id: p.properties.person_id,
                                name: p.properties.name,
                                type: 'person',
                                color: p.properties.color || null
                            });

                            const memberships = record.get('memberships').filter(m => m.group !== null);
                            for (const m of memberships.slice(0, limitGroups)) {
                                const g = m.group;
                                nodes.push({
                                    id: g.properties.group_id,
                                    name: g.properties.name,
                                    type: 'group',
                                    photo: g.properties.photo || null
                                });
                                edges.push({
                                    source: p.properties.person_id,
                                    target: g.properties.group_id,
                                    type: 'MEMBER_OF',
                                    role: m.role,
                                    from_date: m.from_date,
                                    to_date: m.to_date,
                                    instruments: m.instruments
                                });
                            }
                        }
                    }
                } else if (nodeId.includes(':group:') || nodeId.startsWith('prov:group:')) {
                    // Group neighborhood: group + members + limited tracks + releases
                    const result = await session.run(`
                        MATCH (g:Group {group_id: $nodeId})
                        OPTIONAL MATCH (p:Person)-[m:MEMBER_OF]->(g)
                        WITH g, collect(DISTINCT {
                            person: p,
                            role: m.role,
                            from_date: m.from_date,
                            to_date: m.to_date,
                            instruments: m.instruments
                        }) as memberships
                        OPTIONAL MATCH (g)-[:PERFORMED_ON]->(t:Track)
                        WITH g, memberships, collect(DISTINCT t)[0..$limitTracks] as tracks
                        UNWIND tracks as t
                        OPTIONAL MATCH (t)-[:IN_RELEASE]->(r:Release)
                        RETURN g, memberships,
                               collect(DISTINCT {track: t}) as trackNodes,
                               collect(DISTINCT {release: r, trackId: t.track_id}) as releaseEdges
                    `, { nodeId, limitTracks: neo4j.int(limitTracks) });

                    if (result.records.length > 0) {
                        const record = result.records[0];
                        const g = record.get('g');
                        if (g) {
                            nodes.push({
                                id: g.properties.group_id,
                                name: g.properties.name,
                                type: 'group',
                                photo: g.properties.photo || null
                            });

                            const memberships = record.get('memberships').filter(m => m.person !== null);
                            for (const m of memberships.slice(0, limitPersons)) {
                                const p = m.person;
                                nodes.push({
                                    id: p.properties.person_id,
                                    name: p.properties.name,
                                    type: 'person',
                                    color: p.properties.color || null
                                });
                                edges.push({
                                    source: p.properties.person_id,
                                    target: g.properties.group_id,
                                    type: 'MEMBER_OF',
                                    role: m.role,
                                    from_date: m.from_date,
                                    to_date: m.to_date,
                                    instruments: m.instruments
                                });
                            }

                            const trackNodes = record.get('trackNodes').filter(t => t.track !== null);
                            for (const tn of trackNodes) {
                                const t = tn.track;
                                nodes.push({
                                    id: t.properties.track_id,
                                    name: t.properties.title || t.properties.name,
                                    type: 'track'
                                });
                                edges.push({
                                    source: g.properties.group_id,
                                    target: t.properties.track_id,
                                    type: 'PERFORMED_ON'
                                });
                            }

                            const releaseEdges = record.get('releaseEdges').filter(re => re.release !== null);
                            const seenReleases = new Set();
                            for (const re of releaseEdges) {
                                const r = re.release;
                                if (!seenReleases.has(r.properties.release_id)) {
                                    seenReleases.add(r.properties.release_id);
                                    nodes.push({
                                        id: r.properties.release_id,
                                        name: r.properties.name,
                                        type: 'release'
                                    });
                                }
                                edges.push({
                                    source: re.trackId,
                                    target: r.properties.release_id,
                                    type: 'IN_RELEASE'
                                });
                            }
                        }
                    }
                } else {
                    // Generic fallback: try known node types
                    const nodeTypes = [
                        { label: 'Person', idField: 'person_id', type: 'person' },
                        { label: 'Group', idField: 'group_id', type: 'group' },
                        { label: 'Track', idField: 'track_id', type: 'track' },
                        { label: 'Release', idField: 'release_id', type: 'release' },
                        { label: 'Song', idField: 'song_id', type: 'song' }
                    ];
                    for (const meta of nodeTypes) {
                        const result = await session.run(
                            `MATCH (n:${meta.label} {${meta.idField}: $nodeId}) RETURN n LIMIT 1`,
                            { nodeId }
                        );
                        if (result.records.length > 0) {
                            const n = result.records[0].get('n');
                            nodes.push({
                                id: n.properties[meta.idField],
                                name: n.properties.name || n.properties.title || 'Unknown',
                                type: meta.type
                            });
                            break;
                        }
                    }
                }

                // Deduplicate nodes by id
                const nodeMap = new Map();
                for (const n of nodes) {
                    if (n && n.id) nodeMap.set(n.id, n);
                }

                res.json({
                    success: true,
                    nodes: Array.from(nodeMap.values()),
                    edges
                });
            } finally {
                await safeClose(session);
            }
        } catch (error) {
            console.error('Neighborhood fetch failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    return router;
}
