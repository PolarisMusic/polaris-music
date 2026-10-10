/**
 * What a drag on the info sheet's handle means.
 *
 * The handle looked draggable and was not — a 36×3px grabber above a sheet
 * whose only control was the ✕ beside the title. A thing shaped like a
 * grabber either grabs or should not be there, and the sheet already has two
 * states to move between, so it grabs.
 *
 * Only the decision lives here: given where the sheet is, how far the finger
 * moved and how fast it was going, which state should it land in. The pointer
 * plumbing and the transform belong to the caller, and the decision is the part
 * worth testing, because distance-only snapping ignores a flick and
 * velocity-only snapping ignores a slow, deliberate drag.
 *
 * @module visualization/sheetGesture
 */

/** How far a slow drag must travel to change state. */
export const SHEET_SNAP_DISTANCE_PX = 48;

/**
 * How fast a short drag must be going to count as a flick, in px/ms.
 *
 * 0.5 px/ms is 500px/s — brisk, and clear of the speed a finger reaches while
 * settling into a slow drag, so a careful half-gesture does not snap.
 */
export const SHEET_FLICK_VELOCITY_PX_PER_MS = 0.5;

/**
 * Where the sheet should end up.
 *
 * `deltaY` is positive downwards, matching clientY. A flick wins over distance:
 * someone who has flicked has already committed, and holding them to 48px
 * would ignore it.
 *
 * @param {object} gesture
 * @param {'peek'|'open'} gesture.state - where the sheet started
 * @param {number} gesture.deltaY - total movement, positive downwards
 * @param {number} gesture.velocity - px/ms at release, signed like deltaY
 * @returns {'peek'|'open'}
 */
export function resolveSheetDrag({ state, deltaY, velocity = 0 }) {
    const flicked = Math.abs(velocity) >= SHEET_FLICK_VELOCITY_PX_PER_MS;
    const travelled = Math.abs(deltaY) >= SHEET_SNAP_DISTANCE_PX;

    if (!flicked && !travelled) return state;

    // A flick is judged on its own direction, which can disagree with the net
    // distance — a drag down and back up ends near where it started but is
    // released moving upwards, and upwards is what the person meant.
    const downwards = flicked ? velocity > 0 : deltaY > 0;

    return downwards ? 'peek' : 'open';
}

/**
 * How far the sheet may follow the finger, so a drag cannot pull it off screen
 * or lift it above its open position.
 *
 * Opening upwards is bounded by nothing useful — the sheet is already as tall
 * as it gets — so an upward drag from `open` is resisted entirely, and a
 * downward drag from `peek` likewise. Each state can only move the way it has
 * somewhere to go.
 *
 * @param {'peek'|'open'} state
 * @param {number} deltaY
 * @param {number} travel - the distance between the two resting positions
 * @returns {number} the translation to apply, positive downwards
 */
export function clampSheetDrag(state, deltaY, travel) {
    if (state === 'open') return Math.max(0, Math.min(deltaY, travel));
    return Math.min(0, Math.max(deltaY, -travel));
}
