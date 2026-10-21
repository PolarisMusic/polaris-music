/**
 * @fileoverview Import what MusicBrainz says a release and its band sound like.
 *
 * Read-only as far as the chain is concerned. An imported tag is a mirror, not
 * an assertion: its provenance is the MBID and the fetch date, anyone can check
 * it at the source, and re-running this reproduces it — which is the test for
 * what may live in the graph without being anchored. A tag somebody invents is
 * the opposite, and goes through a signed event instead.
 *
 * The route in is the barcode, and that is the whole design. Discogs carries no
 * MusicBrainz ids, so the alternative is matching artist and title — the
 * guesswork `tracklistDiff.js` exists to referee, and a worse bet here because
 * a wrong match attaches an entire vocabulary to the wrong band without
 * anything looking broken. So:
 *
 *     Release.barcode  →  MusicBrainz release
 *                      →  its release-group   → genres for the Release
 *                      →  its artist-credit   → genres for the Group
 *
 * Every step is an identifier. Where an identifier cannot decide — two
 * release-groups under one barcode, or a release whose artists and whose groups
 * are not one-to-one — the release is skipped and reported rather than guessed
 * at. A gap in the data is visible and fixable; a wrong genre is neither.
 *
 * @module api/genreImport
 */

import neo4j from 'neo4j-driver';
import { canonicalGenres } from '../graph/genreVocabulary.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('api.genreImport');

/** Where MusicBrainz's two lists land, kept apart because they differ in kind. */
export const GENRE_ORIGIN = 'musicbrainz:genre';
export const TAG_ORIGIN = 'musicbrainz:tag';

/**
 * Releases worth asking about: they carry a barcode and nothing imported yet.
 *
 * A release already tagged by a person is still a candidate — the two origins
 * do not collide — but one already tagged by this importer is skipped unless
 * the caller asks for a refresh, because the point of a re-run is usually to
 * reach the releases the last run could not.
 */
const PENDING_RELEASES = `
    MATCH (r:Release)
    WHERE r.barcode IS NOT NULL AND coalesce(r.status, 'ACTIVE') = 'ACTIVE'
    OPTIONAL MATCH (r)-[t:TAGGED]->(:Genre)
    WITH r, size([o IN collect(t.origin) WHERE o STARTS WITH 'musicbrainz']) AS imported
    WHERE $refresh OR imported = 0
    RETURN r.release_id AS id, r.name AS name, r.barcode AS barcode
    ORDER BY r.name
    LIMIT $limit
`;

/**
 * The groups credited on a release, through the tracks they performed on.
 *
 * PERFORMED_ON points at a Track and IN_RELEASE joins the Track to the Release,
 * so this is the registry's own answer to "whose record is this" — no names
 * involved.
 */
const GROUPS_ON_RELEASE = `
    MATCH (r:Release {release_id: $releaseId})
    OPTIONAL MATCH (g:Group)-[:PERFORMED_ON]->(:Track)-[:IN_RELEASE]->(r)
    WHERE coalesce(g.status, 'ACTIVE') = 'ACTIVE'
    RETURN collect(DISTINCT g.group_id) AS groupIds
`;

export class GenreImporter {
    /**
     * @param {Object} deps
     * @param {Object} deps.graph - MusicGraphDatabase
     * @param {Object} deps.musicbrainz - MusicBrainzClient
     */
    constructor({ graph, musicbrainz }) {
        this.graph = graph;
        this.musicbrainz = musicbrainz;
    }

    /**
     * Import genres for every release that has a barcode and no imported tags.
     *
     * @param {Object} [options]
     * @param {number} [options.limit=50] - At one request a second, a run of
     *   any size is measured in minutes; the cap keeps that a decision rather
     *   than a surprise.
     * @param {boolean} [options.refresh=false] - Re-ask about releases already
     *   imported, which is how a genre MusicBrainz has since dropped goes away.
     * @param {boolean} [options.execute=true]
     * @returns {Promise<{considered: number, results: Array}>}
     */
    async run({ limit = 50, refresh = false, execute = true } = {}) {
        const session = this.graph.driver.session();
        let pending;
        try {
            // neo4j.int, not a plain number: LIMIT takes an Integer and the
            // driver sends a JS number as a Float, which Cypher rejects.
            // nodeSearchService.js does the same for the same reason.
            const found = await session.run(PENDING_RELEASES, {
                refresh,
                limit: neo4j.int(Math.trunc(Number(limit) || 0)),
            });
            pending = found.records.map((r) => ({
                id: r.get('id'),
                name: r.get('name'),
                barcode: r.get('barcode'),
            }));
        } finally {
            await session.close();
        }

        const results = [];
        for (const release of pending) {
            results.push(await this.importRelease(release, { execute }));
        }

        return { considered: pending.length, results };
    }

    /**
     * One release: find it at MusicBrainz, then tag it and its group.
     *
     * Never throws for a release it cannot place. A run over fifty releases
     * must not stop because the fourth has an unknown barcode.
     *
     * @param {{id: string, name: string, barcode: string}} release
     * @param {{execute?: boolean}} [options]
     * @returns {Promise<{id: string, name: string, outcome: string, [key: string]: unknown}>}
     */
    async importRelease(release, { execute = true } = {}) {
        const report = (outcome, extra = {}) => ({ ...release, outcome, ...extra });

        let candidates;
        try {
            candidates = await this.musicbrainz.releasesByBarcode(release.barcode);
        } catch (error) {
            log.warn('musicbrainz_unreachable', { release: release.id, error: error.message });
            return report('lookup_failed', { error: error.message });
        }

        if (candidates.length === 0) return report('not_on_musicbrainz');

        // Several pressings can share a barcode, and they usually share a
        // release-group. When they do not, nothing here can say which record
        // this is, and picking the first would be a guess wearing an
        // identifier's clothes.
        const groupIds = [...new Set(candidates.map((c) => c.releaseGroupId).filter(Boolean))];
        if (groupIds.length > 1) {
            return report('ambiguous_release_group', { candidates: groupIds.length });
        }

        const releaseGroupId = groupIds[0] ?? null;
        const artistIds = [...new Set(candidates.flatMap((c) => c.artistIds))];

        let tagged = { release: null, group: null };

        if (releaseGroupId) {
            tagged.release = await this._applyVocabulary(
                'release', release.id, 'release-group', releaseGroupId,
                { execute, sourceUrl: `https://musicbrainz.org/release-group/${releaseGroupId}` });
        }

        // One artist on their side, one group on ours: the mapping is decided
        // by both being "the artist of this release", with no name compared. Any
        // other shape — a split single, a compilation, a release whose groups we
        // have not finished entering — is left alone.
        const ourGroups = await this._groupsOnRelease(release.id);
        if (artistIds.length === 1 && ourGroups.length === 1) {
            tagged.group = await this._applyVocabulary(
                'group', ourGroups[0], 'artist', artistIds[0],
                { execute, sourceUrl: `https://musicbrainz.org/artist/${artistIds[0]}` });
        }

        return report('imported', {
            release_group: releaseGroupId,
            artists: artistIds.length,
            groups: ourGroups.length,
            tagged,
        });
    }

    /**
     * Fetch one entity's vocabulary and write it against one of our nodes.
     *
     * @private
     */
    async _applyVocabulary(nodeType, nodeId, kind, mbid, { execute, sourceUrl }) {
        let vocabulary;
        try {
            vocabulary = await this.musicbrainz.vocabularyFor(kind, mbid);
        } catch (error) {
            log.warn('vocabulary_failed', { mbid, error: error.message });
            return { error: error.message };
        }

        const genres = canonicalGenres(vocabulary.genres);
        const tags = canonicalGenres(vocabulary.tags);

        if (execute) {
            await this.graph.setGenreTags(nodeType, nodeId, genres,
                { origin: GENRE_ORIGIN, sourceUrl });
            await this.graph.setGenreTags(nodeType, nodeId, tags,
                { origin: TAG_ORIGIN, sourceUrl });
        }

        return {
            node: nodeId,
            genres: genres.map((g) => g.key),
            tags: tags.map((g) => g.key),
        };
    }

    /**
     * @private
     * @returns {Promise<string[]>}
     */
    async _groupsOnRelease(releaseId) {
        const session = this.graph.driver.session();
        try {
            const result = await session.run(GROUPS_ON_RELEASE, { releaseId });
            return (result.records[0]?.get('groupIds') ?? []).filter(Boolean);
        } finally {
            await session.close();
        }
    }
}

export default GenreImporter;
