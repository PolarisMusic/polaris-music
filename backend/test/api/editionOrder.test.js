/**
 * Edition ordering for the info viewer's version switcher.
 *
 * Pure unit tests — no Neo4j, so they never skip.
 */

import {
    dateSortKey, toInt, normalizeFormat, orderEditions, editionLabel
} from '../../src/api/editionOrder.js';

describe('dateSortKey', () => {
    it('pads partial dates so a year sorts before a fuller date in it', () => {
        expect(dateSortKey('2002')).toBe('20020000');
        expect(dateSortKey('2002/08')).toBe('20020800');
        expect(dateSortKey('2002/08/27')).toBe('20020827');
        expect(dateSortKey('2002') < dateSortKey('2002/08/27')).toBe(true);
    });

    it('is separator-agnostic, so dashes and slashes compare equal', () => {
        expect(dateSortKey('2002-08-27')).toBe(dateSortKey('2002/08/27'));
    });

    it('returns empty for missing dates', () => {
        expect(dateSortKey(null)).toBe('');
        expect(dateSortKey('')).toBe('');
        expect(dateSortKey('unknown')).toBe('');
    });
});

describe('normalizeFormat', () => {
    it('unwraps the empty list a formatless release is stored with', () => {
        expect(normalizeFormat([])).toBeNull();
    });
    it('passes a plain string through', () => {
        expect(normalizeFormat('CD')).toBe('CD');
    });
    it('joins a multi-value format', () => {
        expect(normalizeFormat(['2xLP', 'Gatefold'])).toBe('2xLP, Gatefold');
    });
    it('treats blank as absent', () => {
        expect(normalizeFormat('  ')).toBeNull();
        expect(normalizeFormat(null)).toBeNull();
    });
});

describe('toInt', () => {
    it('unwraps a Neo4j integer', () => {
        expect(toInt({ low: 12, high: 0 })).toBe(12);
        expect(toInt({ toNumber: () => 7 })).toBe(7);
    });
    it('passes numbers through and defaults nullish to 0', () => {
        expect(toInt(3)).toBe(3);
        expect(toInt(null)).toBe(0);
    });
});

describe('orderEditions', () => {
    const original = { release_id: 'r1', release_date: '2002/08/27', is_master_release: true, catalog_number: 'A' };
    const remaster = { release_id: 'r2', release_date: '2010/01/01', is_master_release: false, catalog_number: 'B' };
    const deluxe = { release_id: 'r3', release_date: '2019/06/07', is_master_release: false, catalog_number: 'C' };

    it('orders oldest first', () => {
        const out = orderEditions([deluxe, original, remaster]);
        expect(out.map(e => e.release_id)).toEqual(['r1', 'r2', 'r3']);
    });

    it('does not mutate its input', () => {
        const input = [deluxe, original];
        const copy = [...input];
        orderEditions(input);
        expect(input).toEqual(copy);
    });

    it('puts undated editions last rather than first', () => {
        // An empty sort key sorts before everything as a raw string; a release
        // nobody dated is not evidence that it came first.
        const undated = { release_id: 'r9', release_date: null, is_master_release: false };
        const out = orderEditions([undated, remaster, original]);
        expect(out.map(e => e.release_id)).toEqual(['r1', 'r2', 'r9']);
    });

    it('breaks a date tie toward the master release', () => {
        const a = { release_id: 'rb', release_date: '2002', is_master_release: false };
        const b = { release_id: 'ra', release_date: '2002', is_master_release: true };
        expect(orderEditions([a, b]).map(e => e.release_id)).toEqual(['ra', 'rb']);
    });

    it('is a total order, so the same set always yields the same sequence', () => {
        const twins = [
            { release_id: 'z', release_date: '2002', is_master_release: false, catalog_number: 'X' },
            { release_id: 'a', release_date: '2002', is_master_release: false, catalog_number: 'X' }
        ];
        expect(orderEditions(twins).map(e => e.release_id))
            .toEqual(orderEditions([...twins].reverse()).map(e => e.release_id));
    });

    it('tolerates an empty or missing set', () => {
        expect(orderEditions([])).toEqual([]);
        expect(orderEditions(undefined)).toEqual([]);
    });
});

describe('editionLabel', () => {
    it('names only the fields that actually differ across the set', () => {
        const set = [
            { name: 'Album', release_date: '2002', format: 'CD', country: 'US' },
            { name: 'Album', release_date: '2010', format: 'CD', country: 'US' }
        ];
        // Format and country are constant here, so saying "CD" distinguishes
        // nothing and is left out.
        expect(editionLabel(set[0], set)).toBe('2002');
        expect(editionLabel(set[1], set)).toBe('2010');
    });

    it('combines several varying fields', () => {
        const set = [
            { name: 'Album', release_date: '2002', format: 'CD', country: 'US' },
            { name: 'Album', release_date: '2002', format: 'LP', country: 'UK' }
        ];
        expect(editionLabel(set[1], set)).toBe('LP · UK');
    });

    it('falls back to catalogue number when nothing else varies', () => {
        const set = [
            { name: 'Album', release_date: '2002', format: 'CD', catalog_number: 'AAA' },
            { name: 'Album', release_date: '2002', format: 'CD', catalog_number: 'BBB' }
        ];
        expect(editionLabel(set[0], set)).toBe('AAA');
    });

    it('falls back to the release name when the set is indistinguishable', () => {
        const set = [{ name: 'Album', release_date: '2002', format: 'CD' }];
        expect(editionLabel(set[0], set)).toBe('Album');
    });
});
