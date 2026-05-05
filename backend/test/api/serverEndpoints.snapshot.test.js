/**
 * Stage H — Server endpoint characterization tests.
 *
 * These tests lock the public response shapes of APIServer's most-used
 * endpoints. Stage I will split server.js into smaller modules; these tests
 * must remain green at every commit during that split. If a snapshot here
 * changes during a refactor, the response contract changed — investigate.
 *
 * Strategy: ESM-mock every dependency APIServer imports so the constructor
 * succeeds without a real Neo4j/IPFS/S3/RPC stack, then drive the actual
 * Express app via supertest.
 *
 * Endpoint coverage (per refactor plan, Stage H):
 *   REST:    GET  /health
 *            GET  /api/stats
 *            GET  /api/group/:groupId
 *            GET  /api/person/:personId
 *            GET  /api/track/:trackId
 *            GET  /api/release/:releaseId
 *            GET  /api/song/:songId
 *            POST /api/events/create
 *            POST /api/events/confirm-anchor
 *            POST /api/crypto/resolve-signing-key (RPC-unavailable branch)
 *   GraphQL: person, group, track, release, song
 */

import { jest } from '@jest/globals';
import express from 'express';

// ---------------------------------------------------------------------------
// Shared mock state — captured here so every test in the file can reach in.
// ---------------------------------------------------------------------------

const sharedRun = jest.fn();
const sharedSession = {
    run: sharedRun,
    close: jest.fn(async () => {})
};
const sharedDriver = {
    session: jest.fn(() => sharedSession),
    close: jest.fn(async () => {})
};

const sharedStoreState = {
    storeEvent: jest.fn(),
    retrieveEvent: jest.fn(),
    getStats: jest.fn(() => ({ stored: 10, retrieved: 5, errors: 0 })),
    testConnectivity: jest.fn(async () => ({ ipfs: true, s3: true, redis: true })),
    redis: null,
    close: jest.fn(async () => {})
};

const sharedDbStats = {
    nodes: { Person: 100, Group: 50, Track: 500, Release: 25, Song: 75 },
    relationships: { MEMBER_OF: 80, PERFORMED_ON: 600 }
};

// ---------------------------------------------------------------------------
// Module mocks — must be registered BEFORE the dynamic import of server.js.
// ---------------------------------------------------------------------------

jest.unstable_mockModule('../../src/graph/schema.js', () => ({
    default: jest.fn().mockImplementation(() => ({
        driver: sharedDriver,
        getStats: jest.fn(async () => sharedDbStats),
        testConnection: jest.fn(async () => true),
        initializeSchema: jest.fn(async () => {}),
        close: jest.fn(async () => {})
    }))
}));

jest.unstable_mockModule('../../src/storage/eventStore.js', () => ({
    default: jest.fn().mockImplementation(() => sharedStoreState)
}));

jest.unstable_mockModule('../../src/indexer/eventProcessor.js', () => ({
    default: jest.fn().mockImplementation(() => ({
        eventHandlers: {},
        start: jest.fn(),
        stop: jest.fn()
    }))
}));

jest.unstable_mockModule('../../src/api/ingestion.js', () => ({
    IngestionHandler: jest.fn().mockImplementation(() => ({
        fetchAccountData: jest.fn(async () => null),
        flushBatch: jest.fn(),
        shutdown: jest.fn()
    }))
}));

jest.unstable_mockModule('../../src/api/playerService.js', () => ({
    PlayerService: jest.fn().mockImplementation(() => ({
        getQueue: jest.fn(async () => ({ tracks: [] }))
    }))
}));

jest.unstable_mockModule('../../src/api/nodeSearchService.js', () => ({
    NodeSearchService: jest.fn().mockImplementation(() => ({
        search: jest.fn(async () => [])
    }))
}));

jest.unstable_mockModule('../../src/api/chainReaderService.js', () => ({
    ChainReaderService: jest.fn().mockImplementation(() => ({
        registerRoutes: jest.fn()
    }))
}));

jest.unstable_mockModule('../../src/api/routes/identity.js', () => ({
    createIdentityRoutes: jest.fn(() => express.Router())
}));

// ---------------------------------------------------------------------------
// Import APIServer + supertest only after mocks are in place.
// ---------------------------------------------------------------------------

const { default: APIServer } = await import('../../src/api/server.js');
const { default: request } = await import('supertest');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(fields) {
    return {
        get(key) {
            if (!(key in fields)) {
                throw new Error(`record.get('${key}') — key not in fixture`);
            }
            return fields[key];
        }
    };
}

/**
 * neo4j-driver returns Integer wrappers for whole numbers. Routes call
 * .toNumber() on them, so the fixture must too.
 */
function int(n) {
    return { toNumber: () => n, low: n, high: 0 };
}

function nodeProps(properties) {
    return { properties };
}

let server;
let app;

beforeAll(() => {
    server = new APIServer({
        port: 0,
        database: { uri: 'bolt://stub:7687', user: 'stub', password: 'stub' },
        storage: {},
        env: 'test',
    });
    app = server.app;
});

beforeEach(() => {
    sharedRun.mockReset();
    sharedStoreState.storeEvent.mockReset();
    sharedStoreState.retrieveEvent.mockReset();
    sharedStoreState.redis = null;
});

// ---------------------------------------------------------------------------
// REST snapshots
// ---------------------------------------------------------------------------

describe('Stage H · REST endpoint snapshots', () => {

    test('GET /health → 200 with status/uptime envelope', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        // Drop volatile fields, snapshot the shape only.
        const { timestamp, uptime, ...stable } = res.body;
        expect(typeof timestamp).toBe('string');
        expect(typeof uptime).toBe('number');
        expect(stable).toMatchSnapshot();
    });

    test('GET /api/stats → 200 with database+storage envelope', async () => {
        const res = await request(app).get('/api/stats');
        expect(res.status).toBe(200);
        const { timestamp, ...stable } = res.body;
        expect(typeof timestamp).toBe('string');
        expect(stable).toMatchSnapshot();
    });

    test('GET /api/group/:groupId → 200 with members + counts', async () => {
        sharedRun.mockResolvedValueOnce({
            records: [makeRecord({
                g: nodeProps({ group_id: 'group:beatles', name: 'The Beatles', status: 'ACTIVE' }),
                trackCount: int(213),
                releaseCount: int(13),
                members: [
                    { person: 'John Lennon', person_id: 'person:lennon', role: 'rhythm guitar', from_date: '1960', to_date: '1970' },
                    { person: 'Paul McCartney', person_id: 'person:mccartney', role: 'bass', from_date: '1960', to_date: '1970' },
                    { person: null, person_id: null, role: null, from_date: null, to_date: null }
                ]
            })]
        });

        const res = await request(app).get('/api/group/group:beatles');
        expect(res.status).toBe(200);
        expect(res.body).toMatchSnapshot();
    });

    test('GET /api/group/:groupId → 404 when not found', async () => {
        sharedRun.mockResolvedValueOnce({ records: [] });
        const res = await request(app).get('/api/group/group:missing');
        expect(res.status).toBe(404);
        expect(res.body).toMatchSnapshot();
    });

    test('GET /api/person/:personId → 200 with groups + counts', async () => {
        sharedRun.mockResolvedValueOnce({
            records: [makeRecord({
                p: nodeProps({ person_id: 'person:lennon', name: 'John Lennon', status: 'ACTIVE' }),
                groups: [
                    { group: 'The Beatles', group_id: 'group:beatles', role: 'rhythm guitar', from_date: '1960', to_date: '1970' },
                    { group: null, group_id: null, role: null, from_date: null, to_date: null }
                ],
                songsWritten: int(180),
                guestAppearances: int(3)
            })]
        });

        const res = await request(app).get('/api/person/person:lennon');
        expect(res.status).toBe(200);
        expect(res.body).toMatchSnapshot();
    });

    test('GET /api/track/:trackId → 200 envelope shape', async () => {
        sharedRun.mockResolvedValueOnce({
            records: [makeRecord({
                t: nodeProps({ track_id: 'track:abbey', title: 'Come Together', status: 'ACTIVE' }),
                s: nodeProps({ song_id: 'song:come-together', title: 'Come Together' }),
                performedBy: [
                    { group: 'The Beatles', group_id: 'group:beatles' },
                    { group: null, group_id: null }
                ],
                guests: [{ guest: null, person_id: null }],
                releases: [{ release: 'Abbey Road', release_id: 'release:abbey-road' }]
            })]
        });
        const res = await request(app).get('/api/track/track:abbey');
        expect(res.status).toBe(200);
        expect(res.body).toMatchSnapshot();
    });

    test('GET /api/release/:releaseId → 200 envelope shape', async () => {
        // Three sequential session.run() calls: main, groups, guests
        sharedRun
            .mockResolvedValueOnce({
                records: [makeRecord({
                    r: nodeProps({ release_id: 'release:abbey-road', name: 'Abbey Road', release_date: '1969-09-26' }),
                    tracks: [
                        { track: 'Come Together', track_id: 'track:abbey', disc_number: 1, track_number: 1, side: 'A' },
                        { track: null, track_id: null, disc_number: null, track_number: null, side: null }
                    ],
                    labels: [{ label: 'Apple Records', label_id: 'label:apple' }]
                })]
            })
            .mockResolvedValueOnce({
                records: [{
                    get(key) {
                        if (key === 'group_id') return 'group:beatles';
                        if (key === 'name') return 'The Beatles';
                        throw new Error(`unexpected key: ${key}`);
                    }
                }]
            })
            .mockResolvedValueOnce({
                records: [{
                    get(key) {
                        if (key === 'person_id') return 'person:preston';
                        if (key === 'name') return 'Billy Preston';
                        if (key === 'color') return '#abc';
                        if (key === 'roles') return ['organ', ''];
                        throw new Error(`unexpected key: ${key}`);
                    }
                }]
            });
        const res = await request(app).get('/api/release/release:abbey-road');
        expect(res.status).toBe(200);
        expect(res.body).toMatchSnapshot();
    });

    test('GET /api/song/:songId → 200 envelope shape', async () => {
        sharedRun.mockResolvedValueOnce({
            records: [makeRecord({
                s: nodeProps({ song_id: 'song:come-together', title: 'Come Together' }),
                writers: [
                    { writer: 'John Lennon', person_id: 'person:lennon' },
                    { writer: null, person_id: null }
                ],
                recordings: [{ track: 'Come Together', track_id: 'track:abbey' }],
                releases: [{
                    release: 'Abbey Road', release_id: 'release:abbey-road',
                    release_date: '1969-09-26', album_art: null
                }]
            })]
        });
        const res = await request(app).get('/api/song/song:come-together');
        expect(res.status).toBe(200);
        expect(res.body).toMatchSnapshot();
    });

    test('POST /api/events/create → 201 envelope on storage success', async () => {
        sharedStoreState.storeEvent.mockResolvedValueOnce({
            hash: 'abc123',
            canonical_cid: 'bafkreicanon',
            event_cid: 'bafkreievent',
            s3: 's3://bucket/abc',
            redis: true,
            replication: { canonical: { primary: true }, event: { primary: true } },
            pinning: { attempted: false, success: false },
            errors: []
        });
        const res = await request(app)
            .post('/api/events/create')
            .send({ type: 'TEST', body: { foo: 'bar' } });
        expect(res.status).toBe(201);
        expect(res.body).toMatchSnapshot();
    });

    test('POST /api/events/create → 503 when event_cid is missing', async () => {
        sharedStoreState.storeEvent.mockResolvedValueOnce({
            hash: 'abc123',
            canonical_cid: 'bafkreicanon',
            event_cid: null,
            s3: 's3://bucket/abc',
            redis: true,
            errors: ['ipfs unavailable']
        });
        const res = await request(app)
            .post('/api/events/create')
            .send({ type: 'TEST', body: { foo: 'bar' } });
        expect(res.status).toBe(503);
        const { stored, ...rest } = res.body;
        expect(rest).toMatchSnapshot();
        expect(stored).toMatchSnapshot('event_cid-missing.stored');
    });

    test('POST /api/events/confirm-anchor → 200 with status:anchored', async () => {
        const res = await request(app)
            .post('/api/events/confirm-anchor')
            .send({ hash: 'abc', trx_id: 'trx', author_account: 'alice', event_cid: 'cid' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchSnapshot();
    });

    test('POST /api/events/confirm-anchor → 400 when required fields missing', async () => {
        const res = await request(app)
            .post('/api/events/confirm-anchor')
            .send({ hash: 'abc' });
        expect(res.status).toBe(400);
        expect(res.body).toMatchSnapshot();
    });

    test('POST /api/crypto/resolve-signing-key → 503 when RPC_URL unset', async () => {
        const oldRpc = process.env.RPC_URL;
        delete process.env.RPC_URL;
        try {
            const res = await request(app)
                .post('/api/crypto/resolve-signing-key')
                .send({});
            expect(res.status).toBe(503);
            expect(res.body).toMatchSnapshot();
        } finally {
            if (oldRpc !== undefined) process.env.RPC_URL = oldRpc;
        }
    });

    test('POST /api/crypto/resolve-signing-key → 400 on missing fields (RPC set)', async () => {
        const oldRpc = process.env.RPC_URL;
        process.env.RPC_URL = 'http://stub-rpc:8888';
        try {
            const res = await request(app)
                .post('/api/crypto/resolve-signing-key')
                .send({ account: 'alice' }); // missing other required fields
            expect(res.status).toBe(400);
            expect(res.body).toMatchSnapshot();
        } finally {
            if (oldRpc !== undefined) process.env.RPC_URL = oldRpc;
            else delete process.env.RPC_URL;
        }
    });

});

// ---------------------------------------------------------------------------
// GraphQL snapshots
// ---------------------------------------------------------------------------

describe('Stage H · GraphQL snapshots', () => {

    async function gql(query, variables = {}) {
        return request(app).post('/graphql').send({ query, variables });
    }

    test('query { person } returns shape under ACTIVE filter', async () => {
        sharedRun.mockResolvedValueOnce({
            records: [makeRecord({
                p: nodeProps({ person_id: 'person:lennon', name: 'John Lennon', status: 'ACTIVE' }),
                groups: [{
                    group: nodeProps({ group_id: 'group:beatles', name: 'The Beatles', status: 'ACTIVE' }),
                    role: 'rhythm guitar', from_date: '1960', to_date: '1970', instruments: ['guitar', 'vocals']
                }],
                songsWritten: [nodeProps({ song_id: 'song:imagine', title: 'Imagine', status: 'ACTIVE' })],
                tracksProduced: [],
                guestAppearances: []
            })]
        });

        const res = await gql(`
            query($id: String!) {
                person(person_id: $id) {
                    person_id name status
                    groups { group { group_id name } role from_date to_date instruments }
                    songsWritten { song_id title }
                }
            }
        `, { id: 'person:lennon' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchSnapshot();
    });

    test('query { group } returns members + RGraph participation', async () => {
        sharedRun.mockResolvedValueOnce({
            records: [makeRecord({
                g: nodeProps({ group_id: 'group:beatles', name: 'The Beatles', status: 'ACTIVE' }),
                members: [{
                    person: nodeProps({ person_id: 'person:lennon', name: 'John Lennon', status: 'ACTIVE' }),
                    role: 'rhythm guitar', from_date: '1960', to_date: '1970',
                    instruments: ['guitar'], participation_percentage: 100, track_count: int(213), release_count: int(13)
                }],
                releases: [],
                tracks: []
            })]
        });
        const res = await gql(`
            query($id: String!) {
                group(group_id: $id) {
                    group_id name status
                    members { person { person_id name } role participation_percentage track_count release_count }
                }
            }
        `, { id: 'group:beatles' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchSnapshot();
    });

    test('query { track } returns shape', async () => {
        sharedRun.mockResolvedValueOnce({
            records: [makeRecord({
                t: nodeProps({ track_id: 'track:abbey', title: 'Come Together', status: 'ACTIVE' }),
                performedBy: [nodeProps({ group_id: 'group:beatles', name: 'The Beatles', status: 'ACTIVE' })],
                guests: [],
                recordingOf: nodeProps({ song_id: 'song:come-together', title: 'Come Together', status: 'ACTIVE' }),
                releases: []
            })]
        });
        const res = await gql(`
            query($id: String!) {
                track(track_id: $id) {
                    track_id title status
                    performedBy { group_id name }
                    recordingOf { song_id title }
                }
            }
        `, { id: 'track:abbey' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchSnapshot();
    });

    test('query { release } returns shape', async () => {
        sharedRun.mockResolvedValueOnce({
            records: [makeRecord({
                r: nodeProps({ release_id: 'release:abbey-road', name: 'Abbey Road', status: 'ACTIVE' }),
                tracks: [{
                    track: nodeProps({ track_id: 'track:abbey', title: 'Come Together', status: 'ACTIVE' }),
                    disc_number: 1, track_number: 1, side: 'A', is_bonus: false
                }],
                labels: [],
                master: null
            })]
        });
        const res = await gql(`
            query($id: String!) {
                release(release_id: $id) {
                    release_id name status
                    tracks { track { track_id title } disc_number track_number side is_bonus }
                }
            }
        `, { id: 'release:abbey-road' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchSnapshot();
    });

    test('query { song } returns shape', async () => {
        sharedRun.mockResolvedValueOnce({
            records: [makeRecord({
                s: nodeProps({ song_id: 'song:come-together', title: 'Come Together', status: 'ACTIVE' }),
                writers: [nodeProps({ person_id: 'person:lennon', name: 'John Lennon', status: 'ACTIVE' })],
                recordings: [nodeProps({ track_id: 'track:abbey', title: 'Come Together', status: 'ACTIVE' })]
            })]
        });
        const res = await gql(`
            query($id: String!) {
                song(song_id: $id) {
                    song_id title
                    writers { person_id name }
                    recordings { track_id title status }
                }
            }
        `, { id: 'song:come-together' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchSnapshot();
    });

});
