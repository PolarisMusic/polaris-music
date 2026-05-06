/**
 * @jest-environment jsdom
 *
 * Stage J.2 — GraphDataLoader characterization tests.
 *
 * Locks the behavior of the graph-loading cluster on MusicGraph so the
 * upcoming GraphDataLoader extraction (~80 lines, currently lines
 * ~1425–1499 + ~2016–2035 of MusicGraph.js) cannot silently change
 * observable side effects. These methods are the single source of
 * truth for `this.rawGraph`, `this.hashIndex`, and the JIT graph the
 * Hypertree renders.
 *
 * Methods covered:
 *   loadGraphData()                — initial fetch + render + hash-index rebuild
 *   rebuildHashIndexFromRawGraph() — checksum256 → metadata mapping
 *   ensureNodeInGraph(nodeId)      — neighborhood fetch + merge + 500-cap
 *
 * Strategy: source-extract + isolated invoke (same as the Stage H
 * InfoPanelRenderer test). We compile each method body via `new Function`
 * and call it with `Function.prototype.call(stubThis, ...)`. Assertions
 * focus on mutated state (rawGraph, hashIndex, _initialParticipation)
 * and outgoing call ledgers (api.fetchInitialGraphRaw,
 * api.fetchNeighborhoodRaw, api.transformToJIT, api.mergeRawGraph,
 * ht.loadJSON, ht.refresh, likeManager.nodeIdToChecksum256).
 */

import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parse } from '@babel/parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MUSIC_GRAPH_PATH = resolve(__dirname, '../../../frontend/src/visualization/MusicGraph.js');
const SOURCE = readFileSync(MUSIC_GRAPH_PATH, 'utf8');

// ---------------------------------------------------------------------------
// AST extraction (same machinery as the Stage H test).
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
    if (!node) throw new Error(`extractMethod: ${name} not found in MusicGraph.js`);
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
// Quiet console.log/error (loadGraphData is chatty by design).
// ---------------------------------------------------------------------------

let logSpy, errSpy, warnSpy;

beforeEach(() => {
    logSpy  = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy  = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Stub `this` builder. The loader methods reach into:
//   - this.api                       (fetchInitialGraphRaw, transformToJIT,
//                                     fetchNeighborhoodRaw, mergeRawGraph)
//   - this.ht                        (loadJSON, refresh, graph.eachNode)
//   - this.rawGraph                  (read+write)
//   - this._initialParticipation     (write)
//   - this.hashIndex                 (Map; cleared+repopulated)
//   - this.likeManager               (nodeIdToChecksum256)
//   - this.syncZoomSlider()          (sibling — stub)
//   - this.updateHistoryCount()      (sibling — stub)
//   - this.rebuildHashIndexFromRawGraph()  (intra-cluster — wire via compileMethod)
//   - this._prePopulateDonutData()   (sibling, called from loadGraphData — stub
//                                     to keep ht-graph-eachNode simulation small;
//                                     its own behavior is not part of this cluster)
// ---------------------------------------------------------------------------

function makeStub({
    initialGraphResponse,
    neighborhoodResponse,
    fetchInitialImpl,
    fetchNeighborhoodImpl,
    rawGraph = null,
    hashIndex = new Map(),
    checksumImpl,
} = {}) {
    const stub = {
        rawGraph,
        hashIndex,
        _initialParticipation: undefined,
        api: {
            fetchInitialGraphRaw: fetchInitialImpl
                ? jest.fn(fetchInitialImpl)
                : jest.fn(async () => initialGraphResponse ?? { nodes: [], edges: [], participation: {} }),
            fetchNeighborhoodRaw: fetchNeighborhoodImpl
                ? jest.fn(fetchNeighborhoodImpl)
                : jest.fn(async () => neighborhoodResponse ?? null),
            transformToJIT: jest.fn(raw => ({ jitFor: raw })),
            mergeRawGraph: jest.fn((a, b) => ({
                nodes: [...(a?.nodes || []), ...(b?.nodes || [])],
                edges: [...(a?.edges || []), ...(b?.edges || [])],
            })),
        },
        ht: {
            loadJSON: jest.fn(),
            refresh: jest.fn(),
            graph: { eachNode: jest.fn() },
        },
        likeManager: {
            nodeIdToChecksum256: checksumImpl
                ? jest.fn(checksumImpl)
                : jest.fn(async (id) => `h(${id})`),
        },
        syncZoomSlider: jest.fn(),
        updateHistoryCount: jest.fn(),
        _prePopulateDonutData: jest.fn(),
    };
    // Intra-cluster delegation: loadGraphData → rebuildHashIndexFromRawGraph
    // and ensureNodeInGraph → rebuildHashIndexFromRawGraph. Wire the real
    // compiled body so we lock both in one shot.
    stub.rebuildHashIndexFromRawGraph =
        compileMethod('rebuildHashIndexFromRawGraph').bind(stub);
    return stub;
}

// ---------------------------------------------------------------------------
// Drift guard.
// ---------------------------------------------------------------------------

describe('Stage J.2 · GraphDataLoader · drift guard', () => {
    test.each([
        ['loadGraphData',                '()'],
        ['rebuildHashIndexFromRawGraph', '()'],
        ['ensureNodeInGraph',            '(nodeId)'],
    ])('method %s exists with signature %s', (name, sig) => {
        const expected = sig.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).join(', ');
        const { params } = extractMethod(name);
        const actual = params.split(',').map(s => s.trim()).filter(Boolean).join(', ');
        expect(actual).toBe(expected);
    });
});

// ---------------------------------------------------------------------------
// loadGraphData
// ---------------------------------------------------------------------------

describe('Stage J.2 · loadGraphData', () => {
    test('happy path: stores rawGraph, captures participation, drives ht render', async () => {
        const initialGraphResponse = {
            nodes: [{ id: 'g:1', name: 'G1', type: 'group' }],
            edges: [{ source: 'p:1', target: 'g:1', type: 'MEMBER_OF' }],
            participation: { 'g:1': { totalTracks: 5, members: [] } },
        };
        const stub = makeStub({ initialGraphResponse });
        await compileMethod('loadGraphData').call(stub);

        expect(stub.rawGraph).toEqual({
            nodes: initialGraphResponse.nodes,
            edges: initialGraphResponse.edges,
        });
        expect(stub._initialParticipation).toEqual(initialGraphResponse.participation);
        expect(stub.api.transformToJIT).toHaveBeenCalledWith(stub.rawGraph);
        expect(stub.ht.loadJSON).toHaveBeenCalledTimes(1);
        expect(stub.ht.refresh).toHaveBeenCalledTimes(1);
        expect(stub.syncZoomSlider).toHaveBeenCalledTimes(1);
        expect(stub.updateHistoryCount).toHaveBeenCalledTimes(1);
        expect(stub._prePopulateDonutData).toHaveBeenCalledTimes(1);
    });

    test('rebuildHashIndexFromRawGraph runs after loadJSON/refresh', async () => {
        const initialGraphResponse = {
            nodes: [{ id: 'a' }, { id: 'b' }],
            edges: [],
            participation: {},
        };
        const stub = makeStub({ initialGraphResponse });
        await compileMethod('loadGraphData').call(stub);

        // Two nodes → likeManager called twice → hashIndex has two entries.
        expect(stub.likeManager.nodeIdToChecksum256).toHaveBeenCalledTimes(2);
        expect(stub.hashIndex.size).toBe(2);
    });

    test('missing participation field defaults to empty object', async () => {
        const initialGraphResponse = { nodes: [], edges: [] };  // no participation
        const stub = makeStub({ initialGraphResponse });
        await compileMethod('loadGraphData').call(stub);
        expect(stub._initialParticipation).toEqual({});
    });

    test('fetch failure is swallowed (logs and returns) — does not throw', async () => {
        const stub = makeStub({
            fetchInitialImpl: async () => { throw new Error('network down'); },
        });
        await expect(compileMethod('loadGraphData').call(stub)).resolves.toBeUndefined();
        // None of the post-fetch side effects should have run.
        expect(stub.ht.loadJSON).not.toHaveBeenCalled();
        expect(stub.ht.refresh).not.toHaveBeenCalled();
        expect(stub._prePopulateDonutData).not.toHaveBeenCalled();
        expect(errSpy).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// rebuildHashIndexFromRawGraph
// ---------------------------------------------------------------------------

describe('Stage J.2 · rebuildHashIndexFromRawGraph', () => {
    test('builds Map<checksum256, {nodeId, name, type}> for every node', async () => {
        const stub = makeStub({
            rawGraph: {
                nodes: [
                    { id: 'g:beatles',  name: 'The Beatles', type: 'group'  },
                    { id: 'p:lennon',   name: 'John Lennon', type: 'person' },
                ],
                edges: [],
            },
            hashIndex: new Map(),
            checksumImpl: async (id) => `H_${id}`,
        });

        await compileMethod('rebuildHashIndexFromRawGraph').call(stub);

        expect(stub.hashIndex.get('H_g:beatles')).toEqual({
            nodeId: 'g:beatles', name: 'The Beatles', type: 'group',
        });
        expect(stub.hashIndex.get('H_p:lennon')).toEqual({
            nodeId: 'p:lennon', name: 'John Lennon', type: 'person',
        });
    });

    test('clears the existing hashIndex before repopulating', async () => {
        const stale = new Map([['stale-hash', { nodeId: 'old', name: 'old', type: 'group' }]]);
        const stub = makeStub({
            rawGraph: { nodes: [{ id: 'fresh', name: 'F', type: 'group' }], edges: [] },
            hashIndex: stale,
        });

        await compileMethod('rebuildHashIndexFromRawGraph').call(stub);

        expect(stub.hashIndex.has('stale-hash')).toBe(false);
        expect(stub.hashIndex.size).toBe(1);
    });

    test('early-returns when rawGraph.nodes is missing', async () => {
        const stub = makeStub({ rawGraph: null });
        await compileMethod('rebuildHashIndexFromRawGraph').call(stub);
        expect(stub.likeManager.nodeIdToChecksum256).not.toHaveBeenCalled();
    });

    test('early-returns when likeManager is missing', async () => {
        const stub = makeStub({ rawGraph: { nodes: [{ id: 'a' }], edges: [] } });
        stub.likeManager = null;
        const before = new Map(stub.hashIndex);
        await compileMethod('rebuildHashIndexFromRawGraph').call(stub);
        // hashIndex should be untouched (no clear, no populate)
        expect([...stub.hashIndex.entries()]).toEqual([...before.entries()]);
    });
});

// ---------------------------------------------------------------------------
// ensureNodeInGraph
// ---------------------------------------------------------------------------

describe('Stage J.2 · ensureNodeInGraph', () => {
    test('happy path: merges neighborhood, reloads JIT, rebuilds hashIndex', async () => {
        const sub = {
            nodes: [{ id: 'p:new', name: 'New Person', type: 'person' }],
            edges: [{ source: 'p:new', target: 'g:1', type: 'MEMBER_OF' }],
        };
        const stub = makeStub({
            rawGraph: { nodes: [{ id: 'g:1', name: 'G1', type: 'group' }], edges: [] },
            neighborhoodResponse: sub,
        });

        await compileMethod('ensureNodeInGraph').call(stub, 'p:new');

        expect(stub.api.fetchNeighborhoodRaw).toHaveBeenCalledWith('p:new');
        expect(stub.api.mergeRawGraph).toHaveBeenCalledTimes(1);
        // After merge, rawGraph should contain both the original and the new nodes.
        expect(stub.rawGraph.nodes.map(n => n.id).sort()).toEqual(['g:1', 'p:new']);
        expect(stub.api.transformToJIT).toHaveBeenCalledWith(stub.rawGraph);
        expect(stub.ht.loadJSON).toHaveBeenCalledTimes(1);
        expect(stub.ht.refresh).toHaveBeenCalledTimes(1);
        // hashIndex was rebuilt for both merged nodes.
        expect(stub.hashIndex.size).toBe(2);
    });

    test('null neighborhood response → early return, no merge, no render', async () => {
        const stub = makeStub({
            rawGraph: { nodes: [{ id: 'g:1' }], edges: [] },
            neighborhoodResponse: null,
        });

        await compileMethod('ensureNodeInGraph').call(stub, 'missing-id');

        expect(stub.api.mergeRawGraph).not.toHaveBeenCalled();
        expect(stub.ht.loadJSON).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
    });

    test('empty-nodes neighborhood → early return', async () => {
        const stub = makeStub({
            rawGraph: { nodes: [{ id: 'g:1' }], edges: [] },
            neighborhoodResponse: { nodes: [], edges: [] },
        });
        await compileMethod('ensureNodeInGraph').call(stub, 'x');
        expect(stub.api.mergeRawGraph).not.toHaveBeenCalled();
        expect(stub.ht.loadJSON).not.toHaveBeenCalled();
    });

    test('graph > 500 nodes after merge → replaces rawGraph with neighborhood only', async () => {
        const big = { nodes: Array.from({ length: 600 }, (_, i) => ({ id: `n:${i}` })), edges: [] };
        const sub = { nodes: [{ id: 'fresh' }], edges: [] };
        const stub = makeStub({
            rawGraph: big,
            neighborhoodResponse: sub,
        });
        // mergeRawGraph default impl concats arrays, so merged length = 601
        await compileMethod('ensureNodeInGraph').call(stub, 'fresh');

        // The 500-cap branch replaces rawGraph wholesale with `sub`.
        expect(stub.rawGraph).toBe(sub);
        expect(stub.rawGraph.nodes).toHaveLength(1);
        expect(stub.api.transformToJIT).toHaveBeenCalledWith(sub);
    });
});
