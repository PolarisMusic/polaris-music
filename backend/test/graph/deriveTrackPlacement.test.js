/**
 * @fileoverview Unit tests for deriveTrackPlacement()
 *
 * Verifies that track position strings are correctly parsed into
 * disc, side, and trackNo components across all supported formats.
 */

import { describe, it, expect } from '@jest/globals';
import { deriveTrackPlacement } from '../../src/graph/schema.js';

describe('deriveTrackPlacement', () => {
    describe('vinyl side format ("A1", "B2", "C10")', () => {
        it('should parse "A1" as side A, track 1', () => {
            const result = deriveTrackPlacement('A1', 0);
            expect(result).toEqual({ position: 'A1', disc: 1, side: 'A', trackNo: 1 });
        });

        it('should parse "B12" as side B, track 12', () => {
            const result = deriveTrackPlacement('B12', 0);
            expect(result).toEqual({ position: 'B12', disc: 1, side: 'B', trackNo: 12 });
        });

        it('should normalize lowercase side letter to uppercase', () => {
            const result = deriveTrackPlacement('c3', 0);
            expect(result).toEqual({ position: 'c3', disc: 1, side: 'C', trackNo: 3 });
        });
    });

    describe('disc.track format ("1.3", "2.07")', () => {
        it('should parse "1.1" as disc 1, track 1', () => {
            const result = deriveTrackPlacement('1.1', 0);
            expect(result).toEqual({ position: '1.1', disc: 1, side: null, trackNo: 1 });
        });

        it('should parse "2.07" as disc 2, track 7', () => {
            const result = deriveTrackPlacement('2.07', 0);
            expect(result).toEqual({ position: '2.07', disc: 2, side: null, trackNo: 7 });
        });

        it('should parse "1.12" as disc 1, track 12', () => {
            const result = deriveTrackPlacement('1.12', 0);
            expect(result).toEqual({ position: '1.12', disc: 1, side: null, trackNo: 12 });
        });

        it('should parse "3.1" as disc 3, track 1', () => {
            const result = deriveTrackPlacement('3.1', 5);
            expect(result).toEqual({ position: '3.1', disc: 3, side: null, trackNo: 1 });
        });
    });

    describe('disc-track format ("1-3", "2-7")', () => {
        it('should parse "1-3" as disc 1, track 3', () => {
            const result = deriveTrackPlacement('1-3', 0);
            expect(result).toEqual({ position: '1-3', disc: 1, side: null, trackNo: 3 });
        });

        it('should parse "2-7" as disc 2, track 7', () => {
            const result = deriveTrackPlacement('2-7', 0);
            expect(result).toEqual({ position: '2-7', disc: 2, side: null, trackNo: 7 });
        });
    });

    describe('numeric-only format ("1", "02")', () => {
        it('should parse "1" as track 1, disc 1', () => {
            const result = deriveTrackPlacement('1', 0);
            expect(result).toEqual({ position: '1', disc: 1, side: null, trackNo: 1 });
        });

        it('should parse "02" as track 2, disc 1', () => {
            const result = deriveTrackPlacement('02', 0);
            expect(result).toEqual({ position: '02', disc: 1, side: null, trackNo: 2 });
        });

        it('should parse "14" as track 14', () => {
            const result = deriveTrackPlacement('14', 13);
            expect(result).toEqual({ position: '14', disc: 1, side: null, trackNo: 14 });
        });
    });

    describe('disc + side + track format ("2-A3", "2 A3")', () => {
        it('should parse "2-A3" as disc 2, side A, track 3', () => {
            const result = deriveTrackPlacement('2-A3', 0);
            expect(result).toEqual({ position: '2-A3', disc: 2, side: 'A', trackNo: 3 });
        });

        it('should parse "2 B5" as disc 2, side B, track 5', () => {
            const result = deriveTrackPlacement('2 B5', 0);
            expect(result).toEqual({ position: '2 B5', disc: 2, side: 'B', trackNo: 5 });
        });
    });

    describe('fallback behavior', () => {
        it('should use index+1 as trackNo for empty string', () => {
            const result = deriveTrackPlacement('', 4);
            expect(result).toEqual({ position: '5', disc: 1, side: null, trackNo: 5 });
        });

        it('should use index+1 as trackNo for null input', () => {
            const result = deriveTrackPlacement(null, 2);
            expect(result).toEqual({ position: '3', disc: 1, side: null, trackNo: 3 });
        });

        it('should use index+1 as trackNo for undefined input', () => {
            const result = deriveTrackPlacement(undefined, 0);
            expect(result).toEqual({ position: '1', disc: 1, side: null, trackNo: 1 });
        });

        it('should use index+1 for unrecognized format', () => {
            const result = deriveTrackPlacement('side-one-track-two', 3);
            expect(result).toEqual({ position: 'side-one-track-two', disc: 1, side: null, trackNo: 4 });
        });

        it('should handle numeric input (not string)', () => {
            const result = deriveTrackPlacement(5, 4);
            expect(result).toEqual({ position: '5', disc: 1, side: null, trackNo: 5 });
        });
    });

    describe('multi-disc release scenarios', () => {
        it('should correctly number a full multi-disc tracklist with dot notation', () => {
            const positions = ['1.1', '1.2', '1.3', '2.1', '2.2', '2.3'];
            const results = positions.map((pos, idx) => deriveTrackPlacement(pos, idx));

            expect(results[0]).toMatchObject({ disc: 1, trackNo: 1 });
            expect(results[2]).toMatchObject({ disc: 1, trackNo: 3 });
            expect(results[3]).toMatchObject({ disc: 2, trackNo: 1 });
            expect(results[5]).toMatchObject({ disc: 2, trackNo: 3 });
        });
    });
});
