/**
 * Keeping the map pointing the same way when the layout is rebuilt.
 *
 * Centring on a node rebuilds the hypertree with that node as root (see
 * MusicGraph.centreOn for why). JIT's computePositions (jit.js:11961) hands the
 * root's first child the angular slice starting at theta = 0 and fans the rest
 * round from there in adjacency order, so the absolute orientation of the whole
 * scene is an accident of which node happens to be first. Nothing ties it to
 * where anything was a moment ago.
 *
 * Measured with scripts/measureOrientation.mjs, that accident rotated the
 * entire scene by 21 to 135 degrees on every single click. A rigid rotation
 * carries no information at all — it is the thing that reads as a shuffle, and
 * it is removable, because a rotation of the Poincare disk about the origin is
 * an isometry: it changes nothing about the layout except which way it faces.
 *
 * So pick the one rotation that best carries the new layout onto the old one
 * and apply it. The remaining motion is then the part that means something:
 * nodes whose place in the graph relative to the focus genuinely changed.
 *
 * Measured after: 12 to 20 degrees of residual on a step between adjacent
 * nodes, against 25 to 135 of spin before.
 *
 * Rejected, with numbers: anchoring instead on "the node you came from lands
 * behind you", which is what a Mobius translation does and what the old
 * navigation felt like. It costs 87 degrees of residual where the best fit
 * costs 19. The two agree only when the departure node sits at the centre of a
 * star. The walk intuition does not survive re-rooting, because re-rooting is
 * not a motion through a fixed space — it builds a different space.
 */

/**
 * A node at the origin has no angle. theta is whatever the layout last left in
 * the field and a sub-pixel wobble swings it by pi, so the focused node and the
 * one focused a moment ago — the two the eye cares about most — are exactly the
 * samples that must not vote.
 */
export const ORIGIN_RADIUS = 0.15;

/**
 * How much a node's angle counts towards the fit.
 *
 * Nodes near the rim are crowded, small, and not what anyone is following; a
 * node near the centre is. Both radii matter: a node that was central and is
 * now at the rim has moved for a reason, and should not drag the whole scene
 * after it.
 *
 * @param {number} fromRho radius in the layout being left
 * @param {number} toRho radius in the layout being entered
 * @returns {number} weight, 0 when either position is unusable
 */
export function angleWeight(fromRho, toRho) {
    if (!(fromRho >= ORIGIN_RADIUS) || !(toRho >= ORIGIN_RADIUS)) return 0;
    if (!(fromRho <= 1) || !(toRho <= 1)) return 0;
    return (1 - fromRho) * (1 - toRho);
}

/**
 * The rotation that best carries the new layout onto the old one.
 *
 * This is the circular mean of the per-node angular differences, which is the
 * exact minimiser of the weighted sum of 1 - cos(error) — the right objective
 * on a circle, and the reason this needs no iteration. Averaging the angles as
 * numbers would be wrong: 359 and 1 degree average to 180.
 *
 * @param {Array<{fromTheta: number, fromRho: number, toTheta: number, toRho: number}>} samples
 * @returns {number} radians to add to every angle of the new layout; 0 when
 *   nothing in the two layouts can be compared
 */
export function bestFitRotation(samples) {
    let re = 0;
    let im = 0;

    for (const s of samples) {
        const w = angleWeight(s.fromRho, s.toRho);
        if (w === 0) continue;
        const d = s.fromTheta - s.toTheta;
        re += w * Math.cos(d);
        im += w * Math.sin(d);
    }

    // No usable samples, or samples that cancel exactly: both give a resultant
    // at the origin, where the mean direction is undefined. Not rotating is the
    // honest answer, and atan2(0, 0) returning 0 happens to be it — but say so
    // rather than leaning on that.
    if (re === 0 && im === 0) return 0;

    return Math.atan2(im, re);
}
