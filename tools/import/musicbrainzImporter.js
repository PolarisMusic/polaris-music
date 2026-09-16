/**
 * MusicBrainz Importer
 *
 * Imports a single release from the MusicBrainz web service into a Polaris
 * CREATE_RELEASE_BUNDLE body.
 *
 * Why MusicBrainz rather than Discogs: Polaris splits Song (composition) from
 * Track (recording), and MusicBrainz is the only open source whose model does
 * the same thing — Work and Recording are separate entities linked by a
 * `performance` relationship. Discogs has no composition entity at all, which
 * is why `discogsImporter.extractWriters()` has to scrape role strings looking
 * for the substring "Written". MusicBrainz gives the composition as data, with
 * an ISWC, and gives per-recording performance credits naming the instrument.
 * That distinction — authorship versus performance — is the one Polaris exists
 * to record, so importing from a source that models it natively loses less.
 *
 * MusicBrainz core data is CC0.
 *
 * Output dialect: this emits what `backend/src/schema/validateReleaseBundle.js`
 * accepts, which is NOT the dialect used by `backend/smoke-tests/releases/*`.
 * Those bundles use `track.groups` and a top-level `labels` array; both are
 * rejected by the canonical schema (`additionalProperties: false`), and they
 * load only because `scripts/loadSmokeTests.js` writes to Neo4j directly
 * without validating. Do not copy their shape.
 *
 * Identity: MBIDs are stable UUIDs that survive retitling and merges, which is
 * what `docs/12-identity-protocol.md` asks a canonical ID to be, so they are
 * emitted as `mb:{entity}:{uuid}` by default. Pass `externalIds: false` to omit
 * every id instead and let `normalizeReleaseBundle` mint `prov:` ids — it keys
 * tracks off ISRC when one is present, which MusicBrainz supplies and Discogs
 * does not.
 *
 * Usage:
 *   node tools/import/musicbrainzImporter.js <release-mbid> \
 *     --contact you@example.com [--members] [--out bundle.json]
 *
 *   import { MusicBrainzImporter } from './tools/import/musicbrainzImporter.js';
 *   const importer = new MusicBrainzImporter({ contact: 'you@example.com' });
 *   const bundle = await importer.importRelease(mbid, { withMembers: true });
 */

/** Relationship types that mean "this person played on this recording". */
const PERFORMANCE_RELS = new Set(['instrument', 'vocal', 'performer', 'performing orchestra']);

/** Relationship types recorded as production credits rather than performances. */
const PRODUCER_RELS = new Set(['producer', 'co-producer']);
const ARRANGER_RELS = new Set(['arranger', 'orchestrator', 'instrument arranger', 'vocal arranger']);

/** Work relationship types that make someone an author of the composition. */
const WRITER_RELS = new Set(['composer', 'lyricist', 'writer', 'librettist']);

/**
 * `inc` parameters for a single release lookup.
 *
 * This is one request rather than one-per-recording: `recording-level-rels`
 * pulls each recording's artist relationships inline, and `work-level-rels`
 * pulls the composer credits off the works those recordings are performances
 * of. MusicBrainz permits one request per second, so collapsing N+1 lookups
 * into one is the difference between a second and a minute per album.
 */
const RELEASE_INC = [
    'artist-credits',
    'labels',
    'recordings',
    'release-groups',
    'media',
    'isrcs',
    'artist-rels',
    'recording-level-rels',
    'work-rels',
    'work-level-rels'
].join('+');

export class MusicBrainzImporter {
    /**
     * @param {Object} config
     * @param {string} [config.contact] - Email or URL for the User-Agent. MusicBrainz
     *   returns 403 for requests that do not identify a contact, so this is effectively
     *   required for live imports.
     * @param {string} [config.userAgent] - Overrides the whole User-Agent string.
     * @param {number} [config.rateLimitMs=1100] - Minimum gap between requests. The
     *   documented limit is one per second; the extra 100ms absorbs clock skew.
     * @param {Function} [config.fetchImpl=fetch] - Injected for tests.
     * @param {boolean} [config.externalIds=true] - Emit `mb:` ids (see module docs).
     */
    constructor(config = {}) {
        this.apiBase = config.apiBase || 'https://musicbrainz.org/ws/2';
        this.contact = config.contact || process.env.MUSICBRAINZ_CONTACT || null;
        this.userAgent = config.userAgent
            || `PolarisImporter/1.0 ( ${this.contact || 'contact-not-set'} )`;
        this.rateLimitMs = config.rateLimitMs ?? 1100;
        this.fetchImpl = config.fetchImpl || globalThis.fetch;
        this.externalIds = config.externalIds !== false;
        this.lastRequestTime = 0;

        if (!this.contact && !config.userAgent) {
            console.warn('⚠ No contact set. MusicBrainz rejects anonymous clients with 403.');
            console.warn('  Pass --contact you@example.com or set MUSICBRAINZ_CONTACT.');
        }

        this.stats = { releases: 0, tracks: 0, songs: 0, credits: 0, requests: 0, errors: 0 };
    }

    /**
     * Fetch a release and convert it to a Polaris bundle body.
     *
     * @param {string} mbid - MusicBrainz release MBID.
     * @param {Object} [options]
     * @param {boolean} [options.withMembers=false] - Also look up each credited
     *   artist to get band membership with date ranges. Costs one request per
     *   artist, so it is off by default.
     * @returns {Promise<Object>} A CREATE_RELEASE_BUNDLE body.
     */
    async importRelease(mbid, options = {}) {
        const release = await this.fetchRelease(mbid);

        let membersByArtist = new Map();
        if (options.withMembers) {
            membersByArtist = await this.fetchMembersForCredits(release['artist-credit'] || []);
        }

        const bundle = this.buildBundle(release, { membersByArtist });

        this.stats.releases += 1;
        this.stats.tracks += bundle.tracks.length;
        this.stats.songs += (bundle.songs || []).length;
        this.stats.credits += bundle.tracks.reduce(
            (n, t) => n + (t.guests?.length || 0) + (t.producers?.length || 0) + (t.arrangers?.length || 0),
            0
        );

        return bundle;
    }

    /**
     * @param {string} mbid
     * @returns {Promise<Object>} Raw MusicBrainz release JSON.
     */
    async fetchRelease(mbid) {
        return this._get(`/release/${encodeURIComponent(mbid)}?inc=${RELEASE_INC}&fmt=json`);
    }

    /**
     * @param {string} mbid
     * @returns {Promise<Object>} Raw MusicBrainz artist JSON with relationships.
     */
    async fetchArtist(mbid) {
        return this._get(`/artist/${encodeURIComponent(mbid)}?inc=artist-rels&fmt=json`);
    }

    /**
     * Resolve band membership for each credited artist.
     *
     * Members and guests are different edges in Polaris, and the difference is
     * not derivable from a release document — membership lives on the artist.
     * Anyone not resolved as a member stays a track guest, which matches the
     * CLAUDE.md rule that unclear credits default to guest.
     *
     * @param {Array} artistCredit - MusicBrainz artist-credit array.
     * @returns {Promise<Map<string, Array>>} artist MBID → member Person objects.
     */
    async fetchMembersForCredits(artistCredit) {
        const out = new Map();
        for (const credit of artistCredit) {
            const artist = credit.artist;
            if (!artist?.id) continue;
            try {
                const full = await this.fetchArtist(artist.id);
                const members = (full.relations || [])
                    .filter(rel => rel.type === 'member of band' && rel.direction === 'backward' && rel.artist)
                    .map(rel => this._person(rel.artist, {
                        roles: rel.attributes || [],
                        instruments: rel.attributes || [],
                        fromDate: rel.begin || undefined,
                        toDate: rel.end || undefined
                    }));
                if (members.length) out.set(artist.id, members);
            } catch (error) {
                this.stats.errors += 1;
                console.warn(`⚠ Could not resolve members for ${artist.name}: ${error.message}`);
            }
        }
        return out;
    }

    /**
     * Pure transform: MusicBrainz release JSON → Polaris bundle body.
     *
     * Kept free of network calls so it can be tested against recorded fixtures.
     *
     * @param {Object} mb - Raw MusicBrainz release.
     * @param {Object} [context]
     * @param {Map<string, Array>} [context.membersByArtist]
     * @returns {Object} CREATE_RELEASE_BUNDLE body.
     */
    buildBundle(mb, context = {}) {
        const membersByArtist = context.membersByArtist || new Map();
        const media = mb.media || [];
        const multiDisc = media.length > 1;

        const songsById = new Map();
        const tracks = [];
        const tracklist = [];

        for (const medium of media) {
            for (const mbTrack of medium.tracks || []) {
                const recording = mbTrack.recording || {};
                const relations = recording.relations || [];

                const song = this._songFromRelations(relations, mbTrack.title);
                if (song && !songsById.has(song.title + (song.song_id || ''))) {
                    songsById.set(song.title + (song.song_id || ''), song);
                }

                const track = this._track(mbTrack, recording, relations, song, mb);
                tracks.push(track);

                tracklist.push(this._compact({
                    position: multiDisc
                        ? `${medium.position ?? 1}-${mbTrack.number ?? mbTrack.position}`
                        : String(mbTrack.number ?? mbTrack.position ?? ''),
                    track_title: mbTrack.title,
                    track_id: track.track_id,
                    duration: track.duration
                }));
            }
        }

        const bundle = {
            release: this._release(mb),
            tracks,
            tracklist
        };

        const groups = this._groups(mb['artist-credit'] || [], membersByArtist);
        if (groups.length) bundle.groups = groups;

        const songs = [...songsById.values()];
        if (songs.length) bundle.songs = songs;

        bundle.sources = [{
            type: 'musicbrainz',
            url: `https://musicbrainz.org/release/${mb.id}`,
            accessed_at: new Date().toISOString().slice(0, 10)
        }];

        return bundle;
    }

    /**
     * @param {Object} mb - Raw MusicBrainz release.
     * @returns {Object} Polaris release object.
     */
    _release(mb) {
        const labels = (mb['label-info'] || [])
            .filter(info => info.label?.name)
            .map(info => this._compact({
                label_id: this.externalIds && info.label.id ? `mb:label:${info.label.id}` : undefined,
                name: info.label.name,
                catalog_number: info['catalog-number'] || undefined
            }));

        // Release-level credits (mastering, art direction, executive production)
        // attach to the release rather than to any one track.
        const guests = (mb.relations || [])
            .filter(rel => rel.artist && (PERFORMANCE_RELS.has(rel.type) || PRODUCER_RELS.has(rel.type)
                || rel.type === 'mastering' || rel.type === 'mix' || rel.type === 'recording'))
            .map(rel => this._person(rel.artist, {
                roles: rel.attributes?.length ? rel.attributes : [rel.type],
                instruments: rel.type === 'instrument' ? rel.attributes : undefined,
                creditedAs: rel['target-credit'] || undefined
            }));

        const format = (mb.media || []).map(m => m.format).filter(Boolean)[0];

        return this._compact({
            release_id: this.externalIds && mb.id ? `mb:release:${mb.id}` : undefined,
            name: mb.title,
            release_date: mb.date || undefined,
            format: format || undefined,
            country: mb.country || undefined,
            master_id: this.externalIds && mb['release-group']?.id
                ? `mb:release-group:${mb['release-group'].id}` : undefined,
            master_name: mb['release-group']?.title || undefined,
            labels: labels.length ? labels : undefined,
            guests: guests.length ? guests : undefined
        });
    }

    /**
     * @param {Array} artistCredit
     * @param {Map<string, Array>} membersByArtist
     * @returns {Array} Polaris groups.
     */
    _groups(artistCredit, membersByArtist) {
        return artistCredit
            .filter(credit => credit.artist?.name)
            .map(credit => {
                const artist = credit.artist;
                const members = membersByArtist.get(artist.id);
                const altNames = [];
                // `credit.name` is how the artist was credited on this specific
                // release, which differs from the canonical name on split
                // billings and pseudonyms. Keep it as an alias rather than
                // letting it overwrite the identity.
                if (credit.name && credit.name !== artist.name) altNames.push(credit.name);
                if (artist.disambiguation) altNames.push(artist.disambiguation);

                return this._compact({
                    group_id: this.externalIds && artist.id ? `mb:artist:${artist.id}` : undefined,
                    name: artist.name,
                    alt_names: altNames.length ? altNames : undefined,
                    members: members?.length ? members : undefined
                });
            });
    }

    /**
     * Build one track, splitting its relationships into performance, production
     * and arrangement credits.
     *
     * Every performer is emitted as a track guest, including people who turn out
     * to be band members. `normalizeReleaseBundle.dropGuestsWhoAreMembers()`
     * removes the overlap, so emitting both here is not a duplicate — it is the
     * only way a member's *instrument on this specific track* survives, and it
     * keeps this importer from having to re-implement the membership rule.
     *
     * @returns {Object} Polaris track.
     */
    _track(mbTrack, recording, relations, song, mb) {
        const guests = [];
        const producers = [];
        const arrangers = [];

        for (const rel of relations) {
            if (!rel.artist) continue;
            const attrs = rel.attributes || [];
            const person = this._person(rel.artist, {
                // An `instrument` relation carries the instrument in its
                // attributes; a `vocal` relation carries the vocal part. Both
                // are the role. A bare `performer` has neither, so fall back to
                // the relation type so the credit is not roleless.
                roles: attrs.length ? attrs : [rel.type],
                instruments: rel.type === 'instrument' && attrs.length ? attrs : undefined,
                creditedAs: rel['target-credit'] || undefined
            });

            if (PERFORMANCE_RELS.has(rel.type)) guests.push(person);
            else if (PRODUCER_RELS.has(rel.type)) producers.push(person);
            else if (ARRANGER_RELS.has(rel.type)) arrangers.push(person);
        }

        const lengthMs = recording.length ?? mbTrack.length;
        const creditName = (mb['artist-credit'] || [])
            .map(c => c.name + (c.joinphrase || '')).join('') || undefined;

        return this._compact({
            track_id: this.externalIds && recording.id ? `mb:recording:${recording.id}` : undefined,
            title: mbTrack.title,
            duration: Number.isFinite(lengthMs) ? Math.round(lengthMs / 1000) : undefined,
            isrc: recording.isrcs?.[0] || undefined,
            performed_by: creditName,
            recording_of: song?.song_id || undefined,
            guests: guests.length ? this._dedupePeople(guests) : undefined,
            producers: producers.length ? this._dedupePeople(producers) : undefined,
            arrangers: arrangers.length ? this._dedupePeople(arrangers) : undefined
        });
    }

    /**
     * Extract the composition behind a recording.
     *
     * A recording points at its Work through a `performance` relationship, and
     * the Work carries the ISWC and the composer/lyricist credits. When a
     * recording has no linked work — common for unpublished and instrumental
     * material — a Song is still synthesized from the track title, because
     * CLAUDE.md requires every Track to be a RECORDING_OF exactly one Song.
     *
     * @returns {Object|null} Polaris song.
     */
    _songFromRelations(relations, fallbackTitle) {
        const performance = relations.find(rel => rel.type === 'performance' && rel.work);
        const work = performance?.work;

        if (!work) {
            return this._compact({ title: fallbackTitle });
        }

        const writers = (work.relations || [])
            .filter(rel => rel.artist && WRITER_RELS.has(rel.type))
            .map(rel => this._compact({
                person_id: this.externalIds && rel.artist.id ? `mb:artist:${rel.artist.id}` : undefined,
                name: rel.artist.name,
                role: rel.type,
                credited_as: rel['target-credit'] || undefined
            }));

        return this._compact({
            song_id: this.externalIds && work.id ? `mb:work:${work.id}` : undefined,
            title: work.title || fallbackTitle,
            iswc: work.iswcs?.[0] || work.iswc || undefined,
            writers: writers.length ? writers : undefined
        });
    }

    /**
     * @returns {Object} Polaris Person, restricted to schema-allowed fields.
     */
    _person(artist, options = {}) {
        const roles = (options.roles || []).filter(Boolean);
        const instruments = (options.instruments || []).filter(Boolean);
        return this._compact({
            person_id: this.externalIds && artist.id ? `mb:artist:${artist.id}` : undefined,
            name: artist.name,
            roles: roles.length ? roles : undefined,
            instruments: instruments.length ? instruments : undefined,
            credited_as: options.creditedAs || undefined,
            from_date: options.fromDate || undefined,
            to_date: options.toDate || undefined
        });
    }

    /**
     * Merge repeated credits for one person on one track.
     *
     * MusicBrainz records a multi-instrumentalist as several relations — one per
     * instrument — so the same name arrives two or three times. Collapsing them
     * into a single Person with several roles keeps one MEMBER_OF/GUEST_ON edge
     * per person per track instead of three parallel edges.
     */
    _dedupePeople(people) {
        const byKey = new Map();
        for (const person of people) {
            const key = person.person_id || person.name.toLowerCase();
            const existing = byKey.get(key);
            if (!existing) {
                byKey.set(key, { ...person });
                continue;
            }
            existing.roles = [...new Set([...(existing.roles || []), ...(person.roles || [])])];
            const instruments = [...new Set([...(existing.instruments || []), ...(person.instruments || [])])];
            if (instruments.length) existing.instruments = instruments;
        }
        return [...byKey.values()];
    }

    /**
     * Drop undefined keys.
     *
     * Every object in the bundle schema sets `additionalProperties: false`, and
     * Ajv rejects a key whose value is undefined the same as any other unknown
     * key once the object is serialized, so the emitted shape has to be exact.
     */
    _compact(object) {
        return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
    }

    /**
     * GET with rate limiting.
     * @private
     */
    async _get(path) {
        await this._rateLimit();
        const url = `${this.apiBase}${path}`;
        const response = await this.fetchImpl(url, {
            headers: { 'User-Agent': this.userAgent, 'Accept': 'application/json' }
        });
        this.stats.requests += 1;

        if (response.status === 503) {
            throw new Error('MusicBrainz rate limit exceeded (503). Increase rateLimitMs.');
        }
        if (!response.ok) {
            throw new Error(`MusicBrainz ${response.status} for ${url}`);
        }
        return response.json();
    }

    /** @private */
    async _rateLimit() {
        const elapsed = Date.now() - this.lastRequestTime;
        if (elapsed < this.rateLimitMs) {
            await new Promise(resolve => setTimeout(resolve, this.rateLimitMs - elapsed));
        }
        this.lastRequestTime = Date.now();
    }

    /** @returns {Object} Import statistics. */
    getStats() {
        return { ...this.stats };
    }
}

export default MusicBrainzImporter;

// ---------------------------------------------------------------------------
// CLI
//
// Writes the bundle to stdout or a file. It deliberately does not anchor,
// store, or submit anything: the bundle is meant to be read before it becomes
// an event, and one release is one event either way.
// ---------------------------------------------------------------------------

/** @returns {Object} Parsed argv. */
function parseArgs(argv) {
    const args = { mbid: null, contact: null, out: null, withMembers: false, externalIds: true };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--members') args.withMembers = true;
        else if (arg === '--no-external-ids') args.externalIds = false;
        else if (arg === '--contact') args.contact = argv[++i];
        else if (arg === '--out') args.out = argv[++i];
        else if (!arg.startsWith('--') && !args.mbid) args.mbid = arg;
    }
    return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = parseArgs(process.argv.slice(2));

    if (!args.mbid) {
        console.error('Usage: node tools/import/musicbrainzImporter.js <release-mbid> \\');
        console.error('         --contact you@example.com [--members] [--no-external-ids] [--out bundle.json]');
        console.error('');
        console.error('Find a release MBID in any musicbrainz.org/release/<mbid> URL.');
        process.exit(1);
    }

    const importer = new MusicBrainzImporter({
        contact: args.contact,
        externalIds: args.externalIds
    });

    try {
        const bundle = await importer.importRelease(args.mbid, { withMembers: args.withMembers });
        const json = JSON.stringify(bundle, null, 2);

        if (args.out) {
            const { writeFileSync } = await import('fs');
            writeFileSync(args.out, json + '\n');
            console.error(`✓ Wrote ${args.out}`);
        } else {
            process.stdout.write(json + '\n');
        }

        const stats = importer.getStats();
        console.error(`  ${bundle.release.name} — ${stats.tracks} tracks, ${stats.songs} songs, ` +
            `${stats.credits} credits, ${stats.requests} requests`);
        if (!args.withMembers) {
            console.error('  (no band membership resolved; pass --members to look it up)');
        }
    } catch (error) {
        console.error(`❌ ${error.message}`);
        process.exit(1);
    }
}
