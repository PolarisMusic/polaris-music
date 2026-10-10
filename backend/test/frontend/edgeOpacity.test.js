/**
 * Dimming a colour without knowing what notation it arrived in.
 *
 * Edge colours reach this from three places with three shapes: the palette's
 * own 6-digit hex, a person's colour out of the database (whatever was stored),
 * and guest credits which are already rgba() at half strength. The dimmer has
 * to multiply what is there rather than replace it, or a credit that was
 * already quiet comes back louder than the membership beside it.
 */

import { jest } from '@jest/globals';
import { ColorPalette } from '../../../frontend/src/visualization/colorPalette.js';

/** rgba(...) → numbers, so tests compare values rather than formatting. */
function parse(text) {
    const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(text);
    if (!m) throw new Error(`not an rgba string: ${text}`);
    return { r: +m[1], g: +m[2], b: +m[3], a: +m[4] };
}

describe('withOpacity', () => {
    let palette;
    beforeEach(() => { palette = new ColorPalette(); });

    test('a 6-digit hex keeps its channels and takes the factor as its alpha', () => {
        expect(parse(palette.withOpacity('#6BC47D', 0.5)))
            .toEqual({ r: 107, g: 196, b: 125, a: 0.5 });
    });

    test('a 3-digit hex expands by doubling, not by zero-padding', () => {
        // #abc is #aabbcc. Padding would give #0a0b0c and a different colour.
        expect(parse(palette.withOpacity('#abc', 1 / 2)))
            .toEqual({ r: 170, g: 187, b: 204, a: 0.5 });
    });

    test('an existing alpha is multiplied, not replaced', () => {
        // A guest edge arrives at 0.5. Dimming by 0.32 must leave it fainter
        // than a membership dimmed by the same factor, not equal to it.
        const guest = parse(palette.withOpacity('rgba(100, 150, 200, 0.5)', 0.32));
        const member = parse(palette.withOpacity('#6496C8', 0.32));

        expect(guest.a).toBeCloseTo(0.16, 6);
        expect(member.a).toBeCloseTo(0.32, 6);
        expect(guest.a).toBeLessThan(member.a);
    });

    test('rgb() without an alpha is treated as opaque', () => {
        expect(parse(palette.withOpacity('rgb(10, 20, 30)', 0.25)))
            .toEqual({ r: 10, g: 20, b: 30, a: 0.25 });
    });

    test('a factor of 1 or more is a no-op, and returns the input untouched', () => {
        // Not merely equivalent: the common case is "not dimmed", and it should
        // not allocate a string or convert notation.
        expect(palette.withOpacity('#6BC47D', 1)).toBe('#6BC47D');
        expect(palette.withOpacity('#6BC47D', 2)).toBe('#6BC47D');
    });

    test('the result is clamped to a legal alpha', () => {
        expect(parse(palette.withOpacity('rgba(0, 0, 0, 0.5)', 0)).a).toBe(0);
    });

    test('an unparseable colour comes back as itself, with one warning', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(palette.withOpacity('papayawhip', 0.5)).toBe('papayawhip');
            expect(palette.withOpacity('papayawhip', 0.5)).toBe('papayawhip');
            // Once per colour, not once per frame — this runs per edge per frame.
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            warn.mockRestore();
        }
    });

    test('a missing colour is not an error', () => {
        expect(palette.withOpacity(undefined, 0.5)).toBeUndefined();
        expect(palette.withOpacity('', 0.5)).toBe('');
    });
});

describe('the memo', () => {
    test('returns the identical string for a repeated request', () => {
        const palette = new ColorPalette();
        const first = palette.withOpacity('#6BC47D', 0.32);
        expect(palette.withOpacity('#6BC47D', 0.32)).toBe(first);
    });

    test('does not confuse two factors for the same colour', () => {
        const palette = new ColorPalette();
        expect(parse(palette.withOpacity('#6BC47D', 0.2)).a).toBeCloseTo(0.2, 6);
        expect(parse(palette.withOpacity('#6BC47D', 0.8)).a).toBeCloseTo(0.8, 6);
    });

    test('stays bounded under a pathological number of colours', () => {
        // One colour per person is the real key space; a corrupt import could
        // be larger, and this runs on every frame.
        const palette = new ColorPalette();
        for (let i = 0; i < 700; i++) {
            palette.withOpacity(`rgb(${i % 256}, ${(i * 3) % 256}, ${(i * 7) % 256})`, 0.32);
        }
        expect(palette._opacityCache.size).toBeLessThanOrEqual(512);
    });
});
