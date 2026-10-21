/**
 * What counts as a genre, and when two spellings are one genre.
 *
 * The whole point of the feature is set arithmetic — which artists sit in the
 * overlap between two genres — and set arithmetic over a folksonomy is only as
 * good as its identity rule. "hip-hop", "Hip Hop" and "hiphop" as three nodes
 * means three disjoint sets reported where there is one.
 *
 * So most of these tests are about what collapses and, just as importantly,
 * what must not: a lookup table that silently merges two genres is making a
 * claim about music where the registry's whole premise is that such claims are
 * signed and voted on.
 */

import { describe, test, expect } from '@jest/globals';
import {
    normalizeGenre, isDescriptive, canonicalGenre, canonicalGenres
} from '../../src/graph/genreVocabulary.js';

describe('two spellings of one genre', () => {
    test.each([
        ['case',              'Psychedelic Rock', 'psychedelic rock'],
        ['a hyphen',          'hip-hop',          'hip hop'],
        ['a joined word',     'HipHop',           'hip hop'],
        ['an ampersand',      'Drum & Bass',      'drum and bass'],
        ['an abbreviation',   'DnB',              'drum and bass'],
        ['stray whitespace',  '  prog   rock  ',  'progressive rock'],
        ['a slash',           'post/rock',        'post rock'],
        ['an accent',         'Québécois Folk',   'quebecois folk'],
    ])('%s collapses', (_label, raw, expected) => {
        expect(normalizeGenre(raw)).toBe(expected);
    });

    test('the same genre from two catalogues lands on one key', () => {
        // Discogs writes styles in title case, MusicBrainz writes genres in
        // lower case with hyphens. Both describe the same records.
        expect(normalizeGenre('Hip-Hop')).toBe(normalizeGenre('hip hop'));
        expect(normalizeGenre('Progressive Rock')).toBe(normalizeGenre('prog rock'));
    });
});

describe('what the table refuses to decide', () => {
    test('R&B is not merged into rhythm and blues', () => {
        // The one that matters. Collapsing them merges 1950s jump blues with
        // 1990s contemporary R&B — a claim about music, not about spelling,
        // and claims about music belong in something somebody signs.
        expect(normalizeGenre('R&B')).not.toBe(normalizeGenre('rhythm and blues'));
    });

    test('nor is alternative into alternative rock', () => {
        expect(normalizeGenre('alternative')).not.toBe(normalizeGenre('alternative rock'));
    });

    test('nor indie into indie rock', () => {
        expect(normalizeGenre('indie')).not.toBe(normalizeGenre('indie rock'));
    });

    test('but R&B still normalizes consistently with itself', () => {
        expect(normalizeGenre('R&B')).toBe(normalizeGenre('r & b'));
        expect(normalizeGenre('R&B')).toBe('r and b');
    });
});

describe('tags that are not about the music', () => {
    test.each([
        ['seen live',        'Seen live'],
        ['a collection note','albums i own'],
        ['an opinion',       'awesome'],
        ['a decade',         '70s'],
        ['a full decade',    '1970s'],
        ['a year',           '1981'],
        ['a rating',         '5'],
        ['a single letter',  'x'],
        ['punctuation only', '---'],
        ['nothing',          ''],
        ['null',             null],
    ])('%s is not a genre', (_label, raw) => {
        // Last.fm's folksonomy is mostly this. "seen live" is among its most
        // used tags and says nothing about any record.
        expect(isDescriptive(raw)).toBe(false);
        expect(canonicalGenre(raw)).toBeNull();
    });

    test.each([
        'psychedelic rock', 'no wave', 'krautrock', 'shoegaze',
        'free jazz', 'ambient', 'uk garage', 'new wave',
    ])('%s is a genre', (raw) => {
        expect(isDescriptive(raw)).toBe(true);
    });

    test('a phrase is not a label', () => {
        // Words, not characters: this one is 57 characters, which an earlier
        // character-only rule let through.
        expect(isDescriptive('one of the greatest records ever made by anybody')).toBe(false);
        expect(isDescriptive('music to listen to while driving')).toBe(false);
    });

    test('but a long genre name still is', () => {
        // Real genres run long in letters and short in words.
        expect(isDescriptive('progressive psychedelic rock')).toBe(true);
        expect(isDescriptive('melodic death metal')).toBe(true);
        expect(isDescriptive('rhythm and blues')).toBe(true);
    });
});

describe('canonicalGenre', () => {
    test('keeps the spelling the source used', () => {
        // Nothing here invents a capitalisation: MusicBrainz writes genres in
        // lower case by editorial choice, and a title case produced by a
        // function is not more canonical for having been computed.
        expect(canonicalGenre('Psychedelic Rock'))
            .toEqual({ key: 'psychedelic rock', name: 'Psychedelic Rock' });
        expect(canonicalGenre('psychedelic rock'))
            .toEqual({ key: 'psychedelic rock', name: 'psychedelic rock' });
    });

    test('tidies whitespace without restyling', () => {
        expect(canonicalGenre('  Hard   Rock ')).toEqual({ key: 'hard rock', name: 'Hard Rock' });
    });
});

describe('canonicalGenres', () => {
    test('one genre spelled twice is tagged once, with the counts added', () => {
        // Both spellings are votes for the same thing, so they add rather than
        // compete for a place in the ordering.
        expect(canonicalGenres([
            { name: 'Hip-Hop', count: 3 },
            { name: 'hip hop', count: 5 },
        ])).toEqual([{ key: 'hip hop', name: 'Hip-Hop', count: 8 }]);
    });

    test('most used first', () => {
        const found = canonicalGenres([
            { name: 'ambient', count: 2 },
            { name: 'krautrock', count: 9 },
            { name: 'shoegaze', count: 5 },
        ]);

        expect(found.map(g => g.key)).toEqual(['krautrock', 'shoegaze', 'ambient']);
    });

    test('ties break alphabetically, so two runs read the same', () => {
        const found = canonicalGenres(['shoegaze', 'ambient', 'krautrock']);
        expect(found.map(g => g.key)).toEqual(['ambient', 'krautrock', 'shoegaze']);
    });

    test('plain strings work as well as MusicBrainz objects', () => {
        expect(canonicalGenres(['Psychedelic Rock']))
            .toEqual([{ key: 'psychedelic rock', name: 'Psychedelic Rock', count: 0 }]);
    });

    test('noise is dropped from the middle of a real list', () => {
        const found = canonicalGenres([
            { name: 'seen live', count: 400 },
            { name: 'hard rock', count: 12 },
            { name: '1981', count: 7 },
        ]);

        expect(found.map(g => g.key)).toEqual(['hard rock']);
    });

    test('nothing in, nothing out', () => {
        expect(canonicalGenres([])).toEqual([]);
        expect(canonicalGenres(null)).toEqual([]);
        expect(canonicalGenres(undefined)).toEqual([]);
        expect(canonicalGenres(['', null, 42])).toEqual([]);
    });
});
