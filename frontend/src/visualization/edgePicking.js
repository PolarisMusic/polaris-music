/**
 * Finding the edge under the pointer.
 *
 * JIT does not do this. `EdgeHelper.hyperline.contains` is `$.lambda(false)`
 * (`public/lib/jit.js`), so the library will never report an edge hit for a
 * Hypertree — every `onClick` with no node under it comes through with
 * `node === null` and the edge is invisible to the event system.
 *
 * The reason it was left unimplemented is that a Hypertree edge is not a line.
 * In the Poincaré disk the geodesic between two points is the arc of the circle
 * through both that meets the unit circle at right angles, and JIT draws it
 * with `ctx.arc`. So hit-testing means measuring to an arc, and the arc has to
 * be the *same* arc the renderer drew or the hit lands where nothing is.
 *
 * Everything here therefore mirrors `EdgeHelper.hyperline.render`'s own
 * arithmetic, including the two places it gives up and draws a straight line
 * instead. Where that arithmetic looks odd — a `> 1000` test with no matching
 * `< -1000` — it is reproduced odd, because the question this module answers is
 * not "where is the geodesic" but "where did JIT put the pixels".
 *
 * All coordinates are normalised Poincaré coordinates, x and y in [-1, 1), the
 * same ones `node.pos.getc()` returns and `Hypertree` hands to the edge
 * renderer. Scaling to pixels is the caller's job.
 *
 * @module visualization/edgePicking
 */

const TAU = Math.PI * 2;

/**
 * The circle a hyperline is an arc of.
 *
 * Mirrors `computeArcThroughTwoPoints` inside `EdgeHelper.hyperline.render`,
 * and folds in the render function's own straight-line fallbacks: null here
 * means JIT drew a straight segment, not that the input was invalid.
 *
 * @param {{x: number, y: number}} p1
 * @param {{x: number, y: number}} p2
 * @returns {{x: number, y: number, radius: number}|null} null when JIT would
 *   have drawn a straight line instead of an arc
 */
export function arcThroughTwoPoints(p1, p2) {
    const den = p1.x * p2.y - p1.y * p2.x;
    // Collinear with the origin: the geodesic *is* a diameter.
    if (den === 0) return null;

    const sq1 = p1.x * p1.x + p1.y * p1.y;
    const sq2 = p2.x * p2.x + p2.y * p2.y;

    const a = (p1.y * sq2 - p2.y * sq1 + p1.y - p2.y) / den;
    const b = (p2.x * sq1 - p1.x * sq2 + p2.x - p1.x) / den;

    const squaredRadius = (a * a + b * b) / 4 - 1;
    if (squaredRadius < 0) return null;

    const radius = Math.sqrt(squaredRadius);
    // JIT's own two bail-outs, kept asymmetric exactly as it has them: the
    // renderer tests `a > 1000 || b > 1000` and computeArc clamps `ratio > 1000`
    // to -1, which the renderer then reads as "straight line".
    if (radius > 1000 || a > 1000 || b > 1000) return null;

    return { x: -a / 2, y: -b / 2, radius };
}

/**
 * Which way round `ctx.arc` was told to sweep.
 *
 * Mirrors the `sense()` helper in `EdgeHelper.hyperline.render`, whose result
 * becomes the `counterclockwise` argument. Reproduced rather than re-derived:
 * a cleaner rule would pick the other half of the circle on some pairs, and
 * the other half is where the pixels are not.
 *
 * @param {number} angleBegin
 * @param {number} angleEnd
 * @returns {boolean} true for counterclockwise
 */
export function arcSense(angleBegin, angleEnd) {
    return angleBegin < angleEnd
        ? !(angleBegin + Math.PI > angleEnd)
        : angleEnd + Math.PI > angleBegin;
}

/** @private Angle into [0, 2π). */
function normalizeAngle(angle) {
    return ((angle % TAU) + TAU) % TAU;
}

/**
 * Whether an angle falls inside the swept part of the circle.
 *
 * @param {number} begin
 * @param {number} end
 * @param {boolean} counterclockwise
 * @param {number} angle
 * @returns {boolean}
 */
export function angleWithinSweep(begin, end, counterclockwise, angle) {
    const span = counterclockwise
        ? normalizeAngle(begin - end)
        : normalizeAngle(end - begin);
    const offset = counterclockwise
        ? normalizeAngle(begin - angle)
        : normalizeAngle(angle - begin);
    return offset <= span;
}

/** @private */
function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Distance from a point to a straight segment.
 *
 * @param {{x: number, y: number}} from
 * @param {{x: number, y: number}} to
 * @param {{x: number, y: number}} point
 * @returns {number}
 */
export function distanceToSegment(from, to, point) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return distance(point, from);

    // Projection parameter, clamped to the segment so a point beyond an
    // endpoint measures to the endpoint rather than to the infinite line.
    const t = Math.max(0, Math.min(1,
        ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared));

    return distance(point, { x: from.x + t * dx, y: from.y + t * dy });
}

/**
 * Distance from a point to the hyperline JIT drew between two nodes.
 *
 * @param {{x: number, y: number}} from
 * @param {{x: number, y: number}} to
 * @param {{x: number, y: number}} point
 * @returns {number} in normalised disk units
 */
export function distanceToHyperline(from, to, point) {
    const arc = arcThroughTwoPoints(from, to);
    if (!arc) return distanceToSegment(from, to, point);

    // `render` takes its angles from `to` first and `from` second; the sweep
    // direction depends on that order, so it is kept.
    const begin = Math.atan2(to.y - arc.y, to.x - arc.x);
    const end = Math.atan2(from.y - arc.y, from.x - arc.x);
    const angle = Math.atan2(point.y - arc.y, point.x - arc.x);

    if (angleWithinSweep(begin, end, arcSense(begin, end), angle)) {
        return Math.abs(distance(point, arc) - arc.radius);
    }

    // Off the end of the drawn arc: the nearest drawn pixel is an endpoint.
    return Math.min(distance(point, from), distance(point, to));
}

/**
 * The nearest edge to a point, if any is near enough.
 *
 * @param {Array<{from: {x: number, y: number}, to: {x: number, y: number}, id: string}>} edges
 * @param {{x: number, y: number}} point
 * @param {number} maxDistance - in normalised disk units
 * @returns {{id: string, distance: number}|null}
 */
export function pickEdge(edges, point, maxDistance) {
    let best = null;

    for (const edge of edges) {
        const d = distanceToHyperline(edge.from, edge.to, point);
        // Strictly nearer, so the first of two equidistant edges wins and the
        // pick does not flicker between them as the list order changes.
        if (d <= maxDistance && (best === null || d < best.distance)) {
            best = { id: edge.id, distance: d };
        }
    }

    return best;
}
