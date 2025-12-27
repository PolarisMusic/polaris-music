/**
 * @fileoverview Neo4j graph database schema and operations for Polaris Music Registry
 *
 * This module implements the core graph database layer that stores normalized music data
 * with Groups as primary performance entities and careful tracking of member/guest relationships.
 *
 * Key Concepts:
 * - Groups (not individual artists) are the primary performance entities
 * - MEMBER_OF relationships track core group membership with date ranges
 * - GUEST_ON relationships track session musicians and non-member contributors
 * - All operations are idempotent and can be safely replayed
 * - Provisional IDs are used when external canonical IDs are unavailable
 *
 * @module graph/schema
 */

import neo4j from 'neo4j-driver';
import { createHash } from 'crypto';
import { IdentityService, EntityType } from '../identity/idService.js';
import { MergeOperations } from './merge.js';

/**
 * Main class for interacting with the Neo4j graph database.
 * Handles schema initialization, event processing, and data queries.
 *
 * @class MusicGraphDatabase
 */
class MusicGraphDatabase {
    /**
     * Create a new database connection
     *
     * @param {Object} config - Database configuration
     * @param {string} config.uri - Neo4j bolt:// connection URI
     * @param {string} config.user - Database username
     * @param {string} config.password - Database password
     * @param {Object} [config.poolConfig] - Optional connection pool configuration
     */
    constructor(config) {
        if (!config.uri || !config.user || !config.password) {
            throw new Error('Database configuration requires uri, user, and password');
        }

        // Initialize Neo4j driver with connection pooling
        this.driver = neo4j.driver(
            config.uri,
            neo4j.auth.basic(config.user, config.password),
            {
                maxConnectionPoolSize: config.poolConfig?.maxSize || 100,
                connectionTimeout: config.poolConfig?.timeout || 30000,
                maxTransactionRetryTime: 30000,
                ...config.poolConfig
            }
        );

        this.config = config;
    }

    /**
     * Initialize all database constraints and indexes.
     * Must be run before any data insertion to ensure integrity.
     * This operation is idempotent and safe to run multiple times.
     *
     * @returns {Promise<void>}
     * @throws {Error} If database connection fails or constraints cannot be created
     */
    async initializeSchema() {
        const session = this.driver.session();

        try {
            console.log('Initializing database schema...');

            // ========== NODE CONSTRAINTS ==========
            // These ensure each entity has a unique identifier

            const constraints = [
                // Person: Individual musician, producer, engineer, etc.
                {
                    name: 'person_id',
                    query: 'CREATE CONSTRAINT person_id IF NOT EXISTS FOR (p:Person) REQUIRE p.person_id IS UNIQUE'
                },

                // Group: Band, orchestra, ensemble - collection of Persons
                {
                    name: 'group_id',
                    query: 'CREATE CONSTRAINT group_id IF NOT EXISTS FOR (g:Group) REQUIRE g.group_id IS UNIQUE'
                },

                // Song: Composition (the written musical work)
                {
                    name: 'song_id',
                    query: 'CREATE CONSTRAINT song_id IF NOT EXISTS FOR (s:Song) REQUIRE s.song_id IS UNIQUE'
                },

                // Track: Recording (specific performance of a song)
                {
                    name: 'track_id',
                    query: 'CREATE CONSTRAINT track_id IF NOT EXISTS FOR (t:Track) REQUIRE t.track_id IS UNIQUE'
                },

                // Release: Album, EP, Single, or other package
                {
                    name: 'release_id',
                    query: 'CREATE CONSTRAINT release_id IF NOT EXISTS FOR (r:Release) REQUIRE r.release_id IS UNIQUE'
                },

                // Master: Canonical album entity (groups multiple releases)
                {
                    name: 'master_id',
                    query: 'CREATE CONSTRAINT master_id IF NOT EXISTS FOR (m:Master) REQUIRE m.master_id IS UNIQUE'
                },

                // Label: Record label / publisher
                {
                    name: 'label_id',
                    query: 'CREATE CONSTRAINT label_id IF NOT EXISTS FOR (l:Label) REQUIRE l.label_id IS UNIQUE'
                },

                // Account: Blockchain account that submits data
                {
                    name: 'account_id',
                    query: 'CREATE CONSTRAINT account_id IF NOT EXISTS FOR (a:Account) REQUIRE a.account_id IS UNIQUE'
                },

                // City: Geographic location for origin attribution
                {
                    name: 'city_id',
                    query: 'CREATE CONSTRAINT city_id IF NOT EXISTS FOR (c:City) REQUIRE c.city_id IS UNIQUE'
                },

                // Claim: Audit trail for all data changes
                {
                    name: 'claim_id',
                    query: 'CREATE CONSTRAINT claim_id IF NOT EXISTS FOR (cl:Claim) REQUIRE cl.claim_id IS UNIQUE'
                },

                // Source: External data source reference
                {
                    name: 'source_id',
                    query: 'CREATE CONSTRAINT source_id IF NOT EXISTS FOR (src:Source) REQUIRE src.source_id IS UNIQUE'
                },

                // Media: Multimedia content reference
                {
                    name: 'media_id',
                    query: 'CREATE CONSTRAINT media_id IF NOT EXISTS FOR (m:Media) REQUIRE m.media_id IS UNIQUE'
                },

                // IdentityMap: Maps external IDs to canonical IDs
                {
                    name: 'identity_map_key',
                    query: 'CREATE CONSTRAINT identity_map_key IF NOT EXISTS FOR (im:IdentityMap) REQUIRE im.key IS UNIQUE'
                }
            ];

            // Create all constraints
            for (const constraint of constraints) {
                try {
                    await session.run(constraint.query);
                    console.log(`   Created constraint: ${constraint.name}`);
                } catch (error) {
                    // Constraint might already exist - this is fine
                    if (!error.message.includes('already exists')) {
                        console.warn(`  � Warning creating constraint ${constraint.name}:`, error.message);
                    }
                }
            }

            // ========== INDEXES FOR PERFORMANCE ==========

            const indexes = [
                // Name searches (most common query pattern)
                { name: 'person_name', query: 'CREATE INDEX person_name IF NOT EXISTS FOR (p:Person) ON (p.name)' },
                { name: 'group_name', query: 'CREATE INDEX group_name IF NOT EXISTS FOR (g:Group) ON (g.name)' },
                { name: 'release_name', query: 'CREATE INDEX release_name IF NOT EXISTS FOR (r:Release) ON (r.name)' },
                { name: 'track_title', query: 'CREATE INDEX track_title IF NOT EXISTS FOR (t:Track) ON (t.title)' },
                { name: 'song_title', query: 'CREATE INDEX song_title IF NOT EXISTS FOR (s:Song) ON (s.title)' },

                // Date-based queries
                { name: 'release_date', query: 'CREATE INDEX release_date IF NOT EXISTS FOR (r:Release) ON (r.release_date)' },
                { name: 'group_formed', query: 'CREATE INDEX group_formed IF NOT EXISTS FOR (g:Group) ON (g.formed_date)' },

                // Geographic queries
                { name: 'city_location', query: 'CREATE INDEX city_location IF NOT EXISTS FOR (c:City) ON (c.lat, c.lon)' },

                // Status filtering (provisional vs canonical entities)
                { name: 'person_status', query: 'CREATE INDEX person_status IF NOT EXISTS FOR (p:Person) ON (p.status)' },
                { name: 'group_status', query: 'CREATE INDEX group_status IF NOT EXISTS FOR (g:Group) ON (g.status)' },

                // Event hash lookups
                { name: 'claim_event', query: 'CREATE INDEX claim_event IF NOT EXISTS FOR (c:Claim) ON (c.event_hash)' },

                // IdentityMap lookups (for external ID resolution)
                { name: 'identity_map_source', query: 'CREATE INDEX identity_map_source IF NOT EXISTS FOR (im:IdentityMap) ON (im.source)' },
                { name: 'identity_map_external_id', query: 'CREATE INDEX identity_map_external_id IF NOT EXISTS FOR (im:IdentityMap) ON (im.external_id)' },
                { name: 'identity_map_canonical', query: 'CREATE INDEX identity_map_canonical IF NOT EXISTS FOR (im:IdentityMap) ON (im.canonical_id)' }
            ];

            // Create all indexes
            for (const index of indexes) {
                try {
                    await session.run(index.query);
                    console.log(`   Created index: ${index.name}`);
                } catch (error) {
                    if (!error.message.includes('already exists')) {
                        console.warn(`  � Warning creating index ${index.name}:`, error.message);
                    }
                }
            }

            console.log(' Database schema initialized successfully');

        } catch (error) {
            console.error(' Failed to initialize database schema:', error);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Process a CREATE_RELEASE_BUNDLE event.
     * This is the main entry point for new music data submission.
     * Creates all entities and relationships in a single atomic transaction.
     *
     * The operation is idempotent - replaying the same event hash will not duplicate data.
     *
     * @param {string} eventHash - SHA256 hash of the canonical event
     * @param {Object} bundle - The release bundle data
     * @param {Object} bundle.release - Release information
     * @param {Array} bundle.groups - Groups performing on this release
     * @param {Array} bundle.tracks - Track listing with performers
     * @param {Array} [bundle.songs] - Song compositions (optional, can be inferred from tracks)
     * @param {Array} bundle.tracklist - Track ordering information
     * @param {Array} [bundle.sources] - External source references
     * @param {string} submitterAccount - Blockchain account that submitted this event
     * @returns {Promise<Object>} Result with releaseId and statistics
     * @throws {Error} If transaction fails (will rollback all changes)
     */
    async processReleaseBundle(eventHash, bundle, submitterAccount) {
        const session = this.driver.session();
        const tx = session.beginTransaction();

        try {
            // Validate required fields
            if (!eventHash || !bundle || !bundle.release) {
                throw new Error('Invalid release bundle: missing required fields');
            }

            console.log(`Processing release bundle from event ${eventHash.substring(0, 8)}...`);

            // Generate deterministic operation IDs for each sub-operation
            // This ensures idempotency - replaying the same event is safe
            let opIndex = 0;
            const opId = () => {
                const id = createHash('sha256')
                    .update(eventHash + opIndex.toString())
                    .digest('hex');
                opIndex++;
                return id;
            };

            // ========== 1. CREATE/UPDATE GROUPS ==========
            // Groups must be created before we can link members and performances

            const processedGroups = [];

            for (const group of bundle.groups || []) {
                const groupOpId = opId();
                const groupId = await this.resolveEntityId(tx, 'group', group);

                const idKind = IdentityService.parseId(groupId).kind;
                console.log(`  Creating/updating group: ${group.name} (${groupId.substring(0, 12)}...) [${idKind}]`);

                await tx.run(`
                    MERGE (g:Group {group_id: $groupId})
                    SET g.name = $name,
                        g.alt_names = $altNames,
                        g.bio = $bio,
                        g.formed_date = $formed,
                        g.disbanded_date = $disbanded,
                        g.status = $status,
                        g.updated_by = $eventHash,
                        g.updated_at = datetime()

                    // Link to submitter Account
                    WITH g
                    MERGE (a:Account {account_id: $account})
                    ON CREATE SET a.created_at = datetime()
                    MERGE (a)-[sub:SUBMITTED {
                        event_hash: $eventHash,
                        timestamp: datetime()
                    }]->(g)

                    RETURN g.group_id as groupId
                `, {
                    groupId,
                    name: group.name,
                    altNames: group.alt_names || [],
                    bio: group.bio || null,
                    formed: group.formed_date || null,
                    disbanded: group.disbanded_date || null,
                    status: idKind === 'canonical' ? 'ACTIVE' : 'PROVISIONAL',
                    eventHash,
                    account: submitterAccount
                });

                // Link to origin City if provided
                if (group.origin_city) {
                    const cityId = await this.resolveEntityId(tx, 'city', group.origin_city);

                    await tx.run(`
                        MATCH (g:Group {group_id: $groupId})
                        MERGE (c:City {city_id: $cityId})
                        ON CREATE SET c.name = $cityName,
                                     c.lat = $cityLat,
                                     c.lon = $cityLon
                        MERGE (g)-[:ORIGIN]->(c)
                    `, {
                        groupId,
                        cityId,
                        cityName: group.origin_city.name,
                        cityLat: group.origin_city.lat,
                        cityLon: group.origin_city.lon
                    });
                }

                // Process Group members with their roles and periods
                for (const member of group.members || []) {
                    const personId = await this.resolveEntityId(tx, 'person', member);
                    const personIdKind = IdentityService.parseId(personId).kind;

                    console.log(`    Adding member: ${member.name} [${personIdKind}]`);

                    await tx.run(`
                        MERGE (p:Person {person_id: $personId})
                        ON CREATE SET p.name = $name,
                                     p.status = $status,
                                     p.created_at = datetime()

                        WITH p
                        MATCH (g:Group {group_id: $groupId})

                        // MEMBER_OF relationship with full details
                        MERGE (p)-[m:MEMBER_OF {claim_id: $claimId}]->(g)
                        SET m.role = $role,
                            m.from_date = $from,
                            m.to_date = $to,
                            m.instruments = $instruments

                        RETURN p.person_id as personId
                    `, {
                        personId,
                        name: member.name,
                        status: personIdKind === 'canonical' ? 'ACTIVE' : 'PROVISIONAL',
                        groupId,
                        role: member.role || 'member',
                        from: member.from_date || null,
                        to: member.to_date || null,
                        instruments: member.instruments || [],
                        claimId: groupOpId
                    });

                    // Link person to origin city if provided
                    if (member.origin_city) {
                        const memberCityId = await this.resolveEntityId(tx, 'city', member.origin_city);

                        await tx.run(`
                            MATCH (p:Person {person_id: $personId})
                            MERGE (c:City {city_id: $cityId})
                            ON CREATE SET c.name = $cityName,
                                         c.lat = $cityLat,
                                         c.lon = $cityLon
                            MERGE (p)-[:ORIGIN]->(c)
                        `, {
                            personId,
                            cityId: memberCityId,
                            cityName: member.origin_city.name,
                            cityLat: member.origin_city.lat,
                            cityLon: member.origin_city.lon
                        });
                    }
                }

                // Create audit claim for group creation
                await this.createClaim(tx, groupOpId, 'Group', groupId,
                                     'created', group, eventHash);

                processedGroups.push(groupId);
            }

            // ========== 2. CREATE RELEASE ==========

            const releaseOpId = opId();
            const releaseId = await this.resolveEntityId(tx, 'release', bundle.release);

            console.log(`  Creating release: ${bundle.release.name} (${releaseId.substring(0, 12)}...)`);

            await tx.run(`
                MERGE (r:Release {release_id: $releaseId})
                SET r.name = $name,
                    r.alt_names = $altNames,
                    r.release_date = $date,
                    r.format = $format,
                    r.country = $country,
                    r.catalog_number = $catalogNumber,
                    r.liner_notes = $linerNotes,
                    r.trivia = $trivia,
                    r.album_art = $albumArt,
                    r.status = $status,
                    r.updated_by = $eventHash,
                    r.updated_at = datetime()

                // Link to submitter
                WITH r
                MERGE (a:Account {account_id: $account})
                MERGE (a)-[:SUBMITTED {event_hash: $eventHash}]->(r)

                RETURN r.release_id as releaseId
            `, {
                releaseId,
                name: bundle.release.name,
                altNames: bundle.release.alt_names || [],
                date: bundle.release.release_date || null,
                format: bundle.release.format || [],
                country: bundle.release.country || null,
                catalogNumber: bundle.release.catalog_number || null,
                linerNotes: bundle.release.liner_notes || null,
                trivia: bundle.release.trivia || null,
                albumArt: bundle.release.album_art || null,
                status: bundle.release.release_id ? 'canonical' : 'provisional',
                eventHash,
                account: submitterAccount
            });

            // Process release-level guests (engineers, producers, etc.)
            for (const guest of bundle.release.guests || []) {
                const personId = await this.resolveEntityId(tx, 'person', guest);

                await tx.run(`
                    MERGE (p:Person {person_id: $personId})
                    ON CREATE SET p.name = $name,
                                 p.status = $status

                    WITH p
                    MATCH (r:Release {release_id: $releaseId})
                    MERGE (p)-[g:GUEST_ON {claim_id: $claimId}]->(r)
                    SET g.roles = $roles,
                        g.credited_as = $creditedAs
                `, {
                    personId,
                    name: guest.name,
                    status: guest.person_id ? 'canonical' : 'provisional',
                    releaseId,
                    roles: guest.roles || [],
                    creditedAs: guest.credited_as || null,
                    claimId: releaseOpId
                });
            }

            // Create audit claim for release
            await this.createClaim(tx, releaseOpId, 'Release', releaseId,
                                 'created', bundle.release, eventHash);

            // ========== 3. PROCESS SONGS (Compositions) ==========

            const processedSongs = new Map(); // songId -> song data

            for (const song of bundle.songs || []) {
                const songOpId = opId();
                const songId = await this.resolveEntityId(tx, 'song', song);

                console.log(`  Creating song: ${song.title} (${songId.substring(0, 12)}...)`);

                await tx.run(`
                    MERGE (s:Song {song_id: $songId})
                    SET s.title = $title,
                        s.alt_titles = $altTitles,
                        s.iswc = $iswc,
                        s.year = $year,
                        s.lyrics = $lyrics,
                        s.status = $status,
                        s.updated_at = datetime()
                `, {
                    songId,
                    title: song.title,
                    altTitles: song.alt_titles || [],
                    iswc: song.iswc || null,
                    year: song.year || null,
                    lyrics: song.lyrics || null,
                    status: song.song_id ? 'canonical' : 'provisional'
                });

                // Link songwriters (Persons who WROTE this Song)
                for (const writer of song.writers || []) {
                    const writerId = await this.resolveEntityId(tx, 'person', writer);

                    await tx.run(`
                        MERGE (p:Person {person_id: $personId})
                        ON CREATE SET p.name = $name,
                                     p.status = $status
                        WITH p
                        MATCH (s:Song {song_id: $songId})
                        MERGE (p)-[w:WROTE {claim_id: $claimId}]->(s)
                        SET w.role = $role,
                            w.share_percentage = $share
                    `, {
                        personId: writerId,
                        name: writer.name,
                        status: writer.person_id ? 'canonical' : 'provisional',
                        songId,
                        role: writer.role || 'songwriter',
                        share: writer.share_percentage || null,
                        claimId: songOpId
                    });
                }

                await this.createClaim(tx, songOpId, 'Song', songId,
                                     'created', song, eventHash);

                processedSongs.set(songId, song);
            }

            // ========== 4. PROCESS TRACKS (Recordings) ==========

            const processedTracks = [];

            for (const track of bundle.tracks || []) {
                const trackOpId = opId();
                const trackId = await this.resolveEntityId(tx, 'track', track);

                console.log(`  Creating track: ${track.title} (${trackId.substring(0, 12)}...)`);

                await tx.run(`
                    MERGE (t:Track {track_id: $trackId})
                    SET t.title = $title,
                        t.isrc = $isrc,
                        t.duration = $duration,
                        t.recording_date = $recordingDate,
                        t.recording_location = $location,
                        t.listen_links = $listenLinks,
                        t.status = $status,
                        t.updated_at = datetime()
                `, {
                    trackId,
                    title: track.title,
                    isrc: track.isrc || null,
                    duration: track.duration || null,
                    recordingDate: track.recording_date || null,
                    location: track.recording_location || null,
                    listenLinks: track.listen_links || [],
                    status: track.track_id ? 'canonical' : 'provisional'
                });

                // ========== CRITICAL: DISTINGUISH GROUPS vs GUESTS ==========

                // Link performing GROUPS (the main bands/orchestras)
                for (const performingGroup of track.performed_by_groups || []) {
                    const perfGroupId = performingGroup.group_id;

                    if (!perfGroupId) {
                        console.warn(`    Warning: Track ${track.title} has performing group without ID`);
                        continue;
                    }

                    await tx.run(`
                        MATCH (t:Track {track_id: $trackId})
                        MATCH (g:Group {group_id: $groupId})

                        // PERFORMED_ON relationship for the group
                        MERGE (g)-[p:PERFORMED_ON {claim_id: $claimId}]->(t)
                        SET p.credited_as = $creditedAs
                    `, {
                        trackId,
                        groupId: perfGroupId,
                        creditedAs: performingGroup.credited_as || null,
                        claimId: trackOpId
                    });
                }

                // Link GUEST performers (individuals not in the main group)
                for (const guest of track.guests || []) {
                    const guestId = await this.resolveEntityId(tx, 'person', guest);

                    await tx.run(`
                        MERGE (p:Person {person_id: $personId})
                        ON CREATE SET p.name = $name,
                                     p.status = $status

                        WITH p
                        MATCH (t:Track {track_id: $trackId})

                        // GUEST_ON relationship for non-members
                        MERGE (p)-[g:GUEST_ON {claim_id: $claimId}]->(t)
                        SET g.roles = $roles,
                            g.instruments = $instruments,
                            g.credited_as = $creditedAs
                    `, {
                        personId: guestId,
                        name: guest.name,
                        status: guest.person_id ? 'canonical' : 'provisional',
                        trackId,
                        roles: guest.roles || [],
                        instruments: guest.instruments || [],
                        creditedAs: guest.credited_as || null,
                        claimId: trackOpId
                    });
                }

                // Link producers
                for (const producer of track.producers || []) {
                    const producerId = await this.resolveEntityId(tx, 'person', producer);

                    await tx.run(`
                        MERGE (p:Person {person_id: $personId})
                        ON CREATE SET p.name = $name,
                                     p.status = $status
                        WITH p
                        MATCH (t:Track {track_id: $trackId})
                        MERGE (p)-[pr:PRODUCED {claim_id: $claimId}]->(t)
                        SET pr.role = $role
                    `, {
                        personId: producerId,
                        name: producer.name,
                        status: producer.person_id ? 'canonical' : 'provisional',
                        trackId,
                        role: producer.role || 'producer',
                        claimId: trackOpId
                    });
                }

                // Link arrangers
                for (const arranger of track.arrangers || []) {
                    const arrangerId = await this.resolveEntityId(tx, 'person', arranger);

                    await tx.run(`
                        MERGE (p:Person {person_id: $personId})
                        ON CREATE SET p.name = $name,
                                     p.status = $status
                        WITH p
                        MATCH (t:Track {track_id: $trackId})
                        MERGE (p)-[a:ARRANGED {claim_id: $claimId}]->(t)
                        SET a.role = $role
                    `, {
                        personId: arrangerId,
                        name: arranger.name,
                        status: arranger.person_id ? 'canonical' : 'provisional',
                        trackId,
                        role: arranger.role || 'arranger',
                        claimId: trackOpId
                    });
                }

                // Link to Song if it's a recording of a composition
                if (track.recording_of_song_id) {
                    await tx.run(`
                        MATCH (t:Track {track_id: $trackId})
                        MATCH (s:Song {song_id: $songId})
                        MERGE (t)-[r:RECORDING_OF {claim_id: $claimId}]->(s)
                    `, {
                        trackId,
                        songId: track.recording_of_song_id,
                        claimId: trackOpId
                    });
                }

                // Link cover versions
                if (track.cover_of_song_id) {
                    await tx.run(`
                        MATCH (t:Track {track_id: $trackId})
                        MATCH (s:Song {song_id: $songId})
                        MERGE (t)-[c:COVER_OF {claim_id: $claimId}]->(s)
                    `, {
                        trackId,
                        songId: track.cover_of_song_id,
                        claimId: trackOpId
                    });
                }

                // Link samples
                for (const sample of track.samples || []) {
                    await tx.run(`
                        MATCH (t1:Track {track_id: $trackId})
                        MERGE (t2:Track {track_id: $sampleId})
                        ON CREATE SET t2.status = 'provisional',
                                     t2.title = $sampleTitle
                        MERGE (t1)-[s:SAMPLES {claim_id: $claimId}]->(t2)
                        SET s.portion_used = $portion,
                            s.cleared = $cleared
                    `, {
                        trackId,
                        sampleId: sample.track_id,
                        sampleTitle: sample.title || 'Unknown',
                        portion: sample.portion_used || null,
                        cleared: sample.cleared || false,
                        claimId: trackOpId
                    });
                }

                await this.createClaim(tx, trackOpId, 'Track', trackId,
                                     'created', track, eventHash);

                processedTracks.push(trackId);
            }

            // ========== 5. CREATE TRACKLIST ==========
            // Link tracks to the release with order information

            console.log(`  Linking ${bundle.tracklist?.length || 0} tracks to release...`);

            for (const item of bundle.tracklist || []) {
                await tx.run(`
                    MATCH (t:Track {track_id: $trackId})
                    MATCH (r:Release {release_id: $releaseId})
                    MERGE (t)-[i:IN_RELEASE]->(r)
                    SET i.disc_number = $disc,
                        i.track_number = $trackNo,
                        i.side = $side,
                        i.is_bonus = $isBonus
                `, {
                    trackId: item.track_id,
                    releaseId,
                    disc: item.disc_number || 1,
                    trackNo: item.track_number,
                    side: item.side || null,
                    isBonus: item.is_bonus || false
                });
            }

            // ========== 6. LINK MASTER AND LABELS ==========

            if (bundle.release.master_id) {
                await tx.run(`
                    MERGE (m:Master {master_id: $masterId})
                    ON CREATE SET m.name = $masterName,
                                 m.created_at = datetime()
                    WITH m
                    MATCH (r:Release {release_id: $releaseId})
                    MERGE (r)-[:IN_MASTER]->(m)
                `, {
                    masterId: bundle.release.master_id,
                    masterName: bundle.release.master_name || bundle.release.name,
                    releaseId
                });
            }

            // Link labels
            for (const label of bundle.release.labels || []) {
                const labelId = await this.resolveEntityId(tx, 'label', label);

                await tx.run(`
                    MERGE (l:Label {label_id: $labelId})
                    ON CREATE SET l.name = $labelName,
                                 l.status = $status

                    WITH l
                    MATCH (r:Release {release_id: $releaseId})
                    MERGE (l)-[:RELEASED]->(r)
                `, {
                    labelId,
                    labelName: label.name,
                    status: label.label_id ? 'canonical' : 'provisional',
                    releaseId
                });

                // Link label to city if provided
                if (label.origin_city) {
                    await tx.run(`
                        MATCH (l:Label {label_id: $labelId})
                        MERGE (c:City {city_id: $cityId})
                        ON CREATE SET c.name = $cityName,
                                     c.lat = $cityLat,
                                     c.lon = $cityLon
                        MERGE (l)-[:ORIGIN]->(c)
                    `, {
                        labelId,
                        cityId: label.origin_city.city_id ||
                               this.generateProvisionalId('city', label.origin_city),
                        cityName: label.origin_city.name,
                        cityLat: label.origin_city.lat,
                        cityLon: label.origin_city.lon
                    });
                }
            }

            // ========== 7. CREATE SOURCE REFERENCES ==========

            for (const source of bundle.sources || []) {
                const sourceId = await this.resolveEntityId(tx, 'source', source);

                await tx.run(`
                    MERGE (s:Source {source_id: $sourceId})
                    SET s.url = $url,
                        s.type = $type,
                        s.retrieved_at = $retrievedAt

                    WITH s
                    MATCH (r:Release {release_id: $releaseId})
                    MERGE (r)-[:SOURCED_FROM]->(s)
                `, {
                    sourceId,
                    url: source.url,
                    type: source.type || 'web',
                    retrievedAt: source.retrieved_at || new Date().toISOString(),
                    releaseId
                });
            }

            // Commit the entire transaction
            await tx.commit();

            const stats = {
                groups_created: processedGroups.length,
                songs_created: processedSongs.size,
                tracks_created: processedTracks.length
            };

            console.log(` Processed release bundle ${releaseId.substring(0, 12)}... successfully`);
            console.log(`  Groups: ${stats.groups_created}, Songs: ${stats.songs_created}, Tracks: ${stats.tracks_created}`);

            return {
                success: true,
                releaseId,
                stats
            };

        } catch (error) {
            // Rollback on any error
            await tx.rollback();
            console.error(' Failed to process release bundle:', error.message);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Process an ADD_CLAIM event to add new information to an existing entity.
     * Claims provide an audit trail for all data changes.
     *
     * @param {string} eventHash - Hash of the event
     * @param {Object} claimData - The claim details
     * @param {Object} claimData.node - Target node information
     * @param {string} claimData.node.type - Node type (Person, Group, etc.)
     * @param {string} claimData.node.id - Node ID
     * @param {string} claimData.field - Field being modified
     * @param {*} claimData.value - New value
     * @param {Object} [claimData.source] - Optional source reference
     * @param {string} author - Account making the claim
     * @returns {Promise<Object>} Result with claimId
     */
    async processAddClaim(eventHash, claimData, author) {
        const session = this.driver.session();
        const tx = session.beginTransaction();

        try {
            const claimId = this.generateOpId(eventHash, 0);
            const { node, field, value, source } = claimData;

            if (!node || !node.type || !node.id || !field) {
                throw new Error('Invalid claim data: missing required fields');
            }

            console.log(`Adding claim to ${node.type} ${node.id}: ${field}`);

            // Update the target node
            const idField = `${node.type.toLowerCase()}_id`;
            await tx.run(`
                MATCH (n:${node.type} {${idField}: $nodeId})
                SET n[$field] = $value,
                    n.last_updated = datetime(),
                    n.last_updated_by = $author
                RETURN n
            `, {
                nodeId: node.id,
                field,
                value,
                author
            });

            // Create claim record
            await this.createClaim(tx, claimId, node.type, node.id,
                                 field, value, eventHash);

            // Link source if provided
            if (source && source.url) {
                const sourceId = await this.resolveEntityId(tx, 'source', source);
                await tx.run(`
                    MERGE (s:Source {source_id: $sourceId})
                    SET s.url = $url,
                        s.type = $type

                    WITH s
                    MATCH (c:Claim {claim_id: $claimId})
                    MERGE (c)-[:SOURCED_FROM]->(s)
                `, {
                    sourceId,
                    url: source.url,
                    type: source.type || 'web',
                    claimId
                });
            }

            await tx.commit();
            console.log(` Added claim ${claimId.substring(0, 12)}...`);

            return { success: true, claimId };

        } catch (error) {
            await tx.rollback();
            console.error(' Failed to process claim:', error.message);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Calculate group member participation percentages.
     * Used for the RGraph visualization around Group nodes.
     * Shows what percentage of tracks each member performed on.
     *
     * @param {string} groupId - Group to analyze
     * @returns {Promise<Array>} Member participation data sorted by percentage
     */
    async calculateGroupMemberParticipation(groupId) {
        const session = this.driver.session();

        try {
            console.log(`Calculating member participation for group ${groupId.substring(0, 12)}...`);

            const result = await session.run(`
                MATCH (g:Group {group_id: $groupId})
                MATCH (g)-[:PERFORMED_ON]->(t:Track)
                MATCH (t)-[:IN_RELEASE]->(r:Release)

                // For each track, find which members were active at that time
                OPTIONAL MATCH (p:Person)-[m:MEMBER_OF]->(g)
                WHERE (m.from_date IS NULL OR date(m.from_date) <= date(r.release_date))
                  AND (m.to_date IS NULL OR date(m.to_date) >= date(r.release_date))

                // Count tracks per member
                WITH p, count(DISTINCT t) as track_count,
                     collect(DISTINCT r.release_id) as releases

                // Get total tracks for percentage
                MATCH (g:Group {group_id: $groupId})-[:PERFORMED_ON]->(total:Track)
                WITH p, track_count, releases, count(DISTINCT total) as total_tracks

                WHERE p IS NOT NULL

                RETURN p.person_id as personId,
                       p.name as personName,
                       track_count,
                       total_tracks,
                       toFloat(track_count) / toFloat(total_tracks) * 100 as participationPercentage,
                       size(releases) as releaseCount
                ORDER BY participationPercentage DESC
            `, { groupId });

            const participation = result.records.map(record => ({
                personId: record.get('personId'),
                personName: record.get('personName'),
                trackCount: record.get('track_count').toNumber(),
                totalTracks: record.get('total_tracks').toNumber(),
                participationPercentage: record.get('participationPercentage'),
                releaseCount: record.get('releaseCount').toNumber()
            }));

            console.log(` Found ${participation.length} members`);

            return participation;

        } catch (error) {
            console.error(' Failed to calculate participation:', error.message);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Find potential duplicate entities based on similar names.
     * Uses Levenshtein distance for fuzzy matching.
     * Used for deduplication and MERGE_NODE operations.
     *
     * @param {string} type - Entity type to check (Person, Group, etc.)
     * @param {string} name - Name to match against
     * @param {number} [threshold=3] - Maximum edit distance
     * @returns {Promise<Array>} Potential duplicates
     */
    async findPotentialDuplicates(type, name, threshold = 3) {
        const session = this.driver.session();

        try {
            console.log(`Searching for duplicates of ${type}: ${name}`);

            // Simple string matching (Levenshtein requires APOC plugin)
            // In production, you'd use apoc.text.levenshteinDistance
            const idField = `${type.toLowerCase()}_id`;

            const result = await session.run(`
                MATCH (n:${type})
                WHERE toLower(n.name) CONTAINS toLower($name)
                   OR ANY(alt IN n.alt_names WHERE toLower(alt) CONTAINS toLower($name))
                RETURN n.${idField} as id,
                       n.name as name,
                       n.alt_names as altNames,
                       n.status as status
                LIMIT 10
            `, { name });

            const duplicates = result.records.map(record => ({
                id: record.get('id'),
                name: record.get('name'),
                altNames: record.get('altNames') || [],
                status: record.get('status')
            }));

            console.log(` Found ${duplicates.length} potential duplicates`);

            return duplicates;

        } catch (error) {
            console.error(' Failed to find duplicates:', error.message);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Merge duplicate nodes into a canonical entity.
     * Preserves all relationships and claims from both nodes.
     *
     * @param {string} sourceId - Provisional/duplicate node ID
     * @param {string} targetId - Canonical node ID to merge into
     * @param {string} nodeType - Type of nodes being merged
     * @param {string} reason - Reason for merge (for audit trail)
     * @returns {Promise<Object>} Result with mergeId
     */
    async mergeNodes(sourceId, targetId, nodeType, reason) {
        const session = this.driver.session();
        const tx = session.beginTransaction();

        try {
            console.log(`Merging ${nodeType} ${sourceId.substring(0, 12)}... into ${targetId.substring(0, 12)}...`);

            const idField = `${nodeType.toLowerCase()}_id`;

            // Copy properties from source to target (if not already set)
            await tx.run(`
                MATCH (source:${nodeType} {${idField}: $sourceId})
                MATCH (target:${nodeType} {${idField}: $targetId})

                // Combine alt_names
                SET target.alt_names = target.alt_names +
                    [name IN source.alt_names WHERE NOT name IN target.alt_names]

                // Copy any null fields from source
                SET target = CASE
                    WHEN target.bio IS NULL THEN source
                    ELSE target
                END

                SET target.status = 'canonical'

                RETURN target
            `, { sourceId, targetId });

            // Transfer all incoming relationships
            await tx.run(`
                MATCH (source:${nodeType} {${idField}: $sourceId})
                MATCH (target:${nodeType} {${idField}: $targetId})
                MATCH (other)-[r]->(source)

                WITH other, type(r) as relType, properties(r) as props, target
                CALL apoc.create.relationship(other, relType, props, target) YIELD rel

                RETURN count(rel) as transferred
            `, { sourceId, targetId });

            // Transfer all outgoing relationships
            await tx.run(`
                MATCH (source:${nodeType} {${idField}: $sourceId})
                MATCH (target:${nodeType} {${idField}: $targetId})
                MATCH (source)-[r]->(other)

                WITH target, type(r) as relType, properties(r) as props, other
                CALL apoc.create.relationship(target, relType, props, other) YIELD rel

                RETURN count(rel) as transferred
            `, { sourceId, targetId });

            // Delete the source node
            await tx.run(`
                MATCH (source:${nodeType} {${idField}: $sourceId})
                DETACH DELETE source
            `, { sourceId });

            // Create merge record for audit trail
            const mergeId = createHash('sha256')
                .update(sourceId + targetId + Date.now())
                .digest('hex');

            await tx.run(`
                CREATE (m:MergeRecord {
                    merge_id: $mergeId,
                    source_id: $sourceId,
                    target_id: $targetId,
                    node_type: $nodeType,
                    reason: $reason,
                    merged_at: datetime()
                })
            `, { mergeId, sourceId, targetId, nodeType, reason });

            await tx.commit();
            console.log(` Merged nodes successfully`);

            return { success: true, mergeId };

        } catch (error) {
            await tx.rollback();
            console.error(' Failed to merge nodes:', error.message);

            // Check if APOC is missing
            if (error.message.includes('apoc')) {
                throw new Error('APOC plugin required for merge operations. Install with: neo4j-admin install apoc');
            }

            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Create an audit trail claim for data changes.
     * Every modification is tracked with source and timestamp.
     *
     * @private
     * @param {Transaction} tx - Active Neo4j transaction
     * @param {string} claimId - Unique claim identifier
     * @param {string} nodeType - Type of node being claimed about
     * @param {string} nodeId - ID of the node
     * @param {string} field - Field being modified
     * @param {*} value - New value
     * @param {string} eventHash - Hash of the source event
     */
    async createClaim(tx, claimId, nodeType, nodeId, field, value, eventHash) {
        await tx.run(`
            CREATE (c:Claim {
                claim_id: $claimId,
                node_type: $nodeType,
                node_id: $nodeId,
                field: $field,
                value: $value,
                event_hash: $eventHash,
                created_at: datetime()
            })
        `, {
            claimId,
            nodeType,
            nodeId,
            field,
            value: JSON.stringify(value),
            eventHash
        });
    }

    /**
     * Resolve entity ID using the new identity system.
     * Checks for external IDs first, then generates provisional ID.
     *
     * @param {Object} session - Neo4j session
     * @param {string} type - Entity type (person, group, track, etc.)
     * @param {Object} data - Entity data
     * @returns {Promise<string>} Resolved ID (canonical if mapped, provisional otherwise)
     */
    async resolveEntityId(session, type, data) {
        // 1. If explicit canonical or external ID provided, use it
        const explicitIdField = `${type}_id`;
        if (data[explicitIdField]) {
            const parsedId = IdentityService.parseId(data[explicitIdField]);

            // If it's canonical, use directly
            if (parsedId.kind === 'canonical') {
                return data[explicitIdField];
            }

            // If it's external, check IdentityMap
            if (parsedId.kind === 'external') {
                const canonicalId = await MergeOperations.resolveExternalId(
                    session,
                    parsedId.source,
                    parsedId.externalType,
                    parsedId.externalId
                );

                if (canonicalId) {
                    console.log(`    Resolved ${data[explicitIdField]} → ${canonicalId.substring(0, 20)}...`);
                    return canonicalId;
                }

                // External ID not mapped yet, will create provisional
                console.log(`    External ID ${data[explicitIdField]} not mapped, creating provisional`);
            }
        }

        // 2. Check for common external ID fields (Discogs, MusicBrainz, etc.)
        const externalIdFields = {
            discogs_id: 'discogs',
            musicbrainz_id: 'musicbrainz',
            isni: 'isni',
            wikidata_id: 'wikidata',
            spotify_id: 'spotify'
        };

        for (const [field, source] of Object.entries(externalIdFields)) {
            if (data[field]) {
                // Try to resolve via IdentityMap
                const canonicalId = await MergeOperations.resolveExternalId(
                    session,
                    source,
                    type,
                    data[field]
                );

                if (canonicalId) {
                    console.log(`    Resolved ${source}:${type}:${data[field]} → ${canonicalId.substring(0, 20)}...`);
                    return canonicalId;
                }
            }
        }

        // 3. No external ID mapping found, generate provisional ID
        return this.generateProvisionalIdNew(type, data);
    }

    /**
     * Generate deterministic provisional ID using IdentityService.
     * This replaces the old hash-based method with the new fingerprint approach.
     *
     * @param {string} type - Entity type (person, group, track, etc.)
     * @param {Object} data - Entity data
     * @returns {string} Provisional ID (prov:{type}:{hash})
     */
    generateProvisionalIdNew(type, data) {
        let fingerprint;

        switch(type) {
            case 'person':
                fingerprint = IdentityService.personFingerprint({
                    name: data.name || data.person_name,
                    birth_year: data.birth_year
                });
                break;

            case 'group':
                fingerprint = IdentityService.groupFingerprint({
                    name: data.name || data.group_name
                });
                break;

            case 'song':
                fingerprint = IdentityService.songFingerprint({
                    title: data.title || data.song_title,
                    primary_writer: data.primary_writer
                });
                break;

            case 'track':
                fingerprint = IdentityService.trackFingerprint({
                    title: data.title || data.track_title,
                    release_id: data.release_id,
                    position: data.track_number || data.position
                });
                break;

            case 'release':
                fingerprint = IdentityService.releaseFingerprint({
                    title: data.name || data.release_name,
                    date: data.release_date || data.year,
                    catalog_number: data.catalog_number
                });
                break;

            case 'label':
                fingerprint = {
                    type: 'label',
                    name: IdentityService.normalizeName(data.name || data.label_name)
                };
                break;

            case 'city':
                fingerprint = {
                    type: 'city',
                    name: IdentityService.normalizeName(data.name || data.city_name),
                    lat: data.lat,
                    lon: data.lon
                };
                break;

            case 'source':
                fingerprint = {
                    type: 'source',
                    url: data.url
                };
                break;

            default:
                throw new Error(`Unknown entity type: ${type}`);
        }

        return IdentityService.makeProvisionalId(type, fingerprint);
    }

    /**
     * Generate deterministic provisional ID when external ID unavailable.
     * IDs are consistent for the same input data, ensuring idempotency.
     * Format: prov:{type}:{hash}
     *
     * @deprecated Use generateProvisionalIdNew() instead
     * @param {string} type - Entity type (person, group, track, etc.)
     * @param {Object} data - Entity data
     * @returns {string} Provisional ID
     */
    generateProvisionalId(type, data) {
        let normalizedString;

        switch(type) {
            case 'group':
                // Group ID based on name and founding members
                normalizedString = [
                    data.name?.toLowerCase() || '',
                    data.formed_date || '',
                    ...(data.members || []).slice(0, 5).map(m => m.name?.toLowerCase() || '').sort()
                ].filter(Boolean).join('|');
                break;

            case 'person':
                // Person ID based on name (could add birth date if available)
                normalizedString = (data.name?.toLowerCase() || '') + '|person';
                break;

            case 'track':
                // Track ID based on title, duration, and performers
                normalizedString = [
                    data.title?.toLowerCase() || '',
                    data.duration || '',
                    data.performed_by_groups?.[0]?.name?.toLowerCase() || ''
                ].filter(Boolean).join('|');
                break;

            case 'song':
                // Song ID based on title and writers
                normalizedString = [
                    data.title?.toLowerCase() || '',
                    ...(data.writers || []).slice(0, 3).map(w => w.name?.toLowerCase() || '').sort()
                ].filter(Boolean).join('|');
                break;

            case 'release':
                // Release ID based on name, date, and label
                normalizedString = [
                    data.name?.toLowerCase() || '',
                    data.release_date || '',
                    data.labels?.[0]?.name?.toLowerCase() || ''
                ].filter(Boolean).join('|');
                break;

            case 'label':
                // Label ID based on name
                normalizedString = (data.name?.toLowerCase() || '') + '|label';
                break;

            case 'city':
                // City ID based on name and coordinates
                normalizedString = [
                    data.name?.toLowerCase() || '',
                    data.lat?.toString() || '',
                    data.lon?.toString() || ''
                ].filter(Boolean).join('|');
                break;

            case 'source':
                // Source ID based on URL
                normalizedString = data.url || JSON.stringify(data);
                break;

            default:
                // Fallback: stringify entire object
                normalizedString = JSON.stringify(data);
        }

        const hash = createHash('sha256')
            .update(normalizedString)
            .digest('hex')
            .substring(0, 16);

        return `prov:${type}:${hash}`;
    }

    /**
     * Generate operation ID for sub-operations within an event.
     * Ensures deterministic IDs for idempotent event replay.
     *
     * @param {string} eventHash - Parent event hash
     * @param {number} index - Operation index
     * @returns {string} Operation ID
     */
    generateOpId(eventHash, index) {
        return createHash('sha256')
            .update(eventHash + ':' + index.toString())
            .digest('hex');
    }

    /**
     * Test database connectivity.
     *
     * @returns {Promise<boolean>} True if connected
     */
    async testConnection() {
        const session = this.driver.session();
        try {
            await session.run('RETURN 1');
            return true;
        } catch (error) {
            console.error('Database connection test failed:', error.message);
            return false;
        } finally {
            await session.close();
        }
    }

    /**
     * Get database statistics.
     *
     * @returns {Promise<Object>} Node and relationship counts
     */
    async getStats() {
        const session = this.driver.session();
        try {
            const result = await session.run(`
                MATCH (n)
                RETURN labels(n)[0] as type, count(*) as count
                ORDER BY count DESC
            `);

            const nodes = {};
            result.records.forEach(record => {
                nodes[record.get('type')] = record.get('count').toNumber();
            });

            return { nodes };
        } finally {
            await session.close();
        }
    }

    /**
     * Clean up and close database connections.
     * Always call this when shutting down the application.
     *
     * @returns {Promise<void>}
     */
    async close() {
        console.log('Closing database connections...');
        await this.driver.close();
        console.log(' Database connections closed');
    }
}

export default MusicGraphDatabase;
