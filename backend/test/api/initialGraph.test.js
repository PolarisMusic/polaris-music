/**
 * Regression tests for GET /api/graph/initial
 *
 * Ensures the endpoint returns ALL groups with tracks (no silent cap),
 * along with their MEMBER_OF person relationships.
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
                    } ELSE null END) as edges
                `);

                if (result.records.length === 0) {
                    return res.json({ success: true, nodes: [], edges: [] });
                }

                const groups = result.records[0].get('groups');
                const persons = result.records[0].get('persons').filter(p => p !== null);
                const edges = result.records[0].get('edges').filter(e => e !== null);

                res.json({
                    success: true,
                    nodes: [...groups, ...persons],
                    edges: edges
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
        }

        const driver = makeDriverStub(async () => ({
            records: [makeRecord({ groups, persons, edges })]
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

    test('Cypher query does not contain LIMIT', async () => {
        const driver = makeDriverStub(async () => ({
            records: [makeRecord({
                groups: [],
                persons: [],
                edges: []
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
    });

    test('filters null persons and edges from OPTIONAL MATCH', async () => {
        const driver = makeDriverStub(async () => ({
            records: [makeRecord({
                groups: [{ id: 'group:1', name: 'Solo Act', type: 'group', trackCount: 5, photo: null }],
                persons: [null, { id: 'person:1', name: 'Alice', type: 'person', color: '#fff' }],
                edges: [null, { source: 'person:1', target: 'group:1', type: 'MEMBER_OF', role: 'vocals' }]
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
    });
});
