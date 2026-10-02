/**
 * Hit-testing a Hypertree edge.
 *
 * The thing that makes this worth testing hard is that the answer has to agree
 * with a renderer we do not control. A distance function that is beautifully
 * correct about hyperbolic geodesics but disagrees with what JIT's `ctx.arc`
 * actually drew produces a UI where clicking the line does nothing and clicking
 * next to it works.
 *
 * So the tests check the geometry two independent ways: against the defining
 * property of a Poincaré geodesic (its circle passes through both endpoints and
 * meets the unit circle at right angles), and against points sampled along the
 * arc itself, which is where the pixels are.
 */

import {
    arcThroughTwoPoints,
    arcSense,
    angleWithinSweep,
    distanceToSegment,
    distanceToHyperline,
    pickEdge,
} from '../../../frontend/src/visualization/edgePicking.js';

/** A deterministic spread of point pairs inside the disk, avoiding diameters. */
function* pointPairs() {
    for (let i = 1; i <= 9; i++) {
        for (let j = 1; j <= 9; j++) {
            const r1 = i / 10;
            const r2 = j / 10;
            // Angles chosen so no pair is collinear with the origin.
            const a1 = (i * 0.7) % (Math.PI * 2);
            const a2 = a1 + 0.4 + (j * 0.21) % 2.2;
            yield [
                { x: r1 * Math.cos(a1), y: r1 * Math.sin(a1) },
                { x: r2 * Math.cos(a2), y: r2 * Math.sin(a2) },
            ];
        }
    }
}

const norm = (p) => Math.hypot(p.x, p.y);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

describe('the circle a hyperline is an arc of', () => {
    test('passes through both endpoints', () => {
        // The real test of the transcribed arithmetic: a sign error in a or b
        // still yields a circle, just not one touching the nodes.
        for (const [p1, p2] of pointPairs()) {
            const arc = arcThroughTwoPoints(p1, p2);
            if (!arc) continue;
            expect(dist(p1, arc)).toBeCloseTo(arc.radius, 9);
            expect(dist(p2, arc)).toBeCloseTo(arc.radius, 9);
        }
    });

    test('meets the unit circle at right angles, which is what makes it a geodesic', () => {
        // Orthogonality to the boundary: |centre|² = 1 + r².
        for (const [p1, p2] of pointPairs()) {
            const arc = arcThroughTwoPoints(p1, p2);
            if (!arc) continue;
            expect(norm(arc) ** 2).toBeCloseTo(1 + arc.radius ** 2, 9);
        }
    });

    test('its centre lies outside the disk, as orthogonality requires', () => {
        for (const [p1, p2] of pointPairs()) {
            const arc = arcThroughTwoPoints(p1, p2);
            if (!arc) continue;
            expect(norm(arc)).toBeGreaterThan(1);
        }
    });

    test('a pair collinear with the origin has no arc — JIT draws a diameter', () => {
        expect(arcThroughTwoPoints({ x: -0.5, y: 0 }, { x: 0.5, y: 0 })).toBeNull();
        expect(arcThroughTwoPoints({ x: 0.2, y: 0.2 }, { x: -0.6, y: -0.6 })).toBeNull();
        expect(arcThroughTwoPoints({ x: 0, y: -0.3 }, { x: 0, y: 0.8 })).toBeNull();
    });

    test('a point paired with the origin has no arc', () => {
        // Every geodesic through the centre is a diameter.
        expect(arcThroughTwoPoints({ x: 0, y: 0 }, { x: 0.5, y: 0.5 })).toBeNull();
    });

    test('a pair too nearly collinear to curve is a straight line too', () => {
        // JIT bails at a > 1000 or b > 1000 rather than drawing an arc of
        // enormous radius, and so must this, or the hit test measures to a
        // curve the renderer never drew.
        const arc = arcThroughTwoPoints({ x: 0.5, y: 1e-7 }, { x: -0.5, y: -1e-7 });
        expect(arc).toBeNull();
    });
});

describe('distance to a hyperline', () => {
    test('is zero at either endpoint', () => {
        for (const [p1, p2] of pointPairs()) {
            expect(distanceToHyperline(p1, p2, p1)).toBeCloseTo(0, 9);
            expect(distanceToHyperline(p1, p2, p2)).toBeCloseTo(0, 9);
        }
    });

    test('is zero all along the drawn arc', () => {
        // Sampled on the arc between the endpoints — the pixels themselves.
        for (const [p1, p2] of pointPairs()) {
            const arc = arcThroughTwoPoints(p1, p2);
            if (!arc) continue;

            const begin = Math.atan2(p2.y - arc.y, p2.x - arc.x);
            const end = Math.atan2(p1.y - arc.y, p1.x - arc.x);
            const ccw = arcSense(begin, end);
            const TAU = Math.PI * 2;
            const wrap = (v) => ((v % TAU) + TAU) % TAU;
            const span = ccw ? wrap(begin - end) : wrap(end - begin);

            for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
                const angle = ccw ? begin - span * t : begin + span * t;
                const onArc = {
                    x: arc.x + arc.radius * Math.cos(angle),
                    y: arc.y + arc.radius * Math.sin(angle),
                };
                expect(distanceToHyperline(p1, p2, onArc)).toBeCloseTo(0, 9);
            }
        }
    });

    test('grows by exactly how far off the arc the point is', () => {
        for (const [p1, p2] of pointPairs()) {
            const arc = arcThroughTwoPoints(p1, p2);
            if (!arc) continue;

            const begin = Math.atan2(p2.y - arc.y, p2.x - arc.x);
            const end = Math.atan2(p1.y - arc.y, p1.x - arc.x);
            const ccw = arcSense(begin, end);
            const TAU = Math.PI * 2;
            const wrap = (v) => ((v % TAU) + TAU) % TAU;
            const mid = ccw ? begin - wrap(begin - end) / 2 : begin + wrap(end - begin) / 2;

            for (const offset of [0.01, -0.01, 0.05]) {
                const point = {
                    x: arc.x + (arc.radius + offset) * Math.cos(mid),
                    y: arc.y + (arc.radius + offset) * Math.sin(mid),
                };
                expect(distanceToHyperline(p1, p2, point)).toBeCloseTo(Math.abs(offset), 9);
            }
        }
    });

    test('a point on the far side of the circle measures to an endpoint, not the circle', () => {
        // The half of the circle JIT did not draw must not be clickable. Without
        // the sweep check this point reads as a hit directly on the edge.
        const p1 = { x: 0.6, y: 0.1 };
        const p2 = { x: 0.1, y: 0.6 };
        const arc = arcThroughTwoPoints(p1, p2);
        expect(arc).not.toBeNull();

        const begin = Math.atan2(p2.y - arc.y, p2.x - arc.x);
        const end = Math.atan2(p1.y - arc.y, p1.x - arc.x);
        const ccw = arcSense(begin, end);
        const TAU = Math.PI * 2;
        const wrap = (v) => ((v % TAU) + TAU) % TAU;
        const span = ccw ? wrap(begin - end) : wrap(end - begin);
        // Just outside the sweep, still exactly on the circle.
        const outside = ccw ? begin + 0.3 : begin - 0.3;
        expect(span).toBeLessThan(TAU - 0.3);

        const onCircleOffArc = {
            x: arc.x + arc.radius * Math.cos(outside),
            y: arc.y + arc.radius * Math.sin(outside),
        };

        const d = distanceToHyperline(p1, p2, onCircleOffArc);
        expect(d).toBeCloseTo(Math.min(dist(onCircleOffArc, p1), dist(onCircleOffArc, p2)), 9);
        expect(d).toBeGreaterThan(0.001);
    });

    test('a diameter is measured as the segment it is drawn as', () => {
        const p1 = { x: -0.5, y: 0 };
        const p2 = { x: 0.5, y: 0 };
        expect(distanceToHyperline(p1, p2, { x: 0, y: 0 })).toBeCloseTo(0, 9);
        expect(distanceToHyperline(p1, p2, { x: 0, y: 0.1 })).toBeCloseTo(0.1, 9);
        // Past the end of the segment, not alongside the infinite line.
        expect(distanceToHyperline(p1, p2, { x: 0.9, y: 0 })).toBeCloseTo(0.4, 9);
    });
});

describe('distance to a segment', () => {
    test('measures perpendicular within the span and to an endpoint beyond it', () => {
        const from = { x: 0, y: 0 };
        const to = { x: 1, y: 0 };
        expect(distanceToSegment(from, to, { x: 0.5, y: 0.25 })).toBeCloseTo(0.25, 9);
        expect(distanceToSegment(from, to, { x: 2, y: 0 })).toBeCloseTo(1, 9);
        expect(distanceToSegment(from, to, { x: -1, y: 0 })).toBeCloseTo(1, 9);
    });

    test('a zero-length segment is its own point', () => {
        expect(distanceToSegment({ x: 0.2, y: 0.2 }, { x: 0.2, y: 0.2 }, { x: 0.2, y: 0.5 }))
            .toBeCloseTo(0.3, 9);
    });
});

describe('the sweep test', () => {
    test('an angle inside a clockwise sweep is inside', () => {
        expect(angleWithinSweep(0, 1, false, 0.5)).toBe(true);
        expect(angleWithinSweep(0, 1, false, 1.5)).toBe(false);
    });

    test('an angle inside a counterclockwise sweep is inside', () => {
        expect(angleWithinSweep(1, 0, true, 0.5)).toBe(true);
        expect(angleWithinSweep(1, 0, true, 1.5)).toBe(false);
    });

    test('a sweep across the wrap point still contains its own angles', () => {
        // begin just under 2π, end just over 0: the arithmetic has to wrap.
        expect(angleWithinSweep(6.2, 0.2, false, 6.28)).toBe(true);
        expect(angleWithinSweep(6.2, 0.2, false, 0.1)).toBe(true);
        expect(angleWithinSweep(6.2, 0.2, false, 3.0)).toBe(false);
    });
});

describe('picking the edge under the pointer', () => {
    const edges = [
        { id: 'near', from: { x: -0.5, y: 0 }, to: { x: 0.5, y: 0 } },
        { id: 'far', from: { x: -0.5, y: 0.8 }, to: { x: 0.5, y: 0.8 } },
    ];

    test('returns the nearer edge', () => {
        expect(pickEdge(edges, { x: 0, y: 0.05 }, 0.2).id).toBe('near');
        expect(pickEdge(edges, { x: 0, y: 0.75 }, 0.2).id).toBe('far');
    });

    test('returns nothing when everything is out of reach', () => {
        expect(pickEdge(edges, { x: 0, y: 0.4 }, 0.05)).toBeNull();
    });

    test('the threshold is inclusive, so an edge exactly at reach is pickable', () => {
        expect(pickEdge(edges, { x: 0, y: 0.1 }, 0.1)).not.toBeNull();
    });

    test('reports the distance, so a caller can prefer a node hit over an edge', () => {
        expect(pickEdge(edges, { x: 0, y: 0.05 }, 0.2).distance).toBeCloseTo(0.05, 9);
    });

    test('a tie goes to the first, so the pick does not flicker', () => {
        const tied = [
            { id: 'first', from: { x: -0.5, y: 0 }, to: { x: 0.5, y: 0 } },
            { id: 'second', from: { x: -0.5, y: 0 }, to: { x: 0.5, y: 0 } },
        ];
        expect(pickEdge(tied, { x: 0, y: 0.02 }, 0.2).id).toBe('first');
    });

    test('an empty graph picks nothing rather than throwing', () => {
        expect(pickEdge([], { x: 0, y: 0 }, 1)).toBeNull();
    });
});
