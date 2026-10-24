/**
 * Unit tests for the Discogs↔Spotify tracklist comparison.
 *
 * The value of this check is entirely in its signal-to-noise ratio. Spotify's
 * catalogue is full of "- Remastered 2011" and "(feat. …)" suffixes that do not
 * change which recording a track is; a comparison that flags those reports a
 * difference on nearly every album and gets ignored, which is worse than no
 * check at all. So most of these tests are about what must NOT be reported.
 */

import { describe, test, expect } from '@jest/globals';
import {
    normalizeTitle, displayTitle, sameTitle, nearlySameTitle,
    diffTracklists, describeDifference, matchSpotifyTracks,
    chooseAlbumByTracklist, describeAlbumChoice, tracklistSupportsAlbum
} from '../../../frontend/src/utils/tracklistDiff.js';

const discogs = (...titles) => titles.map((title, i) => ({ position: `A${i + 1}`, title }));
const spotify = (...names) => names.map((name, i) => ({ name, track_number: i + 1 }));

describe('titles that mean the same recording', () => {
    test.each([
        ['a remaster suffix',      'Something In The Way', 'Something In The Way - Remastered 2011'],
        ['a bare remaster',        'Lithium',              'Lithium - Remaster'],
        ['a featured artist',      'Drain You',            'Drain You (feat. Someone)'],
        ['a deluxe marker',        'Polly',                'Polly (Deluxe Edition)'],
        ['case and punctuation',   'Smells Like Teen Spirit', 'smells like teen spirit'],
        ['a curly apostrophe',     "Rock n Roll",          "Rock ’n Roll"],
    ])('%s is not a difference', (_label, ours, theirs) => {
        expect(sameTitle(ours, theirs)).toBe(true);
    });

    test('genuinely different titles are different', () => {
        expect(sameTitle('In Bloom', 'Breed')).toBe(false);
    });

    test('an empty title never matches, including another empty one', () => {
        // Otherwise two blank rows would silently agree with each other.
        expect(sameTitle('', '')).toBe(false);
        expect(sameTitle('', 'Lithium')).toBe(false);
    });

    test('normalizeTitle tolerates null and undefined', () => {
        expect(normalizeTitle(null)).toBe('');
        expect(normalizeTitle(undefined)).toBe('');
    });
});

describe('diffTracklists', () => {
    test('identical tracklists produce no differences', () => {
        const differences = diffTracklists(
            discogs('Smells Like Teen Spirit', 'In Bloom'),
            spotify('Smells Like Teen Spirit - Remastered', 'In Bloom - Remastered')
        );
        expect(differences).toEqual([]);
    });

    test('a differing count is reported once, not per track', () => {
        const differences = diffTracklists(
            discogs('One', 'Two', 'Three'),
            spotify('One', 'Two')
        );
        const counts = differences.filter(d => d.kind === 'count');
        expect(counts).toHaveLength(1);
        expect(counts[0]).toMatchObject({ discogs: '3', spotify: '2' });
    });

    test('a track missing from Spotify is named', () => {
        // The Songs For The Deaf case: a pre-roll track Discogs has and the
        // streaming release does not.
        const differences = diffTracklists(discogs('One', 'Two', 'Hidden'), spotify('One', 'Two'));
        const missing = differences.find(d => d.kind === 'missing_on_spotify');
        expect(missing).toMatchObject({ discogs: 'Hidden', position: 'A3' });
    });

    test('a track Spotify has and the form does not is also reported', () => {
        const differences = diffTracklists(discogs('One'), spotify('One', 'Two'));
        expect(differences.find(d => d.kind === 'missing_locally'))
            .toMatchObject({ spotify: 'Two' });
    });

    test('a wrong title at a position is a title difference', () => {
        const differences = diffTracklists(discogs('One', 'Wrong'), spotify('One', 'Two'));
        expect(differences).toHaveLength(1);
        expect(differences[0]).toMatchObject({
            kind: 'title', index: 1, position: 'A2', discogs: 'Wrong', spotify: 'Two',
        });
    });

    test('a transposition is reported as order, not as two wrong titles', () => {
        // Both tracks exist on both sides; only their places disagree. Calling
        // that a title mismatch would send the submitter looking for the wrong
        // problem.
        const differences = diffTracklists(discogs('One', 'Two'), spotify('Two', 'One'));
        expect(differences.every(d => d.kind === 'order')).toBe(true);
    });

    test('vinyl positions do not confuse the comparison', () => {
        // Discogs numbers per side, Spotify numbers straight through, so
        // comparison has to be by sequence rather than by the position string.
        const ours = [
            { position: 'A1', title: 'One' }, { position: 'A2', title: 'Two' },
            { position: 'B1', title: 'Three' }, { position: 'B2', title: 'Four' },
        ];
        expect(diffTracklists(ours, spotify('One', 'Two', 'Three', 'Four'))).toEqual([]);
    });

    test('empty and missing input does not throw', () => {
        expect(diffTracklists([], [])).toEqual([]);
        expect(diffTracklists()).toEqual([]);
        expect(diffTracklists(null, null)).toEqual([]);
    });
});

describe('describeDifference', () => {
    test('every kind produces a sentence naming the tracks involved', () => {
        const kinds = [
            { kind: 'count', discogs: '13', spotify: '12', position: null },
            { kind: 'title', position: 'A2', discogs: 'Wrong', spotify: 'Two' },
            { kind: 'order', position: 'A1', discogs: 'One', spotify: 'Two' },
            { kind: 'spelling', position: 'A3', discogs: 'Mystic Lover', spotify: 'Mystic Lovers' },
            { kind: 'missing_on_spotify', position: 'B7', discogs: 'Hidden', spotify: null },
            { kind: 'missing_locally', position: null, discogs: null, spotify: 'Extra' },
        ];
        for (const difference of kinds) {
            const text = describeDifference(difference);
            expect(text.length).toBeGreaterThan(10);
            for (const value of [difference.discogs, difference.spotify]) {
                if (value) expect(text).toContain(value);
            }
        }
    });
});

describe('matchSpotifyTracks', () => {
    /**
     * This decides which Spotify link gets written onto which track row, so a
     * wrong answer is bad data written silently — the exact failure the whole
     * cross-check exists to catch. A missed match is visible as an empty field
     * and costs a moment, so the bias throughout is toward matching nothing.
     */
    const form = (...titles) => titles.map((title, i) => ({ position: `A${i + 1}`, title }));
    const spot = (...names) => names.map((name, i) => ({
        id: `id${i + 1}`, name, track_number: i + 1,
    }));

    test('a clean tracklist matches straight through', () => {
        const result = matchSpotifyTracks(
            form('No One Knows', 'First It Giveth'),
            spot('No One Knows', 'First It Giveth'));

        expect(result.map(r => r.spotify?.id)).toEqual(['id1', 'id2']);
        expect(result.every(r => r.reason === 'matched')).toBe(true);
    });

    test('edition noise does not defeat a match', () => {
        // The reason this reuses normalizeTitle rather than comparing strings:
        // Spotify's catalogue is full of these and an exact comparison would
        // match almost nothing.
        const [result] = matchSpotifyTracks(
            form('No One Knows'),
            spot('No One Knows - Remastered 2011'));

        expect(result.reason).toBe('matched');
    });

    test('order does not matter — matching is by title', () => {
        const result = matchSpotifyTracks(
            form('Go With The Flow', 'No One Knows'),
            spot('No One Knows', 'Go With The Flow'));

        expect(result.map(r => r.spotify?.id)).toEqual(['id2', 'id1']);
    });

    test('an offset tracklist does not shift links onto the wrong tracks', () => {
        // Spotify has a hidden intro the Discogs listing does not. Position
        // matching would put every link one row out; title matching does not.
        const result = matchSpotifyTracks(
            form('No One Knows', 'Go With The Flow'),
            spot('Intro', 'No One Knows', 'Go With The Flow'));

        expect(result.map(r => r.spotify?.name))
            .toEqual(['No One Knows', 'Go With The Flow']);
    });

    test('a title Spotify does not have is left unmatched', () => {
        const [, second] = matchSpotifyTracks(
            form('No One Knows', 'A Vinyl-Only Bonus'),
            spot('No One Knows'));

        expect(second.spotify).toBeNull();
        expect(second.reason).toBe('no_match');
    });

    test('duplicate titles on both sides pair in order', () => {
        // A reprise, or two untitled tracks. Both sides agree on how many, so
        // the only sane pairing is sequential.
        const result = matchSpotifyTracks(
            form('Untitled', 'Song', 'Untitled'),
            spot('Untitled', 'Song', 'Untitled'));

        expect(result.map(r => r.spotify?.id)).toEqual(['id1', 'id2', 'id3']);
    });

    test('equal numbers of a repeated title pair in order', () => {
        // Two "Untitled" rows and two "Untitled" recordings: sequential is the
        // only sane reading, and it is the same count on both sides.
        const result = matchSpotifyTracks(
            form('Untitled', 'Untitled'),
            spot('Untitled', 'Song', 'Untitled'));

        expect(result.map(r => r.spotify?.id)).toEqual(['id1', 'id3']);
    });

    test('more rows than recordings means nothing is matched', () => {
        // Three rows share a title Spotify has once. At least one row has no
        // counterpart and nothing says which — an ordinal here would be a coin
        // toss dressed up as a match, and it would write a link onto the wrong
        // track silently.
        const result = matchSpotifyTracks(
            form('Untitled', 'Untitled', 'Untitled'),
            spot('Untitled'));

        expect(result.filter(r => r.spotify).length).toBe(0);
        expect(result.every(r => r.reason === 'ambiguous')).toBe(true);
    });

    test('more recordings than rows picks the one on the row ordinal', () => {
        // Spotify lists an extra version. Every row does have a counterpart, so
        // a track number landing exactly on the ordinal is a real signal.
        const result = matchSpotifyTracks(
            [{ title: 'Take' }, { title: 'Filler' }],
            [{ id: 'a', name: 'Take', track_number: 1 },
             { id: 'b', name: 'Take', track_number: 5 },
             { id: 'c', name: 'Filler', track_number: 2 }]);

        expect(result[0].spotify?.id).toBe('a');
        expect(result[1].spotify?.id).toBe('c');
    });

    test('an untitled row matches nothing rather than everything', () => {
        // normalizeTitle collapses blanks to the same empty key, which would
        // group every untitled row together if they were not skipped.
        const result = matchSpotifyTracks(
            [{ title: '' }, { title: null }, { title: 'No One Knows' }],
            spot('No One Knows'));

        expect(result[0].spotify).toBeNull();
        expect(result[1].spotify).toBeNull();
        expect(result[2].spotify?.id).toBe('id1');
    });

    test('there is one result per form track, in order', () => {
        const result = matchSpotifyTracks(form('A', 'B', 'C'), spot('B'));

        expect(result).toHaveLength(3);
        expect(result.map(r => r.index)).toEqual([0, 1, 2]);
    });

    test.each([
        ['no spotify tracks', ['A'], []],
        ['no form tracks', [], ['A']],
        ['neither', [], []],
    ])('%s is handled without throwing', (_label, ours, theirs) => {
        expect(() => matchSpotifyTracks(form(...ours), spot(...theirs))).not.toThrow();
    });

    test('non-array input is tolerated', () => {
        expect(matchSpotifyTracks(undefined, undefined)).toEqual([]);
    });

    describe('titles the two services spell differently', () => {
        test('a one-character difference still gets its link', () => {
            const [result] = matchSpotifyTracks(
                form('Mystic Lover'), spot('Mystic Lovers'));

            expect(result.spotify?.id).toBe('id1');
            expect(result.reason).toBe('near_match');
        });

        test("the other spelling comes back, so it can be kept", () => {
            // The point of the whole second pass: the information Discogs and
            // Spotify disagree about is itself worth recording, as an alternate
            // title, rather than being discarded along with the link.
            const [result] = matchSpotifyTracks(
                form('Mystic Lover'), spot('Mystic Lovers'));

            expect(result.alt_title).toBe('Mystic Lovers');
        });

        test('the alternate title carries no edition decoration', () => {
            // Otherwise "Mystic Lovers - Remastered 2011" is written into the
            // registry as a title somebody once printed, which nobody did.
            const [result] = matchSpotifyTracks(
                form('Mystic Lover'), spot('Mystic Lovers - Remastered 2011'));

            expect(result.reason).toBe('near_match');
            expect(result.alt_title).toBe('Mystic Lovers');
        });

        test('an exact match records no alternate title', () => {
            // Edition noise is not a spelling: "Lithium - Remaster" matches
            // exactly once normalized, and recording it as an alternate title
            // would fill the registry with catalogue cruft.
            const [result] = matchSpotifyTracks(form('Lithium'), spot('Lithium - Remaster'));

            expect(result.reason).toBe('matched');
            expect(result.alt_title).toBeNull();
        });

        test('a short title gets no tolerance at all', () => {
            // One edit apart and a different song. This is why the budget
            // scales with length instead of being a constant.
            const [result] = matchSpotifyTracks(form('Intro'), spot('Outro'));

            expect(result.spotify).toBeNull();
            expect(result.reason).toBe('no_match');
        });

        test('two edits on a twelve-character title is too many', () => {
            const [result] = matchSpotifyTracks(form('Mystic Lover'), spot('Mystik Loverz'));

            expect(result.spotify).toBeNull();
        });

        test('two plausible candidates match nothing', () => {
            // Both are within budget of the row and nothing chooses between
            // them. Picking either writes a link onto a recording the
            // submitter never saw.
            const [result] = matchSpotifyTracks(
                form('Mystic Lover'), spot('Mystic Lovers', 'Mystic Loverr'));

            expect(result.spotify).toBeNull();
            expect(result.reason).toBe('ambiguous');
        });

        test('two rows reaching for the same recording match nothing', () => {
            // The mirror image of the case above, and the reason the pass
            // requires mutual uniqueness: first-come-first-served here would
            // make the answer depend on tracklist order.
            const result = matchSpotifyTracks(
                form('Mystic Lover', 'Mystic Loverr'), spot('Mystic Lovers'));

            expect(result.filter(r => r.spotify).length).toBe(0);
            expect(result.map(r => r.reason)).toEqual(['ambiguous', 'ambiguous']);
        });

        test('the answer does not depend on which row comes first', () => {
            const forwards = matchSpotifyTracks(
                form('Mystic Lover', 'Mystic Loverr'), spot('Mystic Lovers'));
            const backwards = matchSpotifyTracks(
                form('Mystic Loverr', 'Mystic Lover'), spot('Mystic Lovers'));

            expect(forwards.map(r => r.reason)).toEqual(backwards.map(r => r.reason));
        });

        test('a near match never steals a recording already matched exactly', () => {
            // Row 1 holds Spotify's exact spelling. The near-identical row 0
            // must not take that link away from it.
            const result = matchSpotifyTracks(
                form('Mystic Lover', 'Mystic Lovers'), spot('Mystic Lovers'));

            expect(result[1].spotify?.id).toBe('id1');
            expect(result[1].reason).toBe('matched');
            expect(result[0].spotify).toBeNull();
        });

        test('a row left ambiguous by the exact pass stays ambiguous', () => {
            // Three "Untitled" rows against one "Untitled" recording was
            // already judged unresolvable; a weaker match is no way to resolve
            // it.
            const result = matchSpotifyTracks(
                form('Untitled', 'Untitled', 'Untitled'), spot('Untitled'));

            expect(result.filter(r => r.spotify).length).toBe(0);
        });

        test('an ambiguous row does not spoil another row\u2019s near match', () => {
            // Rows 0 and 1 share a title Spotify has once, so the exact pass
            // gives up on both. If they were still in the running here they
            // would contest the same recording row 2 is a clean near match
            // for, and all three would come back empty — one unresolvable
            // group would have cost a match it has no claim on.
            const result = matchSpotifyTracks(
                form('Mystic Lovers', 'Mystic Lovers', 'Mystic Loverz'),
                spot('Mystic Lovers'));

            expect(result[2].spotify?.id).toBe('id1');
            expect(result[2].reason).toBe('near_match');
            expect(result[2].alt_title).toBe('Mystic Lovers');
            expect(result.slice(0, 2).every(r => r.reason === 'ambiguous')).toBe(true);
        });
    });
});

describe('titles that are the same recording spelled differently', () => {
    test.each([
        ['a plural',          'Mystic Lover',  'Mystic Lovers'],
        ['a dropped letter',  'Smells Like Teen Spirit', 'Smells Like Teen Spirt'],
        ['a transposition',   'Everything In Its Right Place',
                              'Everyhting In Its Right Place'],
    ])('%s is a near match', (_label, ours, theirs) => {
        expect(nearlySameTitle(ours, theirs)).toBe(true);
        // And must not be mistaken for the same string.
        expect(sameTitle(ours, theirs)).toBe(false);
    });

    test.each([
        ['one edit on a short title', 'The Wait',     'The Weit'],
        ['a different short word',    'Intro',        'Outro'],
        ['two edits at twelve',       'Mystic Lover', 'Mystik Loverz'],
        ['different songs',           'In Bloom',     'Breed'],
        ['an empty title',            '',             'Lithium'],
    ])('%s is not a near match', (_label, ours, theirs) => {
        expect(nearlySameTitle(ours, theirs)).toBe(false);
    });

    test('the tolerance is one edit per ten characters of the shorter title', () => {
        // Stated outright because every case above depends on it: nine
        // characters buy nothing, and a long title is allowed proportionally
        // more slack rather than a fixed amount.
        expect(nearlySameTitle('Lithiu', 'Lithium')).toBe(false);
        expect(nearlySameTitle('Lithium Ion', 'Lithium Eon')).toBe(true);
    });

    test('an ampersand is not a spelling difference', () => {
        // "Rock & Roll" against "Rock and Roll" is four characters of edit
        // distance and the same title; it is normalized away rather than
        // spent out of the tolerance budget.
        expect(sameTitle('Rock & Roll', 'Rock and Roll')).toBe(true);
    });

    test('displayTitle keeps the spelling and drops the decoration', () => {
        expect(displayTitle('Mystic Lovers - Remastered 2011')).toBe('Mystic Lovers');
        expect(displayTitle('Drain You (feat. Someone)')).toBe('Drain You');
        expect(displayTitle("Rock 'n Roll")).toBe("Rock 'n Roll");
        expect(displayTitle(null)).toBe('');
    });

    test('diffTracklists calls it a spelling, not a wrong title', () => {
        const [difference] = diffTracklists(
            discogs('Mystic Lover'), spotify('Mystic Lovers'));

        expect(difference.kind).toBe('spelling');
        expect(difference.discogs).toBe('Mystic Lover');
        expect(difference.spotify).toBe('Mystic Lovers');
    });

    test('a genuinely wrong title is still reported as one', () => {
        const [difference] = diffTracklists(discogs('In Bloom'), spotify('Breed'));
        expect(difference.kind).toBe('title');
    });

    test('a transposition is still reported as one', () => {
        // Both rows are near matches of what sits at their position, but each
        // title appears exactly elsewhere — which says the list shifted, not
        // that anybody misspelled anything.
        const differences = diffTracklists(
            discogs('Mystic Lover', 'Mystic Lovers'),
            spotify('Mystic Lovers', 'Mystic Lover'));

        expect(differences.map(d => d.kind)).toEqual(['order', 'order']);
    });
});

describe('choosing an album a name search only proposed', () => {
    /**
     * Artist-and-title search is the last way into the catalogue, used when
     * there is no Spotify link and no barcode — which is the normal state of a
     * record pressed before the mid-80s, and of plenty of Discogs entries for
     * ones pressed after.
     *
     * A search hit is an opinion about relevance. What makes it safe to use
     * anyway is that it does not have to be trusted: the tracklist in the
     * submitter's form is independent evidence, and eleven titles agreeing in
     * order is not something two unrelated releases do. These tests are mostly
     * about the proposals that must be refused, because the cost of accepting
     * one is a whole tracklist of links and ISRCs silently attached to the
     * wrong record.
     */
    const album = (id, name, titles) => ({
        id,
        name,
        tracks: titles.map((title, i) => ({ id: `${id}-${i}`, name: title, track_number: i + 1 })),
    });

    const BLEED = ['Bleed American', 'A Praise Chorus', 'The Middle', 'Your House',
        'Sweetness', 'Hear You Me', 'If You Don\'t, Don\'t', 'Get It Faster',
        'Cautioners', 'The Authority Song', 'My Sundown'];
    const form = BLEED.map((title, i) => ({ position: String(i + 1), title }));

    test('the record whose tracklist agrees is chosen', async () => {
        const choice = chooseAlbumByTracklist(form, [album('a', 'Bleed American', BLEED)]);

        expect(choice.reason).toBe('matched');
        expect(choice.album.id).toBe('a');
    });

    test('a compilation that happens to carry the singles is refused', () => {
        // The failure this guards against: "The Middle" is on every Jimmy Eat
        // World compilation there is, and a greatest-hits package ranks well
        // for the artist. Accounting for two of eleven rows while leaving
        // eighteen tracks unexplained is not this album.
        const hits = album('h', 'Greatest Hits', [
            'The Middle', 'Sweetness', 'Pain', 'Work', 'Futures', 'Big Casino',
            'Lucky Denver Mint', 'Chase This Light', 'My Best Theory', 'Damage',
            'Sure and Certain', 'Get Right', 'Always Be', 'Coffee and Cigarettes',
            'Dizzy', 'Here It Goes', 'Let It Happen', 'Invented', 'Action Needs an Audience',
            'Movielike']);

        const choice = chooseAlbumByTracklist(form, [hits]);

        expect(choice.album).toBeNull();
        expect(choice.reason).toBe('weak');
        // The rejected front-runner still comes back: "this is the closest
        // thing Spotify has and here is why it was not used" is actionable,
        // where "no match" leaves a submitter with nothing to do.
        expect(choice.best.id).toBe('h');
        expect(choice.accounted).toBe(2);
    });

    test('a live album of the same name, half the same songs, is refused', () => {
        // The case the share bar exists for, and the one the unexplained-track
        // guard cannot see: eleven tracks, six of them this album's, five of
        // them not, so neither side is mostly unaccounted for. Six songs in
        // common is two bands' worth of overlap, not an edition of this record.
        const live = album('l', 'Bleed American (Live)', [
            ...BLEED.slice(0, 6), 'Lucky Denver Mint', 'For Me This Is Heaven',
            'Blister', 'Goodbye Sky Harbor', 'Table for Glasses']);

        const choice = chooseAlbumByTracklist(form, [live]);

        expect(choice.album).toBeNull();
        expect(choice.accounted).toBe(6);
        expect(choice.required).toBe(9);
    });

    test('a missing bonus track or two does not lose the match', () => {
        // Discogs lists the LP; Spotify sells the edition with the B-sides on
        // the end. Demanding a clean sweep would reject the right album for
        // the same reason the diff exists to report.
        const deluxe = album('d', 'Bleed American', [...BLEED, 'No Sensitivity', 'Spangle']);

        expect(chooseAlbumByTracklist(form, [deluxe]).album.id).toBe('d');
    });

    test('the tightest fit wins, so a standard edition beats its own reissue', () => {
        const standard = album('std', 'Bleed American', BLEED);
        const deluxe = album('dx', 'Bleed American (Deluxe Edition)',
            [...BLEED, 'No Sensitivity', 'Spangle', 'Drugs or Me (Demo)']);

        // Ordered deluxe-first deliberately: the choice must come from the
        // evidence, not from Spotify's ranking.
        expect(chooseAlbumByTracklist(form, [deluxe, standard]).album.id).toBe('std');
    });

    test('two different records that fit equally well are refused', () => {
        // The coin toss this module refuses everywhere else. Each accounts for
        // ten of the eleven rows and leaves one track unexplained, and they are
        // not the same record.
        const one = album('a', 'Bleed American',
            [...BLEED.slice(0, 10), 'Firestarter']);
        const two = album('b', 'Bleed American',
            [...BLEED.slice(0, 9), 'My Sundown', 'Softer']);

        const choice = chooseAlbumByTracklist(form, [one, two]);

        expect(choice.album).toBeNull();
        expect(choice.reason).toBe('ambiguous');
    });

    test('two pressings of the one record are not a coin toss', () => {
        // Same tracklist, two catalogue rows — a territory split or a reissue.
        // Refusing here would mean refusing the right answer twice over.
        const choice = chooseAlbumByTracklist(form, [
            album('us', 'Bleed American', BLEED),
            album('eu', 'Bleed American', BLEED),
        ]);

        expect(choice.reason).toBe('matched');
        expect(choice.album.id).toBe('us');
    });

    test('spelling differences still count as agreement', () => {
        // The same tolerance matchSpotifyTracks uses for filling in links: one
        // edit per ten characters, and the remaster suffixes discounted.
        const theirs = album('a', 'Bleed American', [
            'Bleed American - Remastered', 'A Praise Chorus', 'The Middle',
            'Your House', 'Sweetness', 'Hear You Me (feat. Nobody)',
            'If You Dont, Dont', 'Get It Faster', 'Cautioners',
            'The Authority Song', 'My Sundown']);

        expect(chooseAlbumByTracklist(form, [theirs]).reason).toBe('matched');
    });

    test('one title in common is never enough, however short the form', () => {
        // A single-row form clears any percentage on the first album that
        // carries that title, which is why the share is not the whole test.
        const single = [{ position: '1', title: 'The Middle' }];
        const hits = album('h', 'Greatest Hits',
            ['The Middle', 'Pain', 'Work', 'Futures', 'Sweetness']);

        expect(chooseAlbumByTracklist(single, [hits]).album).toBeNull();
    });

    test('a short release still matches when the whole of it agrees', () => {
        const ep = [{ position: '1', title: 'Firestarter' }, { position: '2', title: 'Molotov' }];
        const theirs = album('e', 'Firestarter', ['Firestarter', 'Molotov']);

        expect(chooseAlbumByTracklist(ep, [theirs]).album.id).toBe('e');
    });

    test('nothing to judge with is not a match', () => {
        expect(chooseAlbumByTracklist([], [album('a', 'A', BLEED)]).reason).toBe('none');
        expect(chooseAlbumByTracklist(form, []).reason).toBe('none');
        expect(chooseAlbumByTracklist(form, [{ id: 'x', name: 'X', tracks: [] }]).reason)
            .toBe('none');
        expect(chooseAlbumByTracklist().album).toBeNull();
    });

    test('untitled rows do not count against the form', () => {
        // An empty row can never match anything, so counting it in the
        // denominator would make a tracklist with a blank line unmatchable.
        const withBlank = [...form, { position: '12', title: '  ' }];

        expect(chooseAlbumByTracklist(withBlank, [album('a', 'Bleed American', BLEED)]).album)
            .not.toBeNull();
    });

    test('the rejection names the album and links it', () => {
        const hits = album('h', 'Greatest Hits', ['The Middle', 'Pain', 'Work', 'Futures']);
        const message = describeAlbumChoice(chooseAlbumByTracklist(form, [hits]));

        expect(message).toContain('Greatest Hits');
        expect(message).toContain('https://open.spotify.com/album/h');
        expect(message).toContain('11');
    });

    test('an ambiguous rejection says how many there were', () => {
        const message = describeAlbumChoice(
            { reason: 'ambiguous', considered: 2, best: null, accounted: 10, rows: 11 });

        expect(message).toContain('2 releases');
    });

    test('an empty result says Spotify has nothing, not that the match failed', () => {
        expect(describeAlbumChoice({ reason: 'none' })).toMatch(/nothing/i);
        expect(describeAlbumChoice()).toMatch(/nothing/i);
    });
});

describe('whether an album bears out being the record on the form', () => {
    /**
     * The case that prompted this: Discogs lists a barcode for a 15-track
     * album which Spotify files under a 4-track release. The server verified
     * the barcode — the full album really does carry it — so the match was
     * accepted, its link was written into the release field, and five other
     * services were asked for the same wrong record's links. A barcode proves
     * a barcode; it does not prove the music.
     */
    const AMORE = discogs(
        'The End Of Love', 'Tropics Of Love', 'Broken World', 'Why I Stay',
        'The Invitation', 'Did You Wonder', 'A Sign On The Road', 'Sympathy Crime',
        'The Visitor', 'The Waiter #4', 'A Cry For Love', 'Before The People',
        'Only One Way', 'Fingerprints', 'The One Who Has Disappeared',
    );
    const WRONG_RELEASE = {
        name: 'Smoke and Scissors',
        tracks: spotify('Yoker Swan', 'The Streaker', 'Moonlighting', 'Smoke and Scissors'),
    };

    test('a four-track release is not a fifteen-track album', () => {
        const support = tracklistSupportsAlbum(AMORE, WRONG_RELEASE);

        expect(support.supported).toBe(false);
        expect(support.accounted).toBe(0);
        expect(support.rows).toBe(15);
        expect(support.albumTracks).toBe(4);
    });

    test('the album it really is, is borne out', () => {
        const support = tracklistSupportsAlbum(AMORE, {
            name: 'Amore del Tropico',
            tracks: spotify(...AMORE.map((track) => track.title)),
        });

        expect(support.supported).toBe(true);
        expect(support.accounted).toBe(15);
    });

    test('a bonus track or two does not sink it', () => {
        // Which is the whole reason this is a share and not a clean sweep: the
        // streaming edition of a record routinely carries an extra track.
        const support = tracklistSupportsAlbum(AMORE, {
            name: 'Amore del Tropico (Deluxe)',
            tracks: spotify(...AMORE.map((t) => t.title), 'Demo One', 'Demo Two'),
        });

        expect(support.supported).toBe(true);
    });

    test('a compilation carrying a few of the songs is not the album', () => {
        const support = tracklistSupportsAlbum(AMORE, {
            name: 'Label Retrospective',
            tracks: spotify('Broken World', 'Fingerprints', 'Someone Else', 'Another',
                'And Another', 'More', 'Still More', 'Yet More'),
        });

        expect(support.supported).toBe(false);
        expect(support.accounted).toBe(2);
        expect(support.unexplained).toBe(6);
    });

    test.each([
        ['a form with no tracks yet', [], { name: 'X', tracks: spotify('A', 'B') }],
        ['an album returned without its tracklist', discogs('A', 'B'), { name: 'X', tracks: [] }],
        ['neither', [], { name: 'X' }],
    ])('%s is not judged either way', (_label, form, album) => {
        // No evidence is not evidence against. Refusing a match here would
        // break the ordinary case where the tracks are entered after the link.
        expect(tracklistSupportsAlbum(form, album).supported).toBe(true);
    });

    test('it agrees with the choice the name search already makes', () => {
        // One definition, two callers: if these ever disagree, a barcode match
        // and a name match are being held to different standards again.
        const candidates = [{ id: 'wrong', ...WRONG_RELEASE }];
        expect(chooseAlbumByTracklist(AMORE, candidates).album).toBeNull();
        expect(tracklistSupportsAlbum(AMORE, WRONG_RELEASE).supported).toBe(false);
    });
});

describe('a streaming release that inserts tracks the pressing does not have', () => {
    /**
     * A live record's streaming edition carries the between-song banter as
     * tracks of its own. The songs are all there and all in order, and every
     * position after the first interlude is off by one — which was reported as
     * a separate mismatch per track: nine differences plus a count line for
     * the one fact that Spotify has two extra tracks. A report that long is
     * not read, and this one is meant to be read before signing.
     */
    const SET = ['Brain Telephone', 'Futurephobic', 'Syster System', 'Cops And Robbers',
        'Sidewalk', 'Weird Dog', 'I-Candy', 'Empire', 'Bonehead'];

    const form = discogs(...SET);
    const streaming = spotify(
        '(hello hello)',
        'Brain Telephone - Live', 'Futurephobic - Live', 'Syster System - Live',
        'Cops & Robbers - Live', 'Sidewalk - Live',
        '(are we off the air?)',
        'Weird Dog - Live', 'i-Candy - Live', 'Empire - Live', 'Bonehead - Live',
    );

    test('only the inserted tracks are reported', () => {
        const differences = diffTracklists(form, streaming);

        expect(differences.filter((d) => d.kind === 'missing_locally').map((d) => d.spotify))
            .toEqual(['(hello hello)', '(are we off the air?)']);
    });

    test('not one mismatch per track behind the insertion', () => {
        // Nine 'order' differences, every one of them a song that is present,
        // in order, under the same name once "- Live" is discounted.
        const differences = diffTracklists(form, streaming);

        expect(differences.filter((d) => d.kind === 'order')).toEqual([]);
        expect(differences.filter((d) => d.kind === 'title')).toEqual([]);
    });

    test('the count difference is still stated', () => {
        // Nine against eleven is worth knowing; it is the nine explanations
        // that were not.
        const [first] = diffTracklists(form, streaming);

        expect(first).toMatchObject({ kind: 'count', discogs: '9', spotify: '11' });
    });

    test('the whole report is three lines, not twelve', () => {
        expect(diffTracklists(form, streaming)).toHaveLength(3);
    });

    test('a track the streaming release omits is reported the same way round', () => {
        const differences = diffTracklists(
            discogs('One', 'Two', 'Three', 'Four'),
            spotify('One', 'Three', 'Four'),
        );

        expect(differences.filter((d) => d.kind === 'missing_on_spotify').map((d) => d.discogs))
            .toEqual(['Two']);
        expect(differences.filter((d) => d.kind === 'order')).toEqual([]);
    });

    test('a genuine transposition is still reported as one', () => {
        // The guard must not swallow the thing this module exists to catch:
        // two tracks swapped is not an insertion, and no subsequence runs
        // through.
        const differences = diffTracklists(
            discogs('One', 'Two', 'Three'),
            spotify('One', 'Three', 'Two'),
        );

        expect(differences.some((d) => d.kind === 'order')).toBe(true);
    });

    test('an equal-length pair is compared position by position as before', () => {
        const differences = diffTracklists(
            discogs('One', 'Two', 'Three'),
            spotify('One', 'Different', 'Three'),
        );

        expect(differences).toHaveLength(1);
        expect(differences[0]).toMatchObject({ kind: 'title', index: 1 });
    });
});

describe('a title that differs only by a trailing character', () => {
    test.each([
        ['an extra letter on an eight-character title', 'Super Fxx', 'Super Fx'],
        ['the same the other way round', 'Super Fx', 'Super Fxx'],
        ['a plural', 'Sidewalks', 'Sidewalk'],
        ['two characters', 'Electric Saloons', 'Electric Saloon'],
    ])('%s is the same recording', (_label, a, b) => {
        expect(nearlySameTitle(a, b)).toBe(true);
    });

    test.each([
        // Six characters buy no slack, which this module already decided.
        ['a short truncation', 'Lithiu', 'Lithium'],
        // A digit tail is a different thing, not a typo.
        ['a disc number', 'Disc 1', 'Disc 10'],
        ['a volume number', 'Volume 2', 'Volume 23'],
        // Not a tail at all: the difference is inside the string.
        ['an interior change on a short title', 'Intro', 'Outro'],
        // Too much tail to be a typo.
        ['a longer word appended', 'Fireworks Display', 'Fireworks'],
    ])('%s is not', (_label, a, b) => {
        expect(nearlySameTitle(a, b)).toBe(false);
    });

    test('it is reported as a spelling difference, not hidden', () => {
        // The link gets filled and the submitter is still told the two
        // catalogues disagree — which is the whole posture of this module.
        const [difference] = diffTracklists(discogs('Super Fxx'), spotify('Super Fx'));

        expect(difference).toMatchObject({ kind: 'spelling', discogs: 'Super Fxx' });
    });
});
