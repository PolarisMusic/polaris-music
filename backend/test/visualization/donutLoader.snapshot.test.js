/**
 * @jest-environment jsdom
 *
 * DonutLoader characterization tests.
 *
 * The donut-fetch cluster (originally on MusicGraph) was extracted into
 * `frontend/src/visualization/DonutLoader.js`. The class owns:
 *   - `queue` / `activeLoads` / `maxConcurrent` / `stats`
 *   - `enqueue(node)`
 *   - `processQueue()`
 *   - `loadSingle(node)`              (async)
 *   - `computeSlices(members)`
 *   - `prePopulateData(participation)`
 *
 * These tests were written against the unextracted methods (still on
 * MusicGraph) and updated in-PR with the move; the snapshots and the
 * behavioral assertions are byte-identical across the extraction.
 *
 * Strategy mirrors the Stage J.2 tests: AST-based source extraction +
 * `new Function(...)` compilation + `Function.prototype.call(stub, ...)`
 * isolated invoke. We re-read DonutLoader.js on every run so any drift
 * surfaces as a snapshot/assertion diff.
 */

import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parse } from '@babel/parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SOURCE_PATH = resolve(__dirname, '../../../frontend/src/visualization/DonutLoader.js');
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

// ---------------------------------------------------------------------------
// AST extraction.
// ---------------------------------------------------------------------------

const AST = parse(SOURCE, { sourceType: 'module', plugins: ['classProperties'] });

const METHOD_INDEX = (() => {
    const map = new Map();
    function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'ClassMethod' && node.key?.type === 'Identifier') {
            map.set(node.key.name, node);
        }
        for (const key of Object.keys(node)) {
            const v = node[key];
            if (Array.isArray(v)) v.forEach(visit);
            else if (v && typeof v === 'object' && v.type) visit(v);
        }
    }
    visit(AST);
    return map;
})();

function extractMethod(name) {
    const node = METHOD_INDEX.get(name);
    if (!node) throw new Error(`extractMethod: ${name} not found in DonutLoader.js`);
    const params = node.params.map(p => SOURCE.slice(p.start, p.end)).join(', ');
    const body = SOURCE.slice(node.body.start + 1, node.body.end - 1);
    const isAsync = !!node.async;
    return { params, body, isAsync };
}

function compileMethod(name) {
    const { params, body, isAsync } = extractMethod(name);
    const argNames = params.split(',').map(s => s.trim()).filter(Boolean);
    if (isAsync) {
        const AsyncFunction = (async function () {}).constructor;
        return new AsyncFunction(...argNames, body);
    }
    // eslint-disable-next-line no-new-func
    return new Function(...argNames, body);
}

// ---------------------------------------------------------------------------
// Quiet console — _loadDonutDataSingle logs stats on drain, and on error.
// ---------------------------------------------------------------------------

let logSpy, errSpy;

beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// JIT node fixture. Uses .data + .getData/.setData like real JIT nodes.
// ---------------------------------------------------------------------------

function makeNode({ id = 'node-id', type = 'group', group_id, data: extra = {} } = {}) {
    const data = { type, group_id, ...extra };
    return {
        id,
        data,
        getData: jest.fn(key => data[key]),
        setData: jest.fn((key, value) => { data[key] = value; }),
    };
}

// ---------------------------------------------------------------------------
// Stub `this` builder for DonutLoader. The methods reach into:
//   this.queue                          array
//   this.activeLoads                    number
//   this.maxConcurrent                  number
//   this.stats                          {started, succeeded, failed}
//   this.api.fetchGroupParticipation    async (groupId) → { members }
//   this.colorPalette.getColor          (personId) → string
//   this.callbacks.plot()               redraw
//   this.callbacks.eachNode(cb)         iterator (prePopulateData)
// Intra-cluster delegations (`this.computeSlices`, `this.processQueue`,
// `this.loadSingle`) compile from the same source so drift inside any
// of them flows through to the assertion layer.
// ---------------------------------------------------------------------------

function makeStub({
    queue = [],
    active = 0,
    maxConcurrent = 4,
    fetchImpl,
    palette = id => `#palette:${id}`,
    plot = jest.fn(),
    eachNodeImpl,
} = {}) {
    const stub = {
        queue,
        activeLoads: active,
        maxConcurrent,
        stats: { started: 0, succeeded: 0, failed: 0 },
        api: {
            fetchGroupParticipation: fetchImpl
                ? jest.fn(fetchImpl)
                : jest.fn(async () => ({ members: [] })),
        },
        colorPalette: { getColor: jest.fn(palette) },
        callbacks: {
            plot,
            eachNode: eachNodeImpl ? jest.fn(eachNodeImpl) : jest.fn(() => {}),
        },
    };
    // Intra-cluster bindings — compile from live source.
    stub.computeSlices = compileMethod('computeSlices').bind(stub);
    stub.processQueue  = compileMethod('processQueue').bind(stub);
    stub.loadSingle    = compileMethod('loadSingle').bind(stub);
    return stub;
}

// ---------------------------------------------------------------------------
// Drift guard.
// ---------------------------------------------------------------------------

describe('DonutLoader · drift guard', () => {
    test.each([
        ['enqueue',         '(node)'],
        ['processQueue',    '()'],
        ['loadSingle',      '(node)'],
        ['computeSlices',   '(members)'],
        ['prePopulateData', '(participation)'],
    ])('method %s exists with signature %s', (name, sig) => {
        const expected = sig.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).join(', ');
        const { params } = extractMethod(name);
        const actual = params.split(',').map(s => s.trim()).filter(Boolean).join(', ');
        expect(actual).toBe(expected);
    });

    test('loadSingle is async', () => {
        expect(extractMethod('loadSingle').isAsync).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// enqueue
// ---------------------------------------------------------------------------

describe('enqueue', () => {
    test('pushes node onto queue and triggers processQueue', () => {
        const stub = makeStub();
        // Spy on processQueue without re-running its body.
        const processSpy = jest.fn();
        stub.processQueue = processSpy;

        const node = makeNode({ id: 'g:1' });
        compileMethod('enqueue').call(stub, node);

        expect(stub.queue).toEqual([node]);
        expect(processSpy).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// _processDonutQueue
// ---------------------------------------------------------------------------

describe('processQueue', () => {
    test('drains queue up to concurrency limit', () => {
        const nodes = Array.from({ length: 6 }, (_, i) => makeNode({ id: `g:${i}` }));
        const stub = makeStub({ queue: [...nodes], maxConcurrent: 4 });
        // Replace the async loader with a fire-and-forget spy so we can
        // count starts deterministically without awaiting fetches.
        const startSpy = jest.fn();
        stub.loadSingle = startSpy;

        compileMethod('processQueue').call(stub);

        expect(startSpy).toHaveBeenCalledTimes(4);
        expect(stub.activeLoads).toBe(4);
        expect(stub.stats.started).toBe(4);
        // Two left in queue.
        expect(stub.queue.length).toBe(2);
    });

    test('respects already-active loads (4 active + 2 queued, limit 4 → no new starts)', () => {
        const nodes = [makeNode({ id: 'g:a' }), makeNode({ id: 'g:b' })];
        const stub = makeStub({ queue: [...nodes], active: 4, maxConcurrent: 4 });
        const startSpy = jest.fn();
        stub.loadSingle = startSpy;

        compileMethod('processQueue').call(stub);

        expect(startSpy).not.toHaveBeenCalled();
        expect(stub.activeLoads).toBe(4);
        expect(stub.queue.length).toBe(2);
    });

    test('empty queue → no-op', () => {
        const stub = makeStub({ queue: [], maxConcurrent: 4 });
        const startSpy = jest.fn();
        stub.loadSingle = startSpy;

        compileMethod('processQueue').call(stub);

        expect(startSpy).not.toHaveBeenCalled();
        expect(stub.activeLoads).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// _loadDonutDataSingle
// ---------------------------------------------------------------------------

describe('loadSingle', () => {
    test('success → setData(donutSlices), setData(donutStatus, "ready"), plot, succeeded++', async () => {
        const members = [
            { personId: 'p:1', personName: 'Alice', trackCount: 3, color: '#ff0000' },
            { personId: 'p:2', personName: 'Bob',   trackCount: 1 },
        ];
        const stub = makeStub({
            active: 1,
            fetchImpl: async () => ({ members }),
        });
        const node = makeNode({ id: 'g:1', group_id: 'g:1' });

        await compileMethod('loadSingle').call(stub, node);

        expect(stub.api.fetchGroupParticipation).toHaveBeenCalledWith('g:1');
        expect(node.setData).toHaveBeenCalledWith('donutSlices', expect.any(Array));
        expect(node.setData).toHaveBeenCalledWith('donutStatus', 'ready');
        expect(stub.callbacks.plot).toHaveBeenCalledTimes(1);
        expect(stub.stats.succeeded).toBe(1);
        expect(stub.stats.failed).toBe(0);
        expect(stub.activeLoads).toBe(0);  // decremented in finally
    });

    test('falls back to node.id when group_id missing', async () => {
        const stub = makeStub({
            active: 1,
            fetchImpl: async () => ({ members: [] }),
        });
        const node = makeNode({ id: 'fallback:id', group_id: undefined });

        await compileMethod('loadSingle').call(stub, node);

        expect(stub.api.fetchGroupParticipation).toHaveBeenCalledWith('fallback:id');
    });

    test('fetch throws → setData(donutStatus, "error"), failed++, no plot', async () => {
        const stub = makeStub({
            active: 1,
            fetchImpl: async () => { throw new Error('boom'); },
        });
        const node = makeNode({ id: 'g:err', group_id: 'g:err' });

        await compileMethod('loadSingle').call(stub, node);

        expect(node.setData).toHaveBeenCalledWith('donutStatus', 'error');
        // donutSlices must not be set on failure
        const sliceCalls = node.setData.mock.calls.filter(c => c[0] === 'donutSlices');
        expect(sliceCalls).toHaveLength(0);
        expect(stub.callbacks.plot).not.toHaveBeenCalled();
        expect(stub.stats.failed).toBe(1);
        expect(stub.stats.succeeded).toBe(0);
        expect(stub.activeLoads).toBe(0);
        expect(errSpy).toHaveBeenCalled();
    });

    test('finally drains queue (reprocesses on completion)', async () => {
        const queuedNode = makeNode({ id: 'g:queued', group_id: 'g:queued' });
        const stub = makeStub({
            active: 1,
            queue: [queuedNode],
            maxConcurrent: 4,
            fetchImpl: async () => ({ members: [] }),
        });
        // Watch reprocess. The compiled body calls this.
        const processSpy = jest.spyOn(stub, 'processQueue');

        const node = makeNode({ id: 'g:done', group_id: 'g:done' });
        await compileMethod('loadSingle').call(stub, node);

        expect(processSpy).toHaveBeenCalled();
    });

    test('logs stats when queue fully drains (active=0 && queue empty)', async () => {
        const stub = makeStub({
            active: 1, queue: [], maxConcurrent: 4,
            fetchImpl: async () => ({ members: [] }),
        });
        const node = makeNode({ id: 'g:last', group_id: 'g:last' });
        await compileMethod('loadSingle').call(stub, node);

        // Look for the drain-stats log line.
        const matched = logSpy.mock.calls.find(args =>
            typeof args[0] === 'string' && args[0].includes('Donut load stats'));
        expect(matched).toBeTruthy();
    });

    test('does NOT log stats while other loads are still active', async () => {
        const stub = makeStub({
            active: 2, queue: [], maxConcurrent: 4,
            fetchImpl: async () => ({ members: [] }),
        });
        const node = makeNode({ id: 'g:partial', group_id: 'g:partial' });
        await compileMethod('loadSingle').call(stub, node);

        const matched = logSpy.mock.calls.find(args =>
            typeof args[0] === 'string' && args[0].includes('Donut load stats'));
        expect(matched).toBeFalsy();
    });

    test('handles missing members array (data.members undefined)', async () => {
        const stub = makeStub({
            active: 1,
            fetchImpl: async () => ({}),  // no .members
        });
        const node = makeNode({ id: 'g:nomembers', group_id: 'g:nomembers' });

        await compileMethod('loadSingle').call(stub, node);

        // Should still set ready status (computeSlices handles []).
        expect(node.setData).toHaveBeenCalledWith('donutStatus', 'ready');
        expect(node.setData).toHaveBeenCalledWith('donutSlices', []);
        expect(stub.stats.succeeded).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// computeSlices  (snapshotted — these are the angle/color outputs the
// canvas renderer reads).
// ---------------------------------------------------------------------------

describe('computeSlices', () => {
    test('null members → []', () => {
        const stub = makeStub();
        expect(compileMethod('computeSlices').call(stub, null)).toEqual([]);
    });

    test('empty array → []', () => {
        const stub = makeStub();
        expect(compileMethod('computeSlices').call(stub, [])).toEqual([]);
    });

    test('single member → one full-circle slice from -π/2', () => {
        const stub = makeStub();
        const slices = compileMethod('computeSlices').call(stub, [
            { personId: 'p:1', personName: 'Solo', trackCount: 5, color: '#abc' },
        ]);
        expect(slices).toMatchSnapshot();
    });

    test('two members sorted descending by trackCount', () => {
        const stub = makeStub();
        const slices = compileMethod('computeSlices').call(stub, [
            { personId: 'p:small', personName: 'Small', trackCount: 1 },
            { personId: 'p:big',   personName: 'Big',   trackCount: 9 },
        ]);
        // Big must come first.
        expect(slices[0].personId).toBe('p:big');
        expect(slices[1].personId).toBe('p:small');
        expect(slices).toMatchSnapshot();
    });

    test('all-zero weights → equal slices fallback (sorted stable by index)', () => {
        const stub = makeStub();
        const slices = compileMethod('computeSlices').call(stub, [
            { personId: 'p:a', personName: 'A', trackCount: 0 },
            { personId: 'p:b', personName: 'B', trackCount: 0 },
            { personId: 'p:c', personName: 'C', trackCount: 0 },
        ]);
        // Three equal slices, weightNormalized = 1/3 each, original order preserved.
        expect(slices.map(s => s.personId)).toEqual(['p:a', 'p:b', 'p:c']);
        expect(slices.every(s => Math.abs(s.weightNormalized - 1/3) < 1e-9)).toBe(true);
        expect(slices).toMatchSnapshot();
    });

    test('NaN/negative weights coerced to 0', () => {
        const stub = makeStub();
        const slices = compileMethod('computeSlices').call(stub, [
            { personId: 'p:nan', trackCount: 'not-a-number' },
            { personId: 'p:neg', trackCount: -3 },
            { personId: 'p:ok',  trackCount: 4 },
        ]);
        // Only p:ok has positive weight → it gets the full circle.
        const ok = slices.find(s => s.personId === 'p:ok');
        expect(ok.weightNormalized).toBe(1);
        const others = slices.filter(s => s.personId !== 'p:ok');
        // Others should have weightNormalized = 0 (since real positive weight exists).
        expect(others.every(s => s.weightNormalized === 0)).toBe(true);
    });

    test('falls back to colorPalette.getColor when member.color absent', () => {
        const stub = makeStub({ palette: id => `#palette:${id}` });
        const slices = compileMethod('computeSlices').call(stub, [
            { personId: 'p:1', trackCount: 1 },               // no color → palette
            { personId: 'p:2', trackCount: 1, color: '#fff' },// explicit color
        ]);
        const p1 = slices.find(s => s.personId === 'p:1');
        const p2 = slices.find(s => s.personId === 'p:2');
        expect(p1.color).toBe('#palette:p:1');
        expect(p2.color).toBe('#fff');
    });

    test('slice angles cover exactly 2π starting at -π/2', () => {
        const stub = makeStub();
        const slices = compileMethod('computeSlices').call(stub, [
            { personId: 'p:1', trackCount: 2 },
            { personId: 'p:2', trackCount: 3 },
            { personId: 'p:3', trackCount: 5 },
        ]);
        expect(slices[0].begin).toBeCloseTo(-Math.PI / 2, 12);
        const last = slices[slices.length - 1];
        expect(last.end).toBeCloseTo(-Math.PI / 2 + 2 * Math.PI, 12);
        // Each slice end equals next slice begin.
        for (let i = 1; i < slices.length; i++) {
            expect(slices[i].begin).toBeCloseTo(slices[i - 1].end, 12);
        }
    });

    test('stable sort tie-break: equal weights preserve original index order', () => {
        const stub = makeStub();
        const slices = compileMethod('computeSlices').call(stub, [
            { personId: 'p:first',  trackCount: 5 },
            { personId: 'p:second', trackCount: 5 },
            { personId: 'p:third',  trackCount: 5 },
        ]);
        expect(slices.map(s => s.personId)).toEqual(['p:first', 'p:second', 'p:third']);
    });
});

// ---------------------------------------------------------------------------
// prePopulateData(participation)
// ---------------------------------------------------------------------------

describe('prePopulateData', () => {
    test('no participation map → early return, no plot, no eachNode', () => {
        const stub = makeStub();
        compileMethod('prePopulateData').call(stub, undefined);
        expect(stub.callbacks.plot).not.toHaveBeenCalled();
        expect(stub.callbacks.eachNode).not.toHaveBeenCalled();
    });

    test('null participation → early return', () => {
        const stub = makeStub();
        compileMethod('prePopulateData').call(stub, null);
        expect(stub.callbacks.plot).not.toHaveBeenCalled();
        expect(stub.callbacks.eachNode).not.toHaveBeenCalled();
    });

    test('skips non-group nodes', () => {
        const personNode = makeNode({ id: 'p:1', type: 'person' });
        const trackNode  = makeNode({ id: 't:1', type: 'track' });
        const stub = makeStub({
            eachNodeImpl: cb => { cb(personNode); cb(trackNode); },
        });
        compileMethod('prePopulateData').call(stub, {
            'p:1': { members: [{ personId: 'x', trackCount: 1 }] },
        });
        expect(personNode.setData).not.toHaveBeenCalled();
        expect(trackNode.setData).not.toHaveBeenCalled();
        expect(stub.callbacks.plot).not.toHaveBeenCalled();
    });

    test('group node with participation entry → setData(donutSlices, donutStatus="ready"), plot', () => {
        const groupNode = makeNode({ id: 'g:1', type: 'group', group_id: 'g:1' });
        const stub = makeStub({
            eachNodeImpl: cb => { cb(groupNode); },
        });
        compileMethod('prePopulateData').call(stub, {
            'g:1': { members: [{ personId: 'p:1', trackCount: 1 }] },
        });
        expect(groupNode.setData).toHaveBeenCalledWith('donutSlices', expect.any(Array));
        expect(groupNode.setData).toHaveBeenCalledWith('donutStatus', 'ready');
        expect(stub.callbacks.plot).toHaveBeenCalledTimes(1);
    });

    test('group node falls back to node.id when group_id missing', () => {
        const groupNode = makeNode({ id: 'fallback:id', type: 'group', group_id: undefined });
        const stub = makeStub({
            eachNodeImpl: cb => { cb(groupNode); },
        });
        compileMethod('prePopulateData').call(stub, {
            'fallback:id': { members: [{ personId: 'p:1', trackCount: 1 }] },
        });
        expect(groupNode.setData).toHaveBeenCalledWith('donutStatus', 'ready');
    });

    test('group node missing from participation map → skipped (no setData, no plot)', () => {
        const groupNode = makeNode({ id: 'g:absent', type: 'group', group_id: 'g:absent' });
        const stub = makeStub({
            eachNodeImpl: cb => { cb(groupNode); },
        });
        compileMethod('prePopulateData').call(stub, { 'g:other': { members: [] } });
        expect(groupNode.setData).not.toHaveBeenCalled();
        expect(stub.callbacks.plot).not.toHaveBeenCalled();
    });

    test('group node with no members → skipped', () => {
        const groupNode = makeNode({ id: 'g:nomembers', type: 'group', group_id: 'g:nomembers' });
        const stub = makeStub({
            eachNodeImpl: cb => { cb(groupNode); },
        });
        compileMethod('prePopulateData').call(stub, { 'g:nomembers': { /* no members */ } });
        expect(groupNode.setData).not.toHaveBeenCalled();
        expect(stub.callbacks.plot).not.toHaveBeenCalled();
    });

    test('plot called once even when multiple groups pre-populated', () => {
        const g1 = makeNode({ id: 'g:1', type: 'group', group_id: 'g:1' });
        const g2 = makeNode({ id: 'g:2', type: 'group', group_id: 'g:2' });
        const stub = makeStub({
            eachNodeImpl: cb => { cb(g1); cb(g2); },
        });
        compileMethod('prePopulateData').call(stub, {
            'g:1': { members: [{ personId: 'p', trackCount: 1 }] },
            'g:2': { members: [{ personId: 'q', trackCount: 1 }] },
        });
        expect(stub.callbacks.plot).toHaveBeenCalledTimes(1);
    });
});
