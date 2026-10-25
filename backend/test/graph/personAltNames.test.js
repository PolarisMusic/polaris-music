/**
 * Alternate names on a Person, and why they have to accumulate.
 *
 * The thing a submitter wants: bind a credit to the Kristen Gundred already in
 * the registry, add "Dee Dee" beside it, and have typing "Dee Dee" find her
 * afterwards. Search was ready for that — the fulltext index covers
 * `alt_names` and the substring fallback checks it — and Person was the one
 * entity that never had the property written.
 *
 * It also fixes what Group had instead of this. `coalesce($altNames,
 * g.alt_names, [])` reads as a guard and is not one: the caller sends
 * `alt_names || []`, an empty list is not null in Cypher, so the parameter
 * always won. Any later release by the same act, submitted without repeating
 * the alias, erased it.
 *
 * Driven against a recording transaction: what is at stake is which statements
 * are issued and with what parameters, and the live suites skip silently
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

const HASH = 'c'.repeat(64);

/** Statements that MERGE a Person on its own (not the UNWIND line-up write). */
const personWrites = (statements) =>
    statements.filter((s) => /MERGE \(p:Person \{person_id: \$personId\}\)/.test(s.cypher));

/** The UNWIND that writes a track's line-up. */
const lineUpWrites = (statements) =>
    statements.filter((s) => /MERGE \(p:Person \{person_id: m\.personId\}\)/.test(s.cypher));

const bundle = (overrides = {}) => ({
    release: { name: 'Dum Dum Girls EP' },
    groups: [{
        name: 'Dum Dum Girls',
        members: [{ name: 'Kristen Gundred', roles: ['Vocals'], alt_names: ['Dee Dee'] }],
    }],
    tracks: [{ title: 'Rest Of Our Lives' }],
    tracklist: [{ position: '1', track_title: 'Rest Of Our Lives' }],
    ...overrides,
});

describe('an alias added to a band member', () => {
    test('it reaches the Person node', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bundle(), 'polaristest2', Date.now());

        const [write] = personWrites(statements);
        expect(write).toBeDefined();
        expect(write.params.altNames).toEqual(['Dee Dee']);
        expect(write.cypher).toContain('p.alt_names =');
    });

    test('it is added to what the node already has, never swapped for it', async () => {
        // The whole point: another release knows her as something else, and
        // neither submission is in a position to overrule the other.
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bundle(), 'polaristest2', Date.now());

        const [{ cypher }] = personWrites(statements);
        expect(cypher).toContain('coalesce(p.alt_names, []) +');
        expect(cypher).not.toContain('coalesce($altNames, p.alt_names');
    });

    test('a name the node already has is not stored twice, whatever its case', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bundle(), 'polaristest2', Date.now());

        const [{ cypher }] = personWrites(statements);
        expect(cypher).toContain('toLower(alt) IN [have IN coalesce(p.alt_names, []) | toLower(have)]');
    });

    test('the person’s own name is not stored as an alias of themselves', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bundle(), 'polaristest2', Date.now());

        const [{ cypher }] = personWrites(statements);
        expect(cypher).toContain("toLower(alt) <> toLower(coalesce(p.name, ''))");
    });

    test('a release that names no alias sends an empty list, which adds nothing',
        async () => {
            const { db, statements } = graphWithRecorder();

            await db.processReleaseBundle(HASH, bundle({
                groups: [{ name: 'Dum Dum Girls', members: [{ name: 'Kristen Gundred' }] }],
            }), 'polaristest2', Date.now());

            const [{ params }] = personWrites(statements);
            expect(params.altNames).toEqual([]);
        });
});

describe('every relationship that can bring a Person into being', () => {
    test.each([
        ['a band member', { groups: [{ name: 'G', members: [
            { name: 'Kristen Gundred', alt_names: ['Dee Dee'] }] }] }],
        ['a guest on the release', { release: { name: 'Dum Dum Girls EP', guests: [
            { name: 'Kristen Gundred', roles: ['Producer'], alt_names: ['Dee Dee'] }] },
        groups: [] }],
        ['a guest on a track', { tracks: [{ title: 'Rest Of Our Lives', guests: [
            { name: 'Kristen Gundred', roles: ['Guitar'], alt_names: ['Dee Dee'] }] }] }],
    ])('%s carries the alias', async (_label, overrides) => {
        // An alias that works on a member and silently does not on a guest is
        // worse than none: the submitter has no way to tell which happened.
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bundle(overrides), 'polaristest2', Date.now());

        const carrying = personWrites(statements)
            .filter((s) => (s.params.altNames ?? []).includes('Dee Dee'));
        expect(carrying.length).toBeGreaterThan(0);
        // Exactly one person in each of these fixtures carries it, so a
        // sibling path cannot satisfy the assertion on another's behalf.
        expect(carrying).toHaveLength(1);
        for (const write of carrying) expect(write.cypher).toContain('p.alt_names =');
    });

    test('a songwriter carries it too', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bundle({
            songs: [{ title: 'Rest Of Our Lives', writers: [
                { name: 'Kristen Gundred', roles: ['Composer'], alt_names: ['Dee Dee'] }] }],
        }), 'polaristest2', Date.now());

        const carrying = personWrites(statements)
            .filter((s) => (s.params.altNames ?? []).includes('Dee Dee'));
        expect(carrying.length).toBeGreaterThan(0);
    });

    test('a line-up named on a track carries it per person', async () => {
        // This one writes many people in one statement, so the aliases travel
        // in the row rather than as a parameter for the whole thing.
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, {
            release: { name: 'Compilation' },
            tracks: [{
                title: 'Leap Year',
                performed_by_groups: [{ name: 'Tan Sister Radio', members: [
                    { name: 'Kristen Gundred', roles: ['Drums'], alt_names: ['Dee Dee'] },
                    { name: 'Aaron Dennis', roles: ['Guitar'] },
                ] }],
            }],
            tracklist: [{ position: '1', track_title: 'Leap Year' }],
        }, 'polaristest2', Date.now());

        const [write] = lineUpWrites(statements);
        expect(write).toBeDefined();
        expect(write.params.members[0].altNames).toEqual(['Dee Dee']);
        expect(write.params.members[1].altNames).toEqual([]);
        expect(write.cypher).toContain("coalesce(m.altNames, [])");
    });
});

describe('a group’s own aliases, which used to be erased', () => {
    test('a later release no longer wipes them', async () => {
        // Submitting any release by this act, without restating the alias,
        // set g.alt_names to the empty list it was sent.
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bundle(), 'polaristest2', Date.now());

        const [groupWrite] = statements
            .filter((s) => /MERGE \(g:Group \{group_id: \$groupId\}\)/.test(s.cypher));
        expect(groupWrite).toBeDefined();
        expect(groupWrite.cypher).toContain('coalesce(g.alt_names, []) +');
        expect(groupWrite.cypher).not.toContain('coalesce($altNames, g.alt_names');
    });
});

describe('a picture of an act or a person', () => {
    /**
     * Five places read `photo` — the search results, the graph API, the node
     * renderer that draws it on the node itself, and the info panel, which
     * shows it for both a Group and a Person with an editable Photo URL row.
     * Nothing ever wrote one from a submission, so none of that had anything
     * to draw.
     */
    test('a group’s photo reaches the node', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bundle({
            groups: [{ name: 'Dum Dum Girls', photo: 'https://pic/band.jpg', members: [] }],
        }), 'polaristest2', Date.now());

        const [write] = statements
            .filter((s) => /MERGE \(g:Group \{group_id: \$groupId\}\)/.test(s.cypher));
        expect(write.params.photo).toBe('https://pic/band.jpg');
        expect(write.cypher).toContain('g.photo = coalesce(g.photo, $photo)');
    });

    test('a member’s photo reaches theirs', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bundle({
            groups: [{ name: 'Dum Dum Girls', members: [
                { name: 'Kristen Gundred', photo: 'https://pic/kg.jpg' }] }],
        }), 'polaristest2', Date.now());

        const [write] = personWrites(statements);
        expect(write.params.photo).toBe('https://pic/kg.jpg');
        expect(write.cypher).toContain('p.photo = coalesce(p.photo, $photo)');
    });

    test('one already on the node is kept, not replaced', async () => {
        // A node's picture is a curated fact and a later release should not
        // churn it; the info panel's Photo URL row is how it is changed on
        // purpose. Same posture as p.color, and as the album cover's
        // first-source-wins rule.
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bundle({
            groups: [{ name: 'G', members: [{ name: 'K', photo: 'https://pic/new.jpg' }] }],
        }), 'polaristest2', Date.now());

        const [{ cypher }] = personWrites(statements);
        expect(cypher).toContain('coalesce(p.photo, $photo)');
        expect(cypher).not.toContain('coalesce($photo, p.photo)');
    });

    test('a release that names no photo sends null, which changes nothing', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bundle(), 'polaristest2', Date.now());

        const [write] = personWrites(statements);
        expect(write.params.photo).toBeNull();
    });

    test.each([
        ['a guest on the release', { release: { name: 'Dum Dum Girls EP', guests: [
            { name: 'Björk', roles: ['Featuring'], photo: 'https://pic/b.jpg' }] } }],
        ['a guest on a track', { tracks: [{ title: 'Rest Of Our Lives', guests: [
            { name: 'Björk', roles: ['Guitar'], photo: 'https://pic/b.jpg' }] }] }],
    ])('%s carries one', async (_label, overrides) => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bundle(overrides), 'polaristest2', Date.now());

        // Both halves: the parameter is sent AND the statement writes it. The
        // parameter alone passed with the write removed entirely.
        const carrying = personWrites(statements)
            .filter((s) => s.params.photo === 'https://pic/b.jpg');
        expect(carrying).toHaveLength(1);
        expect(carrying[0].cypher).toContain('p.photo = coalesce(p.photo, $photo)');
    });

    test('a songwriter carries one', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bundle({
            songs: [{ title: 'Rest Of Our Lives', writers: [
                { name: 'Kristen Gundred', photo: 'https://pic/kg.jpg' }] }],
        }), 'polaristest2', Date.now());

        const carrying = personWrites(statements)
            .filter((s) => s.params.photo === 'https://pic/kg.jpg');
        expect(carrying).toHaveLength(1);
        expect(carrying[0].cypher).toContain('p.photo = coalesce(p.photo, $photo)');
    });

    test('a line-up named on a track carries one per person', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, {
            release: { name: 'Compilation' },
            tracks: [{
                title: 'Leap Year',
                performed_by_groups: [{ name: 'Tan Sister Radio', members: [
                    { name: 'Andrew Ware', roles: ['Drums'], photo: 'https://pic/aw.jpg' },
                    { name: 'Aaron Dennis', roles: ['Guitar'] },
                ] }],
            }],
            tracklist: [{ position: '1', track_title: 'Leap Year' }],
        }, 'polaristest2', Date.now());

        const [write] = lineUpWrites(statements);
        expect(write.params.members[0].photo).toBe('https://pic/aw.jpg');
        expect(write.params.members[1].photo).toBeNull();
        expect(write.cypher).toContain('p.photo = coalesce(p.photo, m.photo)');
    });
});
