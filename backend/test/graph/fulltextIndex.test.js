/**
 * The search index has to follow the properties the code writes.
 *
 * `CREATE FULLTEXT INDEX ... IF NOT EXISTS` keeps whatever definition is
 * already in place, so adding a property to the list changes nothing on a
 * database that already has the index — which is every deployed one. That is
 * not a hypothetical: Song.alt_titles is written by processReleaseBundle, read
 * by the resolvers and returned by the API, and has never been searchable,
 * because it was added to the code after the index existed.
 *
 * No Neo4j needed. neo4j.driver() is lazy — it opens no socket until a query
 * runs — so the driver is swapped for a fake that records the DDL and answers
 * the two SHOW INDEXES calls, which is the whole surface under test.
 */

import { jest } from '@jest/globals';
import MusicGraphDatabase from '../../src/graph/schema.js';

const SHOW_PROPERTIES = 'SHOW INDEXES YIELD name, properties';
const SHOW_STATE = 'SHOW INDEXES YIELD name, state';

/**
 * A fake session that reports `properties` for the existing entitySearch index.
 *
 * @param {string[]|null} properties - null means the index does not exist.
 */
function fakeSession(properties, { inspectThrows = false } = {}) {
    const queries = [];
    const session = {
        run: jest.fn(async (query) => {
            const text = String(query);
            queries.push(text);

            if (text.includes(SHOW_PROPERTIES)) {
                if (inspectThrows) throw new Error('SHOW INDEXES not permitted');
                return {
                    records: properties === null
                        ? []
                        : [{ get: () => properties }]
                };
            }
            if (text.includes(SHOW_STATE)) {
                return { records: [{ get: (key) => (key === 'state' ? 'ONLINE' : 'entitySearch') }] };
            }
            if (text.includes('apoc.')) {
                return { records: [{ get: () => ({ toNumber: () => 0 }) }] };
            }
            return { records: [] };
        }),
        close: jest.fn().mockResolvedValue(undefined),
    };
    return { session, queries };
}

async function initializeWith(properties, options) {
    const { session, queries } = fakeSession(properties, options);
    const db = new MusicGraphDatabase({
        uri: 'bolt://127.0.0.1:7687', user: 'neo4j', password: 'test'
    });
    db.driver = {
        session: jest.fn().mockReturnValue(session),
        close: jest.fn().mockResolvedValue(undefined),
    };

    await db.initializeSchema();

    return {
        queries,
        dropped: queries.filter(q => q.includes('DROP INDEX entitySearch')),
        created: queries.filter(q => q.includes('CREATE FULLTEXT INDEX entitySearch')),
    };
}

describe('the entitySearch fulltext index keeps up with the code', () => {
    it('indexes alt_titles, so an alternate spelling can be searched for', async () => {
        // The reason any of this exists: the Spotify cross-check records the
        // other spelling of a track title, which is worthless if nobody can
        // search for it.
        const { created } = await initializeWith(
            ['name', 'title', 'alt_names', 'alt_titles']);

        expect(created).toHaveLength(1);
        expect(created[0]).toContain('n.alt_titles');
    });

    it('still indexes the properties it always did', async () => {
        const { created } = await initializeWith(null);
        for (const property of ['n.name', 'n.title', 'n.alt_names']) {
            expect(created[0]).toContain(property);
        }
    });

    it('rebuilds an index that predates a property', async () => {
        const { dropped, created, queries } = await initializeWith(
            ['name', 'title', 'alt_names']);

        expect(dropped).toHaveLength(1);
        expect(created).toHaveLength(1);
        // Order matters: creating before dropping would leave the old
        // definition in place and then delete it.
        expect(queries.indexOf(dropped[0])).toBeLessThan(queries.indexOf(created[0]));
    });

    it('leaves an up-to-date index alone', async () => {
        const { dropped } = await initializeWith(
            ['name', 'title', 'alt_names', 'alt_titles']);

        expect(dropped).toHaveLength(0);
    });

    it('does not drop an index it could not inspect', async () => {
        // A rebuild is only justified by evidence that the definition is
        // stale. Without that, dropping would cost search for nothing.
        const { dropped, created } = await initializeWith(null, { inspectThrows: true });

        expect(dropped).toHaveLength(0);
        expect(created).toHaveLength(1);
    });

    it('does not drop an index that does not exist', async () => {
        const { dropped } = await initializeWith(null);
        expect(dropped).toHaveLength(0);
    });

    it('finishes schema initialization either way', async () => {
        // The index work sits in the middle of initializeSchema; a throw here
        // would leave the constraints after it uncreated.
        for (const properties of [null, ['name'], ['name', 'title', 'alt_names', 'alt_titles']]) {
            const { queries } = await initializeWith(properties);
            expect(queries.some(q => q.includes('SHOW PROCEDURES'))).toBe(true);
        }
    });
});
