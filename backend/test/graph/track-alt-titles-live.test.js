/**
 * Alternate track titles against a real Neo4j.
 *
 * The question a mock cannot answer: what the node holds after two submissions.
 * `t.alt_titles = coalesce($altTitles, t.alt_titles, [])` is there so a later
 * bundle filled in without running the Spotify cross-check does not erase the
 * spelling an earlier one recorded — a bundle that says nothing about a field
 * is not a bundle that says there is nothing in it. A mock agrees with whatever
 * the query says, so only a database can show that the coalesce works.
 *
 * SKIPS SILENTLY without GRAPH_URI, like every suite in this directory — so a
 * green local run is not evidence this ran. Check the skipped count. See
 * CLAUDE.md for why that warning is there and what shipped past it.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import MusicGraphDatabase from '../../src/graph/schema.js';

const describeOrSkip = (process.env.GRAPH_URI && process.env.SKIP_GRAPH_TESTS !== 'true')
    ? describe : describe.skip;

const RELEASE_NAME = 'Fire of Unknown Origin (alt-title fixture)';
const TITLE = 'Burnin’ For You';
const ALT = 'Burning For You';
const ISRC = 'USSM17900123';

/** A bundle for this release, with whatever extras the case needs on its track. */
const bundleWith = (extras = {}) => ({
    release: { name: RELEASE_NAME, release_date: '1981', format: 'LP' },
    groups: [],
    tracks: [{ title: TITLE, ...extras }],
    tracklist: [{ position: '1', track_title: TITLE }]
});

describeOrSkip('alternate track titles (live graph)', () => {
    let db;
    let session;

    beforeAll(async () => {
        db = new MusicGraphDatabase({
            uri: process.env.GRAPH_URI || 'bolt://127.0.0.1:7687',
            user: process.env.GRAPH_USER || 'neo4j',
            password: process.env.GRAPH_PASSWORD || 'password'
        });
    });

    afterAll(async () => {
        if (session) await session.close();
        if (db?.driver) await db.driver.close();
    });

    beforeEach(async () => {
        if (session) await session.close();
        session = db.driver.session();

        // Scoped to this suite's own release rather than a wholesale wipe: the
        // destructive clean-up belongs to the suites that declare it.
        await session.run(`
            OPTIONAL MATCH (r:Release {name: $release})
            OPTIONAL MATCH (t:Track)-[:IN_RELEASE]->(r)
            OPTIONAL MATCH (t)-[:RECORDING_OF]->(s:Song)
            DETACH DELETE r, t, s
        `, { release: RELEASE_NAME });
    });

    /** The track on this release, as plain properties. */
    async function track() {
        const result = await session.run(`
            MATCH (t:Track)-[:IN_RELEASE]->(:Release {name: $release})
            RETURN t.title AS title, t.alt_titles AS altTitles, t.isrc AS isrc
        `, { release: RELEASE_NAME });

        expect(result.records).toHaveLength(1);
        const row = result.records[0];
        return {
            title: row.get('title'),
            altTitles: row.get('altTitles'),
            isrc: row.get('isrc'),
        };
    }

    test('an alternate title reaches the node', async () => {
        await db.processReleaseBundle('event-alt-1', bundleWith({ alt_titles: [ALT] }), 'tester');

        expect(await track()).toMatchObject({ title: TITLE, altTitles: [ALT] });
    });

    test('an ISRC reaches the node alongside it', async () => {
        // The ISRC is the half of this that other services are queried by, and
        // it travels the same path from the same hidden field.
        await db.processReleaseBundle(
            'event-alt-2', bundleWith({ alt_titles: [ALT], isrc: ISRC }), 'tester');

        expect((await track()).isrc).toBe(ISRC);
    });

    test('a bundle with no alternate title leaves none', async () => {
        await db.processReleaseBundle('event-alt-3', bundleWith(), 'tester');

        expect((await track()).altTitles).toEqual([]);
    });

    test('a later bundle that says nothing does not erase it', async () => {
        // The case the coalesce exists for: the submitter re-submits the
        // release from a form that never ran the cross-check.
        await db.processReleaseBundle('event-alt-4', bundleWith({ alt_titles: [ALT] }), 'tester');
        await db.processReleaseBundle('event-alt-5', bundleWith(), 'tester');

        expect((await track()).altTitles).toEqual([ALT]);
    });

    test('a later bundle that carries one replaces it', async () => {
        await db.processReleaseBundle('event-alt-6', bundleWith({ alt_titles: [ALT] }), 'tester');
        await db.processReleaseBundle(
            'event-alt-7', bundleWith({ alt_titles: ['Burnin For You'] }), 'tester');

        expect((await track()).altTitles).toEqual(['Burnin For You']);
    });

    test('replaying the same event changes nothing', async () => {
        // Idempotency is an invariant here, and property writes are where it
        // has broken before: the edge set replayed stably while the properties
        // on it did not.
        await db.processReleaseBundle('event-alt-8', bundleWith({ alt_titles: [ALT], isrc: ISRC }), 'tester');
        const first = await track();
        await db.processReleaseBundle('event-alt-8', bundleWith({ alt_titles: [ALT], isrc: ISRC }), 'tester');

        expect(await track()).toEqual(first);
    });
});
