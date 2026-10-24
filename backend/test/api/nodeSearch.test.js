/**
 * Tests for the NodeSearchService and /api/search/nodes REST endpoint.
 *
 * Validates:
 * - NodeSearchService.search() returns normalised results
 * - Fulltext search with fallback to substring matching
 * - ID exact/prefix matching
 * - Result merging and deduplication
 * - REST endpoint wiring and response shape
 */

import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Minimal Neo4j driver stub
// ---------------------------------------------------------------------------

function makeRecord(fields) {
    return {
        get(key) { return fields[key]; }
    };
}

function makeDriverStub(runImpl) {
    const session = {
        run: jest.fn(runImpl || (async () => ({ records: [] }))),
        close: jest.fn(async () => {})
    };
    return {
        session: jest.fn(() => session),
        _session: session
    };
}

// ---------------------------------------------------------------------------
// Import after stubs are ready (ESM dynamic import)
// ---------------------------------------------------------------------------

let NodeSearchService;

beforeAll(async () => {
    const mod = await import('../../src/api/nodeSearchService.js');
    NodeSearchService = mod.NodeSearchService;
});

// ---------------------------------------------------------------------------
// Unit tests: NodeSearchService
// ---------------------------------------------------------------------------

describe('NodeSearchService', () => {
    test('returns empty array for short queries', async () => {
        const driver = makeDriverStub();
        const svc = new NodeSearchService(driver);
        expect(await svc.search('')).toEqual([]);
        expect(await svc.search('a')).toEqual([]);
    });

    test('fulltext search returns normalised Person results', async () => {
        const driver = makeDriverStub(async (cypher) => {
            if (cypher.includes('fulltext')) {
                return {
                    records: [
                        makeRecord({
                            node: {
                                properties: {
                                    person_id: 'p:1',
                                    name: 'John Lennon',
                                    city: 'Liverpool'
                                }
                            },
                            label: 'Person',
                            score: 5.0
                        })
                    ]
                };
            }
            // ID search returns nothing
            return { records: [] };
        });

        const svc = new NodeSearchService(driver);
        const results = await svc.search('lennon');

        expect(results.length).toBeGreaterThanOrEqual(1);

        const first = results[0];
        expect(first.id).toBe('p:1');
        expect(first.type).toBe('Person');
        expect(first.display_name).toBe('John Lennon');
        expect(first.subtitle).toBe('Liverpool');
        expect(first.score).toBe(5.0);
    });

    test('falls back to substring search when fulltext fails', async () => {
        let fulltextCalled = false;
        let fallbackCalled = false;

        const driver = makeDriverStub(async (cypher) => {
            if (cypher.includes('fulltext')) {
                fulltextCalled = true;
                throw new Error('No fulltext index');
            }
            if (cypher.includes('toLower')) {
                fallbackCalled = true;
                return {
                    records: [
                        makeRecord({
                            n: {
                                properties: {
                                    group_id: 'g:1',
                                    name: 'The Beatles',
                                    formed_date: '1960'
                                }
                            },
                            label: 'Group'
                        })
                    ]
                };
            }
            return { records: [] };
        });

        const svc = new NodeSearchService(driver);
        const results = await svc.search('beatles');

        expect(fulltextCalled).toBe(true);
        expect(fallbackCalled).toBe(true);
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0].type).toBe('Group');
        expect(results[0].display_name).toBe('The Beatles');
    });

    test('ID exact match takes priority over text results', async () => {
        const driver = makeDriverStub(async (cypher) => {
            if (cypher.includes('fulltext')) {
                return {
                    records: [
                        makeRecord({
                            node: {
                                properties: { person_id: 'p:text', name: 'Text Match' }
                            },
                            label: 'Person',
                            score: 3.0
                        })
                    ]
                };
            }
            // ID search
            if (cypher.includes('$query')) {
                return {
                    records: [
                        makeRecord({
                            n: {
                                properties: { person_id: 'p:exact', name: 'Exact ID Match' }
                            },
                            label: 'Person',
                            score: 1000.0
                        })
                    ]
                };
            }
            return { records: [] };
        });

        const svc = new NodeSearchService(driver);
        const results = await svc.search('p:exact');

        expect(results[0].id).toBe('p:exact');
        expect(results[0].display_name).toBe('Exact ID Match');
    });

    test('deduplicates results by id', async () => {
        const driver = makeDriverStub(async (cypher) => {
            // Both fulltext and ID return the same entity
            if (cypher.includes('fulltext')) {
                return {
                    records: [
                        makeRecord({
                            node: { properties: { person_id: 'p:dup', name: 'Dup' } },
                            label: 'Person',
                            score: 2.0
                        })
                    ]
                };
            }
            return {
                records: [
                    makeRecord({
                        n: { properties: { person_id: 'p:dup', name: 'Dup' } },
                        label: 'Person',
                        score: 1000.0
                    })
                ]
            };
        });

        const svc = new NodeSearchService(driver);
        const results = await svc.search('dup');

        const dupes = results.filter(r => r.id === 'p:dup');
        expect(dupes.length).toBe(1);
    });

    test('normalises all supported node types', async () => {
        const types = [
            { label: 'Person', props: { person_id: 'p1', name: 'A Person', city: 'NYC' } },
            { label: 'Group', props: { group_id: 'g1', name: 'A Group', formed_date: '2000' } },
            { label: 'Release', props: { release_id: 'r1', name: 'An Album', release_date: '2020' } },
            { label: 'Track', props: { track_id: 't1', title: 'A Track' } },
            { label: 'Song', props: { song_id: 's1', title: 'A Song' } },
            { label: 'Label', props: { label_id: 'l1', name: 'A Label' } },
            { label: 'City', props: { city_id: 'c1', name: 'A City', country: 'US' } },
        ];

        for (const { label, props } of types) {
            const driver = makeDriverStub(async (cypher) => {
                if (cypher.includes('fulltext')) {
                    return {
                        records: [makeRecord({ node: { properties: props }, label, score: 1.0 })]
                    };
                }
                return { records: [] };
            });

            const svc = new NodeSearchService(driver);
            const results = await svc.search('test');

            expect(results.length).toBe(1);
            expect(results[0].type).toBe(label);
            expect(results[0].id).toBeTruthy();
            expect(results[0].display_name).toBeTruthy();
        }
    });

    test('respects type filter', async () => {
        const driver = makeDriverStub(async (cypher, params) => {
            if (cypher.includes('fulltext') && params.allowed) {
                expect(params.allowed).toEqual(['Group']);
            }
            return { records: [] };
        });

        const svc = new NodeSearchService(driver);
        await svc.search('test', { types: ['Group'] });

        // Verify session.run was called (at least fulltext + id search)
        expect(driver._session.run).toHaveBeenCalled();
    });

    test('closes session and returns empty when all searches fail', async () => {
        const driver = makeDriverStub(async () => {
            throw new Error('DB down');
        });

        const svc = new NodeSearchService(driver);

        // Should not throw — all failures are caught and return []
        const results = await svc.search('test');
        expect(results).toEqual([]);
        expect(driver._session.close).toHaveBeenCalled();
    });
});

describe('the alternate names a result matched on', () => {
    /**
     * `entitySearch` indexes `alt_names` and `alt_titles`, and the substring
     * fallback checks both — which is how searching "Avey Tare" returns
     * somebody filed as Dave Portner. The projection dropped them, so the
     * caller had the result and no way to say why it was there, and the row
     * read as a mistake rather than an answer.
     */
    const serving = (properties, label = 'Person') => makeDriverStub(async (cypher) => {
        if (cypher.includes('fulltext')) {
            return { records: [makeRecord({
                node: { properties }, label, score: 5.0,
            })] };
        }
        return { records: [] };
    });

    test('a Person carries them', async () => {
        const svc = new NodeSearchService(serving({
            person_id: 'p:1', name: 'Dave Portner', alt_names: ['Avey Tare'],
        }));

        const [first] = await svc.search('avey tare');
        expect(first.alt_names).toEqual(['Avey Tare']);
    });

    test('a Track carries its alternate titles under the same key', async () => {
        // The registry says alt_names for things with a name and alt_titles
        // for things with a title; a search result should not have to care.
        const svc = new NodeSearchService(serving({
            track_id: 't:1', title: 'Rest Of Our Lives', alt_titles: ['Rest of Our Lives - Live'],
        }, 'Track'));

        const [first] = await svc.search('rest of our');
        expect(first.alt_names).toEqual(['Rest of Our Lives - Live']);
    });

    test('blanks and non-strings are dropped, the rest trimmed', async () => {
        const svc = new NodeSearchService(serving({
            person_id: 'p:1', name: 'Dave Portner',
            alt_names: ['  Avey Tare  ', '', '   ', null, 42],
        }));

        const [first] = await svc.search('avey');
        expect(first.alt_names).toEqual(['Avey Tare']);
    });

    test('a node with none gets an empty list, not a missing key', async () => {
        // The caller filters on it; absent and empty should not need
        // different handling.
        const svc = new NodeSearchService(serving({ person_id: 'p:1', name: 'John Lennon' }));

        const [first] = await svc.search('lennon');
        expect(first.alt_names).toEqual([]);
    });

    test.each([
        ['Group', { group_id: 'g:1', name: 'Dum Dum Girls', alt_names: ['DDG'] }],
        ['Release', { release_id: 'r:1', name: 'Album', alt_names: ['Albumen'] }],
        ['Label', { label_id: 'l:1', name: 'Label', alt_names: ['Labelle'] }],
        ['Song', { song_id: 's:1', title: 'Song', alt_titles: ['Songe'] }],
    ])('a %s carries them too', async (label, properties) => {
        const svc = new NodeSearchService(serving(properties, label));

        const [first] = await svc.search('whatever');
        expect(first.alt_names).toHaveLength(1);
    });
});
