/**
 * A credit row that names a band rather than a person.
 *
 * Catalogues do not keep the two apart. Discogs files "The Budos Band" among a
 * release's extraartists beside its mixing engineer, and an act's own member
 * list can name a horn section as readily as a trumpeter — so the row looks
 * like a person all the way through the form.
 *
 * Left alone, the band is stored as a Person. That is not a display problem
 * that a view can paper over: the entity search returns it as a Person, the
 * next submitter binds a human slot to it, and the only way back is a
 * MERGE_NODE event against data that is already anchored. So the marker the
 * form puts on the row is read on the way in, by hoistGroupCredits, which
 * recasts the row as a group that performed on the recording. Every view
 * already draws Group -[:PERFORMED_ON]-> Track, so nothing downstream changes.
 *
 * Driven partly against a recording transaction, for the same reason
 * trackLineup.test.js is: the defects here are in which statements get
 * issued, and the live suites skip silently without GRAPH_URI.
 */

import { describe, test, expect } from '@jest/globals';
import MusicGraphDatabase from '../../src/graph/schema.js';
import { normalizeReleaseBundle } from '../../src/graph/normalizeReleaseBundle.js';

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

/** Statements that write a Group -> Track performance. */
const performances = (statements) =>
    statements.filter((s) => /MERGE \(g\)-\[p:PERFORMED_ON/.test(s.cypher));

/** Statements that write a MEMBER_OF edge. */
const memberships = (statements) =>
    statements.filter((s) => /MERGE \(p\)-\[m(em)?:MEMBER_OF/.test(s.cypher));

/** Statements that write a Person -> Track guest credit. */
const guestWrites = (statements) =>
    statements.filter((s) => /MERGE \(p\)-\[g:GUEST_ON/.test(s.cypher));

/** The groups a track ended up with, by name. */
const groupNames = (track) => (track.performed_by_groups || []).map((g) => g.name);

const bradley = (overrides = {}) => ({
    release: { name: 'Victim Of Love', ...(overrides.release || {}) },
    groups: overrides.groups ?? [{
        name: 'Charles Bradley',
        members: [{ name: 'Charles Bradley', roles: ['Vocals'] }],
    }],
    tracks: overrides.tracks ?? [{
        title: 'Strictly Reserved For You',
        guests: [{ name: 'The Budos Band', entity_type: 'group', role: 'Backing Band' }],
    }],
    tracklist: overrides.tracklist
        ?? [{ position: '1', track_title: 'Strictly Reserved For You' }],
});

describe('a guest on a track that is really a band', () => {
    test('becomes a group performing on that track', () => {
        const out = normalizeReleaseBundle(bradley());

        expect(groupNames(out.tracks[0])).toContain('The Budos Band');
    });

    test('and leaves the guest list, so it is never written as a Person', () => {
        const out = normalizeReleaseBundle(bradley());

        expect(out.tracks[0].guests).toBeUndefined();
    });

    test('flagged a guest, because it is not the act the release is credited to', () => {
        const out = normalizeReleaseBundle(bradley());

        const budos = out.tracks[0].performed_by_groups
            .find((g) => g.name === 'The Budos Band');
        expect(budos.guest).toBe(true);
    });

    test('the flag reaches the edge', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bradley(), 'polaristest2', Date.now());

        const budos = performances(statements)
            .find((s) => s.params.groupName === 'The Budos Band');
        expect(budos).toBeDefined();
        expect(budos.params.guest).toBe(true);
        expect(budos.cypher).toContain('p.guest = $guest');
    });

    test('and the act keeps its own unflagged edge', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bradley(), 'polaristest2', Date.now());

        const act = performances(statements)
            .find((s) => s.params.groupName === 'Charles Bradley');
        expect(act).toBeDefined();
        expect(act.params.guest).toBe(false);
    });

    test('no Person guest credit is written for it', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bradley(), 'polaristest2', Date.now());

        const names = guestWrites(statements).map((s) => s.params.name);
        expect(names).not.toContain('The Budos Band');
    });
});

describe('the act whose track the band guests on', () => {
    test('still performs on it', async () => {
        // The regression this guards: ingestion falls back to the release's
        // act for a track that names no performer of its own, and the test
        // was `performed_by_groups.length === 0`. A hoisted guest band made
        // the list non-empty, so the fallback stopped firing and the track
        // lost the band whose record it is.
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bradley(), 'polaristest2', Date.now());

        expect(performances(statements).map((s) => s.params.groupName))
            .toEqual(expect.arrayContaining(['Charles Bradley', 'The Budos Band']));
    });

    test('and a track that names its own act does not gain the release act', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, bradley({
            tracks: [{
                title: 'Strictly Reserved For You',
                performed_by_groups: [{ name: 'Menahan Street Band' }],
                guests: [{ name: 'The Budos Band', entity_type: 'group' }],
            }],
        }), 'polaristest2', Date.now());

        expect(performances(statements).map((s) => s.params.groupName).sort())
            .toEqual(['Menahan Street Band', 'The Budos Band']);
    });
});

describe('a member of an act that is really a band', () => {
    const withBandMember = () => bradley({
        groups: [{
            name: 'Charles Bradley',
            members: [
                { name: 'Charles Bradley', roles: ['Vocals'] },
                { name: 'The Budos Band', entity_type: 'group', role: 'Backing Band' },
            ],
        }],
        tracks: [{ title: 'Strictly Reserved For You' }, { title: 'Victim Of Love' }],
        tracklist: [
            { position: '1', track_title: 'Strictly Reserved For You' },
            { position: '2', track_title: 'Victim Of Love' },
        ],
    });

    test('stops being a member', () => {
        const out = normalizeReleaseBundle(withBandMember());

        expect(out.groups[0].members.map((m) => m.name)).toEqual(['Charles Bradley']);
    });

    test('and performs on every track the act performs on', () => {
        const out = normalizeReleaseBundle(withBandMember());

        for (const track of out.tracks) {
            expect(groupNames(track)).toContain('The Budos Band');
        }
    });

    test('not flagged a guest: the line-up puts it in the band', () => {
        const out = normalizeReleaseBundle(withBandMember());

        const budos = out.tracks[0].performed_by_groups
            .find((g) => g.name === 'The Budos Band');
        expect(budos.guest).toBe(false);
    });

    test('and no MEMBER_OF is written for it', async () => {
        // A Group cannot be MEMBER_OF a Group in this model — Group is a
        // collection of Persons — so the edge would have had a Person node
        // named after a band on one end.
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, withBandMember(), 'polaristest2', Date.now());

        const named = memberships(statements).flatMap((s) =>
            s.params.members ? s.params.members.map((m) => m.name) : [s.params.name]);
        expect(named).not.toContain('The Budos Band');
    });

    test('only onto the tracks that act plays, on a split release', () => {
        const out = normalizeReleaseBundle(bradley({
            groups: [{
                name: 'Charles Bradley',
                members: [{ name: 'The Budos Band', entity_type: 'group' }],
            }, {
                name: 'Menahan Street Band',
                members: [{ name: 'Thomas Brenneck', roles: ['Guitar'] }],
            }],
            tracks: [
                { title: 'Side A', performed_by_groups: [{ name: 'Charles Bradley' }] },
                { title: 'Side B', performed_by_groups: [{ name: 'Menahan Street Band' }] },
            ],
            tracklist: [
                { position: 'A', track_title: 'Side A' },
                { position: 'B', track_title: 'Side B' },
            ],
        }));

        expect(groupNames(out.tracks[0])).toContain('The Budos Band');
        expect(groupNames(out.tracks[1])).not.toContain('The Budos Band');
    });
});

describe('a release-level guest that is really a band', () => {
    const releaseGuestBand = () => bradley({
        release: {
            guests: [
                { name: 'The Budos Band', entity_type: 'group', role: 'Horns' },
                { name: 'Thomas Brenneck', role: 'Mixing Engineer' },
            ],
        },
        tracks: [{ title: 'Strictly Reserved For You' }, { title: 'Victim Of Love' }],
        tracklist: [
            { position: '1', track_title: 'Strictly Reserved For You' },
            { position: '2', track_title: 'Victim Of Love' },
        ],
    });

    test('performs on the whole record', () => {
        // Group -[:GUEST_ON]-> Release is not in the model: GUEST_ON runs from
        // a Person, and the GraphQL guest list is typed Person. A release-wide
        // credit for a band means it played across the record.
        const out = normalizeReleaseBundle(releaseGuestBand());

        for (const track of out.tracks) {
            expect(groupNames(track)).toContain('The Budos Band');
        }
    });

    test('flagged a guest throughout', () => {
        const out = normalizeReleaseBundle(releaseGuestBand());

        for (const track of out.tracks) {
            const budos = track.performed_by_groups.find((g) => g.name === 'The Budos Band');
            expect(budos.guest).toBe(true);
        }
    });

    test('and the human beside it is left alone', () => {
        const out = normalizeReleaseBundle(releaseGuestBand());

        expect(out.release.guests.map((g) => g.name)).toEqual(['Thomas Brenneck']);
    });
});

describe('an unmarked credit', () => {
    test('stays a person', () => {
        const out = normalizeReleaseBundle(bradley({
            tracks: [{
                title: 'Strictly Reserved For You',
                guests: [{ name: 'Thomas Brenneck', role: 'Guitar' }],
            }],
        }));

        expect(out.tracks[0].guests.map((g) => g.name)).toEqual(['Thomas Brenneck']);
        expect(groupNames(out.tracks[0])).not.toContain('Thomas Brenneck');
    });
});

describe('the id a bound row carries', () => {
    test('a group_id is kept, so the band resolves to the node that was picked', () => {
        const out = normalizeReleaseBundle(bradley({
            tracks: [{
                title: 'Strictly Reserved For You',
                guests: [{
                    name: 'The Budos Band',
                    entity_type: 'group',
                    group_id: 'grp:budos',
                }],
            }],
        }));

        const budos = out.tracks[0].performed_by_groups
            .find((g) => g.name === 'The Budos Band');
        expect(budos.group_id).toBe('grp:budos');
    });

    test('a person_id is not reused as one', () => {
        // It would point the performance edge at a Person node, which is the
        // thing being avoided. Resolving by name is the lesser wrong.
        const out = normalizeReleaseBundle(bradley({
            tracks: [{
                title: 'Strictly Reserved For You',
                guests: [{
                    name: 'The Budos Band',
                    entity_type: 'group',
                    person_id: 'psn:someone',
                }],
            }],
        }));

        const budos = out.tracks[0].performed_by_groups
            .find((g) => g.name === 'The Budos Band');
        expect(budos.group_id).toBeUndefined();
        expect(budos.person_id).toBeUndefined();
    });
});

describe('a band named in two places on one release', () => {
    test('lands once, with the stronger claim', () => {
        // Once in the act's line-up, once in a track's guests. It is one band
        // on that track, and the line-up is the stronger statement — the same
        // way membership beats a guest credit for a person.
        const out = normalizeReleaseBundle(bradley({
            groups: [{
                name: 'Charles Bradley',
                members: [{ name: 'The Budos Band', entity_type: 'group' }],
            }],
            tracks: [{
                title: 'Strictly Reserved For You',
                guests: [{ name: 'The Budos Band', entity_type: 'group' }],
            }],
        }));

        const budos = out.tracks[0].performed_by_groups
            .filter((g) => g.name === 'The Budos Band');
        expect(budos).toHaveLength(1);
        expect(budos[0].guest).toBe(false);
    });
});
