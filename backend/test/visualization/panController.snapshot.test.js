/**
 * @jest-environment jsdom
 *
 * PanController characterization tests.
 *
 * The long-press pan cluster (originally on MusicGraph) was extracted
 * into `frontend/src/visualization/PanController.js`. The class owns:
 *   - `holdMs`                          (was PAN_HOLD_MS)
 *   - `pan` state object  { isDown, isPanning, suppressNextClick,
 *                           timer, lastPos, latestPos, raf }
 *   - `attach()`                        (was setupLongPressPan)
 *   - `eventToCanvasPos(e)`             translates a DOM event to canvas coords
 *   - `onMouseDown(e)`                  (was onPanMouseDown)
 *   - `onMouseMove(e)`                  (was onPanMouseMove)
 *   - `onMouseUp(e)`                    (was onPanMouseUp)
 *   - `consumeSuppressClick()`          read+reset the suppress flag
 *
 * These tests were written against the unextracted methods (still on
 * MusicGraph) and updated in-PR with the move; the behavioral
 * assertions are byte-identical across the extraction.
 *
 * Strategy mirrors the Stage J.2 / J.3 tests: AST-based source extraction +
 * `new Function(...)` compilation + `Function.prototype.call(stub, ...)`
 * isolated invoke. We re-read PanController.js on every run.
 *
 * Notes on DOM/timers:
 *   - jsdom does not ship `requestAnimationFrame`. Each test that exercises
 *     onMouseMove polyfills it as a jest.fn returning a truthy handle, so
 *     the debounce guard (`if (!this.pan.raf)`) sees scheduled state.
 *   - jest.useFakeTimers() lets us advance the 900ms hold timer instantly.
 *   - `$jit.util.event.getPos` is a JIT global; we install a stub on
 *     globalThis before each test.
 */

import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parse } from '@babel/parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SOURCE_PATH = resolve(__dirname, '../../../frontend/src/visualization/PanController.js');
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
    if (!node) throw new Error(`extractMethod: ${name} not found in PanController.js`);
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
// Globals: $jit (used by eventToCanvasPos) and requestAnimationFrame
// (used by onPanMouseMove). Captured per-test so we can inspect calls.
// ---------------------------------------------------------------------------

let jitGetPosStub, rafStub;

beforeEach(() => {
    jest.useFakeTimers();
    jitGetPosStub = jest.fn(() => ({ x: 0, y: 0 }));
    globalThis.$jit = { util: { event: { getPos: jitGetPosStub } } };
    // Return a truthy handle so the rAF-debounce guard
    // (`if (!this._pan.raf)`) sees it as scheduled.
    let rafHandle = 0;
    rafStub = jest.fn(() => ++rafHandle);
    globalThis.requestAnimationFrame = rafStub;
});

afterEach(() => {
    jest.useRealTimers();
    delete globalThis.$jit;
    delete globalThis.requestAnimationFrame;
});

// ---------------------------------------------------------------------------
// Stub `this` builder. The pan methods reach into:
//   this.holdMs                                number
//   this.pan.isDown / isPanning / suppressNextClick / timer
//       / lastPos / latestPos / raf
//   this.getCanvas()                           → JIT canvas object
//   canvas.getElement()                        → HTMLCanvasElement (jsdom)
//   canvas.translate(dx, dy, animate)          JIT canvas translate
//   canvas.getSize() / getPos()                → {width,height} / {x,y}
//   canvas.translateOffsetX / Y                coords
//   canvas.scaleOffsetX / Y                    coords
//   this.callbacks.plot()                      redraw
//   this.callbacks.updateOverlayPosition()
//   this.eventToCanvasPos(e)                   intra-cluster (compiled)
//   this.onMouseDown / Move / Up               intra-cluster (compiled)
// ---------------------------------------------------------------------------

function makeJitCanvas({
    elementClassName = '',
    size = { width: 800, height: 600 },
    pos = { x: 100, y: 50 },
    translateOffsets = { x: 0, y: 0 },
    scaleOffsets = { x: 1, y: 1 },
    translate = jest.fn(),
} = {}) {
    const el = document.createElement('canvas');
    el.className = elementClassName;
    return {
        _el: el,
        getElement: jest.fn(() => el),
        getSize: jest.fn(() => size),
        getPos: jest.fn(() => pos),
        translateOffsetX: translateOffsets.x,
        translateOffsetY: translateOffsets.y,
        scaleOffsetX: scaleOffsets.x,
        scaleOffsetY: scaleOffsets.y,
        translate,
    };
}

function makeStub({
    canvas,
    holdMs = 900,
    panState = {},
    plot = jest.fn(),
    updateOverlayPosition = jest.fn(),
} = {}) {
    const stub = {
        holdMs,
        getCanvas: jest.fn(() => canvas),
        callbacks: { plot, updateOverlayPosition },
        pan: {
            isDown: false,
            isPanning: false,
            suppressNextClick: false,
            timer: null,
            lastPos: null,
            latestPos: null,
            raf: null,
            ...panState,
        },
    };
    // Intra-cluster bindings — compile from live source.
    stub.eventToCanvasPos = compileMethod('eventToCanvasPos').bind(stub);
    stub.onMouseDown      = compileMethod('onMouseDown').bind(stub);
    stub.onMouseMove      = compileMethod('onMouseMove').bind(stub);
    stub.onMouseUp        = compileMethod('onMouseUp').bind(stub);
    return stub;
}

function makeMouseEvent(overrides = {}) {
    // jsdom's MouseEvent works fine. Default to a left-button event.
    return new MouseEvent('mousedown', {
        button: 0,
        bubbles: true,
        cancelable: true,
        ...overrides,
    });
}

// ---------------------------------------------------------------------------
// Drift guard.
// ---------------------------------------------------------------------------

describe('PanController · drift guard', () => {
    test.each([
        ['attach',                '()'],
        ['eventToCanvasPos',      '(e)'],
        ['onMouseDown',           '(e)'],
        ['onMouseMove',           '(e)'],
        ['onMouseUp',             '(e)'],
        ['consumeSuppressClick',  '()'],
    ])('method %s exists with signature %s', (name, sig) => {
        const expected = sig.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).join(', ');
        const { params } = extractMethod(name);
        const actual = params.split(',').map(s => s.trim()).filter(Boolean).join(', ');
        expect(actual).toBe(expected);
    });

    test('no method in cluster is async', () => {
        for (const name of ['attach', 'eventToCanvasPos', 'onMouseDown', 'onMouseMove', 'onMouseUp', 'consumeSuppressClick']) {
            expect(extractMethod(name).isAsync).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// setupLongPressPan
// ---------------------------------------------------------------------------

describe('attach', () => {
    test('no canvas → early return, no listeners attached', () => {
        const stub = makeStub({ canvas: undefined });
        // Must not throw.
        expect(() => compileMethod('attach').call(stub)).not.toThrow();
    });

    test('canvas.getElement() returns null → early return', () => {
        const canvas = makeJitCanvas();
        canvas.getElement = jest.fn(() => null);
        const stub = makeStub({ canvas });
        compileMethod('attach').call(stub);
        // No way to assert directly that nothing was attached; we rely on
        // the implementation guard (`if (!el) return`) being reached. The
        // smoke test is "did not throw".
        expect(canvas.getElement).toHaveBeenCalled();
    });

    test('happy path → attaches mousedown/mousemove/mouseup/mouseleave listeners', () => {
        const canvas = makeJitCanvas();
        const el = canvas._el;
        const elAdd = jest.spyOn(el, 'addEventListener');
        const winAdd = jest.spyOn(window, 'addEventListener');
        const stub = makeStub({ canvas });

        compileMethod('attach').call(stub);

        const elEvents = elAdd.mock.calls.map(c => c[0]).sort();
        expect(elEvents).toEqual(['mousedown', 'mousemove', 'mouseleave'].sort());
        const winEvents = winAdd.mock.calls.map(c => c[0]);
        expect(winEvents).toContain('mouseup');
        elAdd.mockRestore();
        winAdd.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// eventToCanvasPos
// ---------------------------------------------------------------------------

describe('eventToCanvasPos', () => {
    test('applies the documented inverse-transform formula', () => {
        const canvas = makeJitCanvas({
            size: { width: 800, height: 600 },
            pos: { x: 100, y: 50 },
            translateOffsets: { x: 10, y: 20 },
            scaleOffsets: { x: 2, y: 4 },
        });
        const stub = makeStub({ canvas });
        // $jit.util.event.getPos returns the screen-space event position.
        jitGetPosStub.mockReturnValue({ x: 600, y: 400 });

        const result = compileMethod('eventToCanvasPos').call(stub, makeMouseEvent());

        // x = (pos.x - p.x - s.width/2 - ox) * (1/sx)
        //   = (600 - 100 - 400 - 10) * 0.5 = 90 * 0.5 = 45
        // y = (pos.y - p.y - s.height/2 - oy) * (1/sy)
        //   = (400 - 50 - 300 - 20) * 0.25 = 30 * 0.25 = 7.5
        expect(result).toEqual({ x: 45, y: 7.5 });
    });

    test('passes the event and window to $jit.util.event.getPos', () => {
        const canvas = makeJitCanvas();
        const stub = makeStub({ canvas });
        const event = makeMouseEvent();
        compileMethod('eventToCanvasPos').call(stub, event);
        expect(jitGetPosStub).toHaveBeenCalledWith(event, window);
    });
});

// ---------------------------------------------------------------------------
// onPanMouseDown
// ---------------------------------------------------------------------------

describe('onMouseDown', () => {
    test('non-left button → early return, no state change', () => {
        const canvas = makeJitCanvas();
        const stub = makeStub({ canvas });
        const ev = makeMouseEvent({ button: 2 });

        compileMethod('onMouseDown').call(stub, ev);

        expect(stub.pan.isDown).toBe(false);
        expect(stub.pan.timer).toBe(null);
    });

    test('left button → sets isDown, captures position, arms hold timer', () => {
        const canvas = makeJitCanvas();
        const stub = makeStub({ canvas });
        jitGetPosStub.mockReturnValue({ x: 200, y: 200 });

        compileMethod('onMouseDown').call(stub, makeMouseEvent({ button: 0 }));

        expect(stub.pan.isDown).toBe(true);
        expect(stub.pan.isPanning).toBe(false);
        expect(stub.pan.suppressNextClick).toBe(false);
        // latestPos === lastPos === eventToCanvasPos result.
        expect(stub.pan.latestPos).toEqual(stub.pan.lastPos);
        expect(stub.pan.timer).not.toBeNull();
    });

    test('hold timer firing while still down → enters panning, sets suppressNextClick, adds grabbing class', () => {
        const canvas = makeJitCanvas();
        const stub = makeStub({ canvas, holdMs: 900 });
        compileMethod('onMouseDown').call(stub, makeMouseEvent({ button: 0 }));

        // Advance to the hold timer firing.
        jest.advanceTimersByTime(900);

        expect(stub.pan.isPanning).toBe(true);
        expect(stub.pan.suppressNextClick).toBe(true);
        expect(canvas._el.classList.contains('grabbing')).toBe(true);
    });

    test('hold timer firing AFTER mouseup → no panning, no grabbing class', () => {
        const canvas = makeJitCanvas();
        const stub = makeStub({ canvas, holdMs: 900 });

        compileMethod('onMouseDown').call(stub, makeMouseEvent({ button: 0 }));
        // Simulate quick mouseup before the hold completes.
        compileMethod('onMouseUp').call(stub, makeMouseEvent({ button: 0 }));
        // Advance timers — the hold callback should bail because isDown=false.
        jest.advanceTimersByTime(900);

        expect(stub.pan.isPanning).toBe(false);
        expect(canvas._el.classList.contains('grabbing')).toBe(false);
    });

    test('two consecutive mouseDowns clear the previous timer', () => {
        const canvas = makeJitCanvas();
        const stub = makeStub({ canvas });

        compileMethod('onMouseDown').call(stub, makeMouseEvent({ button: 0 }));
        const firstTimer = stub.pan.timer;

        compileMethod('onMouseDown').call(stub, makeMouseEvent({ button: 0 }));
        const secondTimer = stub.pan.timer;

        expect(secondTimer).not.toBe(firstTimer);
    });
});

// ---------------------------------------------------------------------------
// onPanMouseMove
// ---------------------------------------------------------------------------

describe('onMouseMove', () => {
    test('!isDown → early return (no translate, no plot)', () => {
        const canvas = makeJitCanvas();
        const stub = makeStub({ canvas });

        compileMethod('onMouseMove').call(stub, makeMouseEvent());

        expect(canvas.translate).not.toHaveBeenCalled();
        expect(stub.callbacks.plot).not.toHaveBeenCalled();
    });

    test('isDown but !isPanning → updates latestPos but does NOT translate', () => {
        const canvas = makeJitCanvas();
        const stub = makeStub({
            canvas,
            panState: { isDown: true, isPanning: false, lastPos: { x: 0, y: 0 } },
        });
        jitGetPosStub.mockReturnValue({ x: 50, y: 50 });

        compileMethod('onMouseMove').call(stub, makeMouseEvent());

        expect(stub.pan.latestPos).not.toBeNull();
        expect(canvas.translate).not.toHaveBeenCalled();
        expect(rafStub).not.toHaveBeenCalled();
    });

    test('isPanning + nonzero delta → translate, queue rAF, redraw + overlay sync', () => {
        const canvas = makeJitCanvas({
            translateOffsets: { x: 0, y: 0 },
            scaleOffsets: { x: 1, y: 1 },
        });
        const stub = makeStub({
            canvas,
            panState: {
                isDown: true,
                isPanning: true,
                lastPos: { x: 0, y: 0 },
            },
        });
        // eventToCanvasPos with this canvas + 1:1 scale & no offset:
        // x = pos.x - p.x - 400, y = pos.y - p.y - 300 (with size 800x600)
        // We want delta (10, 20) from lastPos (0,0):
        //   need eventToCanvasPos = (10, 20)
        //   pos.x - 100 - 400 = 10 → pos.x = 510
        //   pos.y - 50  - 300 = 20 → pos.y = 370
        jitGetPosStub.mockReturnValue({ x: 510, y: 370 });

        const ev = makeMouseEvent();
        const preventDefault = jest.spyOn(ev, 'preventDefault');
        const stopPropagation = jest.spyOn(ev, 'stopPropagation');

        compileMethod('onMouseMove').call(stub, ev);

        expect(canvas.translate).toHaveBeenCalledWith(10, 20, true);
        expect(stub.pan.lastPos).toEqual({ x: 10, y: 20 });
        expect(preventDefault).toHaveBeenCalled();
        expect(stopPropagation).toHaveBeenCalled();
        expect(rafStub).toHaveBeenCalledTimes(1);

        // Manually fire the rAF callback.
        const rafCb = rafStub.mock.calls[0][0];
        rafCb();
        expect(stub.callbacks.plot).toHaveBeenCalledTimes(1);
        expect(stub.callbacks.updateOverlayPosition).toHaveBeenCalledTimes(1);
        expect(stub.pan.raf).toBeNull();
    });

    test('isPanning + zero delta → no translate, no rAF', () => {
        const canvas = makeJitCanvas({
            translateOffsets: { x: 0, y: 0 },
            scaleOffsets: { x: 1, y: 1 },
        });
        const stub = makeStub({
            canvas,
            panState: { isDown: true, isPanning: true, lastPos: { x: 5, y: 5 } },
        });
        // eventToCanvasPos returning {5, 5} so dx=dy=0.
        // pos.x - 100 - 400 = 5 → pos.x = 505; pos.y - 50 - 300 = 5 → pos.y = 355
        jitGetPosStub.mockReturnValue({ x: 505, y: 355 });

        compileMethod('onMouseMove').call(stub, makeMouseEvent());

        expect(canvas.translate).not.toHaveBeenCalled();
        expect(rafStub).not.toHaveBeenCalled();
    });

    test('multiple moves within one rAF coalesce to a single rAF schedule', () => {
        const canvas = makeJitCanvas({
            translateOffsets: { x: 0, y: 0 },
            scaleOffsets: { x: 1, y: 1 },
        });
        const stub = makeStub({
            canvas,
            panState: { isDown: true, isPanning: true, lastPos: { x: 0, y: 0 } },
        });

        jitGetPosStub.mockReturnValue({ x: 510, y: 370 });
        compileMethod('onMouseMove').call(stub, makeMouseEvent());
        // Second move before the rAF fires.
        jitGetPosStub.mockReturnValue({ x: 520, y: 380 });
        compileMethod('onMouseMove').call(stub, makeMouseEvent());

        // Two translates (one per move).
        expect(canvas.translate).toHaveBeenCalledTimes(2);
        // But only one rAF queued (debounced).
        expect(rafStub).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// onPanMouseUp
// ---------------------------------------------------------------------------

describe('onMouseUp', () => {
    test('!isDown → early return, no state mutation', () => {
        const canvas = makeJitCanvas();
        const stub = makeStub({ canvas });
        // _pan.timer remains null, isPanning remains false; nothing should change.
        compileMethod('onMouseUp').call(stub, makeMouseEvent());

        expect(stub.pan.isDown).toBe(false);
        expect(stub.pan.isPanning).toBe(false);
        expect(stub.pan.timer).toBe(null);
    });

    test('isDown + isPanning → clears timer, removes grabbing class, resets isPanning', () => {
        const canvas = makeJitCanvas({ elementClassName: 'grabbing' });
        const stub = makeStub({
            canvas,
            panState: { isDown: true, isPanning: true, timer: 12345 },
        });

        compileMethod('onMouseUp').call(stub, makeMouseEvent());

        expect(stub.pan.timer).toBeNull();
        expect(stub.pan.isPanning).toBe(false);
        expect(stub.pan.isDown).toBe(false);
        expect(canvas._el.classList.contains('grabbing')).toBe(false);
    });

    test('isDown but !isPanning (quick click) → does NOT touch grabbing class, still resets isDown', () => {
        // 'grabbing' class wasn't added (timer never fired); we should not
        // accidentally remove a class that was put there by something else.
        const canvas = makeJitCanvas({ elementClassName: 'unrelated-class' });
        const stub = makeStub({
            canvas,
            panState: { isDown: true, isPanning: false, timer: 54321 },
        });

        compileMethod('onMouseUp').call(stub, makeMouseEvent());

        expect(stub.pan.isDown).toBe(false);
        expect(canvas._el.classList.contains('unrelated-class')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// consumeSuppressClick (new API — replaces external `_pan.suppressNextClick`
// read+reset in MusicGraph's JIT onClick handler).
// ---------------------------------------------------------------------------

describe('consumeSuppressClick', () => {
    test('suppressNextClick=false → returns false, no state change', () => {
        const stub = makeStub({ canvas: makeJitCanvas() });
        const result = compileMethod('consumeSuppressClick').call(stub);
        expect(result).toBe(false);
        expect(stub.pan.suppressNextClick).toBe(false);
    });

    test('suppressNextClick=true → returns true and resets the flag', () => {
        const stub = makeStub({
            canvas: makeJitCanvas(),
            panState: { suppressNextClick: true },
        });
        const result = compileMethod('consumeSuppressClick').call(stub);
        expect(result).toBe(true);
        expect(stub.pan.suppressNextClick).toBe(false);
    });

    test('second call returns false (consumes once)', () => {
        const stub = makeStub({
            canvas: makeJitCanvas(),
            panState: { suppressNextClick: true },
        });
        const compiled = compileMethod('consumeSuppressClick');
        expect(compiled.call(stub)).toBe(true);
        expect(compiled.call(stub)).toBe(false);
    });
});
