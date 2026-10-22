/**
 * Linking an entity to the city it comes from, without a database.
 *
 * This is the bug that lost a release on 2026-10-22. A submission whose group
 * named an origin city but no coordinates produced:
 *
 *     ✗ Rejected 3cfdf8d7abfb... action=put
 *       error=Expected parameter(s): cityLat, cityLon
 *
 * The Neo4j driver drops a parameter whose value is `undefined` rather than
 * sending null, so a query referencing `$cityLat` arrived without it. That
 * threw inside the bundle transaction and rolled the whole release back: it
 * was anchored on chain and listed in the curation feed, and no node of it
 * ever reached the graph. The form has nowhere to type a latitude, so every
 * submission naming a city was going to do this.
 *
 * Driven against a recording transaction, because the failure is entirely in
 * the parameters — the suites that would have caught it need a live Neo4j and
 * skip silently without one.
 */

import { describe, test, expect } from '@jest/globals';
import MusicGraphDatabase from '../../src/graph/schema.js';

/** A transaction that records statements instead of running them. */
function recordingTx() {
    const statements = [];
    return {
        statements,
        tx: {
            run: async (cypher, params) => {
                statements.push({ cypher, params });
                return { records: [] };
            },
        },
    };
}

/** A graph whose driver is never used: these calls take the tx directly. */
const graph = () => new MusicGraphDatabase({ uri: 'bolt://unused', user: 'u', password: 'p' });

/** The parameters of the statement that wrote the City. */
const cityParams = (statements) =>
    statements.find((s) => s.cypher.includes('MERGE (c:City'))?.params;

describe('linkOriginCity', () => {
    test('a city with no coordinates sends null, not nothing', async () => {
        const { tx, statements } = recordingTx();

        await graph().linkOriginCity(tx, 'group', 'grp:1', { name: 'Austin' });

        const params = cityParams(statements);
        // Both halves matter: `undefined` is dropped in transit and the query
        // then has no $cityLat at all, which is the error above.
        expect(params).toHaveProperty('cityLat', null);
        expect(params).toHaveProperty('cityLon', null);
        expect(params.cityName).toBe('Austin');
    });

    test('coordinates are passed when somebody has them', async () => {
        const { tx, statements } = recordingTx();

        await graph().linkOriginCity(tx, 'group', 'grp:1',
            { name: 'Austin', lat: 30.2672, lon: -97.7431 });

        expect(cityParams(statements)).toMatchObject({ cityLat: 30.2672, cityLon: -97.7431 });
    });

    test('a city with no name is still a city, with a null name', async () => {
        const { tx, statements } = recordingTx();

        await graph().linkOriginCity(tx, 'person', 'per:1', { lat: 51.5, lon: -0.12 });

        expect(cityParams(statements)).toHaveProperty('cityName', null);
    });

    test.each([
        ['a group', 'group', 'MATCH (n:Group {group_id: $nodeId})'],
        ['a person', 'person', 'MATCH (n:Person {person_id: $nodeId})'],
        ['a label', 'label', 'MATCH (n:Label {label_id: $nodeId})'],
    ])('%s is matched by its own label and id field', async (_l, type, expected) => {
        const { tx, statements } = recordingTx();

        await graph().linkOriginCity(tx, type, 'node:1', { name: 'Austin' });

        expect(statements[0].cypher).toContain(expected);
    });

    test('a type outside the allowlist never reaches a query', async () => {
        // The label is interpolated into a Cypher pattern, where it cannot be
        // parameterised, so it comes from SAFE_NODE_TYPES and nowhere else.
        const { tx, statements } = recordingTx();

        await expect(graph().linkOriginCity(tx, 'Group) DETACH DELETE (n', 'x', { name: 'A' }))
            .rejects.toThrow(/Cannot link an origin city/);
        expect(statements).toEqual([]);
    });

    test('no city is not an error, and writes nothing', async () => {
        // The common case by far: most submissions name no origin city.
        const { tx, statements } = recordingTx();

        expect(await graph().linkOriginCity(tx, 'group', 'grp:1', undefined)).toBeNull();
        expect(await graph().linkOriginCity(tx, 'group', 'grp:1', null)).toBeNull();
        expect(statements).toEqual([]);
    });

    test('the city id it returns is the one it wrote', async () => {
        const { tx, statements } = recordingTx();

        const cityId = await graph().linkOriginCity(tx, 'group', 'grp:1', { name: 'Austin' });

        expect(cityId).toMatch(/^prov:city:[a-f0-9]{16}$/);
        expect(cityParams(statements).cityId).toBe(cityId);
    });

    test('two spellings of one city are one node, two cities are two', async () => {
        // The id is a fingerprint of the city, so this is what keeps a release
        // and its label from landing on separate Austins.
        const same = graph();
        const { tx: txA } = recordingTx();
        const { tx: txB } = recordingTx();

        expect(await same.linkOriginCity(txA, 'group', 'grp:1', { name: 'Austin' }))
            .toBe(await same.linkOriginCity(txB, 'label', 'lab:1', { name: 'Austin' }));
        expect(await same.linkOriginCity(txA, 'group', 'grp:1', { name: 'Houston' }))
            .not.toBe(await same.linkOriginCity(txB, 'group', 'grp:2', { name: 'Austin' }));
    });
});
