#!/usr/bin/env node
/**
 * @fileoverview Tests for createSerialQueue — ordered event ingestion.
 *
 * Regression cover for events being applied out of block order. The sink used
 * to call an async handler per stdout line without awaiting it, so events in
 * one chunk raced. A colour-change EDIT_CLAIM at block 283275359 completed in
 * 1.2s while the CREATE_RELEASE_BUNDLE at block 283275172 — the event that
 * creates the Person it edits — was still 3s from finishing, and the edit was
 * rejected with "Target node not found".
 *
 * The failure depended on which HTTP request finished first, so it was
 * intermittent: the same two events succeeded on the previous replay.
 *
 * Usage: node test-ordering.mjs
 */

import { createSerialQueue } from './serialQueue.mjs';

let failures = 0;

function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '✅' : '❌'} ${name}`);
    if (!ok) {
        console.log(`   expected: ${JSON.stringify(expected)}`);
        console.log(`   actual:   ${JSON.stringify(actual)}`);
        failures++;
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log('createSerialQueue\n');

// The core guarantee: a slow first task must not let a fast second overtake it.
// This is the exact shape of the bug — the bundle was slow, the edit was fast.
{
    const order = [];
    const queue = createSerialQueue();

    queue.enqueue(async () => { await sleep(40); order.push('bundle'); });
    queue.enqueue(async () => { await sleep(1);  order.push('edit'); });

    await queue.drain();
    check('a slow task still completes before a fast one enqueued after it',
        order, ['bundle', 'edit']);
}

// A task must not even start until the previous has settled.
{
    const events = [];
    const queue = createSerialQueue();

    queue.enqueue(async () => { events.push('start:1'); await sleep(20); events.push('end:1'); });
    queue.enqueue(async () => { events.push('start:2'); await sleep(1);  events.push('end:2'); });

    await queue.drain();
    check('the second task starts only after the first finishes',
        events, ['start:1', 'end:1', 'start:2', 'end:2']);
}

// Order holds across many tasks with shuffled durations.
{
    const order = [];
    const queue = createSerialQueue();
    const durations = [30, 2, 18, 1, 25, 4];

    durations.forEach((ms, i) => {
        queue.enqueue(async () => { await sleep(ms); order.push(i); });
    });

    await queue.drain();
    check('order is preserved regardless of task duration',
        order, [0, 1, 2, 3, 4, 5]);
}

// One rejected event must not stall the queue behind it — a single bad event
// should not silently drop every event that follows.
{
    const order = [];
    const errors = [];
    const queue = createSerialQueue({ onError: (e) => errors.push(e.message) });

    queue.enqueue(async () => { order.push('first'); });
    queue.enqueue(async () => { throw new Error('ingest refused'); });
    queue.enqueue(async () => { order.push('third'); });

    await queue.drain();
    check('a failing task does not stall the ones behind it', order, ['first', 'third']);
    check('the failure is reported to onError', errors, ['ingest refused']);
}

// drain() must wait for work enqueued before it was called.
{
    let done = false;
    const queue = createSerialQueue();
    queue.enqueue(async () => { await sleep(25); done = true; });

    await queue.drain();
    check('drain waits for outstanding work', done, true);
}

// An empty queue drains immediately rather than hanging.
{
    const queue = createSerialQueue();
    await queue.drain();
    check('an empty queue drains without hanging', true, true);
}

// A queue with no onError must still survive a rejection.
{
    const order = [];
    const queue = createSerialQueue();
    queue.enqueue(async () => { throw new Error('boom'); });
    queue.enqueue(async () => { order.push('after'); });

    await queue.drain();
    check('a rejection is swallowed safely when no onError is given', order, ['after']);
}

console.log('');
if (failures > 0) {
    console.log(`❌ ${failures} test(s) failed`);
    process.exit(1);
}
console.log('✅ All tests passed!');
console.log('');
console.log('createSerialQueue correctly:');
console.log('  - runs tasks strictly in enqueue order, whatever their duration');
console.log('  - starts each task only after the previous one settles');
console.log('  - keeps going when a task rejects, reporting it via onError');
console.log('  - drains outstanding work before resolving');
process.exit(0);
