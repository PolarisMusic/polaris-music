/**
 * GET /api/graph/initial — the two halves of the guest bucket.
 *
 * Everyone who is not a member of the performing group lands in `GUEST_ON`, so
 * a featured vocalist and the person who shot the sleeve arrive over identical
 * edges. Hiding the whole bucket by default is what pushed a submitter with an
 * interesting session player to show into filing them as a *member* — a
 * display default corrupting the data.
 *
 * So the bucket is asked for in halves, per role rather than per person, and
 * the halves get different defaults. Mounted from the real createGraphRoutes,
 * so a change to the route can fail these.
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

const SAX = { id: 'p:sax', name: 'A Saxophonist', type: 'person', color: '#ddeeff' };
const SLEEVE = { id: 'p:sleeve', name: 'A Designer', type: 'person', color: '#334455' };
const BOTH = { id: 'p:both', name: 'Thomas Brenneck', type: 'person', color: '#667788' };

/**
 * Guest rows as the query really returns them: `roles` is a list per credit,
 * collected across a person's credits, so it arrives as a list of lists.
 */
const GUESTS = {
    persons: [SAX, SLEEVE, BOTH],
    edges: [
        { source: 'p:sax', target: 'g:band', type: 'GUEST_ON', trackCount: 2, scope: 'track', roles: [['saxophone']] },
        { source: 'p:sleeve', target: 'g:band', type: 'GUEST_ON', trackCount: 1, scope: 'release', roles: [['artwork', 'photography by']] },
        { source: 'p:both', target: 'g:band', type: 'GUEST_ON', trackCount: 3, scope: 'track', roles: [['mixed by', 'guitar']] },
    ],
};

const NOTHING = { persons: [], edges: [] };

function buildApp({ guests = GUESTS, performers = NOTHING } = {}) {
    const queries = [];
    const session = {
        run: jest.fn(async (cypher) => {
            queries.push(cypher);
            if (cypher.includes('PERFORMED_WITH')) return { records: [record(performers)] };
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

    return { app, queries, session };
}

/** Guest edge ids in the response, by the person they run from. */
const guestSources = (res) =>
    res.body.edges.filter((e) => e.type === 'GUEST_ON').map((e) => e.source).sort();

describe('asking for musical guests', () => {
    test('a saxophonist arrives', async () => {
        const { app } = buildApp();
        const res = await request(app).get('/api/graph/initial?musicalGuests=true').expect(200);

        expect(guestSources(res)).toContain('p:sax');
    });

    test('the sleeve designer does not', async () => {
        const { app } = buildApp();
        const res = await request(app).get('/api/graph/initial?musicalGuests=true').expect(200);

        expect(guestSources(res)).not.toContain('p:sleeve');
    });

    test('and is not left on screen as a node with nothing joining them', async () => {
        // The query collects persons and edges independently, so filtering
        // only the edges would strand them.
        const { app } = buildApp();
        const res = await request(app).get('/api/graph/initial?musicalGuests=true').expect(200);

        expect(res.body.nodes.map((n) => n.id)).not.toContain('p:sleeve');
    });

    test('the nested role lists the query returns are flattened', async () => {
        const { app } = buildApp();
        const res = await request(app).get('/api/graph/initial?musicalGuests=true').expect(200);

        const sax = res.body.edges.find((e) => e.source === 'p:sax');
        expect(sax.roles).toEqual(['saxophone']);
        expect(sax.role).toBe('saxophone');
    });
});

describe('a credit that is both', () => {
    test('arrives, because its owner played', async () => {
        const { app } = buildApp();
        const res = await request(app).get('/api/graph/initial?musicalGuests=true').expect(200);

        expect(guestSources(res)).toContain('p:both');
    });

    test('trimmed to what was asked for, so the edge reads as the guitar credit', async () => {
        // "Mixed By, Guitar" is one human. Labelling the edge "mixed by"
        // because it came first would describe the wrong half of them.
        const { app } = buildApp();
        const res = await request(app).get('/api/graph/initial?musicalGuests=true').expect(200);

        const edge = res.body.edges.find((e) => e.source === 'p:both');
        expect(edge.roles).toEqual(['guitar']);
        expect(edge.role).toBe('guitar');
    });

    test('and keeps both roles once technical credits are asked for too', async () => {
        const { app } = buildApp();
        const res = await request(app)
            .get('/api/graph/initial?musicalGuests=true&technicians=true').expect(200);

        const edge = res.body.edges.find((e) => e.source === 'p:both');
        expect(edge.roles).toEqual(['mixed by', 'guitar']);
    });
});

describe('asking for technical credits', () => {
    test('the sleeve designer arrives', async () => {
        const { app } = buildApp();
        const res = await request(app).get('/api/graph/initial?technicians=true').expect(200);

        expect(guestSources(res)).toContain('p:sleeve');
        expect(res.body.nodes.map((n) => n.id)).toContain('p:sleeve');
    });

    test('and the saxophonist does not, since nobody asked for musicians', async () => {
        // Not a combination the UI offers, but the flags compose rather than
        // override, and a flag that quietly implied another would be worse.
        const { app } = buildApp();
        const res = await request(app).get('/api/graph/initial?technicians=true').expect(200);

        expect(guestSources(res)).not.toContain('p:sax');
    });
});

describe('asking for both', () => {
    test('everyone arrives', async () => {
        const { app } = buildApp();
        const res = await request(app)
            .get('/api/graph/initial?musicalGuests=true&technicians=true').expect(200);

        expect(guestSources(res)).toEqual(['p:both', 'p:sax', 'p:sleeve']);
    });

    test('and the older spelling still means both', async () => {
        // A saved link, or anything written against the endpoint before the
        // bucket was split.
        const { app } = buildApp();
        const res = await request(app).get('/api/graph/initial?guests=true').expect(200);

        expect(guestSources(res)).toEqual(['p:both', 'p:sax', 'p:sleeve']);
    });
});

describe('asking for neither', () => {
    test('no guest query is run at all', async () => {
        // The server's own default stays members-only. Musical guests being on
        // is the frontend's choice, made where the checkbox is.
        const { app, queries } = buildApp();
        const res = await request(app).get('/api/graph/initial').expect(200);

        expect(queries.some((q) => q.includes('GUEST_ON'))).toBe(false);
        expect(res.body.edges.map((e) => e.type)).toEqual(['MEMBER_OF']);
    });

    test('a value that is not exactly true is not the flag', async () => {
        for (const value of ['1', 'yes', 'TRUE', 'false', '']) {
            const { app, queries } = buildApp();
            await request(app)
                .get(`/api/graph/initial?musicalGuests=${value}&technicians=${value}`)
                .expect(200);
            expect(queries.some((q) => q.includes('GUEST_ON'))).toBe(false);
        }
    });
});

describe('people who played without joining', () => {
    const PERFORMERS = {
        persons: [
            { id: 'p:guitar', name: 'Joe Harrison', type: 'person', color: '#112233' },
            { id: 'p:tape', name: 'A Tape Op', type: 'person', color: '#445566' },
        ],
        edges: [
            { source: 'p:guitar', target: 'g:band', type: 'PERFORMED_WITH', trackCount: 1, roles: [['guitar']] },
            { source: 'p:tape', target: 'g:band', type: 'PERFORMED_WITH', trackCount: 1, roles: [['engineer']] },
        ],
    };

    const playedWith = (res) =>
        res.body.edges.filter((e) => e.type === 'PERFORMED_WITH').map((e) => e.source).sort();

    test('the musician arrives with no flag at all', async () => {
        const { app } = buildApp({ performers: PERFORMERS });
        const res = await request(app).get('/api/graph/initial').expect(200);

        expect(playedWith(res)).toEqual(['p:guitar']);
    });

    test('the engineer typed into a line-up does not', async () => {
        // Nothing stops a submitter putting an engineer in "Group Members on
        // This Track". If the same rule did not hold here, the way to force a
        // hidden credit onto the graph would be to use the other form field —
        // which is the loophole this whole split exists to close.
        const { app } = buildApp({ performers: PERFORMERS });
        const res = await request(app).get('/api/graph/initial').expect(200);

        expect(playedWith(res)).not.toContain('p:tape');
        expect(res.body.nodes.map((n) => n.id)).not.toContain('p:tape');
    });

    test('until technical credits are asked for', async () => {
        const { app } = buildApp({ performers: PERFORMERS });
        const res = await request(app).get('/api/graph/initial?technicians=true').expect(200);

        expect(playedWith(res)).toEqual(['p:guitar', 'p:tape']);
    });

    test('and turning musical guests off does not take the musician away', async () => {
        // A named line-up is a deliberate statement and there are few of them,
        // so these are not behind the guest flag at all.
        const { app } = buildApp({ performers: PERFORMERS });
        const res = await request(app).get('/api/graph/initial?technicians=true').expect(200);

        expect(playedWith(res)).toContain('p:guitar');
    });
});

describe('the donut', () => {
    test('still counts the band, whatever is drawn around it', async () => {
        // It answers "who is in this group and how much of its work did they
        // play" — not "who turned up". Widening it would change what the
        // circle means.
        const { app } = buildApp();
        const plain = await request(app).get('/api/graph/initial').expect(200);
        const { app: app2 } = buildApp();
        const everything = await request(app2)
            .get('/api/graph/initial?musicalGuests=true&technicians=true').expect(200);

        expect(everything.body.participation).toEqual(plain.body.participation);
        expect(everything.body.participation['g:band'].members.map((m) => m.personId))
            .toEqual(['p:drums']);
    });
});
