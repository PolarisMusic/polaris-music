/**
 * GET /api/graph/initial?guests=true
 *
 * Mounted from the real `createGraphRoutes`, not from a copy of its logic.
 * The older initialGraph.test.js re-declares the route's Cypher inside the test
 * file, which means it verifies a transcription rather than the endpoint — a
 * change to the real route cannot fail it.
 *
 * What matters here is the member/guest distinction. The registry's whole point
 * is that a session musician is not a band member, and both arrive at the same
 * node over an edge with the same endpoints, so nothing but the declared type
 * tells them apart.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { createGraphRoutes } from '../../src/api/routes/graph.js';

const record = (fields) => ({ get: (key) => fields[key] });

const MEMBERS = {
    groups: [{ id: 'g:band', name: 'Test Band', type: 'group', trackCount: 10, photo: null }],
    persons: [{ id: 'p:drums', name: 'A Drummer', type: 'person', color: '#aabbcc' }],
    edges: [{ source: 'p:drums', target: 'g:band', type: 'MEMBER_OF', role: 'drums' }],
    participationRows: [{
        groupId: 'g:band', personId: 'p:drums', personName: 'A Drummer',
        color: '#aabbcc', trackCount: 10, totalTracks: 10,
    }],
};

const GUESTS = {
    persons: [{ id: 'p:sax', name: 'A Saxophonist', type: 'person', color: '#ddeeff' }],
    edges: [{
        source: 'p:sax', target: 'g:band', type: 'GUEST_ON',
        trackCount: 2, scope: 'track', roles: ['saxophone'],
    }],
};

/**
 * An app on the real router, with a driver that answers each query by shape.
 *
 * @param {{guests?: object}} [options]
 */
function buildApp({ guests = GUESTS } = {}) {
    const queries = [];
    const session = {
        run: jest.fn(async (cypher) => {
            queries.push(cypher);
            // The guest query is the one that matches GUEST_ON.
            if (cypher.includes('GUEST_ON')) return { records: [record(guests)] };
            return { records: [record(MEMBERS)] };
        }),
        close: jest.fn(async () => {}),
    };

    const app = express();
    app.use('/api/graph', createGraphRoutes({
        db: { driver: { session: jest.fn(() => session) } },
        config: { env: 'test' },
    }));

    return { app, session, queries };
}

describe('without the flag', () => {
    test('no guest query is run at all', async () => {
        const { app, queries } = buildApp();
        const res = await request(app).get('/api/graph/initial').expect(200);

        expect(queries.some((q) => q.includes('GUEST_ON'))).toBe(false);
        expect(res.body.edges.map((e) => e.type)).toEqual(['MEMBER_OF']);
    });

    test('a value that is not exactly true is not the flag', async () => {
        // The query string is attacker-reachable and the cost of the guest query
        // is a second round trip; "1", "yes" and "TRUE" are not opt-ins.
        for (const value of ['1', 'yes', 'TRUE', 'false', '']) {
            const { app, queries } = buildApp();
            await request(app).get(`/api/graph/initial?guests=${value}`).expect(200);
            expect(queries.some((q) => q.includes('GUEST_ON'))).toBe(false);
        }
    });
});

describe('with the flag', () => {
    test('guest persons and their edges are added', async () => {
        const { app } = buildApp();
        const res = await request(app).get('/api/graph/initial?guests=true').expect(200);

        expect(res.body.nodes.map((n) => n.id)).toEqual(['g:band', 'p:drums', 'p:sax']);
        expect(res.body.edges).toHaveLength(2);
        expect(res.body.edges[1]).toMatchObject({
            source: 'p:sax', target: 'g:band', type: 'GUEST_ON', trackCount: 2, scope: 'track',
        });
    });

    test('the guest edge is typed GUEST_ON, not MEMBER_OF', async () => {
        // Both run Person → Group. The type is the only thing that keeps a
        // session musician from being drawn as a member of the band.
        const { app } = buildApp();
        const res = await request(app).get('/api/graph/initial?guests=true').expect(200);

        const guestEdge = res.body.edges.find((e) => e.source === 'p:sax');
        expect(guestEdge.type).toBe('GUEST_ON');
    });

    test('members are untouched by the addition', async () => {
        const { app } = buildApp();
        const plain = await request(app).get('/api/graph/initial').expect(200);
        const { app: app2 } = buildApp();
        const withGuests = await request(app2).get('/api/graph/initial?guests=true').expect(200);

        expect(withGuests.body.edges[0]).toEqual(plain.body.edges[0]);
        expect(withGuests.body.participation).toEqual(plain.body.participation);
    });

    test('a guest who is also a member elsewhere is not duplicated as a node', async () => {
        // The guest query returns them because they guest with this group; they
        // are already a node because they are a member of another. One node.
        const { app } = buildApp({
            guests: {
                persons: [{ id: 'p:drums', name: 'A Drummer', type: 'person', color: '#aabbcc' }],
                edges: [{ source: 'p:drums', target: 'g:other', type: 'GUEST_ON', trackCount: 1, scope: 'track', roles: [] }],
            },
        });
        const res = await request(app).get('/api/graph/initial?guests=true').expect(200);

        expect(res.body.nodes.filter((n) => n.id === 'p:drums')).toHaveLength(1);
        // The edge still arrives — it is the new information.
        expect(res.body.edges.filter((e) => e.type === 'GUEST_ON')).toHaveLength(1);
    });

    test('a guest count that comes back as a Neo4j integer is a number', async () => {
        // Counts arrive as {low, high} objects over bolt, and a {low: 2} in the
        // payload renders as nothing useful and compares false against 2.
        const { app } = buildApp({
            guests: {
                persons: GUESTS.persons,
                edges: [{
                    ...GUESTS.edges[0],
                    trackCount: { low: 7, high: 0, toNumber: () => 7 },
                }],
            },
        });
        const res = await request(app).get('/api/graph/initial?guests=true').expect(200);

        expect(res.body.edges[1].trackCount).toBe(7);
    });

    test('no guests at all is an empty addition, not a failure', async () => {
        const { app } = buildApp({ guests: { persons: [], edges: [] } });
        const res = await request(app).get('/api/graph/initial?guests=true').expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.edges.map((e) => e.type)).toEqual(['MEMBER_OF']);
    });

    test('malformed guest rows are dropped rather than emitted', async () => {
        const { app } = buildApp({
            guests: {
                persons: [null, { id: null, name: 'Nobody' }, GUESTS.persons[0]],
                edges: [null, { source: 'p:sax', target: null, type: 'GUEST_ON' }, GUESTS.edges[0]],
            },
        });
        const res = await request(app).get('/api/graph/initial?guests=true').expect(200);

        expect(res.body.nodes.map((n) => n.id)).toEqual(['g:band', 'p:drums', 'p:sax']);
        expect(res.body.edges.filter((e) => e.type === 'GUEST_ON')).toHaveLength(1);
    });
});

describe('the guest query itself', () => {
    test('excludes members of the group it is drawing the edge to', async () => {
        // At group level, membership wins: without this the same person arrives
        // twice on two different edges to the same node.
        const { app, queries } = buildApp();
        await request(app).get('/api/graph/initial?guests=true').expect(200);

        const guestQuery = queries.find((q) => q.includes('GUEST_ON'));
        expect(guestQuery).toMatch(/WHERE NOT \(p\)-\[:MEMBER_OF\]->\(g\)/);
    });

    test('follows both track credits and release credits', async () => {
        // An engineer is credited once for the record, not once per song.
        const { app, queries } = buildApp();
        await request(app).get('/api/graph/initial?guests=true').expect(200);

        const guestQuery = queries.find((q) => q.includes('GUEST_ON'));
        expect(guestQuery).toMatch(/\(t\)<-\[tg:GUEST_ON\]-\(tp:Person\)/);
        expect(guestQuery).toMatch(/\(r:Release\)<-\[rg:GUEST_ON\]-\(rp:Person\)/);
    });

    test('is parameter-free, so nothing from the query string reaches Cypher', async () => {
        const { app, session } = buildApp();
        await request(app).get('/api/graph/initial?guests=true').expect(200);

        for (const call of session.run.mock.calls) {
            // Either no params at all, or none carrying request input.
            expect(call[1] === undefined || Object.keys(call[1]).length === 0).toBe(true);
        }
    });
});
