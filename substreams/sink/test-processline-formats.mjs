#!/usr/bin/env node
/**
 * @fileoverview Test script for processLine() format compatibility
 *
 * Tests that processLine() correctly handles both:
 * 1. Wrapped format: { "@module": "...", "@type": "...", "@data": { ... } }
 * 2. Plain format: { "events": [...] } or { "actionTraces": [...] }
 *
 * This prevents silent ingestion failure when --plain-output strips wrapper keys.
 *
 * Usage: node test-processline-formats.mjs
 */

import { isLikelyJsonLine } from './lines.mjs';

// Track which processor functions were called
let processAnchoredEventsCalls = [];
let processActionTracesCalls = [];

// Mock processor functions
async function processAnchoredEventsOutput(data) {
    processAnchoredEventsCalls.push(data);
}

async function processActionTracesOutput(data) {
    processActionTracesCalls.push(data);
}

// Mock config
const config = {
    substreamsModule: 'filtered_actions'
};

/**
 * Process Substreams output line by line.
 *
 * The format-dispatch body below mirrors http-sink.mjs. The error branch does
 * NOT: it calls the real isLikelyJsonLine() from lines.mjs, so the rule that
 * decides what counts as a failure cannot drift away from the shipped code.
 *
 * @param {string} line - JSON line from Substreams output
 */
async function processLine(line) {
    try {
        const data = JSON.parse(line);

        // Support two output formats to prevent silent ingestion failure:
        // 1. Wrapped: { "@module": "...", "@type": "...", "@data": { ... } }
        // 2. Plain: { "events": [...] } or { "actionTraces": [...] } (from --plain-output)

        let dataPayload;
        let moduleName;
        let typeName;

        if (data['@data']) {
            // Wrapped format (standard Substreams output)
            dataPayload = data['@data'];
            moduleName = data['@module'];
            typeName = data['@type'];
        } else if (data.events || data.actionTraces) {
            // Plain format - treat object itself as payload
            // This happens when --plain-output strips wrapper keys
            dataPayload = data;
            // Infer module/type from payload structure
            if (data.events) {
                moduleName = 'map_anchored_events';
                typeName = 'polaris.v1.AnchoredEvents';
            } else if (data.actionTraces) {
                moduleName = 'filtered_actions';
                typeName = 'sf.antelope.type.v1.ActionTraces';
            }
        } else {
            // Neither wrapped nor recognized plain format - skip
            return;
        }

        // Detect output format by type or module name or payload structure
        const isAnchoredEvents =
            typeName === 'polaris.v1.AnchoredEvents' ||
            moduleName === 'map_anchored_events' ||
            dataPayload.events;

        if (isAnchoredEvents) {
            // Format: { "events": [...] }
            await processAnchoredEventsOutput(dataPayload);
        } else if (moduleName === config.substreamsModule || dataPayload.actionTraces) {
            // Format: { "actionTraces": [...] }
            await processActionTracesOutput(dataPayload);
        }
    } catch (error) {
        if (isLikelyJsonLine(line)) {
            reportedErrors.push(line);
        }
    }
}

// Lines the error branch decided were genuine failures.
let reportedErrors = [];

// Test cases
const testCases = [
    // Wrapped AnchoredEvents format
    {
        description: 'Wrapped AnchoredEvents format (standard output)',
        input: JSON.stringify({
            "@module": "map_anchored_events",
            "@type": "polaris.v1.AnchoredEvents",
            "@data": {
                "events": [
                    { "content_hash": "abc123", "payload": "..." }
                ]
            }
        }),
        expectedProcessor: 'anchored',
        expectedPayload: {
            "events": [
                { "content_hash": "abc123", "payload": "..." }
            ]
        }
    },

    // Plain AnchoredEvents format
    {
        description: 'Plain AnchoredEvents format (with --plain-output)',
        input: JSON.stringify({
            "events": [
                { "content_hash": "def456", "payload": "..." }
            ]
        }),
        expectedProcessor: 'anchored',
        expectedPayload: {
            "events": [
                { "content_hash": "def456", "payload": "..." }
            ]
        }
    },

    // Wrapped ActionTraces format
    {
        description: 'Wrapped ActionTraces format (standard output)',
        input: JSON.stringify({
            "@module": "filtered_actions",
            "@type": "sf.antelope.type.v1.ActionTraces",
            "@data": {
                "actionTraces": [
                    { "action": { "name": "put" } }
                ]
            }
        }),
        expectedProcessor: 'action',
        expectedPayload: {
            "actionTraces": [
                { "action": { "name": "put" } }
            ]
        }
    },

    // Plain ActionTraces format
    {
        description: 'Plain ActionTraces format (with --plain-output)',
        input: JSON.stringify({
            "actionTraces": [
                { "action": { "name": "vote" } }
            ]
        }),
        expectedProcessor: 'action',
        expectedPayload: {
            "actionTraces": [
                { "action": { "name": "vote" } }
            ]
        }
    },

    // Progress messages (should be ignored)
    {
        description: 'Progress message (should be ignored)',
        input: 'Progress: 50%',
        expectedProcessor: 'none',
        expectedPayload: null
    },

    // Block messages (should be ignored)
    {
        description: 'Block message (should be ignored)',
        input: 'Block: 12345',
        expectedProcessor: 'none',
        expectedPayload: null
    },

    // Unrecognized JSON (should be ignored)
    {
        description: 'Unrecognized JSON format (should be ignored)',
        input: JSON.stringify({ "foo": "bar" }),
        expectedProcessor: 'none',
        expectedPayload: null
    },
];

console.log('Testing processLine() Format Compatibility');
console.log('==========================================\n');

let passed = 0;
let failed = 0;

for (const testCase of testCases) {
    // Reset call tracking
    processAnchoredEventsCalls = [];
    processActionTracesCalls = [];

    try {
        await processLine(testCase.input);

        // Check which processor was called
        const anchoredCalled = processAnchoredEventsCalls.length > 0;
        const actionCalled = processActionTracesCalls.length > 0;

        let actualProcessor = 'none';
        let actualPayload = null;

        if (anchoredCalled) {
            actualProcessor = 'anchored';
            actualPayload = processAnchoredEventsCalls[0];
        } else if (actionCalled) {
            actualProcessor = 'action';
            actualPayload = processActionTracesCalls[0];
        }

        const processorMatches = actualProcessor === testCase.expectedProcessor;
        const payloadMatches = testCase.expectedPayload === null ||
            JSON.stringify(actualPayload) === JSON.stringify(testCase.expectedPayload);

        if (processorMatches && payloadMatches) {
            console.log(`✓ ${testCase.description}`);
            console.log(`  Processor: ${actualProcessor}`);
            if (actualPayload) {
                console.log(`  Payload: ${JSON.stringify(actualPayload).substring(0, 60)}...`);
            }
            console.log('');
            passed++;
        } else {
            console.log(`✗ ${testCase.description}`);
            console.log(`  Expected processor: ${testCase.expectedProcessor}`);
            console.log(`  Actual processor: ${actualProcessor}`);
            if (!payloadMatches) {
                console.log(`  Expected payload: ${JSON.stringify(testCase.expectedPayload)}`);
                console.log(`  Actual payload: ${JSON.stringify(actualPayload)}`);
            }
            console.log('');
            failed++;
        }
    } catch (error) {
        console.log(`✗ ${testCase.description} - THREW ERROR`);
        console.log(`  Input: ${testCase.input.substring(0, 60)}...`);
        console.log(`  Error: ${error.message}\n`);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// Error-branch classification.
//
// Regression cover for a bounded run's `Completed ...` line being announced as
// `Error processing line: Unexpected token 'C'`. CLI chatter must be silent;
// something that was meant to be JSON and failed to parse must stay loud.
// ---------------------------------------------------------------------------

console.log('==========================================');
console.log('Error-branch classification');
console.log('');

const classificationCases = [
    { line: 'Completed 283274672 - 283275859', report: false, why: 'bounded-run completion is not a failure' },
    { line: 'Progress: 1187 blocks', report: false, why: 'progress chatter' },
    { line: 'Block: 283275172', report: false, why: 'block marker' },
    { line: '', report: false, why: 'blank line' },
    { line: '   ', report: false, why: 'whitespace only' },
    { line: 'Found substreams version v1.21.0', report: false, why: 'CLI banner' },
    { line: '{ "events": [ ', report: true, why: 'truncated JSON object is a real failure' },
    { line: '{ not json }', report: true, why: 'malformed JSON object is a real failure' },
    { line: '[ 1, 2', report: true, why: 'truncated JSON array is a real failure' },
    { line: '  {"broken": ', report: true, why: 'leading whitespace still counts as JSON' },
];

for (const c of classificationCases) {
    reportedErrors = [];
    await processLine(c.line);
    const reported = reportedErrors.length > 0;
    if (reported === c.report) {
        console.log(`✓ ${c.report ? 'reports' : 'ignores'}: ${JSON.stringify(c.line)} — ${c.why}`);
        passed++;
    } else {
        console.log(`✗ ${JSON.stringify(c.line)} — expected ${c.report ? 'reported' : 'ignored'}, got ${reported ? 'reported' : 'ignored'}`);
        failed++;
    }
}

console.log('');
console.log('==========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('');

if (failed > 0) {
    console.log('❌ Tests failed!');
    process.exit(1);
} else {
    console.log('✅ All tests passed!');
    console.log('');
    console.log('Summary:');
    console.log('- Wrapped AnchoredEvents format: ✓');
    console.log('- Plain AnchoredEvents format: ✓');
    console.log('- Wrapped ActionTraces format: ✓');
    console.log('- Plain ActionTraces format: ✓');
    console.log('- Progress/Block messages ignored: ✓');
    console.log('- Unrecognized JSON ignored: ✓');
    console.log('- CLI chatter (Completed/Progress/Block) not reported as errors: ✓');
    console.log('- Malformed JSON still reported: ✓');
    console.log('');
    console.log('processLine() will NOT silently drop events when --plain-output is used.');
    process.exit(0);
}
