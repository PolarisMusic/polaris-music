/**
 * Unit tests for reading a barcode off a Discogs release.
 *
 * The barcode is load-bearing: it is what lets a pressing be matched to a
 * streaming release by identifier rather than by artist-and-title guesswork.
 * A wrong barcode is therefore a confidently wrong album match, and every
 * track link, ISRC and alternate title that follows from it is wrong too — so
 * most of these tests are about what must NOT be treated as a barcode.
 */

import { describe, test, expect } from '@jest/globals';
import {
    normalizeBarcode, sameBarcode, barcodesFrom, barcodeVariants
} from '../../../frontend/src/utils/discogsBarcode.js';
import {
    barcodeVariants as backendVariants, sameBarcode as backendSame
} from '../../src/api/routes/spotify.js';

const release = (...identifiers) => ({ identifiers });
const barcode = (value) => ({ type: 'Barcode', value });

describe('normalizeBarcode', () => {
    test.each([
        ['as printed on a sleeve', '0 7599-27336-2', '07599273362'],
        ['with spaces only',       '7 59927 33625',  '75992733625'],
        ['already bare',           '075992733625',   '075992733625'],
    ])('%s reduces to digits', (_label, printed, expected) => {
        expect(normalizeBarcode(printed)).toBe(expected);
    });

    test.each([
        ['the word none',      'none'],
        ['a parenthetical',    '(none)'],
        ['a catalogue number', 'SP 34'],
        ['too few digits',     '1234567'],
        ['too many digits',    '123456789012345'],
        ['nothing at all',     ''],
        ['null',               null],
        ['undefined',          undefined],
    ])('%s is not a barcode', (_label, value) => {
        expect(normalizeBarcode(value)).toBe('');
    });
});

describe('sameBarcode', () => {
    test('a UPC-A and its EAN-13 form are the same article', () => {
        // The same number written for different scanners, and which one a
        // catalogue stores is a coin toss.
        expect(sameBarcode('075992733625', '0075992733625')).toBe(true);
    });

    test('printing differences do not matter', () => {
        expect(sameBarcode('0 7599-27336-2', '07599273362')).toBe(true);
    });

    test('different articles are different', () => {
        expect(sameBarcode('075992733625', '075992733626')).toBe(false);
    });

    test('nothing matches nothing', () => {
        // Otherwise two releases with no barcode would agree with each other,
        // which is the worst possible match: silent and wrong.
        expect(sameBarcode('', '')).toBe(false);
        expect(sameBarcode('none', 'none')).toBe(false);
        expect(sameBarcode(null, undefined)).toBe(false);
    });
});

describe('barcodesFrom', () => {
    test('takes the barcode identifier', () => {
        expect(barcodesFrom(release(barcode('0 7599-27336-2'))))
            .toEqual(['07599273362']);
    });

    test('ignores every other kind of identifier', () => {
        // A Discogs release lists matrix numbers, rights-society codes and
        // mould SIDs in the same array, and some of them are long digit runs.
        expect(barcodesFrom(release(
            { type: 'Matrix / Runout', value: '1-75992-27336-2-A1' },
            { type: 'Rights Society', value: '12345678901' },
            { type: 'Label Code', value: 'LC 0309' },
            barcode('075992733625'),
        ))).toEqual(['075992733625']);
    });

    test('keeps several real barcodes, longest first', () => {
        // A reissue often prints its own and the original's.
        expect(barcodesFrom(release(
            barcode('075992733625'),
            barcode('5099748556729'),
        ))).toEqual(['5099748556729', '075992733625']);
    });

    test('does not report the same article twice', () => {
        // The sleeve and the disc, one printed as UPC-A and one as EAN-13.
        expect(barcodesFrom(release(
            barcode('075992733625'),
            barcode('0075992733625'),
        ))).toEqual(['0075992733625']);
    });

    test('a release with no usable barcode reports none', () => {
        expect(barcodesFrom(release(barcode('none'), { type: 'Matrix', value: 'X' })))
            .toEqual([]);
    });

    test('a release with no identifiers at all does not throw', () => {
        expect(barcodesFrom({})).toEqual([]);
        expect(barcodesFrom(null)).toEqual([]);
        expect(barcodesFrom({ identifiers: 'nope' })).toEqual([]);
    });

    test('the type match is case-insensitive', () => {
        // Discogs is community-edited; the field is free text.
        expect(barcodesFrom(release({ type: 'barcode', value: '075992733625' })))
            .toEqual(['075992733625']);
    });
});

describe('barcodeVariants', () => {
    test('a UPC-A is also asked about as an EAN-13', () => {
        // Spotify's upc: filter matches the string it is given, so a UPC-A
        // stored zero-padded is a miss unless both are tried.
        expect(barcodeVariants('075992733625'))
            .toEqual(['075992733625', '0075992733625']);
    });

    test('an EAN-13 is asked about once', () => {
        expect(barcodeVariants('0075992733625')).toEqual(['0075992733625']);
    });

    test('nothing usable produces no queries', () => {
        expect(barcodeVariants('none')).toEqual([]);
        expect(barcodeVariants(null)).toEqual([]);
    });
});

describe('the backend keeps its own copy, and the two must agree', () => {
    /**
     * The API cannot import this module. Its image is built from ./backend
     * alone (docker-compose `context: ./backend`), so a path reaching into
     * frontend/ is a file that does not exist in the container — the same
     * reason parseSpotifyRef is duplicated there. Two copies is the price;
     * this is what stops them drifting apart silently, in the spirit of the
     * schema-copy parity tests in test/schema/.
     */
    const cases = [
        '075992733625',
        '0075992733625',
        '0 7599-27336-2',
        'none',
        'SP 34',
        '7.98',
        '1234567',
        '123456789012345',
        '',
    ];

    test.each(cases)('barcodeVariants agrees about %p', (value) => {
        expect(backendVariants(value)).toEqual(barcodeVariants(value));
    });

    test.each([
        ['075992733625', '0075992733625'],
        ['0 7599-27336-2', '07599273362'],
        ['075992733625', '075992733626'],
        ['none', 'none'],
        ['', ''],
    ])('sameBarcode agrees about %p and %p', (a, b) => {
        expect(backendSame(a, b)).toBe(sameBarcode(a, b));
    });
});
