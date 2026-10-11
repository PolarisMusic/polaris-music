/**
 * The rotation that keeps the map pointing the same way when the hypertree is
 * rebuilt. See frontend/src/visualization/layoutOrientation.js.
 *
 * Measured in the app, the rebuild spun the whole scene by 21 to 135 degrees on
 * every click. These pin the arithmetic that takes the spin out; the end-to-end
 * half (that the spin really is gone, and that the canvas resize no longer
 * canonicalises the layout underneath it) is in
 * frontend/test/e2e/orientation.spec.mjs.
 */

import {
    ORIGIN_RADIUS,
    angleWeight,
    bestFitRotation,
} from '../../../frontend/src/visualization/layoutOrientation.js';

const DEG = Math.PI / 180;

/** A node that moved from one angle to another, both at a usable radius. */
const moved = (fromTheta, toTheta, rho = 0.5) => ({
    fromTheta, toTheta, fromRho: rho, toRho: rho,
});

describe('which nodes get a vote', () => {
    test('a node at the origin has no angle, so it does not vote', () => {
        // The focused node is always at the origin and the one focused a moment
        // ago is near it. They are the nodes the eye cares about most and the
        // ones whose angle is pure noise.
        expect(angleWeight(0, 0.5)).toBe(0);
        expect(angleWeight(0.5, 0)).toBe(0);
    });

    test('the cutoff is a radius, not a special-case on exactly zero', () => {
        expect(angleWeight(ORIGIN_RADIUS - 0.0001, 0.5)).toBe(0);
        expect(angleWeight(ORIGIN_RADIUS, 0.5)).toBeGreaterThan(0);
    });

    test('a node near the centre counts for more than one at the rim', () => {
        expect(angleWeight(0.3, 0.3)).toBeGreaterThan(angleWeight(0.9, 0.9));
    });

    test('a node central in one layout and at the rim in the other is discounted', () => {
        // It moved because its place in the graph changed, which is information,
        // not something the whole scene should be rotated to chase.
        expect(angleWeight(0.2, 0.95)).toBeLessThan(angleWeight(0.2, 0.2));
    });

    test('a radius outside the disk is not a position', () => {
        expect(angleWeight(1.4, 0.5)).toBe(0);
        expect(angleWeight(0.5, 1.4)).toBe(0);
        expect(angleWeight(NaN, 0.5)).toBe(0);
    });
});

describe('the best-fit rotation', () => {
    test('is zero when nothing moved', () => {
        expect(bestFitRotation([moved(1, 1), moved(2, 2), moved(3, 3)])).toBeCloseTo(0, 6);
    });

    test('recovers a rigid rotation exactly', () => {
        const spin = 40 * DEG;
        const samples = [0.3, 1.9, 4.4, 5.8].map((t) => moved(t + spin, t));
        expect(bestFitRotation(samples)).toBeCloseTo(spin, 6);
    });

    test('recovers a rotation that crosses zero', () => {
        // Averaging angles as plain numbers puts 359 and 1 degree at 180. This
        // is the case that catches it.
        const samples = [moved(1 * DEG, 358 * DEG), moved(359 * DEG, 356 * DEG)];
        expect(bestFitRotation(samples) / DEG).toBeCloseTo(3, 4);
    });

    test('never answers more than half a turn', () => {
        // A 350 degree spin is a 10 degree spin the other way, and the scene
        // should take the short way round.
        const samples = [0.4, 2.2, 5.0].map((t) => moved(t + 350 * DEG, t));
        expect(Math.abs(bestFitRotation(samples))).toBeLessThanOrEqual(Math.PI);
        expect(bestFitRotation(samples) / DEG).toBeCloseTo(-10, 4);
    });

    test('ignores the nodes with no vote rather than letting them drag the fit', () => {
        const spin = 25 * DEG;
        const real = [0.5, 2.0, 3.6].map((t) => moved(t + spin, t));
        const noise = [
            { fromTheta: 3.0, toTheta: 0.1, fromRho: 0, toRho: 0.4 },
            { fromTheta: 1.0, toTheta: 5.9, fromRho: 0.4, toRho: 0 },
        ];
        expect(bestFitRotation([...real, ...noise])).toBeCloseTo(spin, 6);
    });

    test('weights a central node above a rim node when the two disagree', () => {
        const central = { fromTheta: 1.0, toTheta: 0.0, fromRho: 0.2, toRho: 0.2 };
        const rim = { fromTheta: 0.0, toTheta: 1.0, fromRho: 0.97, toRho: 0.97 };
        // The central node wants +1 rad, the rim node wants -1. The answer must
        // lean the central node's way rather than splitting the difference.
        expect(bestFitRotation([central, rim])).toBeGreaterThan(0.5);
    });

    test('is zero when there is nothing to compare', () => {
        expect(bestFitRotation([])).toBe(0);
        expect(bestFitRotation([{ fromTheta: 1, toTheta: 2, fromRho: 0, toRho: 0 }])).toBe(0);
    });

    test('is zero when the samples cancel exactly, rather than picking a side', () => {
        // Two nodes asking for opposite rotations with equal weight: the mean
        // direction genuinely does not exist. Not rotating is the answer.
        const samples = [
            { fromTheta: 1.0, toTheta: 0.0, fromRho: 0.5, toRho: 0.5 },
            { fromTheta: 0.0, toTheta: 1.0, fromRho: 0.5, toRho: 0.5 },
        ];
        expect(bestFitRotation(samples)).toBe(0);
    });
});
