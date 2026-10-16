/**
 * EDIT_RELATIONSHIP (type 33): correcting a member to a guest, or back.
 *
 * The correction the registry had no way to make, and the reason it needed its
 * own event rather than either of the two edits that already existed:
 *
 *  - An EDIT_CLAIM sets one property on one node. Membership is not a property
 *    of anybody; it is an edge, and an edge has two ends.
 *
 *  - A corrected bundle resubmission makes it worse rather than better.
 *    `processReleaseBundle` MERGEs `(p)-[:MEMBER_OF {claim_id}]->(g)` with a
 *    claim_id derived from the submission's own event hash, so a second
 *    submission cannot match the first's edge — it adds one beside it — and
 *    nothing in bundle processing deletes a relationship. The person is left
 *    credited as both, which CLAUDE.md lists as an invariant violation.
 *    `dropContradictoryGuests` does not catch it either: it sanitises the
 *    incoming bundle body, so it resolves the contradiction inside one
 *    submission and is blind to the edge the previous one left in the graph.
 *
 * These tests run against a fake transaction rather than Neo4j, because what
 * is worth pinning down here is the decisions — which edges are retired, which
 * tracks the new ones land on, which roles survive, and what a replay does —
 * and those are made in JavaScript from query results. The Cypher itself is
 * exercised by the live suite below, which needs a database.
 *
 * Each test asserts on the parameters the method passed, which is the only
 * place a wrong decision can show up: a scope computed wrongly reaches the
 * graph as a wrong `$trackIds`.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import MusicGraphDatabase from '../../src/graph/schema.js';

/** A record, as the driver hands them back. */
const rec = (fields) => ({ get: (key) => fields[key] });

/**
 * A transaction that answers by pattern.
 *
 * `responses` maps a distinctive fragment of a query to the records it should
 * return. Anything unmatched answers with no records, which is what an
 * unmatched MATCH does.
 */
function fakeTx(responses = {}) {
    const calls = [];
    const entries = Object.entries(responses);

    return {
        calls,
        committed: false,
        rolledBack: false,
        async run(cypher, params) {
            calls.push({ cypher, params });
            const hit = entries.find(([fragment]) => cypher.includes(fragment));
            return { records: hit ? hit[1] : [] };
        },
        async commit() { this.committed = true; },
        async rollback() { this.rolledBack = true; },
    };
}

/** A database service whose only session hands back the given transaction. */
function serviceWith(tx) {
    const db = new MusicGraphDatabase({
        uri: 'bolt://127.0.0.1:7687', user: 'neo4j', password: 'unused'
    });
    // Replacing the driver rather than connecting: nothing here reaches a
    // socket, and a real driver would hold a connection pool open past the
    // test.
    db.driver = {
        session: () => ({
            beginTransaction: () => tx,
            async close() {},
        }),
        async close() {},
    };
    return db;
}

/** Both ends exist — every test needs this or the method refuses to start. */
const ENDS = { 'RETURN p.name AS personName': [rec({ personName: 'Billy Preston', groupName: 'The Beatles' })] };

/** The query fragment each step is recognised by. */
const Q = {
    // Distinct from the replay query, which also collects t.track_id and would
    // otherwise be answered by whichever fragment this file listed first.
    material: 'collect(DISTINCT r.release_id) AS releaseIds',
    guestRows: 'RETURN CASE WHEN x:Track THEN x.track_id',
    deleteGuests: 'DELETE go',
    mergeMember: 'MERGE (p)-[m:MEMBER_OF {claim_id: $claimId}]->(g)',
    replayPerformed: '[:PERFORMED_ON {claim_id: $claimId}]->(t:Track)',
    mergePerformed: 'MERGE (p)-[perf:PERFORMED_ON {claim_id: $claimId, via_group_id: $groupId}]',
    // The demote path's read of the membership it is about to drop. Keyed on
    // the named `g`, which the promote path's read of a membership it is about
    // to supersede does not have — their RETURN clauses start identically, and
    // a fragment that matched both would be answered by whichever this object
    // happened to list first.
    membership: '-[m:MEMBER_OF]->(g:Group',
    // ...and the promote path's read of one it is about to supersede, which
    // asks for the dates as well.
    priorMembership: 'm.from_date AS fromDate',
    performedTracks: 'OPTIONAL MATCH (p)-[:PERFORMED_ON {via_group_id: $groupId}]->(t:Track)',
    deleteMembership: 'DELETE m\n',
    deletePerformances: 'DELETE perf\n',
    mergeGuestTrack: 'MERGE (p)-[go:GUEST_ON {claim_id: $claimId}]->(t)',
    mergeGuestRelease: 'MERGE (p)-[go:GUEST_ON {claim_id: $claimId}]->(r)',
    claim: 'MERGE (c:Claim {claim_id: $claimId})',
    claimsAbout: 'MERGE (c)-[:CLAIMS_ABOUT]->(p)',
    priorClaim: "field: 'relationship'",
    sourced: 'MERGE (c)-[:SOURCED_FROM]->(s)',
    // The untyped read of whatever this claim has already written, which is
    // what a replay has instead of the edge it would otherwise have read.
    alreadyWritten: '-[r {claim_id: $claimId}]->()',
};

/** The call that ran a given step, or undefined. */
const callFor = (tx, fragment) => tx.calls.find(c => c.cypher.includes(fragment));

const HASH = 'a'.repeat(64);
const promote = (db, extra = {}) => db.processRelationshipEdit(HASH, {
    person: { id: 'per:preston' },
    group: { id: 'grp:beatles' },
    to: 'MEMBER_OF',
    ...extra
}, 'curator', 1700000000);
const demote = (db, extra = {}) => db.processRelationshipEdit(HASH, {
    person: { id: 'per:preston' },
    group: { id: 'grp:beatles' },
    to: 'GUEST_ON',
    ...extra
}, 'curator', 1700000000);

describe('EDIT_RELATIONSHIP: what it refuses', () => {
    test('a direction that is neither of the two relationships', async () => {
        const tx = fakeTx(ENDS);
        await expect(db_promote_with(tx, { to: 'PRODUCED' }))
            .rejects.toThrow(/to must be one of MEMBER_OF, GUEST_ON/);
        expect(tx.committed).toBe(false);
    });

    test('a body naming no person', async () => {
        const tx = fakeTx(ENDS);
        const db = serviceWith(tx);
        await expect(db.processRelationshipEdit(HASH, {
            group: { id: 'grp:beatles' }, to: 'MEMBER_OF'
        }, 'curator', null)).rejects.toThrow(/missing person id/);
    });

    test('a body naming no group', async () => {
        const tx = fakeTx(ENDS);
        const db = serviceWith(tx);
        await expect(db.processRelationshipEdit(HASH, {
            person: { id: 'per:preston' }, to: 'MEMBER_OF'
        }, 'curator', null)).rejects.toThrow(/missing group id/);
    });

    test('a person or group that is not in the graph', async () => {
        // Not an empty correction: a MERGE would conjure the missing node and
        // file a claim about something that does not exist.
        const tx = fakeTx({});   // the ends query matches nothing
        const db = serviceWith(tx);
        await expect(promote(db)).rejects.toThrow(/target not found/);
        expect(tx.rolledBack).toBe(true);
        expect(tx.committed).toBe(false);
    });
});

async function db_promote_with(tx, extra) {
    const db = serviceWith(tx);
    return promote(db, extra);
}

describe('EDIT_RELATIONSHIP: guest becomes member', () => {
    const MATERIAL = [rec({
        trackIds: ['trk:1', 'trk:2', 'trk:3'],
        releaseIds: ['rel:abbey']
    })];

    test('the guest credits on the group\'s material are retired', async () => {
        const tx = fakeTx({
            ...ENDS,
            [Q.material]: MATERIAL,
            [Q.guestRows]: [rec({ trackId: 'trk:2', roles: ['organ'], role: 'organ', instruments: [] })],
            [Q.deleteGuests]: [rec({ removed: 1 })],
            [Q.mergePerformed]: [rec({ created: 1 })],
        });
        const result = await db_promote_with(tx, {});

        const deletion = callFor(tx, Q.deleteGuests);
        expect(deletion.params.trackIds).toEqual(['trk:1', 'trk:2', 'trk:3']);
        expect(deletion.params.releaseIds).toEqual(['rel:abbey']);
        expect(result.removed).toEqual({ GUEST_ON: 1, MEMBER_OF: 0 });
    });

    test('an existing membership is retired rather than duplicated', async () => {
        // The state this correction most often repairs: a bundle filed
        // somebody as member *and* guest. Merging a second MEMBER_OF beside
        // the first would list them twice in the group panel, because each
        // edge carries its own roles and dates.
        const tx = fakeTx({
            ...ENDS,
            [Q.material]: MATERIAL,
            [Q.guestRows]: [rec({ trackId: 'trk:1', roles: [], role: null, instruments: [] })],
            [Q.deleteGuests]: [rec({ removed: 1 })],
            [Q.priorMembership]: [rec({
                roles: ['organ'], role: 'organ', instruments: ['Hammond'],
                fromDate: '1969-01-01', toDate: null
            })],
            [Q.deleteMembership]: [rec({ removed: 1 })],
            [Q.mergePerformed]: [rec({ created: 1 })],
        });
        const result = await db_promote_with(tx, {});

        expect(result.removed).toEqual({ GUEST_ON: 1, MEMBER_OF: 1 });
        // And what the retired edge knew is kept, not thrown away with it.
        const merge = callFor(tx, Q.mergeMember);
        expect(merge.params.roles).toEqual(['organ']);
        expect(merge.params.instruments).toEqual(['Hammond']);
        expect(merge.params.fromDate).toBe('1969-01-01');
    });

    test('dates given in the event win over the retired edge\'s', async () => {
        const tx = fakeTx({
            ...ENDS,
            [Q.material]: MATERIAL,
            [Q.guestRows]: [],
            [Q.priorMembership]: [rec({
                roles: [], role: null, instruments: [],
                fromDate: '1969-01-01', toDate: '1970-01-01'
            })],
            [Q.deleteMembership]: [rec({ removed: 1 })],
            [Q.mergePerformed]: [rec({ created: 0 })],
        });
        await db_promote_with(tx, { from_date: '1968-06-01' });

        const merge = callFor(tx, Q.mergeMember);
        expect(merge.params.fromDate).toBe('1968-06-01');
        expect(merge.params.toDate).toBe('1970-01-01');
    });

    test('the roles on the retired credit carry onto the membership', async () => {
        // Nobody retypes "organ" to say someone was in the band. Losing it
        // would turn a correction into a partial data loss.
        const tx = fakeTx({
            ...ENDS,
            [Q.material]: MATERIAL,
            [Q.guestRows]: [
                rec({ trackId: 'trk:1', roles: ['organ'], role: 'organ', instruments: ['Hammond'] }),
                rec({ trackId: 'trk:2', roles: ['piano'], role: 'piano', instruments: [] }),
            ],
            [Q.deleteGuests]: [rec({ removed: 2 })],
            [Q.mergePerformed]: [rec({ created: 2 })],
        });
        await db_promote_with(tx, {});

        const merge = callFor(tx, Q.mergeMember);
        expect(merge.params.roles).toEqual(['organ', 'piano']);
        expect(merge.params.role).toBe('organ');
        expect(merge.params.instruments).toEqual(['Hammond']);
        expect(merge.params.corrected_from).toBeUndefined();   // set in the query, not a param
        expect(merge.cypher).toContain("m.corrected_from = 'GUEST_ON'");
    });

    test('roles given in the event win over the ones being retired', async () => {
        const tx = fakeTx({
            ...ENDS,
            [Q.material]: MATERIAL,
            [Q.guestRows]: [rec({ trackId: 'trk:1', roles: ['organ'], role: 'organ', instruments: [] })],
            [Q.deleteGuests]: [rec({ removed: 1 })],
            [Q.mergePerformed]: [rec({ created: 1 })],
        });
        await db_promote_with(tx, { roles: ['keyboards'] });

        expect(callFor(tx, Q.mergeMember).params.roles).toEqual(['keyboards']);
    });

    test('the performances land on the tracks the guest credits named', async () => {
        // Not on all three. The retired credits are evidence of which tracks
        // the person actually played on, and it is better evidence than "the
        // group recorded twelve, so he played on twelve".
        const tx = fakeTx({
            ...ENDS,
            [Q.material]: MATERIAL,
            [Q.guestRows]: [
                rec({ trackId: 'trk:2', roles: ['organ'], role: 'organ', instruments: [] }),
                rec({ trackId: 'trk:3', roles: ['organ'], role: 'organ', instruments: [] }),
            ],
            [Q.deleteGuests]: [rec({ removed: 2 })],
            [Q.mergePerformed]: [rec({ created: 2 })],
        });
        const result = await db_promote_with(tx, {});

        expect(callFor(tx, Q.mergePerformed).params.trackIds).toEqual(['trk:2', 'trk:3']);
        expect(result.tracks).toEqual(['trk:2', 'trk:3']);
    });

    test('a release-scoped credit names no track, so the group\'s material is used', async () => {
        // The shape a submitter produces by listing guests on the release
        // rather than per track. A member on that release did play on it, and
        // the edge is marked derived for exactly the reason bundle processing
        // marks its release-level lineup derived.
        const tx = fakeTx({
            ...ENDS,
            [Q.material]: MATERIAL,
            [Q.guestRows]: [rec({ trackId: null, roles: ['organ'], role: 'organ', instruments: [] })],
            [Q.deleteGuests]: [rec({ removed: 1 })],
            [Q.mergePerformed]: [rec({ created: 3 })],
        });
        await db_promote_with(tx, {});

        expect(callFor(tx, Q.mergePerformed).params.trackIds)
            .toEqual(['trk:1', 'trk:2', 'trk:3']);
        expect(callFor(tx, Q.mergePerformed).cypher).toContain('perf.derived = true');
    });

    test('a release id narrows which material is swept', async () => {
        const tx = fakeTx({
            ...ENDS,
            [Q.material]: MATERIAL,
            [Q.guestRows]: [],
            [Q.mergePerformed]: [rec({ created: 3 })],
        });
        await db_promote_with(tx, { release_id: 'rel:abbey' });

        expect(callFor(tx, Q.material).params.releaseId).toBe('rel:abbey');
        expect(callFor(tx, Q.deleteGuests).params.releaseIds).toEqual(['rel:abbey']);
    });

    test('replaying it does not widen the performances', async () => {
        // The second run cannot see the guest credits, because the first run
        // deleted them. Without the recovery step it would fall through to the
        // group's whole catalogue and credit the person with tracks the first
        // run deliberately left alone.
        const tx = fakeTx({
            ...ENDS,
            [Q.material]: MATERIAL,
            [Q.guestRows]: [],                                   // already gone
            [Q.deleteGuests]: [rec({ removed: 0 })],
            [Q.replayPerformed]: [rec({ trackIds: ['trk:2'] })],  // what run 1 wrote
            [Q.mergePerformed]: [rec({ created: 1 })],
        });
        await db_promote_with(tx, {});

        expect(callFor(tx, Q.mergePerformed).params.trackIds).toEqual(['trk:2']);
    });

    test('replaying it does not strip the roles either', async () => {
        // The half of idempotency the first version of this got wrong, and CI
        // caught against a real Neo4j: the edge *set* was stable, the
        // properties on it were not. With the guest credits gone there is
        // nothing left to carry roles from except the edges this claim wrote
        // the first time, and without reading those the MERGE overwrote
        // ['organ'] with [].
        const tx = fakeTx({
            ...ENDS,
            [Q.material]: MATERIAL,
            [Q.guestRows]: [],
            [Q.deleteGuests]: [rec({ removed: 0 })],
            [Q.replayPerformed]: [rec({ trackIds: ['trk:2'] })],
            [Q.alreadyWritten]: [rec({
                roles: ['organ'], role: 'organ', instruments: ['Hammond'],
                fromDate: '1969-01-01', toDate: null
            })],
            [Q.mergePerformed]: [rec({ created: 1 })],
        });
        const result = await db_promote_with(tx, {});

        const merge = callFor(tx, Q.mergeMember);
        expect(merge.params.roles).toEqual(['organ']);
        expect(merge.params.instruments).toEqual(['Hammond']);
        expect(merge.params.fromDate).toBe('1969-01-01');
        expect(callFor(tx, Q.mergePerformed).params.roles).toEqual(['organ']);
        expect(result.roles).toEqual(['organ']);
    });

    test('it files a claim about the person and commits', async () => {
        const tx = fakeTx({
            ...ENDS,
            [Q.material]: MATERIAL,
            [Q.guestRows]: [rec({ trackId: 'trk:1', roles: [], role: null, instruments: [] })],
            [Q.deleteGuests]: [rec({ removed: 1 })],
            [Q.mergePerformed]: [rec({ created: 1 })],
        });
        const result = await db_promote_with(tx, { release_id: 'rel:abbey' });

        const claim = callFor(tx, Q.claim);
        expect(claim.params.nodeType).toBe('person');
        expect(claim.params.nodeId).toBe('per:preston');
        expect(claim.params.field).toBe('relationship');
        expect(JSON.parse(claim.params.value)).toEqual({
            to: 'MEMBER_OF',
            group_id: 'grp:beatles',
            release_id: 'rel:abbey',
            roles: []
        });
        expect(callFor(tx, Q.claimsAbout)).toBeTruthy();
        expect(result.claimId).toBe(claim.params.claimId);
        expect(tx.committed).toBe(true);
    });

    test('a later correction supersedes the one before it', async () => {
        const tx = fakeTx({
            ...ENDS,
            [Q.material]: MATERIAL,
            [Q.guestRows]: [],
            [Q.priorClaim]: [rec({ claimId: 'claim:earlier' })],
            [Q.mergePerformed]: [rec({ created: 0 })],
        });
        await db_promote_with(tx, {});

        const supersede = callFor(tx, 'MERGE (newClaim)-[:SUPERSEDES]->(oldClaim)');
        expect(supersede.params.oldClaimId).toBe('claim:earlier');
        // Scoped to this group: a correction about one band says nothing about
        // the reader's membership of another.
        expect(callFor(tx, Q.priorClaim).params.groupId).toBe('grp:beatles');
    });

    test('a cited source is attached to the claim', async () => {
        const tx = fakeTx({
            ...ENDS,
            [Q.material]: MATERIAL,
            [Q.guestRows]: [],
            [Q.mergePerformed]: [rec({ created: 0 })],
        });
        const db = serviceWith(tx);
        db.resolveEntityId = jest.fn(async () => 'src:liner');

        await promote(db, { source: { url: 'https://example.org/liner-notes' } });

        const sourced = callFor(tx, Q.sourced);
        expect(sourced.params.url).toBe('https://example.org/liner-notes');
        expect(sourced.params.sourceId).toBe('src:liner');
    });
});

describe('EDIT_RELATIONSHIP: member becomes guest', () => {
    test('the membership and its performances both go', async () => {
        // A performance edge that outlived the membership would credit a
        // non-member as having played with the group.
        const tx = fakeTx({
            ...ENDS,
            [Q.membership]: [rec({ roles: ['organ'], role: 'organ', instruments: [] })],
            [Q.performedTracks]: [rec({ trackIds: ['trk:1', 'trk:2'] })],
            [Q.deleteMembership]: [rec({ removed: 1 })],
            [Q.deletePerformances]: [rec({ removed: 2 })],
            [Q.mergeGuestTrack]: [rec({ created: 2 })],
        });
        const db = serviceWith(tx);
        const result = await demote(db);

        expect(result.removed).toEqual({ MEMBER_OF: 1, PERFORMED_ON: 2 });
        expect(result.created).toEqual({ GUEST_ON: 2 });
    });

    test('each performance becomes a track-scoped guest credit', async () => {
        const tx = fakeTx({
            ...ENDS,
            [Q.membership]: [rec({ roles: ['organ'], role: 'organ', instruments: ['Hammond'] })],
            [Q.performedTracks]: [rec({ trackIds: ['trk:1', 'trk:2'] })],
            [Q.deleteMembership]: [rec({ removed: 1 })],
            [Q.deletePerformances]: [rec({ removed: 2 })],
            [Q.mergeGuestTrack]: [rec({ created: 2 })],
        });
        const db = serviceWith(tx);
        await demote(db);

        const merge = callFor(tx, Q.mergeGuestTrack);
        expect(merge.params.trackIds).toEqual(['trk:1', 'trk:2']);
        expect(merge.params.roles).toEqual(['organ']);
        expect(merge.params.instruments).toEqual(['Hammond']);
        expect(merge.cypher).toContain("go.scope = 'track'");
    });

    test('nothing performed and a release named: one release-scoped credit', async () => {
        const tx = fakeTx({
            ...ENDS,
            [Q.membership]: [rec({ roles: [], role: null, instruments: [] })],
            [Q.performedTracks]: [rec({ trackIds: [] })],
            [Q.deleteMembership]: [rec({ removed: 1 })],
            [Q.deletePerformances]: [rec({ removed: 0 })],
            [Q.mergeGuestRelease]: [rec({ created: 1 })],
        });
        const db = serviceWith(tx);
        const result = await demote(db, { release_id: 'rel:abbey' });

        const merge = callFor(tx, Q.mergeGuestRelease);
        expect(merge.params.releaseId).toBe('rel:abbey');
        expect(merge.cypher).toContain("go.scope = 'release'");
        expect(result.created).toEqual({ GUEST_ON: 1 });
    });

    test('nothing performed and no release named: the removal alone', async () => {
        const tx = fakeTx({
            ...ENDS,
            [Q.membership]: [rec({ roles: [], role: null, instruments: [] })],
            [Q.performedTracks]: [rec({ trackIds: [] })],
            [Q.deleteMembership]: [rec({ removed: 1 })],
            [Q.deletePerformances]: [rec({ removed: 0 })],
        });
        const db = serviceWith(tx);
        const result = await demote(db);

        expect(callFor(tx, Q.mergeGuestRelease)).toBeUndefined();
        expect(result.created).toEqual({ GUEST_ON: 0 });
        expect(tx.committed).toBe(true);
    });

    test('replaying it does not strip the roles off the guest credits', async () => {
        // Same hole as on the promotion side: the membership whose roles this
        // reads is gone by the second run, and only the credits this claim
        // wrote still say what they were.
        const tx = fakeTx({
            ...ENDS,
            [Q.membership]: [],
            [Q.performedTracks]: [rec({ trackIds: ['trk:1'] })],
            [Q.deleteMembership]: [rec({ removed: 0 })],
            [Q.deletePerformances]: [rec({ removed: 0 })],
            [Q.alreadyWritten]: [rec({
                roles: ['organ'], role: 'organ', instruments: [],
                fromDate: null, toDate: null
            })],
            [Q.mergeGuestTrack]: [rec({ created: 1 })],
        });
        const db = serviceWith(tx);
        await demote(db);

        expect(callFor(tx, Q.mergeGuestTrack).params.roles).toEqual(['organ']);
    });

    test('replaying it does not add a release credit beside the track ones', async () => {
        // Run two sees no performances — run one converted them — so without
        // the union it would read as "nothing performed" and take the release
        // fallback, inventing a credit the first run never made.
        const tx = fakeTx({
            ...ENDS,
            [Q.membership]: [],                                  // already demoted
            [Q.performedTracks]: [rec({ trackIds: ['trk:1'] })],  // from this claim's guest edges
            [Q.deleteMembership]: [rec({ removed: 0 })],
            [Q.deletePerformances]: [rec({ removed: 0 })],
            [Q.mergeGuestTrack]: [rec({ created: 1 })],
        });
        const db = serviceWith(tx);
        await demote(db, { release_id: 'rel:abbey' });

        expect(callFor(tx, Q.mergeGuestRelease)).toBeUndefined();
        expect(callFor(tx, Q.mergeGuestTrack).params.trackIds).toEqual(['trk:1']);
    });

    test('the scope is every track held through the group, not one release', async () => {
        // MEMBER_OF carries no release, so the demotion cannot be scoped to
        // one either — and the query must not filter by the release the
        // submitter happened to be looking at.
        const tx = fakeTx({
            ...ENDS,
            [Q.membership]: [rec({ roles: [], role: null, instruments: [] })],
            [Q.performedTracks]: [rec({ trackIds: ['trk:1', 'trk:9'] })],
            [Q.deleteMembership]: [rec({ removed: 1 })],
            [Q.deletePerformances]: [rec({ removed: 2 })],
            [Q.mergeGuestTrack]: [rec({ created: 2 })],
        });
        const db = serviceWith(tx);
        await demote(db, { release_id: 'rel:abbey' });

        expect(callFor(tx, Q.performedTracks).params.releaseId).toBeUndefined();
        expect(callFor(tx, Q.mergeGuestTrack).params.trackIds).toEqual(['trk:1', 'trk:9']);
    });
});
