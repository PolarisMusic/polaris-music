/**
 * The member/guest invariant, enforced rather than merely documented.
 *
 * CLAUDE.md has always stated it — "A Person can't be both MEMBER_OF and
 * GUEST_ON for same track" — but no code checked. MEMBER_OF and GUEST_ON are
 * merged in independent loops that never see each other, so a bundle listing
 * someone twice produced both edges. The only thing standing between that and
 * the UI was a `WHERE NOT (guest)-[:MEMBER_OF]->(g)` filter on one read query
 * in entities.js, which hides the contradiction instead of preventing it.
 *
 * A real import made this concrete: Discogs credits filed Kurt Cobain and Krist
 * Novoselic as both members of Nirvana and guests on their own album.
 */

import { describe, test, expect } from '@jest/globals';
import { dropContradictoryGuests } from '../../src/graph/normalizeReleaseBundle.js';

const nirvana = () => ({
    name: 'Nirvana',
    members: [
        { name: 'Kurt Cobain', person_id: 'per:cobain', roles: ['Guitar', 'Vocals'] },
        { name: 'Krist Novoselic', roles: ['Bass'] },
    ],
});

describe('dropContradictoryGuests', () => {
    test('a member listed as a release guest loses the guest credit', () => {
        const release = { name: 'Nevermind', guests: [
            { name: 'Kurt Cobain', person_id: 'per:cobain' },
            { name: 'Butch Vig', roles: ['Producer'] },
        ]};

        const dropped = dropContradictoryGuests(release, [nirvana()], []);

        expect(dropped).toBe(1);
        // Membership is the stronger claim, so it is the guest credit that goes.
        expect(release.guests.map(g => g.name)).toEqual(['Butch Vig']);
    });

    test('it applies per track as well as per release', () => {
        const tracks = [
            { title: 'Lithium', guests: [{ name: 'Krist Novoselic' }] },
            { title: 'Polly', guests: [{ name: 'Kirk Canning', roles: ['Cello'] }] },
        ];

        const dropped = dropContradictoryGuests({ guests: [] }, [nirvana()], tracks);

        expect(dropped).toBe(1);
        expect(tracks[0].guests).toEqual([]);
        // A genuine session player is exactly what GUEST_ON is for.
        expect(tracks[1].guests.map(g => g.name)).toEqual(['Kirk Canning']);
    });

    test('matching falls back to the name when there is no person_id', () => {
        const release = { guests: [{ name: 'Krist Novoselic' }] };
        expect(dropContradictoryGuests(release, [nirvana()], [])).toBe(1);
    });

    test("Discogs' disambiguating suffix does not defeat the match", () => {
        const release = { guests: [{ name: 'Krist Novoselic (2)' }] };
        expect(dropContradictoryGuests(release, [nirvana()], [])).toBe(1);
    });

    test('a differently spelled alias is NOT matched', () => {
        // Honest about the limit: "Chris" vs "Krist" is a different string and
        // only person_id can unify it. Asserted so the boundary is deliberate
        // rather than a surprise later.
        const release = { guests: [{ name: 'Chris Novoselic' }] };
        expect(dropContradictoryGuests(release, [nirvana()], [])).toBe(0);
        expect(release.guests).toHaveLength(1);
    });

    test('a bundle with no members is left completely alone', () => {
        const release = { guests: [{ name: 'Butch Vig' }] };
        expect(dropContradictoryGuests(release, [], [])).toBe(0);
        expect(release.guests).toHaveLength(1);
    });

    test('missing guest arrays are tolerated', () => {
        expect(() => dropContradictoryGuests({}, [nirvana()], [{ title: 'X' }])).not.toThrow();
    });

    test('a nameless, idless guest is not treated as matching everyone', () => {
        // personKey returns null for it; a null key must never collide.
        const release = { guests: [{ roles: ['Unknown'] }] };
        expect(dropContradictoryGuests(release, [nirvana()], [])).toBe(0);
    });
});
