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
    normalizeTitle, sameTitle, diffTracklists, describeDifference
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
