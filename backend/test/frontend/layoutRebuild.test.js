/**
 * Deciding whether the layout tree can be rebuilt without anyone noticing.
 * See frontend/src/visualization/layoutRebuild.js.
 *
 * Navigation is a translation, which leaves the selection's own neighbours out
 * at 0.937 while strangers sit at 0.809. Rebuilding the tree fixes that and
 * normally rearranges the scene — but not when there is nothing legible on
 * screen to rearrange, which after a step somewhere sparse is often the case.
 *
 * These pin the arithmetic. That it holds in the running application, and that
 * the rebuild stays inside its gate there, is in
 * frontend/test/e2e/rigidMotion.spec.mjs.
 */

import {
    LEGIBLE_RADIUS,
    ORIGIN_RADIUS,
    angleWeight,
    bestFitRotation,
    rebuildVerdict,
} from '../../../frontend/src/visualization/layoutRebuild.js';

const DEG = Math.PI / 180;

/** A node that moved from one angle to another, at a radius that votes. */
const moved = (fromTheta, toTheta, rho = 0.5) => ({
    fromTheta, toTheta, fromRho: rho, toRho: rho,
});

describe('which nodes get a vote', () => {
    test('a node at the origin has no angle, so it does not vote', () => {
        // The focused node is always at the origin, and its theta is whatever
        // the layout last left in the field.
        expect(angleWeight(0)).toBe(0);
    });

    test('the cutoff is a radius, not a special-case on exactly zero', () => {
        expect(angleWeight(ORIGIN_RADIUS - 0.0001)).toBe(0);
        expect(angleWeight(ORIGIN_RADIUS)).toBeGreaterThan(0);
    });

    test('a node past the rim threshold has no vote at all', () => {
        // Not merely a small weight. Past here it is a dot among dots, and the
        // fit exists to agree with what the visitor can actually see.
        expect(angleWeight(LEGIBLE_RADIUS)).toBe(0);
        expect(angleWeight(LEGIBLE_RADIUS - 0.0001)).toBeGreaterThan(0);
    });

    test('a node near the centre counts for more than one further out', () => {
        expect(angleWeight(0.3)).toBeGreaterThan(angleWeight(0.8));
    });

    test('a radius outside the disk is not a position', () => {
        expect(angleWeight(1.4)).toBe(0);
        expect(angleWeight(NaN)).toBe(0);
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
            { fromTheta: 1.0, toTheta: 5.9, fromRho: 0.97, toRho: 0.4 },
        ];
        expect(bestFitRotation([...real, ...noise])).toBeCloseTo(spin, 6);
    });

    test('weights a central node above an outer one when the two disagree', () => {
        const central = { fromTheta: 1.0, toTheta: 0.0, fromRho: 0.2, toRho: 0.2 };
        const outer = { fromTheta: 0.0, toTheta: 1.0, fromRho: 0.85, toRho: 0.85 };
        // The central node wants +1 rad, the outer one wants -1. The answer
        // must lean the central node's way, not split the difference.
        expect(bestFitRotation([central, outer])).toBeGreaterThan(0.5);
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

describe('whether a rebuild can be taken', () => {
    /* 273px is the disk radius on a 1280x800 desktop; the numbers below are in
       those pixels, which is the only unit that answers "would anyone see it". */
    const DISK = 273;
    const GATE = 4;

    const sample = (fromTheta, fromRho, toTheta, toRho) => ({
        fromTheta, fromRho, toTheta, toRho,
    });

    test('an empty view is free, because there is nothing to disturb', () => {
        // The case that makes the whole rule worth having: step somewhere
        // sparse and the rebuild costs literally nothing.
        const samples = [
            sample(0, 0, 0, 0),              // the focus
            sample(1.2, 0.95, 4.4, 0.51),    // out at the rim, arriving
            sample(2.0, 0.99, 0.3, 0.83),
        ];
        const v = rebuildVerdict(samples, DISK, GATE);
        expect(v.judged).toBe(0);
        expect(v.free).toBe(true);
    });

    test('a node near the centre that moves is still judged', () => {
        // The focus is excluded because it is pinned to the origin in both
        // layouts. That must not become "anything near the middle is ignored",
        // which is where a visible jump would hide.
        const samples = [
            sample(0, 0, 0, 0),
            sample(1.0, 0.05, 2.4, 0.3),
        ];
        const v = rebuildVerdict(samples, DISK, GATE);
        expect(v.judged).toBe(1);
        expect(v.free).toBe(false);
    });

    test('a node arriving from the rim is not counted against it', () => {
        // That node travelling a long way is the gain being sought. Only where
        // the legible ones end up matters.
        const samples = [
            sample(1.0, 0.5, 1.0, 0.5),      // legible, does not move
            sample(0.4, 0.98, 3.4, 0.2),     // was invisible, arrives at the middle
        ];
        expect(rebuildVerdict(samples, DISK, GATE).free).toBe(true);
    });

    test('a legible node moving a long way blocks it', () => {
        const samples = [
            sample(1.0, 0.5, 1.0, 0.5),
            sample(2.0, 0.5, 4.0, 0.5),      // swings right across the disk
        ];
        const v = rebuildVerdict(samples, DISK, GATE);
        expect(v.judged).toBe(2);
        expect(v.worstPx).toBeGreaterThan(GATE);
        expect(v.free).toBe(false);
    });

    test('a rotation of the whole scene does not block it, because it is taken out', () => {
        // Every node turning by the same angle is not a rearrangement, it is
        // the scene facing a different way, and the fit absorbs it.
        const spin = 0.7;
        const samples = [0.3, 1.5, 2.9, 4.6].map((t) => sample(t, 0.5, t - spin, 0.5));
        const v = rebuildVerdict(samples, DISK, GATE);
        expect(v.spin).toBeCloseTo(spin, 6);
        expect(v.free).toBe(true);
    });

    test('the measurement is in pixels, so the same layout change scales with the disk', () => {
        // A shift that is nothing on a monitor can be visible on a phone only
        // if the disk is bigger there, which it is not — but the arithmetic
        // has to be in the unit the eye uses either way.
        const samples = [sample(0, 0.5, 0.02, 0.5)];
        const small = rebuildVerdict(samples, 100, GATE).worstPx;
        const large = rebuildVerdict(samples, 400, GATE).worstPx;
        expect(large / small).toBeCloseTo(4, 6);
    });

    test('a hair under the gate is free and a hair over is not', () => {
        const justUnder = [sample(0, 0.5, 0, 0.5 - (GATE * 0.9) / DISK)];
        const justOver = [sample(0, 0.5, 0, 0.5 - (GATE * 1.1) / DISK)];
        expect(rebuildVerdict(justUnder, DISK, GATE).free).toBe(true);
        expect(rebuildVerdict(justOver, DISK, GATE).free).toBe(false);
    });
});
