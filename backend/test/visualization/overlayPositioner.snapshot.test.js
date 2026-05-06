/**
 * @jest-environment jsdom
 *
 * Stage J.2 — OverlayPositioner characterization tests.
 *
 * The handoff flagged OverlayPositioner as the smallest of the three
 * deferred Stage-J extractions: ReleaseOrbitOverlay is already its own
 * class, so what's left in MusicGraph is the *positioning glue* that
 * computes screen coords + visual-radius from a JIT node and forwards
 * to overlay.show / .updatePosition. The two methods that own this
 * glue (currently lines ~1169–1219 of MusicGraph.js) duplicate the
 * radius computation — extraction-bait that we must lock first.
 *
 * Methods covered:
 *   _syncReleaseOverlay(node)   — show on group nodes, hide otherwise
 *   _updateOverlayPosition()    — re-anchor after re-render
 *
 * Strategy: same source-extract + isolated-invoke pattern as the
 * Stage H InfoPanelRenderer test. We stub `_getNodeScreenPos` (canvas-
 * dependent and not part of the cluster being extracted) so the tests
 * focus on the radius math and the call structure, which are what the
 * extracted module will own.
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
// JIT node fixture. The methods read:
//   node.data.type            (string)
//   node.data.group_id        (string, may be undefined)
//   node.id                   (string, fallback when group_id missing)
//   node.getData('donutSlices')  (array | null | undefined)
// ---------------------------------------------------------------------------

function makeNode({ id = 'node-id', type = 'group', group_id, donutSlices } = {}) {
    return {
        id,
        data: { type, group_id },
        getData: jest.fn(key => (key === 'donutSlices' ? donutSlices : undefined)),
    };
}

// ---------------------------------------------------------------------------
// Stub `this`. The methods reach into:
//   - this.releaseOverlay         (.show, .hide, .updatePosition, .visible)
//   - this.selectedNode           (used by _updateOverlayPosition)
//   - this._getNodeScreenPos(node) (returns {x, y, dim})
//   - document.getElementById('viz-container')   (for getBoundingClientRect)
// ---------------------------------------------------------------------------

function setupVizContainer({ left = 100, top = 50 } = {}) {
    document.body.innerHTML = '';
    const div = document.createElement('div');
    div.id = 'viz-container';
    document.body.appendChild(div);
    // jsdom getBoundingClientRect returns zeros — patch the prototype
    // for our fixture container so subtracting works deterministically.
    div.getBoundingClientRect = () => ({ left, top, right: 0, bottom: 0, width: 0, height: 0 });
    return div;
}

afterEach(() => { document.body.innerHTML = ''; });

function makeStub({
    overlayVisible = false,
    selectedNode = null,
    screenPosImpl,
} = {}) {
    return {
        selectedNode,
        releaseOverlay: {
            visible: overlayVisible,
            show: jest.fn(async () => {}),
            hide: jest.fn(),
            updatePosition: jest.fn(),
        },
        _getNodeScreenPos: screenPosImpl
            ? jest.fn(screenPosImpl)
            : jest.fn(() => ({ x: 200, y: 150, dim: 30 })),
    };
}

// ---------------------------------------------------------------------------
// Drift guard.
// ---------------------------------------------------------------------------

describe('Stage J.2 · OverlayPositioner · drift guard', () => {
    test.each([
        ['_syncReleaseOverlay',   '(node)'],
        ['_updateOverlayPosition', '()'],
    ])('method %s exists with signature %s', (name, sig) => {
        const expected = sig.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).join(', ');
        const { params } = extractMethod(name);
        const actual = params.split(',').map(s => s.trim()).filter(Boolean).join(', ');
        expect(actual).toBe(expected);
    });
});

// ---------------------------------------------------------------------------
// _syncReleaseOverlay
// ---------------------------------------------------------------------------

describe('Stage J.2 · _syncReleaseOverlay', () => {
    test('non-group node → hide(), no show()', async () => {
        setupVizContainer();
        const stub = makeStub();
        await compileMethod('_syncReleaseOverlay').call(stub, makeNode({ type: 'person' }));
        expect(stub.releaseOverlay.hide).toHaveBeenCalledTimes(1);
        expect(stub.releaseOverlay.show).not.toHaveBeenCalled();
    });

    test('group node without donut slices → show() with bare dim as visualRadius', async () => {
        setupVizContainer({ left: 100, top: 50 });
        const stub = makeStub({
            screenPosImpl: () => ({ x: 200, y: 150, dim: 30 }),
        });
        await compileMethod('_syncReleaseOverlay').call(stub, makeNode({
            type: 'group', group_id: 'group:beatles', donutSlices: null,
        }));

        // relX = 200 - 100, relY = 150 - 50, visualRadius = dim = 30
        expect(stub.releaseOverlay.show).toHaveBeenCalledWith(
            'group:beatles',
            { x: 100, y: 100 },
            30
        );
    });

    test('group node with donut slices → visualRadius = dim + gap + thickness', async () => {
        setupVizContainer({ left: 0, top: 0 });
        const stub = makeStub({
            screenPosImpl: () => ({ x: 0, y: 0, dim: 100 }),
        });
        await compileMethod('_syncReleaseOverlay').call(stub, makeNode({
            type: 'group', group_id: 'g:1', donutSlices: [{ pct: 1.0 }],
        }));

        // dim=100 → gap = max(2, 100*0.20) = 20, thickness = max(3, 100*0.45) = 45
        // visualRadius = 100 + 20 + 45 = 165
        expect(stub.releaseOverlay.show).toHaveBeenCalledWith(
            'g:1',
            { x: 0, y: 0 },
            165
        );
    });

    test('small dim with donut slices → gap and thickness floor at 2 and 3', async () => {
        setupVizContainer({ left: 0, top: 0 });
        const stub = makeStub({
            screenPosImpl: () => ({ x: 0, y: 0, dim: 5 }),
        });
        await compileMethod('_syncReleaseOverlay').call(stub, makeNode({
            type: 'group', group_id: 'g:tiny', donutSlices: [{ pct: 1.0 }],
        }));

        // dim=5 → gap = max(2, 5*0.20=1) = 2, thickness = max(3, 5*0.45=2.25) = 3
        // visualRadius = 5 + 2 + 3 = 10
        expect(stub.releaseOverlay.show).toHaveBeenCalledWith(
            'g:tiny',
            { x: 0, y: 0 },
            10
        );
    });

    test('group node falls back to node.id when group_id is missing', async () => {
        setupVizContainer();
        const stub = makeStub();
        await compileMethod('_syncReleaseOverlay').call(stub, makeNode({
            id: 'fallback:id', type: 'group', group_id: undefined,
        }));
        expect(stub.releaseOverlay.show).toHaveBeenCalledWith(
            'fallback:id',
            expect.any(Object),
            expect.any(Number)
        );
    });

    test('missing #viz-container → coords default to (x, y), unshifted', async () => {
        document.body.innerHTML = '';  // no container
        const stub = makeStub({
            screenPosImpl: () => ({ x: 333, y: 444, dim: 10 }),
        });
        await compileMethod('_syncReleaseOverlay').call(stub, makeNode({
            type: 'group', group_id: 'g',
        }));
        expect(stub.releaseOverlay.show).toHaveBeenCalledWith(
            'g',
            { x: 333, y: 444 },  // {left:0, top:0} fallback applied
            10
        );
    });

    test('case-insensitive type check: "GROUP" still matches group branch', async () => {
        setupVizContainer();
        const stub = makeStub();
        await compileMethod('_syncReleaseOverlay').call(stub, makeNode({
            type: 'GROUP', group_id: 'g',
        }));
        expect(stub.releaseOverlay.hide).not.toHaveBeenCalled();
        expect(stub.releaseOverlay.show).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// _updateOverlayPosition
// ---------------------------------------------------------------------------

describe('Stage J.2 · _updateOverlayPosition', () => {
    test('overlay not visible → early return, no updatePosition()', () => {
        setupVizContainer();
        const stub = makeStub({ overlayVisible: false, selectedNode: makeNode() });
        compileMethod('_updateOverlayPosition').call(stub);
        expect(stub.releaseOverlay.updatePosition).not.toHaveBeenCalled();
    });

    test('selectedNode null → early return, no updatePosition()', () => {
        setupVizContainer();
        const stub = makeStub({ overlayVisible: true, selectedNode: null });
        compileMethod('_updateOverlayPosition').call(stub);
        expect(stub.releaseOverlay.updatePosition).not.toHaveBeenCalled();
    });

    test('happy path without slices → updatePosition with bare dim', () => {
        setupVizContainer({ left: 10, top: 20 });
        const stub = makeStub({
            overlayVisible: true,
            selectedNode: makeNode({ donutSlices: null }),
            screenPosImpl: () => ({ x: 110, y: 120, dim: 40 }),
        });
        compileMethod('_updateOverlayPosition').call(stub);
        expect(stub.releaseOverlay.updatePosition).toHaveBeenCalledWith(
            { x: 100, y: 100 },
            40
        );
    });

    test('happy path with slices → updatePosition with dim + gap + thickness', () => {
        setupVizContainer({ left: 0, top: 0 });
        const stub = makeStub({
            overlayVisible: true,
            selectedNode: makeNode({ donutSlices: [{ pct: 1.0 }] }),
            screenPosImpl: () => ({ x: 0, y: 0, dim: 50 }),
        });
        compileMethod('_updateOverlayPosition').call(stub);
        // gap = max(2, 50*0.20=10) = 10, thickness = max(3, 50*0.45=22.5) = 22.5
        // visualRadius = 50 + 10 + 22.5 = 82.5
        expect(stub.releaseOverlay.updatePosition).toHaveBeenCalledWith(
            { x: 0, y: 0 },
            82.5
        );
    });

    test('radius computation matches _syncReleaseOverlay (regression guard for the duplication)', async () => {
        setupVizContainer({ left: 0, top: 0 });

        const node = makeNode({ type: 'group', group_id: 'g', donutSlices: [{ pct: 1.0 }] });
        const screenPos = () => ({ x: 0, y: 0, dim: 75 });

        const syncStub = makeStub({ screenPosImpl: screenPos });
        await compileMethod('_syncReleaseOverlay').call(syncStub, node);

        const updateStub = makeStub({
            overlayVisible: true, selectedNode: node, screenPosImpl: screenPos,
        });
        compileMethod('_updateOverlayPosition').call(updateStub);

        // Same node + same dim must produce the same visualRadius in both
        // call paths. If a future extraction de-duplicates the math, this
        // test will keep both branches honest.
        const showRadius   = syncStub.releaseOverlay.show.mock.calls[0][2];
        const updateRadius = updateStub.releaseOverlay.updatePosition.mock.calls[0][1];
        expect(showRadius).toBe(updateRadius);
    });
});
