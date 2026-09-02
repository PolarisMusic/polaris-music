/**
 * The shared event-type table.
 *
 * There were four partial copies of this mapping — two of them missing
 * MINT_ENTITY and RESOLVE_ID, which is why those rows appeared in the curation
 * feed labelled "TYPE 22". The duplication is the bug; these tests pin the
 * single table and the normalizer that lets callers stop caring which of the
 * two representations of a type they were handed.
 */

import { describe, test, expect } from '@jest/globals';
import {
    EVENT_TYPES, TYPE_CODE_TO_EVENT_TYPE, toTypeCode, isContentType,
    MIN_CONTENT_TYPE, MAX_CONTENT_TYPE,
} from '../../src/constants/eventTypes.js';

describe('the table', () => {
    test('round-trips every type through both directions', () => {
        for (const [name, code] of Object.entries(EVENT_TYPES)) {
            expect(TYPE_CODE_TO_EVENT_TYPE[code]).toBe(name);
        }
    });

    test('includes the two types that were missing from the UI copies', () => {
        expect(EVENT_TYPES.MINT_ENTITY).toBe(22);
        expect(EVENT_TYPES.RESOLVE_ID).toBe(23);
    });

    test('codes are unique', () => {
        // A collision would make the reverse lookup silently lose a type.
        const codes = Object.values(EVENT_TYPES);
        expect(new Set(codes).size).toBe(codes.length);
    });

    test('is frozen', () => {
        // Shared mutable state read by ingestion, the processor and the API.
        expect(Object.isFrozen(EVENT_TYPES)).toBe(true);
    });
});

describe('toTypeCode', () => {
    test('resolves a type name, which is how stored events carry it', () => {
        // The case the detail route was getting wrong.
        expect(toTypeCode('CREATE_RELEASE_BUNDLE')).toBe(21);
    });

    test('passes a numeric code through, which is how the anchor carries it', () => {
        expect(toTypeCode(21)).toBe(21);
    });

    test('resolves a numeric string, which is how JSON sometimes carries it', () => {
        expect(toTypeCode('21')).toBe(21);
    });

    test.each([
        ['an unknown name', 'NOT_A_TYPE'],
        ['null', null],
        ['undefined', undefined],
        ['an empty string', ''],
        ['NaN', NaN],
    ])('returns null for %s rather than a plausible wrong code', (_label, input) => {
        expect(toTypeCode(input)).toBeNull();
    });

    test('lowercase names do not resolve', () => {
        // Names are the contract's, and they are uppercase. Accepting anything
        // else would be inventing a convention no writer follows.
        expect(toTypeCode('create_release_bundle')).toBeNull();
    });
});

describe('isContentType', () => {
    test.each([
        ['a release bundle', 'CREATE_RELEASE_BUNDLE', true],
        ['mint entity', 'MINT_ENTITY', true],
        ['an edit claim', 'EDIT_CLAIM', true],
        ['a vote', 'VOTE', false],
        ['a like', 'LIKE', false],
        ['a finalize', 'FINALIZE', false],
        ['a merge', 'MERGE_ENTITY', false],
    ])('%s', (_label, name, expected) => {
        expect(isContentType(name)).toBe(expected);
        expect(isContentType(EVENT_TYPES[name])).toBe(expected);
    });

    test.each([
        ['the bottom of the range', MIN_CONTENT_TYPE, true],
        ['the top of the range', MAX_CONTENT_TYPE, true],
        ['just below', MIN_CONTENT_TYPE - 1, false],
        ['just above', MAX_CONTENT_TYPE + 1, false],
    ])('%s', (_label, code, expected) => {
        expect(isContentType(code)).toBe(expected);
    });

    test('an unresolvable type is not a content type', () => {
        expect(isContentType('NOT_A_TYPE')).toBe(false);
        expect(isContentType(null)).toBe(false);
    });
});
