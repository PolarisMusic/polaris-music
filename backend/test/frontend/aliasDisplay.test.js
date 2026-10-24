/**
 * Saying why a search result is in the list.
 *
 * Typing "Avey Tare" returns somebody called Dave Portner, because the search
 * index covers alternate names. With nothing on the row to say so, the result
 * reads as a mistake rather than an answer — and the submitter's choice is
 * between picking a stranger and giving up.
 *
 * Lives under backend/test for the usual reason: the frontend has no unit-test
 * runner, and these modules are plain ESM.
 */

import { describe, test, expect } from '@jest/globals';
import { matchingAltName } from '../../../frontend/src/utils/altNames.js';

describe('the alias to show on a result row', () => {
    const portner = { display_name: 'Dave Portner', alt_names: ['Avey Tare', 'Deakin'] };

    test('the one the query matched', () => {
        expect(matchingAltName(portner, 'Avey Tare')).toBe('Avey Tare');
    });

    test('matched case-insensitively and on a partial', () => {
        expect(matchingAltName(portner, 'avey')).toBe('Avey Tare');
    });

    test('not every alias the node has', () => {
        // A node with six aliases shows the relevant one. The row is one line.
        expect(matchingAltName(portner, 'deakin')).toBe('Deakin');
    });

    test('none when the visible name already explains the match', () => {
        // "a.k.a. Avey Tare" beside a row called Dave Portner says something.
        // Beside a row the query already matches, it says nothing.
        expect(matchingAltName(portner, 'Portner')).toBeNull();
    });

    test('none when no alias matches', () => {
        expect(matchingAltName(portner, 'Lennon')).toBeNull();
    });

    test.each([
        ['an empty query', ''],
        ['whitespace', '   '],
        ['no aliases', 'avey'],
    ])('%s gives nothing rather than throwing', (label, query) => {
        const result = label === 'no aliases'
            ? { display_name: 'Dave Portner' }
            : portner;
        expect(matchingAltName(result, query)).toBeNull();
    });

    test('a malformed result is survivable', () => {
        expect(matchingAltName(null, 'x')).toBeNull();
        expect(matchingAltName({}, 'x')).toBeNull();
        expect(matchingAltName({ alt_names: 'not a list' }, 'x')).toBeNull();
    });
});
