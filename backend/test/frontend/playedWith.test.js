/**
 * Drawing somebody who played with a band without being in it.
 *
 * The performance is already in the registry — `(Person)-[:PERFORMED_ON
 * {via_group_id}]->(Track)`, written from a line-up named under a track — and
 * /api/graph now draws it as a Person → Group edge typed PERFORMED_WITH.
 *
 * Member, guest and session player all run Person → Group, so nothing but the
 * declared type tells them apart, and the registry's whole point is that they
 * are not the same claim. These check the weights and alphas that carry that
 * distinction on screen.
 *
 * Lives under backend/test for the usual reason: the frontend has no unit-test
 * runner, and these modules are plain ESM.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { ColorPalette } from '../../../frontend/src/visualization/colorPalette.js';
import { describeRelation } from '../../../frontend/src/visualization/EdgeNavigator.js';

/** rgba(...) → numbers, so tests compare values rather than formatting. */
function parse(text) {
    const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(text);
    if (!m) throw new Error(`not an rgba string: ${text}`);
    return { r: +m[1], g: +m[2], b: +m[3], a: +m[4] };
}

describe('how heavy a played-with edge is', () => {
    let palette;
    beforeEach(() => { palette = new ColorPalette(); });

    test('between a membership and a guest credit', () => {
        // It says more than "this person is on the record" and less than
        // "this person is in the band". The order is the claim.
        const member = palette.getBaseEdgeWidth('MEMBER_OF');
        const playedWith = palette.getBaseEdgeWidth('PERFORMED_WITH');
        const guest = palette.getBaseEdgeWidth('GUEST_ON');

        expect(playedWith).toBeLessThan(member);
        expect(playedWith).toBeGreaterThan(guest);
    });

    test('and it is a width, not the fallback', () => {
        // getBaseEdgeWidth returns 1 for anything it does not know, which is
        // thinner than a guest credit and would read as the weakest claim.
        expect(palette.getBaseEdgeWidth('PERFORMED_WITH')).toBe(2);
        expect(palette.getBaseEdgeWidth('NOT_A_RELATIONSHIP')).toBe(1);
    });

    test('scaling the graph scales it too', () => {
        palette.edgeWidthScale = 3;

        expect(palette.getEdgeWidth('PERFORMED_WITH')).toBe(6);
    });
});

describe('what colour it is', () => {
    let palette;
    beforeEach(() => { palette = new ColorPalette(); });

    test("the person's own colour, so the edge names who played", () => {
        // Same convention as a membership and a guest credit: a person's edges
        // are their colour, which is how a face is followed across the graph.
        const edge = parse(palette.getEdgeColor('PERFORMED_WITH', 'p:guitar'));
        const own = palette.hexToRgb(palette.getColor('p:guitar'));

        expect([edge.r, edge.g, edge.b]).toEqual([own.r, own.g, own.b]);
    });

    test('fainter than a membership, stronger than a guest credit', () => {
        const member = palette.getEdgeColor('MEMBER_OF', 'p:guitar');
        const playedWith = parse(palette.getEdgeColor('PERFORMED_WITH', 'p:guitar'));
        const guest = parse(palette.getEdgeColor('GUEST_ON', 'p:guitar'));

        // A membership is the flat colour, i.e. fully opaque.
        expect(member).not.toMatch(/^rgba/);
        expect(playedWith.a).toBeLessThan(1);
        expect(playedWith.a).toBeGreaterThan(guest.a);
    });

    test('grey where there is no person to colour by', () => {
        expect(palette.getEdgeColor('PERFORMED_WITH', null)).toBe('#888888');
    });
});

describe('what the edge is called when you walk it', () => {
    test('"played with", not the raw relationship name', () => {
        expect(describeRelation({ data: { type: 'PERFORMED_WITH' } })).toBe('played with');
    });

    test('and the instrument is the useful half', () => {
        // "played with · guitar" says what a friend actually did on the track.
        expect(describeRelation({ data: { type: 'PERFORMED_WITH', role: 'guitar' } }))
            .toBe('played with · guitar');
    });

    test('still distinct from a membership and a guest credit', () => {
        expect(describeRelation({ data: { type: 'MEMBER_OF' } })).toBe('member');
        expect(describeRelation({ data: { type: 'GUEST_ON' } })).toBe('guest');
    });
});
