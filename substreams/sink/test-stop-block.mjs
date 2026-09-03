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

/** Every value following a repeated flag, in order. */
function valuesOf(args, flag) {
    return args.reduce((acc, a, i) => (a === flag ? [...acc, args[i + 1]] : acc), []);
}

/** The params entry for one module, or undefined. */
function paramsFor(args, moduleName) {
    return valuesOf(args, '--params').find(v => v.startsWith(`${moduleName}=`));
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

// filtered_actions applies the query from ITS OWN params. Params are per-module,
// so passing only map_anchored_events' leaves the provider-side filter unset and
// every block is streamed — measurably 3.8 MiB per empty 10,000-block window,
// which is what this whole change exists to stop. Nothing errors in that state;
// the data just arrives the expensive way, so it needs pinning here.
check('passes a query to the filtered_actions module it consumes',
    paramsFor(buildSubstreamsArgs({ ...base, substreamsParams: 'map_anchored_events=code:polarismusic' }),
        'antelope:filtered_actions'),
    'antelope:filtered_actions=code:polarismusic');

check('the filter query matches the module query exactly',
    (() => {
        const a = buildSubstreamsArgs({ ...base, substreamsParams: 'map_anchored_events=code:polarismusic' });
        // Optional-chained: when the filter params are missing entirely this
        // must report a failure, not throw and abort the rest of the suite.
        return paramsFor(a, 'antelope:filtered_actions')?.split('=')[1]
            === paramsFor(a, 'map_anchored_events')?.split('=')[1];
    })(), true);

check('quote stripping applies to the filter query too',
    paramsFor(buildSubstreamsArgs({ ...base, substreamsParams: 'map_anchored_events="code:polarismusic"' }),
        'antelope:filtered_actions'),
    'antelope:filtered_actions=code:polarismusic');

check('a bare account name still reaches the filter as a query',
    paramsFor(buildSubstreamsArgs({ ...base, substreamsParams: 'polarismusic' }),
        'antelope:filtered_actions'),
    'antelope:filtered_actions=polarismusic');

// The Pinax-module fallback targets filtered_actions directly and carries its
// own query, so a second one would be redundant at best.
check('no filter params are added for the Pinax fallback module',
    paramsFor(buildSubstreamsArgs({
        ...base,
        substreamsModule: 'filtered_actions',
        substreamsParams: 'filtered_actions=code:polarismusic && action:put',
    }), 'antelope:filtered_actions'),
    undefined);

// Production mode is what actually enables index-based block skipping; without
// it the provider streams every block regardless of any filter, which is how
// three separate filtering changes produced no measurable saving.
check('requests production mode by default',
    buildSubstreamsArgs(base).includes('--production-mode'), true);

check('SUBSTREAMS_DEV_MODE=true opts out',
    (() => {
        process.env.SUBSTREAMS_DEV_MODE = 'true';
        const has = buildSubstreamsArgs(base).includes('--production-mode');
        delete process.env.SUBSTREAMS_DEV_MODE;
        return has;
    })(), false);

check('any other value of SUBSTREAMS_DEV_MODE keeps production mode',
    (() => {
        process.env.SUBSTREAMS_DEV_MODE = 'false';
        const has = buildSubstreamsArgs(base).includes('--production-mode');
        delete process.env.SUBSTREAMS_DEV_MODE;
        return has;
    })(), true);

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
