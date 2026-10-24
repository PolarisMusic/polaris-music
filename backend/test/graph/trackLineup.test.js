/**
 * A line-up named on a track, and whether the graph can see it.
 *
 * /api/graph builds the main view from `MEMBER_OF` and nothing else: a Person
 * enters the graph *because* they are a member of a Group, and MEMBER_OF is
 * the only edge type the query returns. The Person->Track edges this same code
 * writes are read only for the donut's participation counts.
 *
 * So a group whose only line-up is named on a track reached the graph as a
 * bare node. On "Various — Lost Ark Studio Compilation Vol. 4" that was all
 * ten acts: the people were in the registry, the bands were on screen, and
 * nothing joined them — nor joined the compilation to the Andrew Ware already
 * there from another release.
 *
 * Driven against a recording transaction: the defect is in which statements
 * are issued, and the live suites that would have caught it skip silently
 * without GRAPH_URI.
 */

import { describe, test, expect } from '@jest/globals';
import MusicGraphDatabase from '../../src/graph/schema.js';

function recordingDriver() {
    const statements = [];
    const tx = {
        run: async (cypher, params) => {
            statements.push({ cypher, params });
            return { records: [{ get: (key) => (key === 'resolvedId' ? null : 'x') }] };
        },
        commit: async () => {},
        rollback: async () => {},
    };
    const session = { beginTransaction: () => tx, run: tx.run, close: async () => {} };
    return { statements, driver: { session: () => session, close: async () => {} } };
}

function graphWithRecorder() {
    const db = new MusicGraphDatabase({ uri: 'bolt://unused', user: 'u', password: 'p' });
    const recorder = recordingDriver();
    db.driver = recorder.driver;
    return { db, statements: recorder.statements };
}

const HASH = 'b'.repeat(64);

/** Statements that write a MEMBER_OF edge. */
const membershipWrites = (statements) =>
    statements.filter((s) => /MERGE \(p\)-\[mem:MEMBER_OF/.test(s.cypher));

/** The line-up as this release credits it, Tan Sister Radio on track 3. */
const LINE_UP = [
    { name: 'Andrew Ware', roles: ['Drums'] },
    { name: 'Aaron Dennis', roles: ['Guitar'] },
    { name: 'Max Greenhalgh', roles: ['Vocals', 'Bass'] },
];

/** A compilation: no release-level groups, the act named on the track. */
const compilation = (overrides = {}) => ({
    release: { name: 'Lost Ark Studio Compilation Vol. 4' },
    tracks: [{
        title: 'Leap Year',
        performed_by_groups: [{ name: 'Tan Sister Radio', members: LINE_UP }],
        ...overrides,
    }],
    tracklist: [{ position: '3', track_title: 'Leap Year' }],
});

describe('a group whose line-up is only named on a track', () => {
    test('its members become members, so the graph can draw them', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, compilation(), 'polaristest2', Date.now());

        const [write] = membershipWrites(statements);
        expect(write).toBeDefined();
        expect(write.params.members.map((m) => m.name))
            .toEqual(['Andrew Ware', 'Aaron Dennis', 'Max Greenhalgh']);
        // Written against the act named on the track, not the release.
        expect(write.cypher).toContain('MATCH (g:Group {group_id: $groupId})');
    });

    test('the instruments come with them', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, compilation(), 'polaristest2', Date.now());

        // Through normalizeRoleInput, which is the registry's own vocabulary:
        // lowercased, and "Bass" is the instrument "bass guitar". The credit
        // as printed survives on the Discogs side of the import; this is the
        // graph's spelling of it.
        const [{ params }] = membershipWrites(statements);
        expect(params.members[2].roles).toEqual(['vocals', 'bass guitar']);
        expect(params.members[2].role).toBe('vocals');
    });

    test('and the Person->Track edges are still written', async () => {
        // They are what the donut counts participation from, and they say
        // which track each person actually played on.
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, compilation(), 'polaristest2', Date.now());

        expect(statements.some((s) => /MERGE \(p\)-\[perf:PERFORMED_ON/.test(s.cypher)
            && s.cypher.includes('track_explicit'))).toBe(true);
    });

    test('no dates are invented for it', async () => {
        // A track credit says who played on this release, not when they
        // joined the band.
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, compilation(), 'polaristest2', Date.now());

        const [{ cypher }] = membershipWrites(statements);
        expect(cypher).toContain('mem.from_date = null');
        expect(cypher).toContain('mem.to_date = null');
    });

    test('a guest on the track is not made a member of it', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, compilation({
            guests: [{ name: 'Aaron Dennis', roles: ['Guitar'] }],
        }), 'polaristest2', Date.now());

        const [{ params }] = membershipWrites(statements);
        expect(params.members.map((m) => m.name)).toEqual(['Andrew Ware', 'Max Greenhalgh']);
    });
});

describe('a group the release already has a line-up for', () => {
    /**
     * Then a track-level list is an override — a member sitting out, a
     * stand-in behind the kit — and not a statement about who is in the band.
     * Promoting a stand-in to membership is the confidently-wrong answer the
     * domain model warns against ("If unclear, default to guest").
     */
    const album = {
        release: { name: 'Songs For The Deaf' },
        groups: [{
            name: 'Queens Of The Stone Age',
            members: [{ name: 'Josh Homme', roles: ['Vocals', 'Guitar'] }],
        }],
        tracks: [{
            title: 'No One Knows',
            performed_by_groups: [{
                name: 'Queens Of The Stone Age',
                members: [{ name: 'Dave Grohl', roles: ['Drums'] }],
            }],
        }],
        tracklist: [{ position: '2', track_title: 'No One Knows' }],
    };

    test('a track override does not add a membership', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, album, 'polaristest2', Date.now());

        // The release-level loop writes its own MEMBER_OF; the track-level
        // path writes none, which is this assertion.
        expect(membershipWrites(statements)).toEqual([]);
    });

    test('but the override still plays on the track', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, album, 'polaristest2', Date.now());

        const explicit = statements.find((s) => /MERGE \(p\)-\[perf:PERFORMED_ON/.test(s.cypher)
            && s.cypher.includes('track_explicit'));
        expect(explicit.params.members.map((m) => m.name)).toEqual(['Dave Grohl']);
    });
});
