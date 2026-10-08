/**
 * Whether the device has a pointer that can hover.
 *
 * Asked by anything whose interaction differs between a mouse and a finger —
 * edge navigation, the release orbit — so there is one definition rather than a
 * media query copied into each of them with its own idea of the breakpoint.
 *
 * Deliberately a capability query and not a width one: a touchscreen laptop at
 * 1440px needs touch-sized targets, and a 390px window on a desktop does not.
 * Viewport width answers a different question.
 *
 * @module visualization/pointerCapability
 */

/**
 * @param {Window} [win]
 * @returns {boolean} true when a hovering, fine pointer is present
 */
export function canHover(win = window) {
    return !!win.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches;
}
