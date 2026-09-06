/**
 * Edition ordering for the info viewer's version switcher.
 *
 * Pure unit tests — no Neo4j, so they never skip.
 */

import {
    dateSortKey, toInt, normalizeFormat, orderEditions, editionLabel,
    labelNames, catalogNumbers
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

    it('does not claim the `label` key, which holds the record label', () => {
        // Regression: the computed edition label was first assigned to
        // `label`, overwriting the record label on every edition row —
        // "Apple Records" became "1969-09-26 · LP". It belongs under
        // edition_label, and this asserts the two stay separate.
        const set = [
            { name: 'Abbey Road', release_date: '1969', label: 'Apple Records' },
            { name: 'Abbey Road', release_date: '2019', label: 'Apple Records' }
        ];
        const decorated = set.map(e => ({ ...e, edition_label: editionLabel(e, set) }));
        expect(decorated[0].label).toBe('Apple Records');
        expect(decorated[0].edition_label).toBe('1969');
    });
});

describe('labelNames / catalogNumbers', () => {
    const coissue = {
        labels: [
            { name: 'Tupelo', catalog_number: 'TUP 8' },
            { name: 'Sub Pop', catalog_number: 'SP 34' }
        ]
    };

    it('names every issuing label, not just the first', () => {
        // The sibling-editions query used to take collect(...)[0] and throw
        // the rest away, so a co-issued record showed one arbitrary label.
        expect(labelNames(coissue)).toBe('Sub Pop, Tupelo');
    });

    it('sorts, so the same co-issuers compare equal whatever order they arrive in', () => {
        const reversed = { labels: [...coissue.labels].reverse() };
        expect(labelNames(reversed)).toBe(labelNames(coissue));
    });

    it('collects a catalogue number from each issuer', () => {
        expect(catalogNumbers(coissue)).toBe('SP 34, TUP 8');
    });

    it('falls back to the release-level number for rows written before the move', () => {
        expect(catalogNumbers({ labels: [], catalog_number: 'PCS 7088' })).toBe('PCS 7088');
        expect(catalogNumbers({ catalog_number: 'PCS 7088' })).toBe('PCS 7088');
    });

    it('is empty, not undefined, for an unlabelled edition', () => {
        expect(labelNames({})).toBe('');
        expect(catalogNumbers({})).toBe('');
        expect(labelNames(null)).toBe('');
    });

    it('ignores label rows with no name, as an OPTIONAL MATCH miss produces', () => {
        expect(labelNames({ labels: [{ name: null }, { name: 'Stax' }] })).toBe('Stax');
    });
});

describe('editionLabel with labels', () => {
    it('names the issuing label when that is the only difference', () => {
        // A licensed reissue can share the original's title, year and format
        // and be a different edition purely by who put it out.
        const set = [
            { name: 'Bleach', release_date: '1989', format: 'LP',
              labels: [{ name: 'Sub Pop' }] },
            { name: 'Bleach', release_date: '1989', format: 'LP',
              labels: [{ name: 'Tupelo' }] }
        ];
        expect(editionLabel(set[0], set)).toBe('Sub Pop');
        expect(editionLabel(set[1], set)).toBe('Tupelo');
    });

    it('stays quiet about a label every edition shares', () => {
        const set = [
            { name: 'A', release_date: '1969', labels: [{ name: 'Apple' }] },
            { name: 'A', release_date: '2019', labels: [{ name: 'Apple' }] }
        ];
        expect(editionLabel(set[0], set)).toBe('1969');
    });

    it('names both issuers of a co-issue', () => {
        const set = [
            { name: 'A', release_date: '1969',
              labels: [{ name: 'Apple' }, { name: 'EMI' }] },
            { name: 'A', release_date: '1969', labels: [{ name: 'Apple' }] }
        ];
        expect(editionLabel(set[0], set)).toBe('Apple, EMI');
    });

    it('falls back to per-label catalogue numbers when the labels match too', () => {
        const set = [
            { name: 'A', release_date: '1969',
              labels: [{ name: 'Apple', catalog_number: 'PCS 7088' }] },
            { name: 'A', release_date: '1969',
              labels: [{ name: 'Apple', catalog_number: 'PMC 7088' }] }
        ];
        expect(editionLabel(set[0], set)).toBe('PCS 7088');
    });
});

describe('orderEditions with per-label catalogue numbers', () => {
    it('breaks a tie on the label catalogue number, not just the release one', () => {
        const a = { release_id: 'r2', release_date: '1969', is_master_release: false,
                    labels: [{ name: 'Apple', catalog_number: 'ZZZ' }] };
        const b = { release_id: 'r1', release_date: '1969', is_master_release: false,
                    labels: [{ name: 'Apple', catalog_number: 'AAA' }] };
        expect(orderEditions([a, b]).map(e => e.release_id)).toEqual(['r1', 'r2']);
    });
});
