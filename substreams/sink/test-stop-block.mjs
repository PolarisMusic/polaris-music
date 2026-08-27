#!/usr/bin/env node
/**
 * @fileoverview Tests for buildSubstreamsArgs — start/stop block handling.
 *
 * Regression cover for the sink being unable to replay history: `--stop-block`
 * used to be hardcoded to '0' ("follow head"), which made every request span
 * START_BLOCK → current head. A start block further behind head than the
 * provider's limit-processed-blocks cap was therefore refused outright, and the
 * sink crash-looped for days without ingesting anything.
 *
 * These import the real builder rather than copying it, so the assertions
 * cannot drift away from the code that actually runs.
 *
 * Usage: node test-stop-block.mjs
 */

import { buildSubstreamsArgs } from './args.mjs';

const base = {
    substreamsEndpoint: 'jungle4.substreams.pinax.network:443',
    substreamsPackage: '/app/substreams/polaris_music_substreams.spkg',
    substreamsModule: 'map_anchored_events',
    substreamsParams: 'map_anchored_events=polarismusic',
    startBlock: '283274672',
};

let failures = 0;

function check(name, actual, expected) {
    const ok = actual === expected;
    console.log(`${ok ? '✅' : '❌'} ${name}`);
    if (!ok) {
        console.log(`   expected: ${JSON.stringify(expected)}`);
        console.log(`   actual:   ${JSON.stringify(actual)}`);
        failures++;
    }
}

/** Value that follows a flag in the argv array. */
function valueOf(args, flag) {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
}

console.log('buildSubstreamsArgs — stop block\n');

// Default: unchanged live-streaming behaviour.
check('defaults to 0 (follow head) when stopBlock is absent',
    valueOf(buildSubstreamsArgs(base), '--stop-block'), '0');

check('defaults to 0 when stopBlock is explicitly undefined',
    valueOf(buildSubstreamsArgs({ ...base, stopBlock: undefined }), '--stop-block'), '0');

// The whole point: a bounded range must reach the CLI.
check('passes an absolute stop block through',
    valueOf(buildSubstreamsArgs({ ...base, stopBlock: '283275672' }), '--stop-block'), '283275672');

check('passes the relative +N form through untouched',
    valueOf(buildSubstreamsArgs({ ...base, stopBlock: '+1000' }), '--stop-block'), '+1000');

check('coerces a numeric stop block to a string for spawn()',
    valueOf(buildSubstreamsArgs({ ...base, stopBlock: 283275672 }), '--stop-block'), '283275672');

// Start block is independent of the above.
check('passes the start block through',
    valueOf(buildSubstreamsArgs(base), '--start-block'), '283274672');

check('supports a relative start block',
    valueOf(buildSubstreamsArgs({ ...base, startBlock: '-10000' }), '--start-block'), '-10000');

// Params handling must survive the extraction into args.mjs.
check('normalizes module-keyed params',
    valueOf(buildSubstreamsArgs({ ...base, substreamsParams: 'map_anchored_events="polarismusic"' }), '--params'),
    'map_anchored_events=polarismusic');

check('prefixes the module name when params are not module-keyed',
    valueOf(buildSubstreamsArgs({ ...base, substreamsParams: 'polarismusic' }), '--params'),
    'map_anchored_events=polarismusic');

// Shape of the command itself.
const args = buildSubstreamsArgs(base);
check('invokes `substreams run`', args[0], 'run');
check('requests jsonl output', valueOf(args, '--output'), 'jsonl');
check('targets the configured endpoint', valueOf(args, '-e'), base.substreamsEndpoint);
check('every argv entry is a string',
    args.every(a => typeof a === 'string'), true);

console.log('');
if (failures > 0) {
    console.log(`❌ ${failures} test(s) failed`);
    process.exit(1);
}
console.log('✅ All tests passed!');
console.log('');
console.log('buildSubstreamsArgs correctly:');
console.log('  - follows chain head by default (--stop-block 0)');
console.log('  - bounds the range when STOP_BLOCK is set, so history can be replayed');
console.log('  - passes the relative +N stop form through to the CLI');
console.log('  - keeps module-param normalization intact after extraction');
process.exit(0);
