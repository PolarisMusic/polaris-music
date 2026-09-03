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
    normalizeTitle, sameTitle, diffTracklists, describeDifference, matchSpotifyTracks
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
});
