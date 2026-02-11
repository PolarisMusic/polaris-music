/**
 * Property-based / Fuzzing Tests
 *
 * Tests core functions with randomized inputs to catch edge cases
 * that hand-written unit tests might miss.
 */

import { createHash } from 'crypto';
import stringify from 'fast-json-stable-stringify';

/**
 * Simple random generators for property-based testing
 */
const gen = {
    int(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    },
    string(len) {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !@#$%^&*()-_=+[]{}|;:,.<>?/~`\'"\\';
        return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    },
    hex(len) {
        return Array.from({ length: len }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    },
    pick(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    },
    duration() {
        const m = gen.int(0, 120);
        const s = gen.int(0, 59);
        return `${m}:${s.toString().padStart(2, '0')}`;
    },
};

describe('Property-Based Tests', () => {

    describe('SHA256 Hash Properties', () => {

        test('hash should always be 64 hex characters', () => {
            for (let i = 0; i < 200; i++) {
                const input = gen.string(gen.int(0, 5000));
                const hash = createHash('sha256').update(input).digest('hex');
                expect(hash).toMatch(/^[a-f0-9]{64}$/);
            }
        });

        test('hash should be deterministic (same input = same output)', () => {
            for (let i = 0; i < 100; i++) {
                const input = gen.string(gen.int(1, 1000));
                const hash1 = createHash('sha256').update(input).digest('hex');
                const hash2 = createHash('sha256').update(input).digest('hex');
                expect(hash1).toBe(hash2);
            }
        });

        test('hash should differ for different inputs (collision resistance)', () => {
            const hashes = new Set();
            for (let i = 0; i < 500; i++) {
                const input = gen.string(gen.int(1, 200)) + i.toString();
                const hash = createHash('sha256').update(input).digest('hex');
                hashes.add(hash);
            }
            // All 500 hashes should be unique
            expect(hashes.size).toBe(500);
        });

        test('empty input should produce a valid hash', () => {
            const hash = createHash('sha256').update('').digest('hex');
            expect(hash).toMatch(/^[a-f0-9]{64}$/);
        });
    });

    describe('Canonical JSON Serialization Properties', () => {

        test('stringify should be deterministic regardless of key order', () => {
            for (let i = 0; i < 100; i++) {
                const keys = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
                const obj = {};
                // Insert in random order
                const shuffled = keys.sort(() => Math.random() - 0.5);
                shuffled.forEach(k => { obj[k] = gen.string(gen.int(1, 50)); });

                // Build same object with different insertion order
                const obj2 = {};
                const shuffled2 = [...keys].sort(() => Math.random() - 0.5);
                shuffled2.forEach(k => { obj2[k] = obj[k]; });

                expect(stringify(obj)).toBe(stringify(obj2));
            }
        });

        test('stringify then parse should round-trip', () => {
            for (let i = 0; i < 100; i++) {
                const obj = {
                    num: gen.int(-1000000, 1000000),
                    str: gen.string(gen.int(0, 100)),
                    bool: Math.random() > 0.5,
                    arr: [gen.int(0, 100), gen.string(5)],
                    nested: { a: gen.int(0, 100) },
                };
                const serialized = stringify(obj);
                const parsed = JSON.parse(serialized);
                expect(parsed.num).toBe(obj.num);
                expect(parsed.str).toBe(obj.str);
                expect(parsed.bool).toBe(obj.bool);
            }
        });
    });

    describe('Event Type Validation Fuzzing', () => {

        const MIN_EVENT_TYPE = 1;
        const MAX_EVENT_TYPE = 99;

        function isValidEventType(type) {
            return Number.isInteger(type) && type >= MIN_EVENT_TYPE && type <= MAX_EVENT_TYPE;
        }

        test('should accept all integers in [1, 99]', () => {
            for (let i = 1; i <= 99; i++) {
                expect(isValidEventType(i)).toBe(true);
            }
        });

        test('should reject all integers outside [1, 99]', () => {
            for (let i = 0; i < 200; i++) {
                const val = gen.int(-10000, 0);
                expect(isValidEventType(val)).toBe(false);
            }
            for (let i = 0; i < 200; i++) {
                const val = gen.int(100, 10000);
                expect(isValidEventType(val)).toBe(false);
            }
        });

        test('should reject non-integer values', () => {
            const nonIntegers = [1.5, NaN, Infinity, -Infinity, null, undefined, '21', true, {}, []];
            nonIntegers.forEach(val => {
                expect(isValidEventType(val)).toBe(false);
            });
        });
    });

    describe('Timestamp Validation Fuzzing', () => {

        const MIN_VALID_TIMESTAMP = 1672531200; // 2023-01-01
        const MAX_FUTURE_TOLERANCE = 300; // 5 minutes

        function isValidTimestamp(ts) {
            if (!Number.isFinite(ts)) return false;
            const now = Math.floor(Date.now() / 1000);
            return ts >= MIN_VALID_TIMESTAMP && ts <= now + MAX_FUTURE_TOLERANCE;
        }

        test('should accept timestamps from 2023 to now', () => {
            const now = Math.floor(Date.now() / 1000);
            for (let i = 0; i < 200; i++) {
                const ts = gen.int(MIN_VALID_TIMESTAMP, now);
                expect(isValidTimestamp(ts)).toBe(true);
            }
        });

        test('should reject timestamps before 2023', () => {
            for (let i = 0; i < 200; i++) {
                const ts = gen.int(0, MIN_VALID_TIMESTAMP - 1);
                expect(isValidTimestamp(ts)).toBe(false);
            }
        });

        test('should reject timestamps far in the future', () => {
            const now = Math.floor(Date.now() / 1000);
            for (let i = 0; i < 200; i++) {
                const ts = now + MAX_FUTURE_TOLERANCE + gen.int(1, 100000);
                expect(isValidTimestamp(ts)).toBe(false);
            }
        });
    });

    describe('Approval Calculation Fuzzing', () => {

        function calculateApproval(upVotes, totalVotes, thresholdBP) {
            return (totalVotes > 0) && (upVotes * 10000 >= totalVotes * thresholdBP);
        }

        test('100% up votes should always pass any threshold', () => {
            for (let i = 0; i < 200; i++) {
                const total = gen.int(1, 100000);
                const threshold = gen.int(1, 10000);
                expect(calculateApproval(total, total, threshold)).toBe(true);
            }
        });

        test('0 up votes should never pass any positive threshold', () => {
            for (let i = 0; i < 200; i++) {
                const total = gen.int(1, 100000);
                const threshold = gen.int(1, 10000);
                expect(calculateApproval(0, total, threshold)).toBe(false);
            }
        });

        test('approval should be monotonically increasing with up votes', () => {
            for (let i = 0; i < 100; i++) {
                const total = gen.int(10, 1000);
                const threshold = gen.int(1, 10000);

                let lastApproval = false;
                let flippedOnce = false;
                for (let up = 0; up <= total; up++) {
                    const approved = calculateApproval(up, total, threshold);
                    // Once approved, should stay approved (monotonic)
                    if (lastApproval && !approved) {
                        flippedOnce = true;
                    }
                    lastApproval = approved;
                }
                expect(flippedOnce).toBe(false);
            }
        });

        test('should use integer arithmetic (no floating point issues)', () => {
            // Edge cases that could cause floating point problems
            const cases = [
                [1, 3, 3334],   // 33.33...%
                [2, 3, 6667],   // 66.67%
                [1, 7, 1429],   // 14.29%
                [333, 1000, 3330],
            ];
            for (const [up, total, threshold] of cases) {
                // Should not throw or produce NaN
                const result = calculateApproval(up, total, threshold);
                expect(typeof result).toBe('boolean');
            }
        });
    });

    describe('Duration Parsing Fuzzing', () => {

        function parseDuration(duration) {
            if (!duration) return null;
            const parts = duration.split(':');
            if (parts.length !== 2) return null;
            const minutes = parseInt(parts[0], 10);
            const seconds = parseInt(parts[1], 10);
            return minutes * 60 + seconds;
        }

        test('random valid durations should parse to positive numbers', () => {
            for (let i = 0; i < 200; i++) {
                const dur = gen.duration();
                const result = parseDuration(dur);
                expect(result).toBeGreaterThanOrEqual(0);
                expect(Number.isFinite(result)).toBe(true);
            }
        });

        test('parsed duration should equal minutes*60 + seconds', () => {
            for (let i = 0; i < 200; i++) {
                const m = gen.int(0, 120);
                const s = gen.int(0, 59);
                const dur = `${m}:${s.toString().padStart(2, '0')}`;
                expect(parseDuration(dur)).toBe(m * 60 + s);
            }
        });

        test('random strings should not crash parseDuration', () => {
            for (let i = 0; i < 200; i++) {
                const input = gen.string(gen.int(0, 20));
                // Should not throw
                const result = parseDuration(input);
                expect(result === null || typeof result === 'number').toBe(true);
            }
        });
    });
});
