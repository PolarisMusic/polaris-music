/**
 * No statement in a release bundle may carry an undefined parameter.
 *
 * The Neo4j driver does not send a parameter whose value is `undefined`; it
 * drops the key. The query still references `$thing`, so the server answers
 *
 *     Neo4j::ClientError: Expected parameter(s): cityLat, cityLon
 *
 * and — because the bundle is one transaction — the entire release rolls back.
 * That is what happened to a submission on 2026-10-22: anchored on chain,
 * listed in the curation feed, and absent from the graph, with the only trace
 * a line in the sink's log. The trigger was a group that named an origin city
 * and no coordinates, which is every group anybody will ever type, because the
 * form has nowhere to put a latitude.
 *
 * A field that is merely absent is the normal case for most of this schema, so
 * this sweeps the whole bundle path rather than the one field that failed.
 *
 * The transaction is a recorder, not a database: these assertions are about
 * what is sent, which is where the defect was. Whether the statements do the
 * right thing to a real graph is the live suites' job — and those skip
 * silently without GRAPH_URI, which is why this bug reached production.
 */

import { describe, test, expect } from '@jest/globals';
import MusicGraphDatabase from '../../src/graph/schema.js';

/**
 * A driver that records statements and answers every read with one row.
 *
 * The row makes existence checks pass so the sweep reaches the end of the
 * bundle instead of stopping at the first `MATCH … RETURN` that finds nothing.
 * It makes the ids meaningless, which does not matter here: this is an audit
 * of parameter *keys and values*, not of what they resolve to.
 */
function recordingDriver() {
    const statements = [];
    const tx = {
        run: async (cypher, params) => {
            statements.push({ cypher, params });
            return { records: [{ get: (key) => (key === 'resolvedId' ? null : 'x') }] };
        },
        commit: async () => {},
        rollback: async () => {},
    };
    const session = { beginTransaction: () => tx, run: tx.run, close: async () => {} };
    return { statements, driver: { session: () => session, close: async () => {} } };
}

function graphWithRecorder() {
    const db = new MusicGraphDatabase({ uri: 'bolt://unused', user: 'u', password: 'p' });
    const recorder = recordingDriver();
    db.driver = recorder.driver;
    return { db, statements: recorder.statements };
}

/** Every parameter sent, as [statement, key] pairs whose value is undefined. */
const undefinedParameters = (statements) => statements.flatMap(({ cypher, params }) =>
    Object.entries(params ?? {})
        .filter(([, value]) => value === undefined)
        .map(([key]) => `${key} in ${cypher.trim().split('\n')[0].trim()}`));

const HASH = 'a'.repeat(64);

describe('the parameters a release bundle sends', () => {
    test('a bundle of nothing but required fields sends no undefined', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, {
            release: { name: 'Ocelot EP' },
            groups: [{ name: 'Ocelot', members: [{ name: 'Stephanie Brown' }] }],
            tracks: [{ title: 'Borrowed Time' }],
            tracklist: [{ position: '1', track_title: 'Borrowed Time' }],
        }, 'polaristest2', Date.now());

        expect(undefinedParameters(statements)).toEqual([]);
        expect(statements.length).toBeGreaterThan(5);
    });

    test('an origin city with no coordinates sends no undefined', async () => {
        // The exact shape that lost a release: a city somebody named, on all
        // three things that can come from one.
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, {
            release: {
                name: 'Ocelot EP', release_date: '2016/03/31', format: 'Digital',
                labels: [{ name: 'Ursa Polaris Records', origin_city: { name: 'Austin' } }],
            },
            groups: [{
                name: 'Ocelot',
                origin_city: { name: 'Austin' },
                members: [{ name: 'Stephanie Brown', roles: ['vocals'],
                    origin_city: { name: 'Austin' } }],
            }],
            tracks: [{ title: 'Borrowed Time', isrc: 'QM4DW1630374',
                listen_links: ['https://open.spotify.com/track/trk1'] }],
            tracklist: [{ position: '1', track_title: 'Borrowed Time' }],
        }, 'polaristest2', Date.now());

        expect(undefinedParameters(statements)).toEqual([]);
    });

    test('and neither does one where every optional field is filled in', async () => {
        const { db, statements } = graphWithRecorder();

        await db.processReleaseBundle(HASH, {
            release: {
                name: 'Ocelot EP', release_date: '2016/03/31', format: 'Digital',
                country: 'US', catalog_number: 'UPR-001', barcode: '07464373891',
                alt_names: ['Ocelot E.P.'], liner_notes: 'Recorded live.',
                listen_links: ['https://open.spotify.com/album/alb1'],
                labels: [{ name: 'Ursa Polaris Records', catalog_number: 'UPR-001',
                    origin_city: { name: 'Austin', lat: 30.2672, lon: -97.7431 } }],
                guests: [{ name: 'A Guest', roles: ['engineer'] }],
            },
            groups: [{
                name: 'Ocelot', alt_names: ['Ocelot Band'],
                origin_city: { name: 'Austin', lat: 30.2672, lon: -97.7431 },
                members: [{ name: 'Stephanie Brown', roles: ['vocals'],
                    from_date: '2014', to_date: '2018', instruments: ['voice'],
                    origin_city: { name: 'Austin', lat: 30.2672, lon: -97.7431 } }],
            }],
            tracks: [{
                title: 'Borrowed Time', isrc: 'QM4DW1630374', duration: 214,
                alt_titles: ['Borrowed Times'], recording_date: '2015/06/01',
                recording_location: 'Ursa Studios',
                listen_links: ['https://open.spotify.com/track/trk1'],
                lyrics: 'la la', trivia: 'First take.',
            }],
            tracklist: [{ position: '1', track_title: 'Borrowed Time' }],
            sources: [{ type: 'web', url: 'https://www.discogs.com/release/249504' }],
        }, 'polaristest2', Date.now());

        expect(undefinedParameters(statements)).toEqual([]);
    });
});
