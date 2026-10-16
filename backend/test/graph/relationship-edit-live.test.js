/**
 * EDIT_RELATIONSHIP against a real Neo4j.
 *
 * The companion to relationship-edit.test.js, which pins down the decisions
 * with a fake transaction. This pins down the Cypher: which edges a correction
 * actually leaves behind, which is the part a mock cannot tell you anything
 * about, since a mock agrees with whatever the query says.
 *
 * SKIPS SILENTLY without GRAPH_URI, like every suite in this directory — so a
 * green local run is not evidence this ran. Check the skipped count. See
 * CLAUDE.md for why that warning is there and what shipped past it.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import MusicGraphDatabase from '../../src/graph/schema.js';

const describeOrSkip = (process.env.GRAPH_URI && process.env.SKIP_GRAPH_TESTS !== 'true')
    ? describe : describe.skip;

const PERSON = 'test:person:preston';
const GROUP = 'test:group:beatles';
const RELEASE = 'test:release:abbey';
const TRACKS = ['test:track:1', 'test:track:2', 'test:track:3'];

describeOrSkip('EDIT_RELATIONSHIP (live graph)', () => {
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

        // Scoped to this suite's own ids rather than a wholesale wipe: the
        // destructive clean-up belongs to the suites that declare it.
        await session.run(`
            MATCH (n) WHERE n.person_id = $person OR n.group_id = $group
                OR n.release_id = $release OR n.track_id IN $tracks
                OR (n:Claim AND n.node_id = $person)
            DETACH DELETE n
        `, { person: PERSON, group: GROUP, release: RELEASE, tracks: TRACKS });

        await session.run(`
            CREATE (p:Person {person_id: $person, id: $person, name: 'Billy Preston', status: 'ACTIVE'})
            CREATE (g:Group {group_id: $group, id: $group, name: 'The Beatles', status: 'ACTIVE'})
            CREATE (r:Release {release_id: $release, id: $release, name: 'Abbey Road', status: 'ACTIVE'})
            WITH g, r
            UNWIND $tracks AS trackId
            CREATE (t:Track {track_id: trackId, id: trackId, title: trackId, status: 'ACTIVE'})
            CREATE (t)-[:IN_RELEASE]->(r)
            CREATE (g)-[:PERFORMED_ON {claim_id: 'fixture'}]->(t)
        `, { person: PERSON, group: GROUP, release: RELEASE, tracks: TRACKS });
    });

    /** Every edge this suite cares about, as plain rows. */
    async function edges() {
        const result = await session.run(`
            MATCH (p:Person {person_id: $person})-[r]->(x)
            RETURN type(r) AS type,
                   coalesce(x.track_id, x.release_id, x.group_id) AS target,
                   r.scope AS scope, r.roles AS roles, r.via_group_id AS viaGroup
            ORDER BY type, target
        `, { person: PERSON });
        return result.records.map(row => ({
            type: row.get('type'),
            target: row.get('target'),
            scope: row.get('scope'),
            roles: row.get('roles'),
            viaGroup: row.get('viaGroup')
        }));
    }

    const guestOnTrack = (trackId, roles = ['organ']) => session.run(`
        MATCH (p:Person {person_id: $person})
        MATCH (t:Track {track_id: $trackId})
        CREATE (p)-[:GUEST_ON {claim_id: 'fixture', roles: $roles, role: $roles[0], scope: 'track'}]->(t)
    `, { person: PERSON, trackId, roles });

    const guestOnRelease = (roles = ['organ']) => session.run(`
        MATCH (p:Person {person_id: $person})
        MATCH (r:Release {release_id: $release})
        CREATE (p)-[:GUEST_ON {claim_id: 'fixture', roles: $roles, role: $roles[0], scope: 'release'}]->(r)
    `, { person: PERSON, release: RELEASE, roles });

    const memberOf = (roles = ['organ']) => session.run(`
        MATCH (p:Person {person_id: $person})
        MATCH (g:Group {group_id: $group})
        CREATE (p)-[:MEMBER_OF {claim_id: 'fixture', roles: $roles, role: $roles[0]}]->(g)
        WITH p
        UNWIND $tracks AS trackId
        MATCH (t:Track {track_id: trackId})
        CREATE (p)-[:PERFORMED_ON {claim_id: 'fixture', via_group_id: $group, roles: $roles}]->(t)
    `, { person: PERSON, group: GROUP, roles, tracks: TRACKS.slice(0, 2) });

    const correct = (to, extra = {}, hash = 'b'.repeat(64)) => db.processRelationshipEdit(hash, {
        person: { id: PERSON }, group: { id: GROUP }, to, ...extra
    }, 'curator', 1700000000);

    describe('guest becomes member', () => {
        test('the guest credit is gone and the membership is there', async () => {
            await guestOnTrack(TRACKS[1]);

            await correct('MEMBER_OF');

            const found = await edges();
            expect(found.filter(e => e.type === 'GUEST_ON')).toEqual([]);
            expect(found.filter(e => e.type === 'MEMBER_OF')).toEqual([
                { type: 'MEMBER_OF', target: GROUP, scope: null, roles: ['organ'], viaGroup: null }
            ]);
        });

        test('the performances land only on the track they played on', async () => {
            await guestOnTrack(TRACKS[1]);

            await correct('MEMBER_OF');

            expect((await edges()).filter(e => e.type === 'PERFORMED_ON').map(e => e.target))
                .toEqual([TRACKS[1]]);
        });

        test('a release-scoped credit promotes to the whole tracklist', async () => {
            await guestOnRelease();

            await correct('MEMBER_OF');

            const found = await edges();
            expect(found.filter(e => e.type === 'GUEST_ON')).toEqual([]);
            expect(found.filter(e => e.type === 'PERFORMED_ON').map(e => e.target))
                .toEqual(TRACKS);
        });

        test('replaying the same event changes nothing', async () => {
            await guestOnTrack(TRACKS[1]);

            await correct('MEMBER_OF');
            const after = await edges();
            await correct('MEMBER_OF');

            expect(await edges()).toEqual(after);
        });

        test('an existing membership is replaced, not duplicated', async () => {
            // The contradictory state itself: a bundle filed them as member and
            // guest both. One click should leave one membership.
            await memberOf(['organ']);
            await guestOnTrack(TRACKS[2], ['tambourine']);

            await correct('MEMBER_OF');

            const found = await edges();
            expect(found.filter(e => e.type === 'MEMBER_OF').length).toBe(1);
            expect(found.filter(e => e.type === 'GUEST_ON')).toEqual([]);
        });

        test('the person is left credited once, not as member and guest both', async () => {
            // The invariant CLAUDE.md states and a resubmitted bundle breaks.
            await guestOnTrack(TRACKS[1]);

            await correct('MEMBER_OF');

            const found = await edges();
            const onThatTrack = found.filter(e => e.target === TRACKS[1]).map(e => e.type);
            expect(onThatTrack).toEqual(['PERFORMED_ON']);
        });
    });

    describe('member becomes guest', () => {
        test('the membership goes and each performance becomes a guest credit', async () => {
            await memberOf();

            await correct('GUEST_ON');

            const found = await edges();
            expect(found.filter(e => e.type === 'MEMBER_OF')).toEqual([]);
            expect(found.filter(e => e.type === 'PERFORMED_ON')).toEqual([]);
            expect(found.filter(e => e.type === 'GUEST_ON').map(e => [e.target, e.scope, e.roles]))
                .toEqual([[TRACKS[0], 'track', ['organ']], [TRACKS[1], 'track', ['organ']]]);
        });

        test('a member who performed nothing gets a release credit', async () => {
            await session.run(`
                MATCH (p:Person {person_id: $person})
                MATCH (g:Group {group_id: $group})
                CREATE (p)-[:MEMBER_OF {claim_id: 'fixture', roles: ['organ']}]->(g)
            `, { person: PERSON, group: GROUP });

            await correct('GUEST_ON', { release_id: RELEASE });

            expect((await edges()).filter(e => e.type === 'GUEST_ON'))
                .toEqual([{
                    type: 'GUEST_ON', target: RELEASE, scope: 'release',
                    roles: ['organ'], viaGroup: null
                }]);
        });

        test('replaying the same event changes nothing', async () => {
            await memberOf();

            await correct('GUEST_ON', { release_id: RELEASE });
            const after = await edges();
            await correct('GUEST_ON', { release_id: RELEASE });

            expect(await edges()).toEqual(after);
        });

        test('a correction can be reversed, and the claims chain', async () => {
            await memberOf();

            await correct('GUEST_ON', {}, 'c'.repeat(64));
            await correct('MEMBER_OF', {}, 'd'.repeat(64));

            const found = await edges();
            expect(found.filter(e => e.type === 'MEMBER_OF').length).toBe(1);
            expect(found.filter(e => e.type === 'GUEST_ON')).toEqual([]);

            const chain = await session.run(`
                MATCH (newer:Claim)-[:SUPERSEDES]->(older:Claim)
                WHERE newer.node_id = $person AND newer.field = 'relationship'
                RETURN count(*) AS links
            `, { person: PERSON });
            expect(chain.records[0].get('links').toNumber()).toBe(1);
        });
    });

    describe('the release panel can see both kinds of guest', () => {
        /**
         * The query is read out of the route rather than copied into this file,
         * so it cannot drift away from the one that ships. What is being tested
         * is partly that it parses at all: it uses a CALL subquery with UNION,
         * and the endpoint's own test mocks the driver, so nothing else would
         * put this text in front of a real server.
         */
        const routeGuestQuery = () => {
            const here = dirname(fileURLToPath(import.meta.url));
            const source = readFileSync(
                join(here, '../../src/api/routes/entities.js'), 'utf8');
            const match = source.match(
                /const guestResult = await session\.run\(`([\s\S]*?)`/);
            if (!match) throw new Error('could not find the guests query in entities.js');
            return match[1];
        };

        test('a track guest and a release guest both come back', async () => {
            await guestOnTrack(TRACKS[1]);
            await session.run(`
                MATCH (r:Release {release_id: $release})
                CREATE (p:Person {person_id: 'test:person:martin', id: 'test:person:martin',
                                  name: 'George Martin', status: 'ACTIVE'})
                CREATE (p)-[:GUEST_ON {claim_id: 'fixture', role: 'producer', scope: 'release'}]->(r)
            `, { release: RELEASE });

            const result = await session.run(routeGuestQuery(), { releaseId: RELEASE });
            const names = result.records.map(r => r.get('name')).sort();

            expect(names).toEqual(['Billy Preston', 'George Martin']);

            await session.run(
                `MATCH (p:Person {person_id: 'test:person:martin'}) DETACH DELETE p`);
        });
    });
});
