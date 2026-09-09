#!/usr/bin/env node
/**
 * @fileoverview Tests for the filtered-module guard.
 *
 * The package contains modules that read `source: sf.antelope.type.v1.Block` —
 * every block on the chain. `map_events` does directly; `store_stats`,
 * `store_account_activity` and `map_stats` do transitively by reading from it.
 * Nothing calls any of them, but SUBSTREAMS_MODULE is an environment variable,
 * and pointing it at one would stream the whole chain through a metered
 * connection without a single complaint in the logs.
 *
 * The rule this enforces: the sink only runs modules that consume
 * antelope:filtered_actions, so the provider filters to one contract's actions
 * before data crosses the wire.
 *
 * Usage: node test-filtered-module.mjs
 */

import { buildSubstreamsArgs, assertFilteredModule, FILTERED_MODULES } from './args.mjs';

const base = {
    substreamsEndpoint: 'jungle4.substreams.pinax.network:443',
    substreamsPackage: '/app/substreams/polaris_music_substreams.spkg',
    substreamsModule: 'map_anchored_events',
    substreamsParams: 'map_anchored_events=polarismusic',
    startBlock: '-9000',
};

let failures = 0;

function check(name, ok, detail) {
    console.log(`${ok ? '✅' : '❌'} ${name}`);
    if (!ok) {
        if (detail) console.log(`   ${detail}`);
        failures++;
    }
}

function throws(fn) {
    try { fn(); return null; } catch (e) { return e; }
}

console.log('Substreams module guard\n');

// --- The full-block modules must be refused -------------------------------
// Named individually rather than looped over a list, so that adding a module
// to the manifest without adding it here is visible as a gap.
for (const blocked of ['map_events', 'store_stats', 'store_account_activity', 'map_stats']) {
    const err = throws(() => buildSubstreamsArgs({ ...base, substreamsModule: blocked }));
    check(`${blocked} is refused`, err !== null, 'it built argv instead of throwing');
    if (err) {
        check(
            `${blocked}'s error explains why`,
            /filtered module/i.test(err.message) && err.message.includes(blocked),
            `message was: ${err.message.split('\n')[0]}`
        );
    }
}

// --- The filtered modules must run ----------------------------------------
check(
    'map_anchored_events is allowed',
    throws(() => buildSubstreamsArgs(base)) === null
);

check(
    'filtered_actions is allowed (Pinax fallback path)',
    throws(() => buildSubstreamsArgs({
        ...base,
        substreamsModule: 'filtered_actions',
        substreamsParams: 'filtered_actions=code:polarismusic',
    })) === null
);

// --- The guard must be reached before any argv is built -------------------
// If the check ran later, a bad module could still reach the provider through
// some other path that builds args itself.
check(
    'an unknown module is refused rather than passed through',
    throws(() => buildSubstreamsArgs({ ...base, substreamsModule: 'made_up_module' })) !== null
);

check(
    'assertFilteredModule is exported for callers that build argv themselves',
    typeof assertFilteredModule === 'function'
);

// --- The allowlist itself --------------------------------------------------
check(
    'the allowlist holds only the two filtered modules',
    FILTERED_MODULES.size === 2 &&
        FILTERED_MODULES.has('map_anchored_events') &&
        FILTERED_MODULES.has('filtered_actions'),
    `allowlist is: ${[...FILTERED_MODULES].join(', ')}`
);

// --- Production mode, since filtering alone does not skip blocks ----------
check(
    'production mode is on by default',
    buildSubstreamsArgs(base).includes('--production-mode'),
    'without it the provider streams every block to the client regardless of filtering'
);

console.log('');
if (failures > 0) {
    console.log(`❌ ${failures} test(s) failed`);
    process.exit(1);
}
console.log('✅ All tests passed!');
