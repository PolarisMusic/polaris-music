/**
 * Timestamp parsing for the curation feed.
 *
 * Two shapes reach the same renderer and one of them was silently broken. The
 * contract stores anchors.ts as a uint32 of unix SECONDS, so `new Date(ts + 'Z')`
 * built the string "1787608856Z" and every row in the Curate feed read "Invalid
 * Date". The `+ 'Z'` idiom is for a naive datetime like 2026-05-05T00:00:00,
 * which genuinely needs a zone appended; applied to a number it is nonsense.
 *
 * Worth covering because the failure is quiet: a wrong date still renders, it
 * just renders something wrong, and nothing throws.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
    resolve(here, '../../../frontend/src/visualization/InfoPanelRenderer.js'), 'utf8');

/**
 * Compile parseTimestamp out of the class body so the test runs the real
 * source rather than a copy of its logic.
 *
 * @returns {Function}
 */
function compileParseTimestamp() {
    const start = SOURCE.indexOf('\n    parseTimestamp(');
    if (start < 0) throw new Error('parseTimestamp not found');

    const open = SOURCE.indexOf('{', start);
    let depth = 0, i = open;
    for (; i < SOURCE.length; i++) {
        if (SOURCE[i] === '{') depth++;
        else if (SOURCE[i] === '}') { depth--; if (depth === 0) break; }
    }
    return eval(`(function ${SOURCE.slice(start, i + 1).trim()})`);
}

const parseTimestamp = compileParseTimestamp();

describe('parseTimestamp', () => {
    test('unix seconds from the contract', () => {
        // anchors.ts is uint32 seconds. This is the case that was broken.
        expect(parseTimestamp(1787608856).toISOString()).toBe('2026-08-24T22:00:56.000Z');
    });

    test('unix seconds arriving as a string', () => {
        // JSON from the chain API sometimes stringifies numbers.
        expect(parseTimestamp('1787608856').toISOString()).toBe('2026-08-24T22:00:56.000Z');
    });

    test('a naive ISO datetime is read as UTC', () => {
        // The other real shape: no zone, and the chain means UTC.
        expect(parseTimestamp('2026-05-05T00:00:00').toISOString())
            .toBe('2026-05-05T00:00:00.000Z');
    });

    test('an ISO datetime that already has a zone is left alone', () => {
        expect(parseTimestamp('2026-05-05T00:00:00Z').toISOString())
            .toBe('2026-05-05T00:00:00.000Z');
        expect(parseTimestamp('2026-05-05T02:00:00+02:00').toISOString())
            .toBe('2026-05-05T00:00:00.000Z');
    });

    test.each([
        ['null', null],
        ['undefined', undefined],
        ['an empty string', ''],
        ['nonsense', 'not a date'],
    ])('returns null for %s', (_label, input) => {
        // Null, not an Invalid Date: an absent timestamp should render as
        // absent, which is what the caller does with null.
        expect(parseTimestamp(input)).toBeNull();
    });

    test('zero is not mistaken for absent', () => {
        // A falsy number. The previous code used a truthiness guard, which
        // would have dropped this.
        expect(parseTimestamp(0)?.toISOString()).toBe('1970-01-01T00:00:00.000Z');
    });
});
