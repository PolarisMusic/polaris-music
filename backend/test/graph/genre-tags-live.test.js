/**
 * Genre tags against a real Neo4j.
 *
 * The write is a MERGE on a relationship keyed by origin, inside a transaction
 * that deletes that origin's edges first, and the read is an ordered join —
 * none of which a mock can check. It matters more than usual here because the
 * whole feature is set arithmetic: a Genre node that splits in two, or an
 * origin whose replacement deletes somebody else's tag, reports an overlap that
 * is quietly wrong rather than visibly broken.
 *
 * SKIPS SILENTLY without GRAPH_URI, like every suite in this directory — so a
 * green local run is not evidence this ran. Check the skipped count.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import MusicGraphDatabase from '../../src/graph/schema.js';
import { canonicalGenres } from '../../src/graph/genreVocabulary.js';

const describeOrSkip = (process.env.GRAPH_URI && process.env.SKIP_GRAPH_TESTS !== 'true')
    ? describe : describe.skip;

const GROUP = 'test:genre:group';
const RELEASE = 'test:genre:release';
const KEYS = ['hard rock', 'psychedelic rock', 'melancholy', 'hip hop'];

describeOrSkip('genre tags (live graph)', () => {
    let db;
    let session;

    beforeAll(async () => {
        db = new MusicGraphDatabase({
            uri: process.env.GRAPH_URI || 'bolt://127.0.0.1:7687',
            user: process.env.GRAPH_USER || 'neo4j',
            password: process.env.GRAPH_PASSWORD || 'password',
        });
    });

    afterAll(async () => {
        if (session) await session.close();
        if (db?.driver) await db.driver.close();
    });

    beforeEach(async () => {
        if (session) await session.close();
        session = db.driver.session();

        // Scoped to this suite's own nodes, plus the Genre nodes its keys would
        // create — a wholesale wipe belongs to the suites that declare one.
        await session.run(`
            MATCH (n) WHERE n.group_id = $group OR n.release_id = $release
            DETACH DELETE n
        `, { group: GROUP, release: RELEASE });
        await session.run(`
            MATCH (g:Genre) WHERE g.key IN $keys DETACH DELETE g
        `, { keys: KEYS });

        await session.run(`
            CREATE (:Group {group_id: $group, id: $group, name: 'Test Band', status: 'ACTIVE'})
            CREATE (:Release {release_id: $release, id: $release, name: 'Test Record',
                status: 'ACTIVE', barcode: '07464373891'})
        `, { group: GROUP, release: RELEASE });
    });

    const tags = (nodeType, nodeId) => db.getGenreTags(nodeType, nodeId);

    test('a tag lands on a Genre node keyed by its normalized form', async () => {
        await db.setGenreTags('group', GROUP, canonicalGenres([{ name: 'Hard Rock', count: 9 }]),
            { origin: 'musicbrainz:genre' });

        expect(await tags('group', GROUP)).toEqual([{
            key: 'hard rock', name: 'Hard Rock', origin: 'musicbrainz:genre', count: 9,
        }]);
    });

    test('two spellings from two sources share one Genre node', async () => {
        // The reason the whole vocabulary module exists: one node or the
        // overlap between two genres is computed over a split set.
        await db.setGenreTags('group', GROUP, canonicalGenres(['Hip-Hop']),
            { origin: 'musicbrainz:genre' });
        await db.setGenreTags('release', RELEASE, canonicalGenres(['hip hop']),
            { origin: 'musicbrainz:genre' });

        const shared = await session.run(
            `MATCH (g:Genre {key: 'hip hop'})<-[:TAGGED]-(n) RETURN count(DISTINCT g) AS genres,
             count(DISTINCT n) AS tagged`);

        expect(shared.records[0].get('genres').toNumber()).toBe(1);
        expect(shared.records[0].get('tagged').toNumber()).toBe(2);
    });

    test('a re-import replaces only its own origin', async () => {
        // An account tag is somebody's assertion and an import must not touch
        // it, however stale the import thinks the node is.
        await db.setGenreTags('group', GROUP, canonicalGenres(['hard rock']),
            { origin: 'musicbrainz:genre' });
        await db.setGenreTags('group', GROUP, canonicalGenres(['melancholy']),
            { origin: 'account:andrew' });

        // MusicBrainz has since dropped hard rock and says psychedelic rock.
        const result = await db.setGenreTags('group', GROUP,
            canonicalGenres(['psychedelic rock']), { origin: 'musicbrainz:genre' });

        expect(result).toEqual({ added: 1, removed: 1 });
        expect((await tags('group', GROUP)).map(t => `${t.origin}:${t.key}`).sort())
            .toEqual(['account:andrew:melancholy', 'musicbrainz:genre:psychedelic rock']);
    });

    test('the same origin twice does not duplicate an edge', async () => {
        await db.setGenreTags('group', GROUP, canonicalGenres(['hard rock']),
            { origin: 'musicbrainz:genre' });
        await db.setGenreTags('group', GROUP, canonicalGenres(['hard rock']),
            { origin: 'musicbrainz:genre' });

        expect(await tags('group', GROUP)).toHaveLength(1);
    });

    test('two origins can agree about one genre without colliding', async () => {
        await db.setGenreTags('group', GROUP, canonicalGenres([{ name: 'hard rock', count: 9 }]),
            { origin: 'musicbrainz:genre' });
        await db.setGenreTags('group', GROUP, canonicalGenres(['Hard Rock']),
            { origin: 'account:andrew', claimId: 'claim-1' });

        const found = await tags('group', GROUP);
        expect(found).toHaveLength(2);
        expect(found.every(t => t.key === 'hard rock')).toBe(true);
    });

    test('the display name is the first spelling seen', async () => {
        // MusicBrainz writes genres in lower case by editorial choice; a later
        // source does not get to restyle the node.
        await db.setGenreTags('group', GROUP, canonicalGenres(['psychedelic rock']),
            { origin: 'musicbrainz:genre' });
        await db.setGenreTags('release', RELEASE, canonicalGenres(['Psychedelic Rock']),
            { origin: 'musicbrainz:genre' });

        const [tag] = await tags('release', RELEASE);
        expect(tag.name).toBe('psychedelic rock');
    });

    test('tags come back most-used first', async () => {
        await db.setGenreTags('group', GROUP, canonicalGenres([
            { name: 'melancholy', count: 2 },
            { name: 'hard rock', count: 9 },
        ]), { origin: 'musicbrainz:tag' });

        expect((await tags('group', GROUP)).map(t => t.key)).toEqual(['hard rock', 'melancholy']);
    });

    test('an empty list clears what that origin said', async () => {
        await db.setGenreTags('group', GROUP, canonicalGenres(['hard rock']),
            { origin: 'musicbrainz:genre' });

        expect(await db.setGenreTags('group', GROUP, [], { origin: 'musicbrainz:genre' }))
            .toEqual({ added: 0, removed: 1 });
        expect(await tags('group', GROUP)).toEqual([]);
    });

    test('a Track cannot be tagged', async () => {
        // Deliberately out of scope: a recording's mood is a different claim,
        // and MusicBrainz's genre data is thin at that level.
        await expect(db.setGenreTags('track', 'test:genre:track', [], { origin: 'x' }))
            .rejects.toThrow(/does not carry genre tags/);
    });

    test('an origin is required', async () => {
        await expect(db.setGenreTags('group', GROUP, [], {}))
            .rejects.toThrow(/needs an origin/);
    });
});
