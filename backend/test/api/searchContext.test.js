/**
 * Disambiguating context for search results.
 *
 * Pure unit tests plus a fake Neo4j session — no database, so they never skip.
 */

import {
    summarizeNames, yearOf, activeYears, buildContext, enrichResults, CONTEXT_QUERIES
} from '../../src/api/searchContext.js';

describe('summarizeNames', () => {
    it('lists a short set in full', () => {
        expect(summarizeNames(['Kyuss', 'QOTSA'])).toBe('Kyuss, QOTSA');
    });
    it('caps a long set and counts the remainder', () => {
        expect(summarizeNames(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C +2 more');
    });
    it('drops nulls left by OPTIONAL MATCH misses', () => {
        expect(summarizeNames([null, 'A', null])).toBe('A');
    });
    it('returns null for an empty or missing set', () => {
        expect(summarizeNames([])).toBeNull();
        expect(summarizeNames(undefined)).toBeNull();
        expect(summarizeNames([null])).toBeNull();
    });
});

describe('yearOf', () => {
    it('reads a year out of every stored date shape', () => {
        expect(yearOf('2002')).toBe(2002);
        expect(yearOf('2002/08')).toBe(2002);
        expect(yearOf('2002/08/27')).toBe(2002);
        expect(yearOf('2002-08-27')).toBe(2002);
    });
    it('returns null when there is no year', () => {
        expect(yearOf(null)).toBeNull();
        expect(yearOf('')).toBeNull();
        expect(yearOf('unknown')).toBeNull();
    });
});

describe('activeYears', () => {
    it('spans first to last release', () => {
        expect(activeYears(['2002/08/27', '1996', '2013/06'])).toBe('1996–2013');
    });
    it('collapses a single year rather than printing a null span', () => {
        expect(activeYears(['2002/08/27', '2002/11'])).toBe('2002');
    });
    it('ignores undated releases', () => {
        expect(activeYears([null, '2002', undefined])).toBe('2002');
    });
    it('returns null when nothing is dated', () => {
        expect(activeYears([])).toBeNull();
        expect(activeYears([null, 'n/a'])).toBeNull();
    });
});

describe('buildContext', () => {
    it('leads a Person with the groups they played in', () => {
        // The disambiguator the whole feature exists for.
        const chips = buildContext('Person', {
            groupNames: ['Kyuss', 'Queens Of The Stone Age'],
            guestGroupNames: ['Foo Fighters'],
            city: 'Palm Desert'
        });
        expect(chips[0]).toBe('Kyuss, Queens Of The Stone Age');
        expect(chips).toContain('Palm Desert');
    });

    it('falls back to guest credits only for a person in no group', () => {
        const sessionPlayer = buildContext('Person', {
            groupNames: [], guestGroupNames: ['Kyuss', 'Screaming Trees'], city: null
        });
        expect(sessionPlayer).toEqual(['Guest: Kyuss, Screaming Trees']);

        // A person who *is* in a group does not also get their guest credits —
        // a busy session player's row would become unreadable.
        const member = buildContext('Person', {
            groupNames: ['Kyuss'], guestGroupNames: ['A', 'B', 'C'], city: null
        });
        expect(member).toEqual(['Kyuss']);
    });

    it('separates two same-named people by their groups', () => {
        const a = buildContext('Person', { groupNames: ['The Beatles'], guestGroupNames: [] });
        const b = buildContext('Person', { groupNames: ['Wings'], guestGroupNames: [] });
        expect(a).not.toEqual(b);
    });

    it('gives a Group its active years and roster', () => {
        const chips = buildContext('Group', {
            releaseDates: ['1996', '2013/06/04'],
            memberNames: ['Josh Homme', 'Nick Oliveri'],
            formedDate: null,
            city: 'Palm Desert'
        });
        expect(chips[0]).toBe('1996–2013');
        expect(chips[1]).toBe('Josh Homme, Nick Oliveri');
    });

    it('falls back to formed_date when a group has no dated releases', () => {
        const chips = buildContext('Group', {
            releaseDates: [], memberNames: [], formedDate: '1987/03/01', city: null
        });
        expect(chips).toEqual(['Formed 1987']);
    });

    it('describes a Release by its pressing', () => {
        const chips = buildContext('Release', {
            date: '2002/08/27', format: 'CD', country: 'US',
            catalog: 'INT 493 425-2',
            labelNames: ['Interscope'], groupNames: ['Queens Of The Stone Age']
        });
        expect(chips[0]).toBe('2002/08/27 · CD · US');
        expect(chips).toContain('INT 493 425-2');
    });

    it('handles the empty list a formatless release is stored with', () => {
        const chips = buildContext('Release', {
            date: '2002', format: [], country: null,
            catalog: null, labelNames: [], groupNames: []
        });
        expect(chips).toEqual(['2002']);
    });

    it('counts a Label\'s releases, unwrapping the Neo4j integer', () => {
        const chips = buildContext('Label', {
            cityNames: ['London'], parent: 'EMI', releaseCount: { low: 1, high: 0 }
        });
        expect(chips).toEqual(['London', 'Part of EMI', '1 release']);
    });

    it('pluralises the release count', () => {
        const chips = buildContext('Label', {
            cityNames: [], parent: null, releaseCount: { low: 4, high: 0 }
        });
        expect(chips).toEqual(['4 releases']);
    });

    it('names who wrote a Song and who played a Track', () => {
        expect(buildContext('Song', { writerNames: ['Josh Homme'] }))
            .toEqual(['Written by Josh Homme']);
        expect(buildContext('Track', {
            groupNames: ['Queens Of The Stone Age'], releaseNames: ['Songs For The Deaf']
        })).toEqual(['Queens Of The Stone Age', 'On Songs For The Deaf']);
    });

    it('returns nothing rather than throwing for a missing row or unknown label', () => {
        expect(buildContext('Person', null)).toEqual([]);
        expect(buildContext('City', { country: 'US' })).toEqual([]);
    });
});

describe('enrichResults', () => {
    /** Minimal stand-in for a Neo4j result record. */
    const record = (obj) => ({
        keys: Object.keys(obj),
        get: (k) => obj[k]
    });

    function fakeSession(handler) {
        return {
            calls: [],
            async run(cypher, params) {
                this.calls.push({ cypher, params });
                return { records: (handler(cypher, params) || []).map(record) };
            }
        };
    }

    it('issues one query per label, not one per result', async () => {
        const session = fakeSession((_c, { ids }) =>
            ids.map(id => ({ id, groupNames: ['Kyuss'], guestGroupNames: [], city: null })));

        const results = [
            { id: 'p1', type: 'Person' }, { id: 'p2', type: 'Person' },
            { id: 'p3', type: 'Person' }, { id: 'g1', type: 'Group' }
        ];
        await enrichResults(session, results);

        // Four results spanning two labels must cost two round trips.
        expect(session.calls).toHaveLength(2);
        const personCall = session.calls.find(c => c.cypher === CONTEXT_QUERIES.Person);
        expect(personCall.params.ids).toEqual(['p1', 'p2', 'p3']);
    });

    it('maps each row back onto its own result', async () => {
        const rows = {
            p1: { id: 'p1', groupNames: ['The Beatles'], guestGroupNames: [], city: null },
            p2: { id: 'p2', groupNames: ['Wings'], guestGroupNames: [], city: null }
        };
        const session = fakeSession((_c, { ids }) => ids.map(id => rows[id]));

        const results = [{ id: 'p1', type: 'Person' }, { id: 'p2', type: 'Person' }];
        await enrichResults(session, results);

        expect(results[0].context).toEqual(['The Beatles']);
        expect(results[1].context).toEqual(['Wings']);
    });

    it('gives every result a context array even when nothing matched', async () => {
        const session = fakeSession(() => []);
        const results = [{ id: 'p1', type: 'Person' }, { id: 'c1', type: 'City' }];
        await enrichResults(session, results);
        expect(results[0].context).toEqual([]);
        expect(results[1].context).toEqual([]);
    });

    it('degrades to plain results when a context query fails', async () => {
        // Enrichment is decoration. A search that 500s because a subtitle could
        // not be computed is a worse outcome than a plainer list.
        const session = {
            async run() { throw new Error('Neo.ClientError.Statement.SyntaxError'); }
        };
        const warned = [];
        const warn = (...args) => warned.push(args);
        const results = [{ id: 'p1', type: 'Person', display_name: 'John Williams' }];

        await expect(enrichResults(session, results, { warn })).resolves.toBe(results);
        expect(results[0].context).toEqual([]);
        expect(results[0].display_name).toBe('John Williams');
        expect(warned.length).toBeGreaterThan(0);
    });

    it('makes no query at all for an empty result set', async () => {
        const session = fakeSession(() => []);
        await enrichResults(session, []);
        expect(session.calls).toHaveLength(0);
    });

    it('skips results with no id rather than querying for undefined', async () => {
        const session = fakeSession(() => []);
        await enrichResults(session, [{ id: null, type: 'Person' }]);
        expect(session.calls).toHaveLength(0);
    });
});
