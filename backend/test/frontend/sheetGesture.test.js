/**
 * Snapping the info sheet.
 *
 * Two ways to get this wrong, and they are opposites. Distance-only snapping
 * ignores a flick, so a quick confident swipe does nothing. Velocity-only
 * snapping ignores a slow deliberate drag, so pulling the sheet two-thirds of
 * the way up and letting go drops it back.
 */

import {
    SHEET_SNAP_DISTANCE_PX,
    SHEET_FLICK_VELOCITY_PX_PER_MS,
    resolveSheetDrag,
    clampSheetDrag,
} from '../../../frontend/src/visualization/sheetGesture.js';

describe('a slow drag', () => {
    test('far enough upwards from peek opens the sheet', () => {
        expect(resolveSheetDrag({ state: 'peek', deltaY: -SHEET_SNAP_DISTANCE_PX, velocity: 0 }))
            .toBe('open');
    });

    test('far enough downwards from open collapses it', () => {
        expect(resolveSheetDrag({ state: 'open', deltaY: SHEET_SNAP_DISTANCE_PX, velocity: 0 }))
            .toBe('peek');
    });

    test('not far enough leaves the sheet where it was', () => {
        const short = SHEET_SNAP_DISTANCE_PX - 1;
        expect(resolveSheetDrag({ state: 'peek', deltaY: -short, velocity: 0 })).toBe('peek');
        expect(resolveSheetDrag({ state: 'open', deltaY: short, velocity: 0 })).toBe('open');
    });

    test('a nudge in the wrong direction does not change state', () => {
        // Dragging down from peek has nowhere to go; it must not read as "open".
        expect(resolveSheetDrag({ state: 'peek', deltaY: 200, velocity: 0 })).toBe('peek');
        expect(resolveSheetDrag({ state: 'open', deltaY: -200, velocity: 0 })).toBe('open');
    });
});

describe('a flick', () => {
    test('opens on a short fast upward gesture', () => {
        // 10px is nothing like the snap distance. The speed is the signal.
        expect(resolveSheetDrag({
            state: 'peek', deltaY: -10, velocity: -SHEET_FLICK_VELOCITY_PX_PER_MS,
        })).toBe('open');
    });

    test('collapses on a short fast downward gesture', () => {
        expect(resolveSheetDrag({
            state: 'open', deltaY: 10, velocity: SHEET_FLICK_VELOCITY_PX_PER_MS,
        })).toBe('peek');
    });

    test('below the flick speed, a short gesture is ignored', () => {
        expect(resolveSheetDrag({
            state: 'peek', deltaY: -10, velocity: -(SHEET_FLICK_VELOCITY_PX_PER_MS - 0.01),
        })).toBe('peek');
    });

    test('beats the net distance when the two disagree', () => {
        // Down and back up: ends near where it started, released moving up.
        // Upwards is what the person meant.
        expect(resolveSheetDrag({ state: 'peek', deltaY: 60, velocity: -1.2 })).toBe('open');
    });
});

describe('following the finger', () => {
    const TRAVEL = 250;

    test('an open sheet moves down but not up', () => {
        expect(clampSheetDrag('open', 80, TRAVEL)).toBe(80);
        expect(clampSheetDrag('open', -80, TRAVEL)).toBe(0);
    });

    test('a collapsed sheet moves up but not down', () => {
        expect(clampSheetDrag('peek', -80, TRAVEL)).toBe(-80);
        expect(clampSheetDrag('peek', 80, TRAVEL)).toBe(0);
    });

    test('neither can be dragged past the other resting position', () => {
        // Otherwise a long drag pulls the sheet off the screen, or lifts it
        // above the top of its own open state.
        expect(clampSheetDrag('open', 9999, TRAVEL)).toBe(TRAVEL);
        expect(clampSheetDrag('peek', -9999, TRAVEL)).toBe(-TRAVEL);
    });

    test('no movement is no translation', () => {
        expect(clampSheetDrag('open', 0, TRAVEL)).toBe(0);
        expect(clampSheetDrag('peek', 0, TRAVEL)).toBe(0);
    });
});

describe('the thresholds themselves', () => {
    test('the flick speed is brisk enough not to fire while settling', () => {
        // A finger easing into a slow drag passes through low speeds; 500px/s
        // is clear of them.
        expect(SHEET_FLICK_VELOCITY_PX_PER_MS).toBeGreaterThanOrEqual(0.4);
    });

    test('the snap distance is a real gesture, not a tap wobble', () => {
        expect(SHEET_SNAP_DISTANCE_PX).toBeGreaterThanOrEqual(32);
    });
});
