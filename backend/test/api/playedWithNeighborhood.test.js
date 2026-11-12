/**
 * GET /api/graph/neighborhood/:nodeId — the bands somebody played with.
 *
 * The initial graph draws these edges, built from the `(Person)-[:PERFORMED_ON
 * {via_group_id}]->(Track)` statements a track line-up writes. The
 * neighbourhood endpoint builds Person ↔ Group from MEMBER_OF alone, so a
 * session player reached by navigating straight to them — out of a search, or
 * a link — landed on a node with nothing attached, and the merge replaces the
 * whole graph with the neighbourhood once it passes 500 nodes.
 *
 * Mounted from the real createGraphRoutes, so a change to the route's own
 * Cypher can fail these.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { createGraphRoutes } from '../../src/api/routes/graph.js';

/** A neo4j node as the driver hands it over. */
const node = (properties) => ({ properties });

const record = (fields) => ({ get: (key) => fields[key] });

const GUITARIST = node({ person_id: 'p:guitar', name: 'Joe Harrison', color: '#112233' });
const BAND = node({ group_id: 'g:band', name: 'A Famous Act', photo: 'https://x/y.jpg' });

/**
 * An app whose driver answers each query by what it asks for.
 *
 * @param {{playedWith?: Array, memberships?: Array}} [options]
 */
function buildApp({ playedWith = [], memberships = [] } = {}) {
    const queries = [];
    const session = {
        run: jest.fn(async (cypher) => {
            queries.push(cypher);

            // The played-with queries are the ones reading via_group_id.
            if (cypher.includes('via_group_id')) {
                return { records: playedWith };
            }
            if (cypher.includes('MATCH (p:Person {person_id: $nodeId})')) {
                return { records: [record({ p: GUITARIST, memberships })] };
            }
            if (cypher.includes('MATCH (g:Group {group_id: $nodeId})')) {
                return {
                    records: [record({
                        g: BAND, memberships, trackNodes: [], releaseEdges: [],
                    })],
                };
            }
            return { records: [] };
        }),
        close: jest.fn(async () => {}),
    };

    const app = express();
    app.use('/api/graph', createGraphRoutes({
        db: { driver: { session: jest.fn(() => session) } },
        config: { env: 'test' },
    }));

    return { app, queries, session };
}

describe('a person who joined no band', () => {
    const rows = [record({ g: BAND, trackCount: { toNumber: () => 2 }, roles: ['guitar'] })];

    test('the bands they played with come back anyway', async () => {
        const { app } = buildApp({ playedWith: rows });
        const res = await request(app).get('/api/graph/neighborhood/prov:person:abc').expect(200);

        expect(res.body.nodes.map((n) => n.id)).toContain('g:band');
    });

    test('over an edge typed PERFORMED_WITH', async () => {
        const { app } = buildApp({ playedWith: rows });
        const res = await request(app).get('/api/graph/neighborhood/prov:person:abc').expect(200);

        expect(res.body.edges).toEqual([{
            source: 'p:guitar',
            target: 'g:band',
            type: 'PERFORMED_WITH',
            trackCount: 2,
            role: 'guitar',
            roles: ['guitar'],
        }]);
    });

    test('and the count is a number, not a bolt integer', async () => {
        const { app } = buildApp({ playedWith: rows });
        const res = await request(app).get('/api/graph/neighborhood/prov:person:abc').expect(200);

        expect(res.body.edges[0].trackCount).toBe(2);
    });

    test('with no roles recorded the edge still arrives', async () => {
        const { app } = buildApp({
            playedWith: [record({ g: BAND, trackCount: { toNumber: () => 1 }, roles: [] })],
        });
        const res = await request(app).get('/api/graph/neighborhood/prov:person:abc').expect(200);

        expect(res.body.edges[0].role).toBeNull();
        expect(res.body.edges[0].roles).toEqual([]);
    });

    test('nothing played with is an empty neighbourhood, not a failure', async () => {
        const { app } = buildApp();
        const res = await request(app).get('/api/graph/neighborhood/prov:person:abc').expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.edges).toEqual([]);
    });
});

describe('a group', () => {
    const rows = [record({
        p: GUITARIST, trackCount: { toNumber: () => 1 }, roles: ['guitar'],
    })];

    test('shows the people who played its tracks without being in it', async () => {
        const { app } = buildApp({ playedWith: rows });
        const res = await request(app).get('/api/graph/neighborhood/prov:group:abc').expect(200);

        expect(res.body.nodes.map((n) => n.id)).toContain('p:guitar');
        expect(res.body.edges).toContainEqual({
            source: 'p:guitar',
            target: 'g:band',
            type: 'PERFORMED_WITH',
            trackCount: 1,
            role: 'guitar',
            roles: ['guitar'],
        });
    });

    test('the edge runs from the person to the group, as a membership does', async () => {
        // The frontend finds the person endpoint by type to colour the edge,
        // but EdgeNavigator and the info panel read direction.
        const { app } = buildApp({ playedWith: rows });
        const res = await request(app).get('/api/graph/neighborhood/prov:group:abc').expect(200);

        const edge = res.body.edges.find((e) => e.type === 'PERFORMED_WITH');
        expect(edge.source).toBe('p:guitar');
        expect(edge.target).toBe('g:band');
    });
});

describe('both queries', () => {
    test('are anchored on the node asked for, not scanned', async () => {
        // An unanchored match walks every group in the registry to answer a
        // question about one.
        const { app, queries } = buildApp();
        await request(app).get('/api/graph/neighborhood/prov:person:abc').expect(200);

        const q = queries.find((c) => c.includes('via_group_id'));
        expect(q).toMatch(/MATCH \(p:Person \{person_id: \$nodeId\}\)/);
    });

    test('exclude members, who already have a MEMBER_OF edge', async () => {
        const { app, queries } = buildApp();
        await request(app).get('/api/graph/neighborhood/prov:group:abc').expect(200);

        const q = queries.find((c) => c.includes('via_group_id'));
        expect(q).toMatch(/NOT \(p\)-\[:MEMBER_OF\]->\(g\)/);
    });

    test('are capped, like every other arm of this endpoint', async () => {
        const { app, session } = buildApp();
        await request(app)
            .get('/api/graph/neighborhood/prov:group:abc?limitPersons=7')
            .expect(200);

        const call = session.run.mock.calls.find((c) => c[0].includes('via_group_id'));
        expect(call[0]).toContain('LIMIT $limitPersons');
        expect(call[1].limitPersons.toNumber()).toBe(7);
    });

    test('and the cap is clamped, so the query string cannot ask for everything', async () => {
        const { app, session } = buildApp();
        await request(app)
            .get('/api/graph/neighborhood/prov:group:abc?limitPersons=99999')
            .expect(200);

        const call = session.run.mock.calls.find((c) => c[0].includes('via_group_id'));
        expect(call[1].limitPersons.toNumber()).toBe(200);
    });
});
