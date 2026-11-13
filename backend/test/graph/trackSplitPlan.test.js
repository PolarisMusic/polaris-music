/**
 * Splitting a Track that two Releases are sharing.
 *
 * A Track is release-scoped, so a node reachable from two Releases is a
 * defect. The cost is not cosmetic: every read that walks
 * `(Group)-[:PERFORMED_ON]->(Track)` and onward lands on the stranger's
 * release, which is how Pearl Jam came to sit beside the Aquabats'
 * photographer — one Track called "(silence)" on both "Ten" and "The Fury Of
 * The Aquabats!".
 *
 * The fixtures here are the real ones, taken from trackCollisionPlan.js run
 * against the testnet graph. Four shapes have to work, and the last two are
 * the ones that would quietly go wrong:
 *
 *   - two different bands, which the performing group settles;
 *   - three different bands on one node;
 *   - the SAME band twice, where only the claim id can separate them;
 *   - a release whose every track is shared, so it has no unshared track to
 *     judge ownership from and has to be reached by elimination.
 */

import { describe, test, expect } from '@jest/globals';
import { planTrackSplit } from '../../src/graph/trackSplitPlan.js';

/** A relationship on the shared node, as the reader hands it over. */
const rel = (type, otherId, otherLabel, extra = {}) => ({
    type,
    outgoing: type === 'IN_RELEASE' || type === 'RECORDING_OF',
    otherId,
    otherLabel,
    otherName: otherId,
    claimId: null,
    viaGroupId: null,
    ...extra,
});

/** What each placement ended up with, by release, for readable assertions. */
const landed = (plan) => Object.fromEntries(plan.placements.map((p) => [
    p.releaseId,
    p.moves.map((m) => m.otherId).sort(),
]));

describe('"(silence)" — Ten and The Fury Of The Aquabats!', () => {
    const input = () => ({
        trackId: 'prov:track:6f858a78b0376602',
        placements: [
            {
                releaseId: 'rel:fury', releaseName: 'The Fury Of The Aquabats!',
                newTrackId: 'prov:track:284fc5b8642958da',
                owners: [{ groupId: 'grp:aquabats', name: 'The Aquabats!', onTracks: 16 }],
            },
            {
                releaseId: 'rel:ten', releaseName: 'Ten',
                newTrackId: 'prov:track:9641300ac9c2f107',
                owners: [{ groupId: 'grp:pj', name: 'Pearl Jam', onTracks: 11 }],
            },
        ],
        attachments: [
            rel('IN_RELEASE', 'rel:fury', 'Release'),
            rel('IN_RELEASE', 'rel:ten', 'Release'),
            rel('RECORDING_OF', 'song:silence', 'Song'),
            rel('PERFORMED_ON', 'grp:aquabats', 'Group'),
            rel('PERFORMED_ON', 'grp:pj', 'Group'),
            rel('PERFORMED_ON', 'psn:vedder', 'Person', { viaGroupId: 'grp:pj' }),
            rel('PERFORMED_ON', 'psn:commander', 'Person', { viaGroupId: 'grp:aquabats' }),
            // The photographer who started all this.
            rel('GUEST_ON', 'psn:aquabats', 'Person', { claimId: 'claim:fury' }),
            rel('GUEST_ON', 'psn:parashar', 'Person', { claimId: 'claim:ten' }),
        ],
        claimReleases: { 'claim:fury': 'rel:fury', 'claim:ten': 'rel:ten' },
    });

    test('each band keeps its own performance', () => {
        const plan = planTrackSplit(input());

        expect(landed(plan)['rel:ten']).toContain('grp:pj');
        expect(landed(plan)['rel:fury']).toContain('grp:aquabats');
        expect(landed(plan)['rel:ten']).not.toContain('grp:aquabats');
    });

    test('players follow their own band, by via_group_id', () => {
        const plan = planTrackSplit(input());

        expect(landed(plan)['rel:ten']).toContain('psn:vedder');
        expect(landed(plan)['rel:fury']).toContain('psn:commander');
    });

    test('the band-named photographer stops reaching Pearl Jam', () => {
        // The whole point. This credit is real — it is a photography and
        // writing credit on the Aquabats' own record — and it had no business
        // on Ten.
        const plan = planTrackSplit(input());

        expect(landed(plan)['rel:fury']).toContain('psn:aquabats');
        expect(landed(plan)['rel:ten']).not.toContain('psn:aquabats');
    });

    test('the song is recorded by both copies', () => {
        const plan = planTrackSplit(input());

        for (const place of plan.placements) {
            expect(place.copies.map((c) => c.otherId)).toEqual(['song:silence']);
        }
    });

    test('nothing is left behind, so the husk can go', () => {
        const plan = planTrackSplit(input());

        expect(plan.leftovers).toEqual([]);
        expect(plan.originalIsEmpty).toBe(true);
    });

    test('each copy takes exactly one release', () => {
        const plan = planTrackSplit(input());

        for (const place of plan.placements) {
            const releases = place.moves.filter((m) => m.type === 'IN_RELEASE');
            expect(releases.map((r) => r.otherId)).toEqual([place.releaseId]);
        }
    });
});

describe('"Untitled" — three releases, three bands', () => {
    const plan = () => planTrackSplit({
        trackId: 'prov:track:a58439f1ca6ba6b3',
        placements: [
            { releaseId: 'rel:itnr', releaseName: 'In Times New Roman...', newTrackId: 'n1',
              owners: [{ groupId: 'grp:qotsa', name: 'Queens Of The Stone Age', onTracks: 10 }] },
            { releaseId: 'rel:ten', releaseName: 'Ten', newTrackId: 'n2',
              owners: [{ groupId: 'grp:pj', name: 'Pearl Jam', onTracks: 11 }] },
            { releaseId: 'rel:rise', releaseName: 'Rise Above', newTrackId: 'n3',
              owners: [{ groupId: 'grp:dirty', name: 'Dirty Projectors', onTracks: 9 }] },
        ],
        attachments: [
            rel('IN_RELEASE', 'rel:itnr', 'Release'),
            rel('IN_RELEASE', 'rel:ten', 'Release'),
            rel('IN_RELEASE', 'rel:rise', 'Release'),
            rel('PERFORMED_ON', 'grp:qotsa', 'Group'),
            rel('PERFORMED_ON', 'grp:pj', 'Group'),
            rel('PERFORMED_ON', 'grp:dirty', 'Group'),
            // The experimental-scene credits that turned up around Pearl Jam.
            rel('GUEST_ON', 'psn:pavone', 'Person', { claimId: 'claim:rise' }),
            rel('GUEST_ON', 'psn:hillmer', 'Person', { claimId: 'claim:rise' }),
            rel('GUEST_ON', 'psn:parashar', 'Person', { claimId: 'claim:ten' }),
        ],
        claimReleases: { 'claim:rise': 'rel:rise', 'claim:ten': 'rel:ten' },
    });

    test('splits three ways', () => {
        expect(plan().placements).toHaveLength(3);
        expect(plan().leftovers).toEqual([]);
    });

    test('the downtown credits land on Rise Above, not on Ten', () => {
        const got = landed(plan());

        expect(got['rel:rise']).toEqual(expect.arrayContaining(['psn:pavone', 'psn:hillmer']));
        expect(got['rel:ten']).not.toContain('psn:pavone');
        expect(got['rel:ten']).toContain('psn:parashar');
    });
});

describe('the same band on both releases', () => {
    // Six of the twenty-six: Idlewild South and the Final Concert, Axis and
    // Live In Maui. The performing group cannot separate these, and the
    // duplicate edges on the node — "Butch Trucks" twice — are the two
    // submissions that the claim ids distinguish.
    const abb = (claims) => planTrackSplit({
        trackId: 'prov:track:f869689d29a682b5',
        placements: [
            { releaseId: 'rel:idlewild', releaseName: 'Idlewild South', newTrackId: 'n1',
              owners: [{ groupId: 'grp:abb', name: 'The Allman Brothers Band', onTracks: 3 }] },
            { releaseId: 'rel:final', releaseName: 'Final Concert', newTrackId: 'n2',
              owners: [{ groupId: 'grp:abb', name: 'The Allman Brothers Band', onTracks: 24 }] },
        ],
        attachments: [
            rel('IN_RELEASE', 'rel:idlewild', 'Release'),
            rel('IN_RELEASE', 'rel:final', 'Release'),
            rel('PERFORMED_ON', 'grp:abb', 'Group', { claimId: claims ? 'claim:idlewild' : null }),
            rel('PERFORMED_ON', 'grp:abb', 'Group', { claimId: claims ? 'claim:final' : null }),
            rel('PERFORMED_ON', 'psn:duane', 'Person',
                { viaGroupId: 'grp:abb', claimId: claims ? 'claim:idlewild' : null }),
            rel('PERFORMED_ON', 'psn:haynes', 'Person',
                { viaGroupId: 'grp:abb', claimId: claims ? 'claim:final' : null }),
        ],
        claimReleases: claims
            ? { 'claim:idlewild': 'rel:idlewild', 'claim:final': 'rel:final' }
            : {},
    });

    test('is separated by the claim ids', () => {
        const got = landed(abb(true));

        // Duane Allman played on Idlewild South in 1970; Warren Haynes played
        // the final concert in 2014. They are not on the same recording.
        expect(got['rel:idlewild']).toContain('psn:duane');
        expect(got['rel:final']).toContain('psn:haynes');
        expect(got['rel:idlewild']).not.toContain('psn:haynes');
    });

    test('and without them the credits are reported, not guessed at', () => {
        // The performing group says "Allman Brothers" for both, which is true
        // and useless. Assigning either way would invent a fact.
        const plan = abb(false);

        expect(plan.leftovers.map((l) => l.otherId).sort())
            .toEqual(['grp:abb', 'grp:abb', 'psn:duane', 'psn:haynes']);
        for (const leftover of plan.leftovers) {
            expect(leftover.why).toMatch(/owns more than one/);
        }
    });

    test('and the husk is not declared empty while they sit on it', () => {
        expect(abb(false).originalIsEmpty).toBe(false);
        expect(abb(true).originalIsEmpty).toBe(true);
    });

    test('the releases still separate, whatever happens to the credits', () => {
        // IN_RELEASE names its own release, so the split itself never stalls.
        const got = landed(abb(false));

        expect(got['rel:idlewild']).toEqual(['rel:idlewild']);
        expect(got['rel:final']).toEqual(['rel:final']);
    });
});

describe('a release whose every track is shared', () => {
    // "Sadie" and "Oblivion" both. There is no unshared track to judge
    // ownership from, so the owners list comes back empty — but the node
    // carries a group that owns none of the other placements, and exactly one
    // placement has no owner. They are each other's.
    const sadie = (groupsOnNode) => planTrackSplit({
        trackId: 'prov:track:f1967107ff6a86e2',
        placements: [
            { releaseId: 'rel:crimson', releaseName: 'Crimson', newTrackId: 'n1',
              owners: [{ groupId: 'grp:alkaline', name: 'Alkaline Trio', onTracks: 12 }] },
            { releaseId: 'rel:sadie', releaseName: 'Sadie', newTrackId: 'n2', owners: [] },
        ],
        attachments: [
            rel('IN_RELEASE', 'rel:crimson', 'Release'),
            rel('IN_RELEASE', 'rel:sadie', 'Release'),
            ...groupsOnNode.map((g) => rel('PERFORMED_ON', g, 'Group')),
        ],
        claimReleases: {},
    });

    test('is reached by elimination', () => {
        const plan = sadie(['grp:alkaline', 'grp:surrealistics']);

        const surreal = plan.placements.find((p) => p.releaseId === 'rel:sadie');
        expect(surreal.owner).toBe('grp:surrealistics');
        expect(surreal.moves.map((m) => m.otherId).sort())
            .toEqual(['grp:surrealistics', 'rel:sadie']);
    });

    test('and the other release keeps its own band', () => {
        const got = landed(sadie(['grp:alkaline', 'grp:surrealistics']));

        expect(got['rel:crimson']).toContain('grp:alkaline');
        expect(got['rel:crimson']).not.toContain('grp:surrealistics');
    });

    test('but not when two groups are spare, because then it is a guess', () => {
        const plan = sadie(['grp:alkaline', 'grp:surrealistics', 'grp:someone']);

        expect(plan.placements.find((p) => p.releaseId === 'rel:sadie').owner).toBeNull();
        expect(plan.leftovers.length).toBeGreaterThan(0);
    });

    test('nor when no group is spare', () => {
        const plan = sadie(['grp:alkaline']);

        expect(plan.placements.find((p) => p.releaseId === 'rel:sadie').owner).toBeNull();
    });
});

describe('anything this does not understand', () => {
    test('is reported by type rather than dropped', () => {
        // Likes, stakes and claims hang off these nodes in principle and are
        // not reconstructible. None appeared on the twenty-six, but a split
        // that silently discarded one would be unrecoverable.
        const plan = planTrackSplit({
            trackId: 't',
            placements: [
                { releaseId: 'r1', releaseName: 'One', newTrackId: 'n1', owners: [{ groupId: 'g1' }] },
                { releaseId: 'r2', releaseName: 'Two', newTrackId: 'n2', owners: [{ groupId: 'g2' }] },
            ],
            attachments: [
                rel('IN_RELEASE', 'r1', 'Release'),
                rel('IN_RELEASE', 'r2', 'Release'),
                rel('LIKED', 'acct:someone', 'Account'),
                rel('SAMPLES', 'track:other', 'Track'),
            ],
        });

        expect(plan.unhandledTypes.sort()).toEqual(['LIKED', 'SAMPLES']);
        expect(plan.leftovers.map((l) => l.type).sort()).toEqual(['LIKED', 'SAMPLES']);
        expect(plan.originalIsEmpty).toBe(false);
    });

    test('a guest with no claim and no group is kept for a human', () => {
        const plan = planTrackSplit({
            trackId: 't',
            placements: [
                { releaseId: 'r1', releaseName: 'One', newTrackId: 'n1', owners: [{ groupId: 'g1' }] },
                { releaseId: 'r2', releaseName: 'Two', newTrackId: 'n2', owners: [{ groupId: 'g2' }] },
            ],
            attachments: [
                rel('IN_RELEASE', 'r1', 'Release'),
                rel('IN_RELEASE', 'r2', 'Release'),
                rel('GUEST_ON', 'psn:nobody', 'Person'),
            ],
        });

        expect(plan.leftovers).toHaveLength(1);
        expect(plan.leftovers[0].why).toMatch(/no claim id/);
    });
});
