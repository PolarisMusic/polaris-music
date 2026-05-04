/**
 * Hash determinism harness — Stage A of the implementation plan.
 *
 * Compares the frontend's hand-rolled `HashGenerator.canonicalize`
 * (frontend/src/utils/hashGenerator.js) against the backend's
 * `fast-json-stable-stringify`. Every event currently anchored on-chain
 * was canonicalized by the frontend, so before unifying the two we must
 * know exactly which inputs produce different bytes.
 *
 * This test is INTENDED to surface divergences. Cases where the two
 * implementations agree are asserted with .toBe; cases where they
 * diverge are pinned with .not.toBe so a future change that converges
 * them will trip the test and force a deliberate decision.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as pathResolve } from 'path';
import stringify from 'fast-json-stable-stringify';
import { canonicalize } from './__fixtures__/frontendCanonicalize.js';

const canon = (x) => canonicalize(x);
const stable = (x) => stringify(x);

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Drift guard: assert that the mirrored canonicalize() in
 * __fixtures__/frontendCanonicalize.js still matches the live
 * frontend implementation. We compare the function bodies after
 * stripping comments and whitespace so cosmetic edits don't trip us,
 * but any logic change will.
 */
function normalizeBody(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractCanonicalizeBody(src) {
    // Match either `static canonicalize(obj) { ... }` (frontend class)
    // or `export function canonicalize(obj) { ... }` (fixture).
    // Capture the brace-balanced body.
    const startRe = /(?:static\s+canonicalize|function\s+canonicalize)\s*\(\s*obj\s*\)\s*\{/;
    const m = startRe.exec(src);
    if (!m) throw new Error('canonicalize function not found in source');
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    return src.slice(m.index + m[0].length, i - 1);
}

describe('Hash determinism: frontend canonicalize vs fast-json-stable-stringify', () => {
    describe('drift guard', () => {
        test('fixture mirror matches live frontend canonicalize source', () => {
            const frontendSrc = readFileSync(
                pathResolve(__dirname, '../../../frontend/src/utils/hashGenerator.js'),
                'utf8'
            );
            const fixtureSrc = readFileSync(
                pathResolve(__dirname, '__fixtures__/frontendCanonicalize.js'),
                'utf8'
            );
            const liveBody = normalizeBody(extractCanonicalizeBody(frontendSrc));
            // The frontend uses `this.canonicalize(...)`; the fixture uses
            // `canonicalize(...)`. Normalize that one difference before compare.
            const fixtureBody = normalizeBody(extractCanonicalizeBody(fixtureSrc))
                .replace(/\bcanonicalize\(/g, 'this.canonicalize(');
            expect(fixtureBody).toBe(liveBody);
        });
    });

    describe('agreeing fixtures (must stay equal)', () => {
        const cases = [
            ['empty object', {}],
            ['empty array', []],
            ['simple object', { a: 1, b: 2 }],
            ['reverse-keyed object', { b: 2, a: 1 }],
            ['nested object', { outer: { inner: { leaf: 'v' } } }],
            ['array of primitives', [1, 'two', true, null]],
            ['array of objects with mixed key order', [{ b: 2, a: 1 }, { d: 4, c: 3 }]],
            ['null literal', null],
            ['true literal', true],
            ['false literal', false],
            ['number zero', 0],
            ['negative zero', -0],
            ['large integer (within safe range)', 9007199254740991],
            ['float', 3.14159],
            ['negative float', -2.5],
            ['empty string', ''],
            ['ascii string', 'hello world'],
            ['emoji string', '🎵🎶'],
            ['RTL string', 'مرحبا'],
            ['cjk string', '音楽'],
            ['string with embedded quotes', 'a "quoted" b'],
            ['string with backslash', 'a\\b'],
            ['string with unicode escape', ''],
            ['key with unicode', { '日本語': 1 }],
            ['key with quote', { 'a"b': 1 }],
            ['deeply nested', { a: { b: { c: { d: { e: 1 } } } } }],
            ['mixed scalars', { s: 'x', n: 1, b: true, z: null }],
            ['array of empties', [{}, [], null, '']],
            // Hash-collision regression case (see smoke.test.js):
            ['differing nested data 1', { a: 1, b: { c: 2 } }],
            ['differing nested data 2', { a: 1, b: { c: 3 } }],
            // Realistic event payload shape:
            ['release-bundle-shaped event', {
                type: 21,
                actor: 'alice',
                timestamp: '2026-05-04T00:00:00.000Z',
                payload: {
                    release: { title: 'Abbey Road', year: 1969 },
                    groups: [{ name: 'The Beatles', members: ['John', 'Paul', 'George', 'Ringo'] }],
                    tracks: [
                        { title: 'Come Together', position: 1 },
                        { title: 'Something', position: 2 },
                    ],
                },
            }],
        ];

        for (const [name, input] of cases) {
            test(`agree: ${name}`, () => {
                expect(canon(input)).toBe(stable(input));
            });
        }
    });

    describe('non-finite numbers', () => {
        // JSON.stringify(NaN) === 'null', stable-stringify also returns 'null'.
        test('NaN as scalar', () => {
            expect(canon(NaN)).toBe(stable(NaN));
        });
        test('Infinity as scalar', () => {
            expect(canon(Infinity)).toBe(stable(Infinity));
        });
        test('NaN inside object', () => {
            expect(canon({ x: NaN })).toBe(stable({ x: NaN }));
        });
    });

    describe('known divergence: undefined values', () => {
        // The frontend canonicalize falls through to `JSON.stringify(undefined)`
        // (which returns the JS value `undefined`, not a string), then string-
        // concatenates it. stable-stringify omits the key/element entirely.
        // These are pinned so a future converging change is deliberate.
        test('undefined as scalar diverges', () => {
            const a = canon(undefined);
            const b = stable(undefined);
            // Frontend yields the JS value `undefined`; stable-stringify also
            // returns undefined for top-level undefined input. Both are
            // "no string", so they happen to be loosely equal at the top level.
            expect(a).toBe(b);
        });

        test('undefined as object value diverges', () => {
            const input = { a: 1, b: undefined };
            const frontendOut = canon(input);
            const stableOut = stable(input);
            // Frontend: '{"a":1,"b":undefined}' (literal "undefined" via concat)
            // Stable:   '{"a":1}' (key elided)
            expect(frontendOut).not.toBe(stableOut);
            expect(stableOut).toBe('{"a":1}');
            expect(frontendOut).toBe('{"a":1,"b":undefined}');
        });

        test('undefined as array element diverges', () => {
            const input = [1, undefined, 3];
            const frontendOut = canon(input);
            const stableOut = stable(input);
            // Frontend: canonicalize(undefined) returns the JS value
            // `undefined`; .map(...).join(',') then coerces undefined to
            // empty, yielding '[1,,3]'. This string is NOT round-trippable
            // through JSON.parse — a meaningful divergence.
            // Stable: '[1,null,3]' (per JSON.stringify behaviour for arrays).
            expect(frontendOut).not.toBe(stableOut);
            expect(stableOut).toBe('[1,null,3]');
            expect(frontendOut).toBe('[1,,3]');
        });

        test('missing key vs explicit-undefined-key', () => {
            // Both implementations produce identical output for the object
            // that lacks the key entirely.
            const missing = { a: 1 };
            const explicitUndef = { a: 1, b: undefined };
            // Stable-stringify treats them as equivalent, frontend does not.
            expect(stable(missing)).toBe(stable(explicitUndef));
            expect(canon(missing)).not.toBe(canon(explicitUndef));
        });
    });

    describe('known divergence: toJSON-bearing objects', () => {
        // stable-stringify calls .toJSON() if present (matches JSON.stringify);
        // the frontend canonicalize does not — it iterates own enumerable
        // keys via Object.keys, so a Date becomes "{}".
        test('Date diverges', () => {
            const d = new Date('2026-05-04T00:00:00.000Z');
            const frontendOut = canon(d);
            const stableOut = stable(d);
            expect(frontendOut).not.toBe(stableOut);
            expect(frontendOut).toBe('{}');
            expect(stableOut).toBe('"2026-05-04T00:00:00.000Z"');
        });

        test('plain object with custom toJSON diverges', () => {
            const obj = { toJSON: () => ({ wrapped: true }) };
            const frontendOut = canon(obj);
            const stableOut = stable(obj);
            expect(frontendOut).not.toBe(stableOut);
            expect(stableOut).toBe('{"wrapped":true}');
        });
    });

    describe('BigInt handling', () => {
        // JSON.stringify throws on BigInt. The frontend goes through
        // JSON.stringify, so it throws too. stable-stringify takes the
        // typeof !== 'object' branch and calls JSON.stringify, also throwing.
        test('BigInt scalar throws in both', () => {
            expect(() => canon(10n)).toThrow();
            expect(() => stable(10n)).toThrow();
        });
    });

    describe('round-trip via SHA256 (the actual on-chain anchor)', () => {
        // The canonicalized string is what gets SHA256'd. For every fixture
        // that is bit-identical between the two canonicalizers, the resulting
        // hash is also bit-identical. We assert this directly for one
        // representative event so a regression in either implementation
        // surfaces here too.
        test('release-bundle event hash matches between implementations', () => {
            const event = {
                type: 21,
                actor: 'alice',
                timestamp: '2026-05-04T00:00:00.000Z',
                payload: { release: { title: 'Abbey Road', year: 1969 } },
            };
            // Use the same SHA256 implementation in both branches so we are
            // measuring canonicalization, not hashing.
            const h = (s) => createHash('sha256').update(s).digest('hex');
            expect(h(canon(event))).toBe(h(stable(event)));
        });
    });
});
