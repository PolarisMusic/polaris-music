/**
 * Graph visualization endpoints.
 *
 * Mounted at /api/graph. Extracted from `api/server.js` (Stage I).
 *
 *   GET /api/graph/initial
 *   GET /api/graph/neighborhood/:nodeId
 *   GET /api/graph/sponsored
 *
 * @module api/routes/graph
 */

import express from 'express';
import { partitionRoles, creditIsMusical } from '../../graph/creditKind.js';
import neo4j from 'neo4j-driver';
import { sanitizeError } from '../../utils/errorSanitizer.js';
import { safeClose } from '../../graph/safeTx.js';

/**
 * @param {Object} ctx
 * @param {Object} ctx.db
 * @param {Object} ctx.config
 * @returns {express.Router}
 */
export function createGraphRoutes({ db, config, sponsoredNodes = null }) {
    const router = express.Router();

    /**
     * Neo4j returns 64-bit integers as {low, high} objects, which serialize to
     * JSON as a pair of numbers and break every arithmetic comparison the
     * frontend does on them.
     *
     * @param {*} value
     * @returns {number}
     */
    const toInt = (value) =>
        value && typeof value === 'object' && value.toNumber ? value.toNumber() : Number(value) || 0;

    /**
     * A credit's roles as one flat, deduplicated list of strings.
     *
     * The shape that arrives is not uniform. A relationship's `roles` property
     * is itself a list, so collecting it across a person's several credits
     * gives a list of lists; the singular `role` beside it is a bare string.
     * Both reach here, and the classifier wants neither nested nor null.
     *
     * @param {*} value
     * @returns {string[]}
     */
    const flatRoles = (value) => {
        const out = [];
        const push = (item) => {
            if (item == null) return;
            if (Array.isArray(item)) {
                for (const inner of item) push(inner);
                return;
            }
            const text = String(item).trim();
            if (text) out.push(text);
        };
        push(value);
        return [...new Set(out)];
    };

    /**
     * The roles of one credit that this request should see, or null to drop it.
     *
     * Per role rather than per person: "Mixed By, Guitar" is one human, and
     * judging the person would lose one of the two facts whichever way it went.
     * A credit with any performance role is a musical credit, trimmed to those
     * roles unless technical ones were asked for too — so the edge reads
     * "guitar", not "mixed by, guitar". See graph/creditKind.js.
     *
     * An empty list is a kept credit with nothing said about it, not a dropped
     * one: a credit nobody described is still a connection somebody recorded.
     *
     * @param {*} value - The credit's roles, in any of the shapes flatRoles takes.
     * @param {{musical: boolean, technical: boolean}} wanted
     * @returns {string[]|null}
     */
    const visibleRoles = (value, wanted) => {
        const roles = flatRoles(value);
        const { musical } = partitionRoles(roles);

        if (creditIsMusical(roles)) {
            if (!wanted.musical) return null;
            return wanted.technical ? roles : musical;
        }
        return wanted.technical ? roles : null;
    };

    /**
     * Which halves of the guest bucket a request asked for.
     *
     * `guests=true` is the older spelling and means both, so a saved link still
     * works. The server's own default is neither: a bare request gets members,
     * as it always did. Musical guests being on by default is the frontend's
     * choice, made where the checkbox lives.
     *
     * @param {express.Request} req
     * @returns {{musical: boolean, technical: boolean, any: boolean}}
     */
    const creditFlags = (req) => {
        const isTrue = (value) => String(value || '') === 'true';
        const all = isTrue(req.query.guests);
        const musical = all || isTrue(req.query.musicalGuests);
        const technical = all || isTrue(req.query.technicians);
        return { musical, technical, any: musical || technical };
    };

    /**
     * Keep the credits this request asked for, and the people still on one.
     *
     * Per role rather than per person: "Mixed By, Guitar" is one human, and
     * judging the person would lose one of the two facts whichever way it
     * went. A credit with any performance role is a musical credit, and its
     * roles are trimmed to those unless technical ones were asked for too —
     * so the edge reads "guitar", not "mixed by, guitar". See
     * graph/creditKind.js for what counts as which.
     *
     * Persons are filtered from the surviving edges rather than alongside
     * them: the query collects the two lists independently, so filtering only
     * the edges would leave people on screen with nothing joining them.
     *
     * @param {{persons: Array, edges: Array}} credits
     * @param {{musical: boolean, technical: boolean}} wanted
     * @returns {{persons: Array, edges: Array}}
     */
    const selectCredits = ({ persons, edges }, wanted) => {
        const kept = [];
        for (const edge of edges) {
            const roles = visibleRoles(edge.roles ?? edge.role, wanted);
            if (!roles) continue;
            kept.push({ ...edge, roles, role: roles[0] ?? null });
        }

        const live = new Set(kept.map((edge) => edge.source));
        return { persons: persons.filter((person) => live.has(person.id)), edges: kept };
    };

    /**
     * GET /api/graph/sponsored
     *
     * The node the visualization should open on this period, drawn by the
     * weighted lottery, with the inputs it was drawn from.
     *
     * Always 200. A missing draw is `{ node: null }`, not an error: the
     * chain being unreachable or the contract being unconfigured is a reason
     * for the front page to fall back to its own default, not a reason for the
     * frontend to show a failure to a visitor who never asked for this.
     */
    router.get('/sponsored', async (req, res) => {
        if (!sponsoredNodes) {
            return res.json({ success: true, node: null, reason: 'not_configured' });
        }

        try {
            const result = await sponsoredNodes.getSponsoredNode();
            if (!result) {
                return res.json({ success: true, node: null, reason: 'no_draw' });
            }
            return res.json({ success: true, ...result });
        } catch (error) {
            // The service already swallows its own failures; reaching here
            // means something unanticipated, and the same reasoning applies.
            return res.json({ success: true, node: null, reason: 'error' });
        }
    });

    /**
     * Guest credits, as edges from the guest to the group they appeared with.
     *
     * Conceptually a guest belongs to a *track* — that is the claim the registry
     * records, and GUEST_ON points at a Track or a Release, never at a Group.
     * This draws it at the group instead, because the initial graph holds no
     * tracks: putting them in to hang guest edges off would turn a group with
     * forty tracks into forty-one nodes. The edge carries trackCount and scope
     * so the depiction can say how much of the group's work a guest touched
     * without pretending the relationship is membership.
     *
     * Both routes to a guest credit are followed: a credit on one of the
     * group's tracks, and a credit on a release carrying them — an engineer is
     * usually credited once for the record, not once per song.
     *
     * @param {import('neo4j-driver').Session} session
     * @returns {Promise<{persons: Array<object>, edges: Array<object>}>}
     */
    async function readGuestEdges(session) {
        const result = await session.run(`
            MATCH (g:Group)-[:PERFORMED_ON]->(t:Track)
            OPTIONAL MATCH (t)<-[tg:GUEST_ON]-(tp:Person)
            OPTIONAL MATCH (t)-[:IN_RELEASE]->(r:Release)<-[rg:GUEST_ON]-(rp:Person)

            WITH g,
                 collect(DISTINCT CASE WHEN tp IS NOT NULL
                     THEN {person: tp, roles: tg.roles, track: t, scope: 'track'} END) AS trackGuests,
                 collect(DISTINCT CASE WHEN rp IS NOT NULL
                     THEN {person: rp, roles: rg.roles, track: t, scope: 'release'} END) AS releaseGuests
            WITH g, [x IN trackGuests + releaseGuests WHERE x IS NOT NULL] AS credits
            UNWIND credits AS credit
            WITH g, credit.person AS p, credit.scope AS scope, credit.roles AS roles, credit.track AS t

            // A member of this group is not its guest. The registry's rule is
            // per-track; at group level the honest reading is that membership
            // wins, or the same person arrives twice on two different edges.
            WHERE NOT (p)-[:MEMBER_OF]->(g)

            WITH g, p, count(DISTINCT t) AS trackCount,
                 collect(DISTINCT scope) AS scopes,
                 collect(DISTINCT roles) AS roleValues
            RETURN collect(DISTINCT {
                id: p.person_id,
                name: p.name,
                type: 'person',
                color: p.color
            }) AS persons,
            collect({
                source: p.person_id,
                target: g.group_id,
                type: 'GUEST_ON',
                trackCount: trackCount,
                scope: CASE WHEN 'track' IN scopes THEN 'track' ELSE 'release' END,
                roles: [x IN roleValues WHERE x IS NOT NULL]
            }) AS edges
        `);

        if (result.records.length === 0) return { persons: [], edges: [] };

        return {
            persons: result.records[0].get('persons').filter((p) => p && p.id),
            edges: result.records[0].get('edges')
                .filter((e) => e && e.source && e.target)
                .map((e) => ({ ...e, trackCount: toInt(e.trackCount) })),
        };
    }

    /**
     * GET /api/graph/initial
     * Get initial graph data for visualization using all groups with tracks
     * and their member relationships. Includes per-group participation data
     * so the frontend does not need separate per-group fetches.
     */
    router.get('/initial', async (req, res) => {
        // The guest bucket holds two unlike things — a featured vocalist and
        // the person who shot the sleeve — so it is asked for in halves.
        const wanted = creditFlags(req);

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

                // Separate queries rather than more OPTIONAL MATCHes on the
                // first: the member query already collects four lists off one
                // row per (group, member), and joining anything else into it
                // multiplies every one of them. The cost is a round trip; the
                // alternative is a payload that silently over-counts
                // participation.
                const seenPersons = new Set(persons.map((p) => p.id));

                // Guests, when asked for.
                const guestNodes = [];
                const guestEdges = [];
                if (wanted.any) {
                    const guests = selectCredits(
                        await readGuestEdges(session),
                        { musical: wanted.musical, technical: wanted.technical });
                    for (const guest of guests.persons) {
                        // A guest who is also a member of some other group is
                        // already a node; only the edge is new.
                        if (seenPersons.has(guest.id)) continue;
                        seenPersons.add(guest.id);
                        guestNodes.push(guest);
                    }
                    guestEdges.push(...guests.edges);
                }

                res.json({
                    success: true,
                    nodes: [...groups, ...persons, ...guestNodes],
                    edges: [...edges, ...guestEdges],
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
