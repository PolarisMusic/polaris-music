/**
 * @fileoverview Ingest a release, then read it back through PlayerService.
 *
 * This is the test that was missing. Every other graph suite checks what
 * processReleaseBundle *writes*; none checked that the result is *visible*
 * afterwards. So a submitted release could be ingested perfectly — correct
 * tracks, correct IN_RELEASE edges, correct ordering — and still return an
 * empty queue for every context, which is exactly what happened: `status` was
 * written 'PROVISIONAL' while all 32 read queries filter `status = 'ACTIVE'`.
 *
 * Write-side assertions cannot catch that class of bug by construction. Only a
 * round trip can.
 *
 * Requires a live Neo4j (GRAPH_URI) and, because it clears the database,
 * ALLOW_DESTRUCTIVE_GRAPH_TESTS=true. See test/graphGuard.js.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import MusicGraphDatabase from '../../src/graph/schema.js';
import { PlayerService } from '../../src/api/playerService.js';
import { assertDisposableGraph } from '../graphGuard.js';

const describeOrSkip = (process.env.GRAPH_URI && process.env.SKIP_GRAPH_TESTS !== 'true')
    ? describe
    : describe.skip;

describeOrSkip('Player queue round trip', () => {
    let graphDb;
    let driver;
    let playerService;
    let releaseId;

    const BUNDLE = {
        release: { name: 'Round Trip Album', release_date: '2024-01-01' },
        groups: [{
            name: 'Round Trip Band',
            members: [{ name: 'Round Trip Member', instruments: ['guitar'] }]
        }],
        tracks: [
            {
                track_id: 'prov:track:rt-one',
                title: 'First Track',
                performed_by_groups: [{ name: 'Round Trip Band' }],
                listen_links: ['https://open.spotify.com/track/RTONE']
            },
            {
                track_id: 'prov:track:rt-two',
                title: 'Second Track',
                performed_by_groups: [{ name: 'Round Trip Band' }]
            }
        ],
        tracklist: [
            { track_id: 'prov:track:rt-one', track_number: 1, disc_number: 1 },
            { track_id: 'prov:track:rt-two', track_number: 2, disc_number: 1 }
        ]
    };

    beforeAll(async () => {
        graphDb = new MusicGraphDatabase({
            uri: process.env.GRAPH_URI || 'bolt://127.0.0.1:7687',
            user: process.env.GRAPH_USER || 'neo4j',
            password: process.env.GRAPH_PASSWORD || 'password'
        });
        driver = graphDb.driver;

        await driver.verifyConnectivity();

        // This suite deletes every node. Refuse unless explicitly opted in.
        await assertDisposableGraph(driver, 'Player queue round trip');

        const session = driver.session();
        try { await session.run('MATCH (n) DETACH DELETE n'); } finally { await session.close(); }
        await graphDb.initializeSchema();

        playerService = new PlayerService(driver);
    });

    afterAll(async () => {
        await graphDb.close();
    });

    beforeEach(async () => {
        const session = driver.session();
        try { await session.run('MATCH (n) DETACH DELETE n'); } finally { await session.close(); }

        const result = await graphDb.processReleaseBundle(
            'roundtrip_event_hash', BUNDLE, 'testaccount'
        );
        releaseId = result.releaseId;
    });

    test('a freshly ingested release yields a non-empty queue', async () => {
        const { context, queue } = await playerService.buildQueue('release', releaseId);

        expect(context).not.toBeNull();
        expect(context.name).toBe('Round Trip Album');
        expect(queue).toHaveLength(2);
    });

    test('the group that performed it also yields a queue', async () => {
        // The reported symptom: selecting the group showed "No tracks in queue".
        const session = driver.session();
        let groupId;
        try {
            const r = await session.run(
                `MATCH (g:Group {name: 'Round Trip Band'}) RETURN g.group_id AS id`
            );
            groupId = r.records[0]?.get('id');
        } finally {
            await session.close();
        }

        expect(groupId).toBeTruthy();
        const { queue } = await playerService.buildQueue('group', groupId);
        expect(queue.length).toBeGreaterThan(0);
    });

    test('the queue comes back in tracklist order', async () => {
        const { queue } = await playerService.buildQueue('release', releaseId);

        expect(queue.map(t => t.track_name)).toEqual(['First Track', 'Second Track']);
        expect(queue.map(t => t.track_number)).toEqual([1, 2]);
    });

    test('listen links survive the round trip and classify as an embed', async () => {
        const { queue } = await playerService.buildQueue('release', releaseId);
        const first = queue.find(t => t.track_name === 'First Track');

        // A Spotify URL is a web page, not an audio stream — never inline-playable,
        // but it must reach the MiniPlayer as an embed URI.
        expect(first.listen.can_inline_play).toBe(false);
        expect(first.listen.embed_uri).toBe('spotify:track:RTONE');
        expect(first.listen.embed_service).toBe('spotify');
    });

    test('ingested nodes are ACTIVE with the provisional marker kept in id_kind', async () => {
        const session = driver.session();
        try {
            const r = await session.run(`
                MATCH (n)
                WHERE n:Group OR n:Release OR n:Track OR n:Person
                RETURN DISTINCT labels(n)[0] AS label, n.status AS status, n.id_kind AS idKind
            `);
            const rows = r.records.map(rec => ({
                label: rec.get('label'), status: rec.get('status'), idKind: rec.get('idKind')
            }));

            expect(rows.length).toBeGreaterThan(0);
            // status is lifecycle only; PROVISIONAL there makes the node invisible.
            expect([...new Set(rows.map(x => x.status))]).toEqual(['ACTIVE']);
            // and the distinction is not lost, only relocated.
            expect([...new Set(rows.map(x => x.idKind))]).toEqual(['provisional']);
        } finally {
            await session.close();
        }
    });
});
