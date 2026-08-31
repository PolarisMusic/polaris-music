/**
 * Contract test: what the submission form emits as a tracklist position, and
 * what the backend makes of it.
 *
 * A submitted LP of Nirvana's Nevermind came back with duplicate track numbers
 * — "1. Territorial Pissings" alongside "1. Smells Like Teen Spirit", and so on
 * down both sides. Discogs gives vinyl positions as "A1".."A6" and "B1".."B7";
 * the form took /\d+/ of that and then emitted `${disc}.${number}`, so A1 and
 * B1 both left the browser as "1.1". The side letter was destroyed in the
 * browser and could not be recovered afterwards.
 *
 * deriveTrackPlacement() was never the problem — it has always parsed "A1"
 * correctly. What was missing was a test that the two halves agree, so this
 * pins the join: feed it the positions the form now produces and require that
 * thirteen tracks get thirteen distinct places on the record.
 *
 * The `describe('the old format')` block at the bottom is the regression
 * itself, kept executable so the failure mode stays legible.
 */

import { describe, test, expect } from '@jest/globals';
import { deriveTrackPlacement } from '../../src/graph/schema.js';

/** Nevermind as Discogs returns it: six on side A, seven on side B. */
const NEVERMIND_VINYL = [
    'A1', 'A2', 'A3', 'A4', 'A5', 'A6',
    'B1', 'B2', 'B3', 'B4', 'B5', 'B6',
    '',              // "Endless, Nameless" — an untracked hidden track
];

/** A placement's identity on the physical record. */
const place = (p) => `${p.disc}/${p.side ?? '-'}/${p.trackNo}`;

describe('vinyl positions carried through verbatim', () => {
    const placements = NEVERMIND_VINYL.map((pos, i) => deriveTrackPlacement(pos, i));

    test('thirteen tracks occupy thirteen distinct places', () => {
        // The bug in one assertion: this was 7 distinct places for 13 tracks.
        expect(new Set(placements.map(place)).size).toBe(13);
    });

    test('the side letter survives', () => {
        expect(placements.slice(0, 6).map(p => p.side)).toEqual(['A', 'A', 'A', 'A', 'A', 'A']);
        expect(placements.slice(6, 12).map(p => p.side)).toEqual(['B', 'B', 'B', 'B', 'B', 'B']);
    });

    test('A1 and B1 are different tracks', () => {
        const a1 = deriveTrackPlacement('A1', 0);
        const b1 = deriveTrackPlacement('B1', 6);
        expect(a1.trackNo).toBe(b1.trackNo);      // both are 1 on their side...
        expect(a1.side).not.toBe(b1.side);        // ...which is why side matters
        expect(place(a1)).not.toBe(place(b1));
    });

    test('a blank position falls back to its index, not to a collision', () => {
        // "Endless, Nameless" is the 13th entry and has no printed position.
        expect(placements[12].trackNo).toBe(13);
        expect(placements[12].side).toBeNull();
    });

    test('a lowercase side letter is normalized', () => {
        expect(deriveTrackPlacement('b2', 0).side).toBe('B');
    });
});

describe('the formats a hand-entered position can take', () => {
    test.each([
        ['a bare number',        '7',    { disc: 1, side: null, trackNo: 7 }],
        ['a zero-padded number', '02',   { disc: 1, side: null, trackNo: 2 }],
        ['disc and track',       '2.7',  { disc: 2, side: null, trackNo: 7 }],
        ['disc-track hyphenated','1-3',  { disc: 1, side: null, trackNo: 3 }],
        ['a double LP side',     '2-A3', { disc: 2, side: 'A',  trackNo: 3 }],
    ])('%s', (_label, position, expected) => {
        expect(deriveTrackPlacement(position, 0)).toMatchObject(expected);
    });

    test('the raw position string is preserved alongside the parse', () => {
        // The graph stores this verbatim, so a curator can see what was printed
        // rather than only our interpretation of it.
        expect(deriveTrackPlacement('A1', 0).position).toBe('A1');
    });
});

describe('the old format, kept to document the failure', () => {
    test('emitting `${disc}.${number}` collapses both sides onto each other', () => {
        // What the form used to send for A1..A6 and B1..B6.
        const old = ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6',
                     '1.1', '1.2', '1.3', '1.4', '1.5', '1.6'];
        const placements = old.map((pos, i) => deriveTrackPlacement(pos, i));

        expect(new Set(placements.map(place)).size).toBe(6);   // twelve tracks, six places
        expect(placements.every(p => p.side === null)).toBe(true);
    });
});
