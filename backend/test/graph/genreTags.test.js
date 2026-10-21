/**
 * Writing genre tags, without a database.
 *
 * The companion of genre-tags-live.test.js, and the layer that was missing:
 * every test of this feature needed a live Neo4j, those suites skip silently
 * without GRAPH_URI, and so `setGenreTags` was never once executed before CI
 * ran it. It threw on the first line that mattered — `Invalid entity type:
 * genre` out of IdentityService, from a path nothing local could reach.
 *
 * So this drives the real method against a recording driver. It cannot check
 * what a MERGE does, which is what the live suite is for; it can check what
 * Cypher is sent and with which ids, which is where that bug lived.
 */

import { describe, test, expect } from '@jest/globals';
import MusicGraphDatabase from '../../src/graph/schema.js';
import { IdentityService } from '../../src/identity/idService.js';
import { canonicalGenres } from '../../src/graph/genreVocabulary.js';

/** A Neo4j integer, as far as countOf is concerned. */
const int = (n) => ({ toNumber: () => n });

/**
 * A driver that records every statement instead of running one.
 *
 * `removed` is what the DELETE reports back, since the method returns it.
 */
function recordingDriver({ removed = 0 } = {}) {
    const statements = [];
    const tx = {
        run: async (cypher, params) => {
            statements.push({ cypher, params });
            return { records: [{ get: (key) => (key === 'removed' ? int(removed) : null) }] };
        },
        commit: async () => { tx.committed = true; },
        rollback: async () => { tx.rolledBack = true; },
    };
    const session = { beginTransaction: () => tx, run: tx.run, close: async () => {} };

    return { statements, tx, session, driver: { session: () => session, close: async () => {} } };
}

/** A graph whose driver is the recorder above. */
function graphWith(options) {
    const db = new MusicGraphDatabase({ uri: 'bolt://unused', user: 'u', password: 'p' });
    const recorder = recordingDriver(options);
    db.driver = recorder.driver;
    return { db, recorder };
}

describe('setGenreTags', () => {
    test('the Genre id comes from the key, nothing else', async () => {
        const { db, recorder } = graphWith();

        await db.setGenreTags('group', 'grp:1', canonicalGenres([{ name: 'Hard Rock', count: 9 }]),
            { origin: 'musicbrainz:genre' });

        const merge = recorder.statements.find(s => s.cypher.includes('MERGE (g:Genre'));
        expect(merge.params.genreId).toBe(IdentityService.makeGenreId('hard rock'));
        expect(merge.params.genreId).toMatch(/^prov:genre:[a-f0-9]{16}$/);
        expect(merge.params.key).toBe('hard rock');
        // Spotted by the one spelling somebody actually wrote.
        expect(merge.params.name).toBe('Hard Rock');
    });

    test('two spellings of one genre are one id', async () => {
        // The whole point of the vocabulary module: a genre that splits in two
        // halves every overlap between two genres, silently.
        const first = graphWith();
        const second = graphWith();

        await first.db.setGenreTags('group', 'grp:1', canonicalGenres(['Hip-Hop']),
            { origin: 'musicbrainz:genre' });
        await second.db.setGenreTags('release', 'rel:1', canonicalGenres(['hip hop']),
            { origin: 'account:andrew' });

        const idOf = ({ recorder }) => recorder.statements
            .find(s => s.cypher.includes('MERGE (g:Genre')).params.genreId;

        expect(idOf(first)).toBe(idOf(second));
    });

    test('it returns what it added and what it replaced', async () => {
        const { db } = graphWith({ removed: 2 });

        const result = await db.setGenreTags('group', 'grp:1',
            canonicalGenres(['hard rock', 'psychedelic rock']), { origin: 'musicbrainz:genre' });

        expect(result).toEqual({ added: 2, removed: 2 });
    });

    test('the delete that precedes it is scoped to one origin', async () => {
        // A re-import must not touch somebody's own tag. This is the parameter
        // that keeps it from doing so; the live suite checks the effect.
        const { db, recorder } = graphWith();

        await db.setGenreTags('group', 'grp:1', [], { origin: 'musicbrainz:genre' });

        const [first] = recorder.statements;
        expect(first.cypher).toMatch(/DELETE r/);
        expect(first.cypher).toMatch(/r\.origin = \$origin/);
        expect(first.params.origin).toBe('musicbrainz:genre');
    });

    test('a genre with no key is skipped rather than written as one', async () => {
        const { db, recorder } = graphWith();

        const result = await db.setGenreTags('group', 'grp:1',
            [{ name: 'Rock' }, { key: '', name: '' }, null], { origin: 'account:andrew' });

        expect(result.added).toBe(0);
        expect(recorder.statements.filter(s => s.cypher.includes('MERGE (g:Genre'))).toHaveLength(0);
    });

    test('a node type that carries no genres is refused before any write', async () => {
        const { db, recorder } = graphWith();

        await expect(db.setGenreTags('track', 'trk:1', canonicalGenres(['rock']),
            { origin: 'account:andrew' })).rejects.toThrow(/does not carry genre tags/);
        expect(recorder.statements).toEqual([]);
    });

    test('an origin is required, because provenance lives on the edge', async () => {
        const { db, recorder } = graphWith();

        await expect(db.setGenreTags('group', 'grp:1', canonicalGenres(['rock']), {}))
            .rejects.toThrow(/needs an origin/);
        expect(recorder.statements).toEqual([]);
    });

    test('a failed write rolls back rather than half-committing', async () => {
        const { db, recorder } = graphWith();
        recorder.tx.run = async () => { throw new Error('neo4j said no'); };

        await expect(db.setGenreTags('group', 'grp:1', canonicalGenres(['rock']),
            { origin: 'musicbrainz:genre' })).rejects.toThrow('neo4j said no');
        expect(recorder.tx.rolledBack).toBe(true);
        expect(recorder.tx.committed).toBeUndefined();
    });
});

describe('a genre is not an entity the identity service mints', () => {
    /**
     * The decision this encodes, rather than the line it protects: everything
     * in EntityType can acquire a canonical id later, because two rows about
     * one person may turn out to be the same person. A genre cannot — it is
     * defined by its key (docs/02-graph-database-schema.md, "Genre tags") — and
     * a second identity for one genre would halve every overlap between two
     * genres silently.
     */
    test('there is no canonical genre id to mint', () => {
        expect(() => IdentityService.mintCanonicalId('genre'))
            .toThrow(/Invalid entity type: genre/);
    });

    test('and no provisional one either, except through makeGenreId', () => {
        expect(() => IdentityService.makeProvisionalId('genre', { key: 'hard rock' }))
            .toThrow(/Invalid entity type: genre/);
        expect(IdentityService.makeGenreId('hard rock')).toMatch(/^prov:genre:[a-f0-9]{16}$/);
    });

    test('the id it does make is deterministic and parses as provisional', () => {
        expect(IdentityService.makeGenreId('hard rock'))
            .toBe(IdentityService.makeGenreId('  hard rock  '));

        const parsed = IdentityService.parseId(IdentityService.makeGenreId('hip hop'));
        expect(parsed).toMatchObject({ kind: 'provisional', entityType: 'genre', valid: true });
    });

    test('a genre with no key is an error, not an id', () => {
        expect(() => IdentityService.makeGenreId('')).toThrow(/needs a key/);
        expect(() => IdentityService.makeGenreId(null)).toThrow(/needs a key/);
    });
});
