/**
 * Importing genres, reached by identifier or not at all.
 *
 * The decisions worth pinning are the refusals. A barcode that matches two
 * release-groups, or a release whose artists and whose groups are not
 * one-to-one, cannot be resolved by any identifier — and picking the first
 * would attach a whole vocabulary to the wrong band without anything looking
 * broken. A gap is visible and fixable; a wrong genre is neither.
 *
 * Both the graph and MusicBrainz are faked: this is wiring, and the wiring's
 * most important property is what it declines to do.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { GenreImporter, GENRE_ORIGIN, TAG_ORIGIN } from '../../src/api/genreImport.js';

const RG = 'bbbbbbbb-1111-2222-3333-444444444444';
const ARTIST = 'aaaaaaaa-1111-2222-3333-444444444444';

const RELEASE = { id: 'rel:1', name: 'Fire of Unknown Origin', barcode: '07464373891' };

/**
 * A graph whose two queries answer from fixtures, and whose writes are recorded.
 */
function fakeGraph({ groupIds = ['grp:1'] } = {}) {
    const written = [];
    return {
        written,
        setGenreTags: jest.fn(async (nodeType, nodeId, genres, options) => {
            written.push({ nodeType, nodeId, keys: genres.map((g) => g.key), ...options });
            return { added: genres.length, removed: 0 };
        }),
        driver: {
            session: () => ({
                run: async (query) => {
                    if (query.includes('collect(DISTINCT g.group_id)')) {
                        return { records: [{ get: () => groupIds }] };
                    }
                    return { records: [] };
                },
                close: async () => {},
            }),
        },
    };
}

/** A MusicBrainz whose answers are supplied per test. */
const fakeMusicBrainz = ({ releases = [], vocabulary = {}, throws = null } = {}) => ({
    releasesByBarcode: jest.fn(async () => {
        if (throws === 'barcode') throw new Error('rate-limited');
        return releases;
    }),
    vocabularyFor: jest.fn(async (kind) => {
        if (throws === 'vocabulary') throw new Error('rate-limited');
        return vocabulary[kind] ?? { genres: [], tags: [] };
    }),
});

const oneRelease = [{ id: 'mb:1', title: 'Fire', releaseGroupId: RG, artistIds: [ARTIST] }];

describe('a release that resolves', () => {
    const vocabulary = {
        'release-group': {
            genres: [{ name: 'hard rock', count: 9 }],
            tags: [{ name: 'melancholy', count: 3 }, { name: 'seen live', count: 500 }],
        },
        artist: {
            genres: [{ name: 'Psychedelic Rock', count: 4 }],
            tags: [{ name: 'dreamy', count: 2 }],
        },
    };

    test('tags the release from the release-group', async () => {
        const graph = fakeGraph();
        const importer = new GenreImporter({ graph, musicbrainz: fakeMusicBrainz({ releases: oneRelease, vocabulary }) });

        const result = await importer.importRelease(RELEASE);

        expect(result.outcome).toBe('imported');
        expect(graph.written).toContainEqual(expect.objectContaining({
            nodeType: 'release', nodeId: 'rel:1',
            keys: ['hard rock'], origin: GENRE_ORIGIN,
        }));
    });

    test('and the group from the artist', async () => {
        // Reached through the release's artist-credit, not by comparing names.
        const graph = fakeGraph();
        const importer = new GenreImporter({ graph, musicbrainz: fakeMusicBrainz({ releases: oneRelease, vocabulary }) });

        await importer.importRelease(RELEASE);

        expect(graph.written).toContainEqual(expect.objectContaining({
            nodeType: 'group', nodeId: 'grp:1',
            keys: ['psychedelic rock'], origin: GENRE_ORIGIN,
        }));
    });

    test('genres and tags land under separate origins', async () => {
        // A controlled list and a stranger's adjective deserve different trust,
        // and a reader should be able to ask for one without the other.
        const graph = fakeGraph();
        const importer = new GenreImporter({ graph, musicbrainz: fakeMusicBrainz({ releases: oneRelease, vocabulary }) });

        await importer.importRelease(RELEASE);

        const origins = graph.written.map((w) => w.origin);
        expect(origins).toContain(GENRE_ORIGIN);
        expect(origins).toContain(TAG_ORIGIN);
    });

    test('noise is dropped from the tags on the way in', async () => {
        const graph = fakeGraph();
        const importer = new GenreImporter({ graph, musicbrainz: fakeMusicBrainz({ releases: oneRelease, vocabulary }) });

        await importer.importRelease(RELEASE);

        const tagWrite = graph.written.find(
            (w) => w.origin === TAG_ORIGIN && w.nodeType === 'release');
        expect(tagWrite.keys).toEqual(['melancholy']);
    });

    test('the source url points at what was read', async () => {
        const graph = fakeGraph();
        const importer = new GenreImporter({ graph, musicbrainz: fakeMusicBrainz({ releases: oneRelease, vocabulary }) });

        await importer.importRelease(RELEASE);

        expect(graph.written[0].sourceUrl).toBe(`https://musicbrainz.org/release-group/${RG}`);
    });

    test('a dry run reads everything and writes nothing', async () => {
        const graph = fakeGraph();
        const importer = new GenreImporter({ graph, musicbrainz: fakeMusicBrainz({ releases: oneRelease, vocabulary }) });

        const result = await importer.importRelease(RELEASE, { execute: false });

        expect(result.outcome).toBe('imported');
        expect(result.tagged.release.genres).toEqual(['hard rock']);
        expect(graph.setGenreTags).not.toHaveBeenCalled();
    });
});

describe('what it refuses to resolve', () => {
    test('a barcode MusicBrainz does not know', async () => {
        const graph = fakeGraph();
        const importer = new GenreImporter({ graph, musicbrainz: fakeMusicBrainz({ releases: [] }) });

        expect((await importer.importRelease(RELEASE)).outcome).toBe('not_on_musicbrainz');
        expect(graph.setGenreTags).not.toHaveBeenCalled();
    });

    test('two release-groups under one barcode', async () => {
        // Pressings sharing a barcode usually share a release-group. When they
        // do not, nothing here can say which record this is.
        const graph = fakeGraph();
        const importer = new GenreImporter({
            graph,
            musicbrainz: fakeMusicBrainz({
                releases: [
                    { id: 'mb:1', releaseGroupId: RG, artistIds: [ARTIST] },
                    { id: 'mb:2', releaseGroupId: 'cccccccc-1111-2222-3333-444444444444', artistIds: [ARTIST] },
                ],
            }),
        });

        const result = await importer.importRelease(RELEASE);

        expect(result.outcome).toBe('ambiguous_release_group');
        expect(graph.setGenreTags).not.toHaveBeenCalled();
    });

    test('a split single: two artists, one group of ours', async () => {
        const graph = fakeGraph({ groupIds: ['grp:1'] });
        const importer = new GenreImporter({
            graph,
            musicbrainz: fakeMusicBrainz({
                releases: [{ id: 'mb:1', releaseGroupId: RG, artistIds: [ARTIST, 'dddddddd-1111-2222-3333-444444444444'] }],
                vocabulary: { 'release-group': { genres: [{ name: 'punk', count: 1 }], tags: [] } },
            }),
        });

        const result = await importer.importRelease(RELEASE);

        // The release is still tagged — the barcode identified it — but no
        // group is, because which artist is which band is not decidable here.
        expect(result.outcome).toBe('imported');
        expect(graph.written.every((w) => w.nodeType === 'release')).toBe(true);
    });

    test('a release whose groups we have not finished entering', async () => {
        const graph = fakeGraph({ groupIds: ['grp:1', 'grp:2'] });
        const importer = new GenreImporter({
            graph,
            musicbrainz: fakeMusicBrainz({
                releases: oneRelease,
                vocabulary: { 'release-group': { genres: [{ name: 'punk', count: 1 }], tags: [] } },
            }),
        });

        await importer.importRelease(RELEASE);

        expect(graph.written.every((w) => w.nodeType === 'release')).toBe(true);
    });

    test('a release with no group of ours at all', async () => {
        const graph = fakeGraph({ groupIds: [] });
        const importer = new GenreImporter({
            graph,
            musicbrainz: fakeMusicBrainz({
                releases: oneRelease,
                vocabulary: { 'release-group': { genres: [{ name: 'punk', count: 1 }], tags: [] } },
            }),
        });

        await importer.importRelease(RELEASE);

        expect(graph.written.every((w) => w.nodeType === 'release')).toBe(true);
    });
});

describe('a run survives its own failures', () => {
    test('an unreachable MusicBrainz is reported, not thrown', async () => {
        // A run over fifty releases must not stop because the fourth fails.
        const importer = new GenreImporter({
            graph: fakeGraph(),
            musicbrainz: fakeMusicBrainz({ throws: 'barcode' }),
        });

        const result = await importer.importRelease(RELEASE);

        expect(result.outcome).toBe('lookup_failed');
        expect(result.error).toMatch(/rate-limited/);
    });

    test('a failed vocabulary lookup still reports the release', async () => {
        const graph = fakeGraph();
        const importer = new GenreImporter({
            graph,
            musicbrainz: fakeMusicBrainz({ releases: oneRelease, throws: 'vocabulary' }),
        });

        const result = await importer.importRelease(RELEASE);

        expect(result.outcome).toBe('imported');
        expect(result.tagged.release.error).toMatch(/rate-limited/);
        expect(graph.setGenreTags).not.toHaveBeenCalled();
    });
});
