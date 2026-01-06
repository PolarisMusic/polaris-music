#!/usr/bin/env node
/**
 * @fileoverview Test script for normalizeModuleParams helper
 *
 * Tests that the function correctly strips wrapping quotes from module params
 * to prevent them from being passed literally via spawn() argv.
 *
 * Usage: node test-normalize-params.mjs
 */

/**
 * Normalize module-keyed params by stripping wrapping quotes from value
 * (Copied from http-sink.mjs for testing)
 */
function normalizeModuleParams(params) {
    const eqIndex = params.indexOf('=');
    if (eqIndex === -1) {
        return params;
    }

    const moduleName = params.slice(0, eqIndex);
    let value = params.slice(eqIndex + 1);

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
    }

    return `${moduleName}=${value}`;
}

// Test cases
const testCases = [
    // Double quotes (should be stripped)
    {
        input: 'filtered_actions="code:polaris && action:put"',
        expected: 'filtered_actions=code:polaris && action:put',
        description: 'Strip double quotes from value'
    },

    // Single quotes (should be stripped)
    {
        input: "filtered_actions='code:polaris && action:put'",
        expected: 'filtered_actions=code:polaris && action:put',
        description: 'Strip single quotes from value'
    },

    // No quotes (should stay the same)
    {
        input: 'filtered_actions=code:polaris && action:put',
        expected: 'filtered_actions=code:polaris && action:put',
        description: 'No quotes - leave unchanged'
    },

    // Simple value with quotes
    {
        input: 'map_anchored_events="polaris"',
        expected: 'map_anchored_events=polaris',
        description: 'Strip quotes from simple value'
    },

    // Simple value without quotes
    {
        input: 'map_anchored_events=polaris',
        expected: 'map_anchored_events=polaris',
        description: 'Simple value without quotes'
    },

    // No equals sign (legacy format, should return as-is)
    {
        input: 'code:polaris && action:put',
        expected: 'code:polaris && action:put',
        description: 'Legacy format without module name'
    },

    // Mismatched quotes (only strip if both match)
    {
        input: 'module="value\'',
        expected: 'module="value\'',
        description: 'Mismatched quotes - leave unchanged'
    },

    // Empty value with quotes
    {
        input: 'module=""',
        expected: 'module=',
        description: 'Empty value with quotes'
    },

    // Value with internal quotes (should only strip outer)
    {
        input: 'module="code:\\"polaris\\""',
        expected: 'module=code:\\"polaris\\"',
        description: 'Strip only outer quotes, keep internal escaped quotes'
    },
];

console.log('Testing normalizeModuleParams()');
console.log('================================\n');

let passed = 0;
let failed = 0;

for (const testCase of testCases) {
    try {
        const result = normalizeModuleParams(testCase.input);
        const success = result === testCase.expected;

        if (success) {
            console.log(`✓ ${testCase.description}`);
            console.log(`  Input:    ${testCase.input}`);
            console.log(`  Output:   ${result}\n`);
            passed++;
        } else {
            console.log(`✗ ${testCase.description}`);
            console.log(`  Input:    ${testCase.input}`);
            console.log(`  Expected: ${testCase.expected}`);
            console.log(`  Got:      ${result}\n`);
            failed++;
        }
    } catch (error) {
        console.log(`✗ ${testCase.description} - THREW ERROR`);
        console.log(`  Input: ${testCase.input}`);
        console.log(`  Error: ${error.message}\n`);
        failed++;
    }
}

console.log('================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('');

if (failed > 0) {
    console.log('❌ Tests failed!');
    process.exit(1);
} else {
    console.log('✅ All tests passed!');
    console.log('');
    console.log('The normalizeModuleParams() function correctly:');
    console.log('  - Strips wrapping double quotes from param values');
    console.log('  - Strips wrapping single quotes from param values');
    console.log('  - Leaves unquoted values unchanged');
    console.log('  - Preserves legacy format (no module name)');
    console.log('  - Only strips matching outer quotes');
    process.exit(0);
}
