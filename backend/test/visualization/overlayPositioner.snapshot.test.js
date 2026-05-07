/**
 * @jest-environment jsdom
 *
 * Stage J.2 — OverlayPositioner characterization tests.
 *
 * Stage J.2 extracted the positioning glue from MusicGraph into
 * `frontend/src/visualization/OverlayPositioner.js`. ReleaseOrbitOverlay
 * itself was already its own class; what moved is the JIT-node-to-
 * screen-coords-to-overlay-args translation, plus the deduplication of
 * the visual-radius math that both methods used to compute inline.
 *
 * Methods covered (now on OverlayPositioner, no `_` prefix):
 *   syncReleaseOverlay(node)   — show on group nodes, hide otherwise
 *   updateOverlayPosition()    — re-anchor after re-render
 *
 * Strategy: same source-extract + isolated-invoke pattern as the
 * Stage H InfoPanelRenderer test. We compile each method body via
 * `new Function` and call it with `Function.prototype.call(stubThis, ...)`.
 * The stub provides `this.callbacks.getNodeScreenPos`,
 * `this.callbacks.getSelectedNode`, plus compiled bindings for
 * `this.computeVisualRadius` and `this._toOverlayCoords` so intra-class
 * calls resolve through the same source we're locking.
 */

import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parse } from '@babel/parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const POSITIONER_PATH = resolve(__dirname, '../../../frontend/src/visualization/OverlayPositioner.js');
const SOURCE = readFileSync(POSITIONER_PATH, 'utf8');

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
    if (!node) throw new Error(`extractMethod: ${name} not found in OverlayPositioner.js`);
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
// Stub `this`. The methods now reach into:
//   - this.releaseOverlay              (.show, .hide, .updatePosition, .visible)
//   - this.callbacks.getNodeScreenPos(node)  → {x, y, dim}
//   - this.callbacks.getSelectedNode()       → node|null
//   - this.computeVisualRadius(dim, slices)  (intra-class — wired via compileMethod)
//   - this._toOverlayCoords(x, y)            (intra-class — wired via compileMethod)
//   - document.getElementById('viz-container') (for getBoundingClientRect)
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
    const stub = {
        releaseOverlay: {
            visible: overlayVisible,
            show: jest.fn(async () => {}),
            hide: jest.fn(),
            updatePosition: jest.fn(),
        },
        callbacks: {
            getNodeScreenPos: screenPosImpl
                ? jest.fn(screenPosImpl)
                : jest.fn(() => ({ x: 200, y: 150, dim: 30 })),
            getSelectedNode: jest.fn(() => selectedNode),
        },
    };
    // Intra-class delegations. Compile from the same source we're locking
    // so any drift inside computeVisualRadius / _toOverlayCoords also
    // flows through to the snapshot/assertion layer.
    stub.computeVisualRadius = compileMethod('computeVisualRadius').bind(stub);
    stub._toOverlayCoords    = compileMethod('_toOverlayCoords').bind(stub);
    return stub;
}

// ---------------------------------------------------------------------------
// Drift guard.
// ---------------------------------------------------------------------------

describe('Stage J.2 · OverlayPositioner · drift guard', () => {
    test.each([
        ['syncReleaseOverlay',    '(node)'],
        ['updateOverlayPosition', '()'],
        // Pin the deduplicated radius helper too — if a future refactor
        // moves its math somewhere else, this guard fires.
        ['computeVisualRadius',   '(dim, donutSlices)'],
    ])('method %s exists with signature %s', (name, sig) => {
        const expected = sig.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).join(', ');
        const { params } = extractMethod(name);
        const actual = params.split(',').map(s => s.trim()).filter(Boolean).join(', ');
        expect(actual).toBe(expected);
    });
});

// ---------------------------------------------------------------------------
// syncReleaseOverlay
// ---------------------------------------------------------------------------

describe('Stage J.2 · syncReleaseOverlay', () => {
    test('non-group node → hide(), no show()', async () => {
        setupVizContainer();
        const stub = makeStub();
        await compileMethod('syncReleaseOverlay').call(stub, makeNode({ type: 'person' }));
        expect(stub.releaseOverlay.hide).toHaveBeenCalledTimes(1);
        expect(stub.releaseOverlay.show).not.toHaveBeenCalled();
    });

    test('group node without donut slices → show() with bare dim as visualRadius', async () => {
        setupVizContainer({ left: 100, top: 50 });
        const stub = makeStub({
            screenPosImpl: () => ({ x: 200, y: 150, dim: 30 }),
        });
        await compileMethod('syncReleaseOverlay').call(stub, makeNode({
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
        await compileMethod('syncReleaseOverlay').call(stub, makeNode({
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
        await compileMethod('syncReleaseOverlay').call(stub, makeNode({
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
        await compileMethod('syncReleaseOverlay').call(stub, makeNode({
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
        await compileMethod('syncReleaseOverlay').call(stub, makeNode({
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
        await compileMethod('syncReleaseOverlay').call(stub, makeNode({
            type: 'GROUP', group_id: 'g',
        }));
        expect(stub.releaseOverlay.hide).not.toHaveBeenCalled();
        expect(stub.releaseOverlay.show).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// updateOverlayPosition
// ---------------------------------------------------------------------------

describe('Stage J.2 · updateOverlayPosition', () => {
    test('overlay not visible → early return, no updatePosition()', () => {
        setupVizContainer();
        const stub = makeStub({ overlayVisible: false, selectedNode: makeNode() });
        compileMethod('updateOverlayPosition').call(stub);
        expect(stub.releaseOverlay.updatePosition).not.toHaveBeenCalled();
    });

    test('selectedNode null → early return, no updatePosition()', () => {
        setupVizContainer();
        const stub = makeStub({ overlayVisible: true, selectedNode: null });
        compileMethod('updateOverlayPosition').call(stub);
        expect(stub.releaseOverlay.updatePosition).not.toHaveBeenCalled();
    });

    test('happy path without slices → updatePosition with bare dim', () => {
        setupVizContainer({ left: 10, top: 20 });
        const stub = makeStub({
            overlayVisible: true,
            selectedNode: makeNode({ donutSlices: null }),
            screenPosImpl: () => ({ x: 110, y: 120, dim: 40 }),
        });
        compileMethod('updateOverlayPosition').call(stub);
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
        compileMethod('updateOverlayPosition').call(stub);
        // gap = max(2, 50*0.20=10) = 10, thickness = max(3, 50*0.45=22.5) = 22.5
        // visualRadius = 50 + 10 + 22.5 = 82.5
        expect(stub.releaseOverlay.updatePosition).toHaveBeenCalledWith(
            { x: 0, y: 0 },
            82.5
        );
    });

    test('radius computation matches syncReleaseOverlay (regression guard for the dedup)', async () => {
        setupVizContainer({ left: 0, top: 0 });

        const node = makeNode({ type: 'group', group_id: 'g', donutSlices: [{ pct: 1.0 }] });
        const screenPos = () => ({ x: 0, y: 0, dim: 75 });

        const syncStub = makeStub({ screenPosImpl: screenPos });
        await compileMethod('syncReleaseOverlay').call(syncStub, node);

        const updateStub = makeStub({
            overlayVisible: true, selectedNode: node, screenPosImpl: screenPos,
        });
        compileMethod('updateOverlayPosition').call(updateStub);

        // Same node + same dim must produce the same visualRadius in both
        // call paths. If a future extraction de-duplicates the math, this
        // test will keep both branches honest.
        const showRadius   = syncStub.releaseOverlay.show.mock.calls[0][2];
        const updateRadius = updateStub.releaseOverlay.updatePosition.mock.calls[0][1];
        expect(showRadius).toBe(updateRadius);
    });
});
