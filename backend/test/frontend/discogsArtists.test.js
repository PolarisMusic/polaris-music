/**
 * Reading who performed what off a Discogs compilation.
 *
 * The case this exists for: release 6380913, "Various — Lost Ark Studio
 * Compilation Vol. 4". Discogs credits the release to "Various" (their artist
 * id 194) and names the real act on each track. The import read only the
 * release-level credit, so the registry got a band called Various that played
 * every track and lost the dozen acts that actually did.
 *
 * "Various" is not a band. A Group node for it is one every compilation then
 * attaches its recordings to — a hub in the graph that means nothing and that
 * nobody can be a member of.
 */

import { describe, test, expect } from '@jest/globals';
import {
    isVariousArtists, releaseArtists, isCompilation, trackPerformers, cleanArtistName,
    overridesReleaseCredit, creditsByAct, VARIOUS_ARTISTS_ID,
} from '../../../frontend/src/utils/discogsArtists.js';

const various = { id: VARIOUS_ARTISTS_ID, name: 'Various' };
const act = (name, id, extra = {}) => ({ id, name, ...extra });

describe('spotting the placeholder', () => {
    test('the id is the reliable half', () => {
        // Whatever the display name has been edited to on this release.
        expect(isVariousArtists({ id: 194, name: 'Various Artists' })).toBe(true);
        expect(isVariousArtists({ id: 194, name: 'Diverse Artiesten' })).toBe(true);
    });

    test.each([['Various'], ['Various Artists'], ['various artists'], ['V/A'], ['VA']])
    ('%s with no id is still the placeholder', (name) => {
        expect(isVariousArtists({ name })).toBe(true);
    });

    test('a real act is not', () => {
        expect(isVariousArtists(act('Nocturnal Rites', 12345))).toBe(false);
        expect(isVariousArtists(act('Various Production', 99))).toBe(false);
        expect(isVariousArtists(null)).toBe(false);
    });

    test('Discogs numbering is not part of a name', () => {
        expect(cleanArtistName('Heaven (2)')).toBe('Heaven');
        expect(cleanArtistName('Various (3)')).toBe('Various');
        expect(isVariousArtists({ name: 'Various (3)' })).toBe(true);
    });
});

describe('what the release is credited to', () => {
    test('a compilation is credited to nobody, not to Various', () => {
        // The honest answer. A release-level Group here would be the bogus
        // node this whole module exists to keep out of the registry.
        expect(releaseArtists({ artists: [various] })).toEqual([]);
    });

    test('an ordinary release keeps its acts', () => {
        const artists = [act('Queens Of The Stone Age', 1), act('Dave Grohl', 2)];
        expect(releaseArtists({ artists })).toEqual(artists);
    });

    test('a split release keeps both sides', () => {
        const artists = [act('Band A', 1), act('Band B', 2)];
        expect(releaseArtists({ artists, formats: [{ descriptions: ['Split'] }] }))
            .toHaveLength(2);
    });
});

describe('is this a compilation', () => {
    test('the Various credit says so on its own', () => {
        expect(isCompilation({ artists: [various] })).toBe(true);
    });

    test('so does a Compilation format whose tracks disagree about the act', () => {
        // Some compilations credit a label or a curator rather than Various.
        expect(isCompilation({
            artists: [act('Lost Ark Studio', 77)],
            formats: [{ descriptions: ['Compilation'] }],
            tracklist: [
                { title: 'One', artists: [act('Band A', 1)] },
                { title: 'Two', artists: [act('Band B', 2)] },
            ],
        })).toBe(true);
    });

    test("but one act's own best-of is not a compilation of other people", () => {
        // Every track is theirs, so the release-level credit is true and the
        // tracks should go on inheriting it.
        expect(isCompilation({
            artists: [act('Queens Of The Stone Age', 1)],
            formats: [{ descriptions: ['Compilation'] }],
            tracklist: [
                { title: 'One', artists: [act('Queens Of The Stone Age', 1)] },
                { title: 'Two', artists: [act('Queens Of The Stone Age', 1)] },
            ],
        })).toBe(false);
    });

    test('an ordinary album is not', () => {
        expect(isCompilation({
            artists: [act('Ocelot', 5)],
            formats: [{ descriptions: ['Album'] }],
            tracklist: [{ title: 'One' }],
        })).toBe(false);
        expect(isCompilation({})).toBe(false);
    });
});

describe('who played this track', () => {
    const release = { artists: [various] };

    test("the track's own credit is the answer", () => {
        expect(trackPerformers({ artists: [act('Nocturnal Rites', 12345)] }, release))
            .toEqual([{ name: 'Nocturnal Rites', id: 12345, alt_names: [] }]);
    });

    test('two acts on one track both come through', () => {
        const performers = trackPerformers(
            { artists: [act('Band A', 1, { join: '&' }), act('Band B', 2)] }, release);

        expect(performers.map((p) => p.name)).toEqual(['Band A', 'Band B']);
    });

    test('one act credited twice is one performer', () => {
        const performers = trackPerformers(
            { artists: [act('Band A', 1, { join: 'feat.' }), act('Band A', 1)] }, release);

        expect(performers).toHaveLength(1);
    });

    test('how they were billed is kept as an alternate name', () => {
        // "Bob Dylan" printed on the sleeve as "Blind Boy Grunt" is one act
        // with two names, which is exactly what alt_names is for — and what
        // the old import threw away along with the credit.
        expect(trackPerformers(
            { artists: [act('Bob Dylan', 7, { anv: 'Blind Boy Grunt' })] }, release))
            .toEqual([{ name: 'Bob Dylan', id: 7, alt_names: ['Blind Boy Grunt'] }]);
    });

    test('a billing that matches the name is not an alternate name', () => {
        expect(trackPerformers({ artists: [act('Band A', 1, { anv: 'Band A' })] }, release)[0]
            .alt_names).toEqual([]);
    });

    test('a track with no credit of its own falls back to the release', () => {
        const ordinary = { artists: [act('Ocelot', 5)] };
        expect(trackPerformers({ title: 'Borrowed Time' }, ordinary))
            .toEqual([{ name: 'Ocelot', id: 5, alt_names: [] }]);
    });

    test('and on a compilation that fallback is empty, never Various', () => {
        // Nothing here knows who played it. An unfilled field is visible and
        // costs a moment; a track credited to a placeholder is wrong forever.
        expect(trackPerformers({ title: 'Untitled' }, release)).toEqual([]);
    });

    test('Various named on the track itself is dropped too', () => {
        expect(trackPerformers({ artists: [various, act('Band A', 1)] }, release))
            .toEqual([{ name: 'Band A', id: 1, alt_names: [] }]);
    });
});

describe('when a track stops inheriting the release credit', () => {
    /**
     * The form inherits performing groups from the release by default, and
     * that default is worth keeping: an inherited group carries the node id
     * the submitter bound at the top, where a re-typed name mints a new
     * provisional group. So inheritance is broken only where breaking it says
     * something true.
     */
    const ocelot = act('Ocelot', 5);

    test('every track on a compilation names its own act', () => {
        expect(overridesReleaseCredit(
            { artists: [act('Band A', 1)] }, { artists: [various] })).toBe(true);
    });

    test('even one with no credit, so it does not inherit a placeholder', () => {
        expect(overridesReleaseCredit({ title: 'Untitled' }, { artists: [various] })).toBe(true);
    });

    test('an album track repeating the album credit keeps inheriting', () => {
        // Discogs repeats the artist per track on plenty of ordinary releases.
        // Overriding here would replace a bound group id with a fresh one.
        expect(overridesReleaseCredit({ artists: [ocelot] }, { artists: [ocelot] })).toBe(false);
    });

    test('a track with no credit of its own keeps inheriting', () => {
        expect(overridesReleaseCredit({ title: 'Borrowed Time' }, { artists: [ocelot] }))
            .toBe(false);
    });

    test('but a guest act on one track does not inherit', () => {
        // How Discogs writes one outside contribution to an otherwise
        // single-artist record.
        expect(overridesReleaseCredit(
            { artists: [act('A Visiting Band', 9)] }, { artists: [ocelot] })).toBe(true);
    });

    test('the same act under a different Discogs row still overrides', () => {
        // Ids differ, so this is a different row and worth saying so; the
        // submitter can see both names in the form and merge them.
        expect(overridesReleaseCredit(
            { artists: [act('Ocelot', 6)] }, { artists: [ocelot] })).toBe(true);
    });
});

describe('putting a track\u2019s line-up with its act', () => {
    /**
     * Release 6380913 again, track 3: "Tan Sister Radio — Leap Year", credited
     * underneath with Drums – Andrew Ware, Guitar – Aaron Dennis, Vocals/Bass –
     * Max Greenhalgh. The people are right there in the payload and every group
     * the import created was empty.
     */
    const credit = (name, role, id = null) => ({ name, id, role, roles: role.split(', ') });

    const LEAP_YEAR = [
        credit('Andrew Ware', 'Drums'),
        credit('Aaron Dennis', 'Guitar'),
        credit('Max Greenhalgh', 'Vocals, Bass'),
    ];

    test('one act takes the whole line-up', () => {
        const [members] = creditsByAct([{ name: 'Tan Sister Radio', id: 1 }], LEAP_YEAR);

        expect(members.map((m) => m.name))
            .toEqual(['Andrew Ware', 'Aaron Dennis', 'Max Greenhalgh']);
    });

    test('a performer who is one of the acts goes with their own group', () => {
        // Track 6: "The Paragraphs, Tori Rogg", with Tori Rogg on organ. She is
        // a group of one beside The Paragraphs, not a member of it.
        const [paragraphs, tori] = creditsByAct(
            [{ name: 'The Paragraphs', id: 10 }, { name: 'Tori Rogg', id: 11 }],
            [
                credit('Mike Butler', 'Lap Steel Guitar'),
                credit('Jesse Hofbauer', 'Vocals, Guitar'),
                credit('Tori Rogg', 'Vocals, Organ', 11),
            ]);

        expect(paragraphs.map((m) => m.name)).toEqual(['Mike Butler', 'Jesse Hofbauer']);
        expect(tori.map((m) => m.name)).toEqual(['Tori Rogg']);
    });

    test('matched by name when Discogs gave the credit no id', () => {
        const [, tori] = creditsByAct(
            [{ name: 'The Paragraphs', id: 10 }, { name: 'Tori Rogg', id: 11 }],
            [credit('Tori Rogg', 'Vocals, Organ')]);

        expect(tori.map((m) => m.name)).toEqual(['Tori Rogg']);
    });

    test('and by name through a Discogs numbering suffix', () => {
        const [, second] = creditsByAct(
            [{ name: 'Band A', id: 1 }, { name: 'Mike Hunt', id: null }],
            [credit('Mike Hunt (8)', 'Drums')]);

        expect(second.map((m) => m.name)).toEqual(['Mike Hunt (8)']);
    });

    test('everyone else goes with the first act, which is a guess', () => {
        // Nothing in the payload says who played in which band. The release
        // level makes the same guess for the same reason.
        const [first, second] = creditsByAct(
            [{ name: 'Band A', id: 1 }, { name: 'Band B', id: 2 }],
            [credit('Somebody', 'Drums')]);

        expect(first).toHaveLength(1);
        expect(second).toEqual([]);
    });

    test('no acts means nowhere to put anybody', () => {
        expect(creditsByAct([], LEAP_YEAR)).toEqual([]);
    });

    test('no credits leaves every act empty rather than undefined', () => {
        expect(creditsByAct([{ name: 'Band A', id: 1 }], [])).toEqual([[]]);
        expect(creditsByAct([{ name: 'Band A', id: 1 }], undefined)).toEqual([[]]);
    });
});
