/**
 * Which evidence dates a node that has no creation record.
 *
 * The order is the whole decision. A submission edge and a claim are the
 * node's own history; a neighbour's date only says "no later than", which is
 * enough for the lottery's cutoff but is not the same claim — so it comes last
 * and is flagged where it is written.
 *
 * Nothing here touches a database: the script's queries are driven through a
 * fake session that records what it was asked.
 */

import { describe, test, expect } from '@jest/globals';
import { earliestEvidence, ADDRESSABLE } from '../../scripts/backfillCreatedAt.js';

/**
 * A session that answers from a table of source -> value.
 *
 * Keyed on what each probe is recognisable by, so the test says which kind of
 * evidence exists rather than which query text is expected.
 */
function fakeSession(answers) {
    const asked = [];
    return {
        asked,
        run: async (query) => {
            asked.push(query.replace(/\s+/g, ' ').trim());
            const source = query.includes('SUBMITTED') ? 'submitted'
                : query.includes(':Claim') ? 'claim'
                : 'neighbour';
            const at = answers[source] ?? null;
            return { records: [{ get: () => at }] };
        },
    };
}

describe('earliestEvidence', () => {
    test('a submission edge wins, and nothing else is asked', async () => {
        const session = fakeSession({ submitted: 'A', claim: 'B', neighbour: 'C' });

        expect(await earliestEvidence(session, 'g1', 'Group'))
            .toEqual({ at: 'A', source: 'submitted' });
        // Stopping at the first answer is not just a saving: the later probes
        // are weaker evidence and must not be able to override it.
        expect(session.asked).toHaveLength(1);
    });

    test('a claim is used when there is no submission edge', async () => {
        const session = fakeSession({ claim: 'B', neighbour: 'C' });

        expect(await earliestEvidence(session, 'g1', 'Group'))
            .toEqual({ at: 'B', source: 'claim' });
    });

    test('a neighbour is the last resort', async () => {
        const session = fakeSession({ neighbour: 'C' });

        expect(await earliestEvidence(session, 'p1', 'Person'))
            .toEqual({ at: 'C', source: 'neighbour' });
        expect(session.asked).toHaveLength(3);
    });

    test('no evidence is null, not a guess', async () => {
        // A wrong date is worse than a missing one: the draw already copes
        // with missing, and a wrong one silently pins the field to a lie.
        expect(await earliestEvidence(fakeSession({}), 'g1', 'Group')).toBeNull();
    });

    test('a group is addressed by group_id, a person by person_id', async () => {
        // Matching by label and id hits the uniqueness constraint. The
        // alternative scans every node in the graph once per candidate.
        const group = fakeSession({ submitted: 'A' });
        await earliestEvidence(group, 'g1', 'Group');
        expect(group.asked[0]).toContain('(n:Group {group_id: $id})');

        const person = fakeSession({ submitted: 'A' });
        await earliestEvidence(person, 'p1', 'Person');
        expect(person.asked[0]).toContain('(n:Person {person_id: $id})');
    });

    test('a label outside the table is refused rather than interpolated', async () => {
        // The label reaches Cypher as text, so the allowlist is what makes
        // that safe. A label not in it is a bug, not a node to repair.
        await expect(earliestEvidence(fakeSession({}), 'x', 'Release'))
            .rejects.toThrow(/Not a candidate label/);
        await expect(earliestEvidence(fakeSession({}), 'x', 'Group) DETACH DELETE (n'))
            .rejects.toThrow(/Not a candidate label/);
    });

    test('only groups and people are addressable', async () => {
        expect(Object.keys(ADDRESSABLE).sort()).toEqual(['Group', 'Person']);
    });
});
