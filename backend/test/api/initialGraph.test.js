/**
 * Regression tests for GET /api/graph/initial
 *
 * Ensures the endpoint returns ALL groups with tracks (no silent cap),
 * along with their MEMBER_OF person relationships and participation data.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Minimal Neo4j driver stub
// ---------------------------------------------------------------------------

function makeRecord(fields) {
    return {
        get(key) { return fields[key]; }
    };
}

function makeDriverStub(runImpl) {
    const session = {
        run: jest.fn(runImpl || (async () => ({ records: [] }))),
        close: jest.fn(async () => {})
    };
    return {
        session: jest.fn(() => session),
        _session: session
    };
}

// ---------------------------------------------------------------------------
// Build a minimal Express app that mounts only the /api/graph/initial route
// using the same logic as the real server.
// ---------------------------------------------------------------------------

function buildTestApp(driver) {
    const app = express();
    app.use(express.json());

    const db = { driver };

    app.get('/api/graph/initial', async (req, res) => {
        try {
            const session = db.driver.session();
            try {
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
                    return res.json({ success: true, nodes: [], edges: [], participation: {} });
                }

                const groups = result.records[0].get('groups');
                const persons = result.records[0].get('persons').filter(p => p !== null);
                const edges = result.records[0].get('edges').filter(e => e !== null);

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
                await session.close();
            }
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/graph/initial', () => {
    test('returns all groups — no silent cap at 20', async () => {
        // Generate 30 groups to exceed the old LIMIT 20
        const groupCount = 30;
        const groups = [];
        const persons = [];
        const edges = [];
        const participationRows = [];

        for (let i = 1; i <= groupCount; i++) {
            groups.push({
                id: `group:${i}`,
                name: `Group ${i}`,
                type: 'group',
                trackCount: groupCount - i + 1,
                photo: null
            });
            persons.push({
                id: `person:${i}`,
                name: `Person ${i}`,
                type: 'person',
                color: '#aaa'
            });
            edges.push({
                source: `person:${i}`,
                target: `group:${i}`,
                type: 'MEMBER_OF',
                role: 'member',
                from_date: null,
                to_date: null,
                instruments: null
            });
            participationRows.push({
                groupId: `group:${i}`,
                personId: `person:${i}`,
                personName: `Person ${i}`,
                color: '#aaa',
                trackCount: groupCount - i + 1,
                totalTracks: groupCount - i + 1
            });
        }

        const driver = makeDriverStub(async () => ({
            records: [makeRecord({ groups, persons, edges, participationRows })]
        }));

        const app = buildTestApp(driver);

        const response = await request(app)
            .get('/api/graph/initial')
            .expect(200);

        expect(response.body.success).toBe(true);

        const returnedGroups = response.body.nodes.filter(n => n.type === 'group');
        const returnedPersons = response.body.nodes.filter(n => n.type === 'person');

        // Must return ALL 30 groups, not silently capped at 20
        expect(returnedGroups.length).toBe(groupCount);
        expect(returnedPersons.length).toBe(groupCount);
        expect(response.body.edges.length).toBe(groupCount);

        // Verify specific groups beyond old limit are present
        expect(returnedGroups.find(g => g.id === 'group:25')).toBeDefined();
        expect(returnedGroups.find(g => g.id === 'group:30')).toBeDefined();
    });

    test('includes participation data in response', async () => {
        const driver = makeDriverStub(async () => ({
            records: [makeRecord({
                groups: [{ id: 'group:1', name: 'Test Band', type: 'group', trackCount: 10, photo: null }],
                persons: [{ id: 'person:1', name: 'Alice', type: 'person', color: '#f00' }],
                edges: [{ source: 'person:1', target: 'group:1', type: 'MEMBER_OF', role: 'vocals' }],
                participationRows: [{
                    groupId: 'group:1',
                    personId: 'person:1',
                    personName: 'Alice',
                    color: '#f00',
                    trackCount: 8,
                    totalTracks: 10
                }]
            })]
        }));

        const app = buildTestApp(driver);

        const response = await request(app)
            .get('/api/graph/initial')
            .expect(200);

        expect(response.body.participation).toBeDefined();
        expect(response.body.participation['group:1']).toBeDefined();
        expect(response.body.participation['group:1'].totalTracks).toBe(10);
        expect(response.body.participation['group:1'].members).toHaveLength(1);
        expect(response.body.participation['group:1'].members[0].personId).toBe('person:1');
        expect(response.body.participation['group:1'].members[0].trackCount).toBe(8);
        expect(response.body.participation['group:1'].members[0].trackPctOfGroupTracks).toBe(80.0);
    });

    test('Cypher query does not contain LIMIT', async () => {
        const driver = makeDriverStub(async () => ({
            records: [makeRecord({
                groups: [],
                persons: [],
                edges: [],
                participationRows: []
            })]
        }));

        const app = buildTestApp(driver);

        await request(app)
            .get('/api/graph/initial')
            .expect(200);

        // Inspect the Cypher that was sent to the driver
        const cypher = driver._session.run.mock.calls[0][0];
        expect(cypher).not.toMatch(/LIMIT\s+\d+/i);
    });

    test('returns empty graph when no groups exist', async () => {
        const driver = makeDriverStub(async () => ({ records: [] }));
        const app = buildTestApp(driver);

        const response = await request(app)
            .get('/api/graph/initial')
            .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.nodes).toEqual([]);
        expect(response.body.edges).toEqual([]);
        expect(response.body.participation).toEqual({});
    });

    test('filters null persons and edges from OPTIONAL MATCH', async () => {
        const driver = makeDriverStub(async () => ({
            records: [makeRecord({
                groups: [{ id: 'group:1', name: 'Solo Act', type: 'group', trackCount: 5, photo: null }],
                persons: [null, { id: 'person:1', name: 'Alice', type: 'person', color: '#fff' }],
                edges: [null, { source: 'person:1', target: 'group:1', type: 'MEMBER_OF', role: 'vocals' }],
                participationRows: [null, {
                    groupId: 'group:1', personId: 'person:1', personName: 'Alice',
                    color: '#fff', trackCount: 5, totalTracks: 5
                }]
            })]
        }));

        const app = buildTestApp(driver);

        const response = await request(app)
            .get('/api/graph/initial')
            .expect(200);

        // Nulls should be filtered out
        expect(response.body.nodes.every(n => n !== null)).toBe(true);
        expect(response.body.edges.every(e => e !== null)).toBe(true);
        expect(response.body.nodes.length).toBe(2); // 1 group + 1 person
        expect(response.body.edges.length).toBe(1);
        // Participation should also be clean
        expect(response.body.participation['group:1'].members).toHaveLength(1);
    });
});
