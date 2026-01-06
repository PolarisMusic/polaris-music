#!/usr/bin/env node
/**
 * @fileoverview Test script for safe hash helpers
 *
 * Tests that normalizeHashString() and safeHashPreview() handle all input types
 * without throwing errors.
 *
 * Usage: node test-hash-helpers.mjs
 */

// Copy the helper functions from http-sink.mjs for testing
/**
 * Normalize hash value to string (defensive)
 * Handles: string, byte array, object with hex field, null, undefined
 *
 * @param {string|Array|Object|null|undefined} value - Hash in various formats
 * @returns {string|null} Normalized hash string or null if invalid
 */
function normalizeHashString(value) {
    if (!value) {
        return null;
    }

    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value)) {
        // Byte array
        try {
            return Buffer.from(value).toString('hex');
        } catch (error) {
            return null;
        }
    }

    if (typeof value === 'object' && value.hex) {
        return typeof value.hex === 'string' ? value.hex : null;
    }

    return null;
}

/**
 * Safe hash preview for logging (never throws)
 * Returns a truncated preview or placeholder for missing hashes
 *
 * @param {string|Array|Object|null|undefined} value - Hash in various formats
 * @param {number} n - Number of characters to show (default: 8)
 * @returns {string} Preview string like "abcd1234..." or "<no-hash>"
 */
function safeHashPreview(value, n = 8) {
    const normalized = normalizeHashString(value);

    if (!normalized) {
        return '<no-hash>';
    }

    if (normalized.length <= n) {
        return normalized;
    }

    return normalized.substring(0, n) + '...';
}

// Test cases
const testCases = [
    // String inputs
    { input: 'abcdef1234567890', expected: 'abcdef12...', description: 'Normal hex string' },
    { input: 'abc', expected: 'abc', description: 'Short string (no truncation)' },
    { input: '', expected: '<no-hash>', description: 'Empty string' },

    // Null/undefined
    { input: null, expected: '<no-hash>', description: 'Null value' },
    { input: undefined, expected: '<no-hash>', description: 'Undefined value' },

    // Byte arrays (typical Substreams output)
    { input: [0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78, 0x90], expected: 'abcdef12...', description: 'Byte array' },
    { input: [], expected: '<no-hash>', description: 'Empty byte array' },

    // Object with hex field (checksum256 format)
    { input: { hex: 'deadbeef12345678' }, expected: 'deadbeef...', description: 'Object with hex field' },
    { input: { hex: 123 }, expected: '<no-hash>', description: 'Object with non-string hex field' },
    { input: {}, expected: '<no-hash>', description: 'Empty object' },

    // Edge cases
    { input: 0, expected: '<no-hash>', description: 'Number zero' },
    { input: 123, expected: '<no-hash>', description: 'Number' },
    { input: false, expected: '<no-hash>', description: 'Boolean false' },
    { input: true, expected: '<no-hash>', description: 'Boolean true' },
    { input: { foo: 'bar' }, expected: '<no-hash>', description: 'Object without hex field' },
];

console.log('Testing Safe Hash Helpers');
console.log('=========================\n');

let passed = 0;
let failed = 0;

for (const testCase of testCases) {
    try {
        const result = safeHashPreview(testCase.input, 8);
        const success = result === testCase.expected;

        if (success) {
            console.log(`✓ ${testCase.description}`);
            console.log(`  Input: ${JSON.stringify(testCase.input)}`);
            console.log(`  Output: ${result}\n`);
            passed++;
        } else {
            console.log(`✗ ${testCase.description}`);
            console.log(`  Input: ${JSON.stringify(testCase.input)}`);
            console.log(`  Expected: ${testCase.expected}`);
            console.log(`  Got: ${result}\n`);
            failed++;
        }
    } catch (error) {
        console.log(`✗ ${testCase.description} - THREW ERROR`);
        console.log(`  Input: ${JSON.stringify(testCase.input)}`);
        console.log(`  Error: ${error.message}\n`);
        failed++;
    }
}

console.log('=========================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('');

if (failed > 0) {
    console.log('❌ Tests failed!');
    process.exit(1);
} else {
    console.log('✅ All tests passed!');
    process.exit(0);
}
