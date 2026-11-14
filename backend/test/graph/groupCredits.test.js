/**
 * A credit that names a band rather than a person.
 *
 * Bands are credited constantly: "Pearl Jam — Produced By", a group credited
 * as the writer of its own songs. Those are true credits, and they belong
 * where credits go. The node carrying one is Person-shaped because that is
 * what a credit is, and the only thing missing is which entity it is about.
 *
 * So the credit stays put and gains a SAME_AS edge to the band, which the
 * info panel follows to offer "Main page: Pearl Jam". Deliberately not a
 * merge and deliberately not a performance: MERGE_NODE would rewire the
 * GUEST_ON onto a Group, which this model does not have, and PERFORMED_ON
 * would claim the producer played, which they may not have.
 *
 * Driven against a recording transaction, like trackLineup.test.js: the
 * defect would be in which statements get issued, and the live suites skip
 * silently without GRAPH_URI.
 */

import { describe, test, expect } from '@jest/globals';
import MusicGraphDatabase from '../../src/graph/schema.js';
import { normalizeReleaseBundle } from '../../src/graph/normalizeReleaseBundle.js';

function graphWithRecorder() {
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
    const db = new MusicGraphDatabase({ uri: 'bolt://unused', user: 'u', password: 'p' });
    db.driver = { session: () => session, close: async () => {} };
    return { db, statements };
}

const HASH = 'c'.repeat(64);

const pointers = (statements) =>
    statements.filter((s) => /MERGE \(p\)-\[same:SAME_AS\]->\(g\)/.test(s.cypher));

const guestWrites = (statements) =>
    statements.filter((s) => /MERGE \(p\)-\[g:GUEST_ON/.test(s.cypher));

/** Ten, produced by the band, as Discogs credits it. */
const ten = (overrides = {}) => ({
    release: {
        name: 'Ten',
        guests: [{ name: 'Pearl Jam', entity_type: 'group', role: 'Producer' }],
        ...(overrides.release || {}),
    },
    groups: overrides.groups ?? [{
        name: 'Pearl Jam',
        members: [{ name: 'Eddie Vedder', roles: ['Vocals'] }],
    }],
    tracks: overrides.tracks ?? [{ title: 'Black' }],
    tracklist: overrides.tracklist ?? [{ position: '1', track_title: 'Black' }],
});

describe('a band credited as the producer of its own record', () => {
    test('the credit stays a credit', () => {
        // A producer did not necessarily play a note, so moving this onto a
        // performance edge would say something nobody claimed.
        const out = normalizeReleaseBundle(ten());

        expect(out.release.guests.map((g) => g.name)).toEqual(['Pearl Jam']);
        expect(out.release.guests[0].roles).toEqual(['producer']);
    });

    test('and is still written as a guest credit', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, ten(), 'polaristest2', Date.now());

        expect(guestWrites(statements).map((s) => s.params.name)).toContain('Pearl Jam');
    });

    test('with a pointer to the band', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, ten(), 'polaristest2', Date.now());

        const [pointer] = pointers(statements);
        expect(pointer).toBeDefined();
        expect(pointer.params.name).toBe('Pearl Jam');
        expect(pointer.params.personId).toBeTruthy();
        expect(pointer.params.groupId).toBeTruthy();
        expect(pointer.params.personId).not.toBe(pointer.params.groupId);
    });

    test('and the band exists to be pointed at, even if only a credit named it', async () => {
        // The pointer is useless without a page on the other end.
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, ten({ groups: [] }), 'polaristest2', Date.now());

        const [pointer] = pointers(statements);
        expect(pointer.cypher).toContain('MERGE (g:Group {group_id: $groupId})');
    });

    test('bound to the band in the search box, it resolves to that node', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, ten({
            release: { guests: [{
                name: 'Pearl Jam', entity_type: 'group',
                group_id: 'prov:group:ceedb8b4aca6de6c', role: 'Producer',
            }] },
        }), 'polaristest2', Date.now());

        // resolveEntityId honours a provisional id that names a real node and
        // otherwise mints from the fingerprint; either way the id the
        // submitter picked is what it is asked about.
        expect(pointers(statements)).toHaveLength(1);
    });
});

describe('the same band credited more than once', () => {
    test('gets one pointer, not one per credit', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, ten({
            tracks: [
                { title: 'Black', guests: [{ name: 'Pearl Jam', entity_type: 'group', role: 'Producer' }] },
                { title: 'Alive', guests: [{ name: 'Pearl Jam', entity_type: 'group', role: 'Producer' }] },
            ],
            tracklist: [
                { position: '1', track_title: 'Black' },
                { position: '2', track_title: 'Alive' },
            ],
        }), 'polaristest2', Date.now());

        expect(pointers(statements)).toHaveLength(1);
    });
});

describe('a member credited as a band', () => {
    test('is pointed at the band too', async () => {
        // A horn section listed in a line-up. Where that should be drawn is a
        // separate question; that it is a band is recorded here either way.
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, ten({
            release: { guests: [] },
            groups: [{
                name: 'Charles Bradley',
                members: [
                    { name: 'Charles Bradley', roles: ['Vocals'] },
                    { name: 'The Budos Band', entity_type: 'group', role: 'Backing Band' },
                ],
            }],
        }), 'polaristest2', Date.now());

        expect(pointers(statements).map((p) => p.params.name)).toEqual(['The Budos Band']);
    });
});

describe('an ordinary credit', () => {
    test('gets no pointer at all', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, ten({
            release: { guests: [{ name: 'Rick Parashar', role: 'Producer' }] },
        }), 'polaristest2', Date.now());

        expect(pointers(statements)).toEqual([]);
    });

    test('and a bundle with none runs no extra statements', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, ten({ release: { guests: [] } }),
            'polaristest2', Date.now());

        expect(statements.some((s) => s.cypher.includes('SAME_AS'))).toBe(false);
    });
});
