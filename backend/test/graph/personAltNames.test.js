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
        ['a guest on the release', { release_guests: [
            { name: 'Kristen Gundred', roles: ['Producer'], alt_names: ['Dee Dee'] }] }],
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
