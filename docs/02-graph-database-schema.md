# Implementation in backend/src/graph/schema.js

# Graph Database Schema - Neo4j Implementation

## Overview
Complete Neo4j graph database schema for the music registry. Groups have clear distinctions between group members (MEMBER_OF) and guest performers (GUEST_ON).

## Schema Implementation

```javascript
// File: backend/src/graph/schema.js
// Neo4j graph database schema and operations
// This stores the normalized music data model with Groups as primary entities

import neo4j from 'neo4j-driver';
import { createHash } from 'crypto';

class MusicGraphDatabase {
    constructor(config) {
        // Initialize Neo4j driver with connection pooling
        this.driver = neo4j.driver(
            config.uri,
            neo4j.auth.basic(config.user, config.password),
            {
                maxConnectionPoolSize: 100,
                connectionTimeout: 30000,
                maxTransactionRetryTime: 30000
            }
        );
    }
    
    /**
     * Initialize all constraints and indexes for the database
     * Must be run before any data insertion to ensure integrity
     * Creates unique constraints on IDs and indexes for common queries
     */
    async initializeSchema() {
        const session = this.driver.session();
        
        try {
            // ========== NODE CONSTRAINTS ==========
            // These ensure each entity has a unique identifier
            
            // Person: Individual musician, producer, engineer, etc.
            await session.run(`
                CREATE CONSTRAINT person_id IF NOT EXISTS
                FOR (p:Person) REQUIRE p.person_id IS UNIQUE
            `);
            
            // Group: Band, orchestra, ensemble - collection of Persons
            await session.run(`
                CREATE CONSTRAINT group_id IF NOT EXISTS
                FOR (g:Group) REQUIRE g.group_id IS UNIQUE
            `);
            
            // Song: Composition (the written musical work)
            await session.run(`
                CREATE CONSTRAINT song_id IF NOT EXISTS
                FOR (s:Song) REQUIRE s.song_id IS UNIQUE
            `);
            
            // Track: Recording (specific performance of a song)
            await session.run(`
                CREATE CONSTRAINT track_id IF NOT EXISTS
                FOR (t:Track) REQUIRE t.track_id IS UNIQUE
            `);
            
            // Release: Album, EP, Single, or other package
            await session.run(`
                CREATE CONSTRAINT release_id IF NOT EXISTS
                FOR (r:Release) REQUIRE r.release_id IS UNIQUE
            `);
            
            // Master: Canonical album entity (groups multiple releases)
            await session.run(`
                CREATE CONSTRAINT master_id IF NOT EXISTS
                FOR (m:Master) REQUIRE m.master_id IS UNIQUE
            `);
            
            // Label: Record label / publisher
            await session.run(`
                CREATE CONSTRAINT label_id IF NOT EXISTS
                FOR (l:Label) REQUIRE l.label_id IS UNIQUE
            `);
            
            // Account: Blockchain account that submits data
            await session.run(`
                CREATE CONSTRAINT account_id IF NOT EXISTS
                FOR (a:Account) REQUIRE a.account_id IS UNIQUE
            `);
            
            // City: Geographic location for origin attribution
            await session.run(`
                CREATE CONSTRAINT city_id IF NOT EXISTS
                FOR (c:City) REQUIRE c.city_id IS UNIQUE
            `);
            
            // Claim: Audit trail for all data changes
            await session.run(`
                CREATE CONSTRAINT claim_id IF NOT EXISTS
                FOR (cl:Claim) REQUIRE cl.claim_id IS UNIQUE
            `);
            
            // Source: External data source reference
            await session.run(`
                CREATE CONSTRAINT source_id IF NOT EXISTS
                FOR (src:Source) REQUIRE src.source_id IS UNIQUE
            `);
            
            // ========== INDEXES FOR PERFORMANCE ==========
            
            // Name searches
            await session.run(`
                CREATE INDEX person_name IF NOT EXISTS
                FOR (p:Person) ON (p.name)
            `);
            
            await session.run(`
                CREATE INDEX group_name IF NOT EXISTS
                FOR (g:Group) ON (g.name)
            `);
            
            // Date-based queries
            await session.run(`
                CREATE INDEX release_date IF NOT EXISTS
                FOR (r:Release) ON (r.release_date)
            `);
            
            // Geographic queries
            await session.run(`
                CREATE INDEX city_location IF NOT EXISTS
                FOR (c:City) ON (c.lat, c.lon)
            `);
            
            // Status filtering
            await session.run(`
                CREATE INDEX person_status IF NOT EXISTS
                FOR (p:Person) ON (p.status)
            `);
            
            await session.run(`
                CREATE INDEX group_active IF NOT EXISTS
                FOR (g:Group) ON (g.disbanded_date)
            `);
            
            console.log('Database schema initialized successfully');
            
        } finally {
            await session.close();
        }
    }
    
    /**
     * Process a CREATE_RELEASE_BUNDLE event
     * This is the main entry point for new music data
     * Creates all entities and relationships in a single transaction
     * 
     * @param {string} eventHash - Hash of the canonical event
     * @param {object} bundle - The release bundle data
     * @param {string} submitterAccount - Blockchain account that submitted
     */
    async processReleaseBundle(eventHash, bundle, submitterAccount) {
        const session = this.driver.session();
        const tx = session.beginTransaction();
        
        try {
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
            
            for (const group of bundle.groups || []) {
                const groupOpId = opId();
                const groupId = group.group_id || 
                               this.generateProvisionalId('group', group);
                
                await tx.run(`
                    MERGE (g:Group {group_id: $groupId})
                    SET g.name = $name,
                        g.alt_names = $altNames,
                        g.bio = $bio,
                            // g.formed_date = $formed,
                            // g.disbanded_date = $disbanded,
                        g.updated_by = $eventHash,
                        g.updated_at = datetime()
                    
                    // Link to submitter Account
                    WITH g
                    MERGE (a:Account {account_id: $account})
                    MERGE (a)-[sub:SUBMITTED {
                        event_hash: $eventHash,
                        timestamp: datetime()
                    }]->(g)
                    
                    // Link to origin City if provided
                    WITH g
                    WHERE $cityId IS NOT NULL
                    MERGE (c:City {city_id: $cityId})
                    ON CREATE SET c.name = $cityName,
                                 c.lat = $cityLat,
                                 c.lon = $cityLon
                    MERGE (g)-[:ORIGIN]->(c)
                    
                    RETURN g
                `, {
                    groupId,
                    name: group.name,
                    altNames: group.alt_names || [],
                    bio: group.bio,
                    // formed: group.formed_date,
                    // disbanded: group.disbanded_date,
                    eventHash,
                    account: submitterAccount,
                    cityId: group.origin_city?.id,
                    cityName: group.origin_city?.name,
                    cityLat: group.origin_city?.lat,
                    cityLon: group.origin_city?.lon
                });
                
                // Process Group members with their roles and periods
                for (const member of group.members || []) {
                    const personId = member.person_id || 
                                   this.generateProvisionalId('person', member);
                    
                    await tx.run(`
                        MERGE (p:Person {person_id: $personId})
                        ON CREATE SET p.name = $name,
                                     p.status = $status
                        
                        WITH p
                        MATCH (g:Group {group_id: $groupId})
                        
                        // MEMBER_OF relationship with full details
                        MERGE (p)-[m:MEMBER_OF {claim_id: $claimId}]->(g)
                        SET m.role = $role,
                            m.from_date = $from,
                            m.to_date = $to,
                            m.primary_instrument = $instrument
                        
                        RETURN p
                    `, {
                        personId,
                        name: member.name,
                        status: member.person_id ? 'canonical' : 'provisional',
                        groupId,
                        role: member.role || 'member',
                        from: member.from_date,
                        to: member.to_date,
                        instrument: member.primary_instrument,
                        claimId: groupOpId
                    });
                }
                
                // Create audit claim for group creation
                await this.createClaim(tx, groupOpId, 'Group', groupId, 
                                     'created', group, eventHash);
            }
            
            // ========== 2. CREATE RELEASE ==========
            
            const releaseOpId = opId();
            const releaseId = bundle.release.release_id || 
                             this.generateProvisionalId('release', bundle.release);
            
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
                    r.listen_links = $listenLinks,
                    r.updated_by = $eventHash
                RETURN r
            `, {
                releaseId,
                name: bundle.release.name,
                altNames: bundle.release.alt_names || [],
                date: bundle.release.release_date,
                format: bundle.release.format || [],
                country: bundle.release.country,
                catalogNumber: bundle.release.catalog_number,
                linerNotes: bundle.release.liner_notes,
                trivia: bundle.release.trivia,
                albumArt: bundle.release.album_art,
                listenLinks: bundle.release.listen_links || [],
                eventHash
            });
            
            // ========== 3. PROCESS SONGS (Compositions) ==========
            
            for (const song of bundle.songs || []) {
                const songOpId = opId();
                const songId = song.song_id || 
                              this.generateProvisionalId('song', song);
                
                await tx.run(`
                    MERGE (s:Song {song_id: $songId})
                    SET s.title = $title,
                        s.alt_titles = $altTitles,
                        s.iswc = $iswc,
                        s.year = $year,
                        s.lyrics = $lyrics
                `, {
                    songId,
                    title: song.title,
                    altTitles: song.alt_titles || [],
                    iswc: song.iswc,
                    year: song.year,
                    lyrics: song.lyrics
                });
                
                // Link songwriters (can be Persons or credited to Groups)
                for (const writer of song.writers || []) {
                    if (writer.person_id) {
                        await tx.run(`
                            MERGE (p:Person {person_id: $personId})
                            WITH p
                            MATCH (s:Song {song_id: $songId})
                            MERGE (p)-[w:WROTE {claim_id: $claimId}]->(s)
                            SET w.role = $role,
                                w.share_percentage = $share
                        `, {
                            personId: writer.person_id,
                            songId,
                            role: writer.role || 'writer',
                            share: writer.share_percentage,
                            claimId: songOpId
                        });
                    }
                }
                
                await this.createClaim(tx, songOpId, 'Song', songId,
                                     'created', song, eventHash);
            }
            
            // ========== 4. PROCESS TRACKS (Recordings) ==========
            
            for (const track of bundle.tracks || []) {
                const trackOpId = opId();
                const trackId = track.track_id ||
                               this.generateProvisionalId('track', track);
                
                await tx.run(`
                    MERGE (t:Track {track_id: $trackId})
                    SET t.title = $title,
                        // coalesce, not assign: an alternate spelling is
                        // additive, and a later bundle that says nothing about
                        // it must not be read as "there are none".
                        t.alt_titles = coalesce($altTitles, t.alt_titles, []),
                        t.isrc = $isrc,
                        t.duration = $duration,
                        t.recording_date = $recordingDate,
                        t.recording_location = $location,
                        t.listen_links = $listenLinks,
                        t.lyrics = $lyrics,
                        t.trivia = $trivia
                `, {
                    trackId,
                    title: track.title,
                    altTitles: track.alt_titles?.length ? track.alt_titles : null,
                    isrc: track.isrc,
                    duration: track.duration,
                    recordingDate: track.recording_date,
                    location: track.recording_location,
                    listenLinks: track.listen_links || [],
                    lyrics: track.lyrics || null,
                    trivia: track.trivia || null
                });
                
                // ========== CRITICAL: DISTINGUISH GROUPS vs GUESTS ==========
                
                // Link performing GROUP (the main band/orchestra)
                if (track.performed_by_group) {
                    await tx.run(`
                        MATCH (t:Track {track_id: $trackId})
                        MERGE (g:Group {group_id: $groupId})
                        ON CREATE SET g.name = $groupName,
                                     g.status = 'provisional'
                        
                        // PERFORMED_ON relationship for the group
                        MERGE (g)-[p:PERFORMED_ON {claim_id: $claimId}]->(t)
                        SET p.role = 'primary_artist',
                            p.credited_as = $creditedAs
                    `, {
                        trackId,
                        groupId: track.performed_by_group.group_id,
                        groupName: track.performed_by_group.name || 'Unknown',
                        creditedAs: track.performed_by_group.credited_as,
                        claimId: trackOpId
                    });
                }
                
                // Link GUEST performers (individuals not in the main group)
                for (const guest of track.guests || []) {
                    await tx.run(`
                        MERGE (p:Person {person_id: $personId})
                        ON CREATE SET p.name = $name,
                                     p.status = $status
                        
                        WITH p
                        MATCH (t:Track {track_id: $trackId})
                        
                        // GUEST_ON relationship for non-members
                        MERGE (p)-[g:GUEST_ON {claim_id: $claimId}]->(t)
                        SET g.role = $role,
                            g.instrument = $instrument,
                            g.credited_as = $creditedAs
                    `, {
                        personId: guest.person_id || 
                                 this.generateProvisionalId('person', guest),
                        name: guest.name,
                        status: guest.person_id ? 'canonical' : 'provisional',
                        trackId,
                        role: guest.role,
                        instrument: guest.instrument,
                        creditedAs: guest.credited_as,
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
                        portion: sample.portion_used,
                        cleared: sample.cleared,
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
                
                await this.createClaim(tx, trackOpId, 'Track', trackId,
                                     'created', track, eventHash);
            }
            
            // ========== 5. CREATE TRACKLIST ==========
            // Link tracks to the release with order information
            
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
                    disc: item.disc || 1,
                    trackNo: item.track_number,
                    side: item.side,
                    isBonus: item.is_bonus || false
                });
            }
            
            // ========== 6. LINK MASTER AND LABEL ==========
            
            if (bundle.release.master_id) {
                await tx.run(`
                    MERGE (m:Master {master_id: $masterId})
                    ON CREATE SET m.name = $masterName
                    WITH m
                    MATCH (r:Release {release_id: $releaseId})
                    MERGE (r)-[:IN_MASTER]->(m)
                `, {
                    masterId: bundle.release.master_id,
                    masterName: bundle.release.master_name || bundle.release.name,
                    releaseId
                });
            }
            
            if (bundle.release.label_id) {
                await tx.run(`
                    MERGE (l:Label {label_id: $labelId})
                    ON CREATE SET l.name = $labelName
                    
                    WITH l
                    MATCH (r:Release {release_id: $releaseId})
                    MERGE (r)-[:UNDER]->(l)
                `, {
                    labelId: bundle.release.label_id,
                    labelName: bundle.release.label_name,
                    releaseId
                });
            }
            
            // ========== 7. CREATE SOURCE REFERENCES ==========
            
            for (const source of bundle.sources || []) {
                const sourceId = this.generateProvisionalId('source', source);
                
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
            
            console.log(`Processed release bundle ${releaseId} with ${bundle.tracks?.length || 0} tracks`);
            
            return {
                success: true,
                releaseId,
                stats: {
                    groups_created: bundle.groups?.length || 0,
                    songs_created: bundle.songs?.length || 0,
                    tracks_created: bundle.tracks?.length || 0
                }
            };
            
        } catch (error) {
            // Rollback on any error
            await tx.rollback();
            console.error('Failed to process release bundle:', error);
            throw error;
        } finally {
            await session.close();
        }
    }
    
    /**
     * Process an ADD_CLAIM event to add new information
     * Claims provide an audit trail for all data changes
     * 
     * @param {string} eventHash - Hash of the event
     * @param {object} claimData - The claim details
     * @param {string} author - Account making the claim
     */
    async processAddClaim(eventHash, claimData, author) {
        const session = this.driver.session();
        const tx = session.beginTransaction();
        
        try {
            const claimId = this.generateOpId(eventHash, 0);
            const { node, field, value, source } = claimData;
            
            // Update the target node
            await tx.run(`
                MATCH (n:${node.type} {${node.type.toLowerCase()}_id: $nodeId})
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
            if (source) {
                const sourceId = this.generateProvisionalId('source', source);
                await tx.run(`
                    MERGE (s:Source {source_id: $sourceId})
                    SET s.url = $url
                    
                    WITH s
                    MATCH (c:Claim {claim_id: $claimId})
                    MERGE (c)-[:SOURCED_FROM]->(s)
                `, {
                    sourceId,
                    url: source.url,
                    claimId
                });
            }
            
            await tx.commit();
            return { success: true, claimId };
            
        } catch (error) {
            await tx.rollback();
            throw error;
        } finally {
            await session.close();
        }
    }
    
    /**
     * Calculate group member participation percentages
     * Used for the RGraph visualization around Group nodes
     * 
     * @param {string} groupId - Group to analyze
     * @returns {Array} Member participation data
     */
    async calculateGroupMemberParticipation(groupId) {
        const session = this.driver.session();
        
        try {
            const result = await session.run(`
                MATCH (g:Group {group_id: $groupId})
                MATCH (g)-[:PERFORMED_ON]->(t:Track)
                MATCH (t)-[:IN_RELEASE]->(r:Release)
                
                // For each track, find which members were active
                OPTIONAL MATCH (p:Person)-[m:MEMBER_OF]->(g)
                WHERE (m.from_date IS NULL OR date(m.from_date) <= date(r.release_date))
                  AND (m.to_date IS NULL OR date(m.to_date) >= date(r.release_date))
                
                // Count tracks per member
                WITH p, count(DISTINCT t) as track_count, 
                     collect(DISTINCT r.release_id) as releases
                
                // Get total tracks for percentage
                MATCH (g:Group {group_id: $groupId})-[:PERFORMED_ON]->(total:Track)
                WITH p, track_count, releases, count(DISTINCT total) as total_tracks
                
                RETURN p.person_id as personId,
                       p.name as personName,
                       track_count,
                       total_tracks,
                       toFloat(track_count) / toFloat(total_tracks) * 100 as participationPercentage,
                       size(releases) as releaseCount
                ORDER BY participationPercentage DESC
            `, { groupId });
            
            return result.records.map(record => ({
                personId: record.get('personId'),
                personName: record.get('personName'),
                trackCount: record.get('track_count').toNumber(),
                totalTracks: record.get('total_tracks').toNumber(),
                participationPercentage: record.get('participationPercentage'),
                releaseCount: record.get('releaseCount').toNumber()
            }));
            
        } finally {
            await session.close();
        }
    }
    
    /**
     * Find potential duplicates based on similar names
     * Used for deduplication and MERGE_NODE operations
     * 
     * @param {string} type - Entity type to check
     * @param {string} name - Name to match
     */
    async findPotentialDuplicates(type, name) {
        const session = this.driver.session();
        
        try {
            // Use fuzzy matching with Levenshtein distance
            const result = await session.run(`
                MATCH (n:${type})
                WHERE apoc.text.levenshteinDistance(
                    toLower(n.name), 
                    toLower($name)
                ) < 3
                OR ANY(alt IN n.alt_names WHERE 
                    apoc.text.levenshteinDistance(
                        toLower(alt), 
                        toLower($name)
                    ) < 3
                )
                RETURN n.${type.toLowerCase()}_id as id,
                       n.name as name,
                       n.alt_names as altNames,
                       n.status as status
                LIMIT 10
            `, { name });
            
            return result.records.map(record => ({
                id: record.get('id'),
                name: record.get('name'),
                altNames: record.get('altNames'),
                status: record.get('status')
            }));
            
        } finally {
            await session.close();
        }
    }
    
    /**
     * Merge duplicate nodes into canonical entity
     * Preserves all relationships and claims
     * 
     * @param {string} sourceId - Provisional/duplicate node
     * @param {string} targetId - Canonical node to merge into
     * @param {string} reason - Reason for merge
     */
    async mergeNodes(sourceId, targetId, reason) {
        const session = this.driver.session();
        const tx = session.beginTransaction();
        
        try {
            // Get node type
            const typeResult = await tx.run(`
                MATCH (s {id: $sourceId})
                RETURN labels(s)[0] as type
            `, { sourceId });
            
            const nodeType = typeResult.records[0].get('type');
            
            // Merge nodes using APOC
            await tx.run(`
                MATCH (source:${nodeType} {${nodeType.toLowerCase()}_id: $sourceId})
                MATCH (target:${nodeType} {${nodeType.toLowerCase()}_id: $targetId})
                
                // Copy all properties from source to target (if not already set)
                SET target += source
                SET target.status = 'canonical'
                
                // Transfer all relationships
                WITH source, target
                CALL apoc.refactor.mergeNodes([source, target], {
                    properties: 'combine',
                    mergeRels: true
                }) YIELD node
                
                RETURN node
            `, { sourceId, targetId });
            
            // Create merge record for audit
            const mergeId = createHash('sha256')
                .update(sourceId + targetId + Date.now())
                .digest('hex');
                
            await tx.run(`
                CREATE (m:MergeRecord {
                    merge_id: $mergeId,
                    source_id: $sourceId,
                    target_id: $targetId,
                    reason: $reason,
                    merged_at: datetime()
                })
            `, { mergeId, sourceId, targetId, reason });
            
            await tx.commit();
            console.log(`Merged ${sourceId} into ${targetId}`);
            
            return { success: true, mergeId };
            
        } catch (error) {
            await tx.rollback();
            throw error;
        } finally {
            await session.close();
        }
    }
    
    /**
     * Create audit trail claim for data changes
     * Every modification is tracked with source and timestamp
     * 
     * @param {Transaction} tx - Active Neo4j transaction
     * @param {string} claimId - Unique claim identifier
     * @param {string} nodeType - Type of node being claimed about
     * @param {string} nodeId - ID of the node
     * @param {string} field - Field being modified
     * @param {any} value - New value
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
     * Generate deterministic provisional ID when external ID unavailable
     * IDs are consistent for the same input data
     * 
     * @param {string} type - Entity type
     * @param {object} data - Entity data
     */
    generateProvisionalId(type, data) {
        let normalizedString;
        
        switch(type) {
            case 'group':
                // Group ID based on name and founding members
                normalizedString = [
                    data.name?.toLowerCase(),
                    data.formed_date,
                    ...(data.members || []).map(m => m.name).sort()
                ].join('|');
                break;
                
            case 'person':
                // Person ID based on name
                normalizedString = data.name?.toLowerCase() || '';
                break;
                
            case 'track':
                // Track ID based on title, duration, and performers
                normalizedString = [
                    data.title?.toLowerCase(),
                    data.duration,
                    data.performed_by_group?.name
                ].join('|');
                break;
                
            case 'song':
                // Song ID based on title and writers
                normalizedString = [
                    data.title?.toLowerCase(),
                    ...(data.writers || []).map(w => w.person_id || w.name).sort()
                ].join('|');
                break;
                
            case 'release':
                // Release ID based on name, date, and label
                normalizedString = [
                    data.name?.toLowerCase(),
                    data.release_date,
                    data.label_id
                ].join('|');
                break;
                
            case 'source':
                // Source ID based on URL
                normalizedString = data.url;
                break;
                
            default:
                normalizedString = JSON.stringify(data);
        }
        
        const hash = createHash('sha256')
            .update(normalizedString)
            .digest('hex')
            .substring(0, 16);
            
        return `prov:${type}:${hash}`;
    }
    
    /**
     * Generate operation ID for sub-operations within an event
     * 
     * @param {string} eventHash - Parent event hash
     * @param {number} index - Operation index
     */
    generateOpId(eventHash, index) {
        return createHash('sha256')
            .update(eventHash + index.toString())
            .digest('hex');
    }
    
    /**
     * Clean up and close database connections
     */
    async close() {
        await this.driver.close();
    }
}

export default MusicGraphDatabase;
```

## An alias is on the node; a billing is on the relationship

Two different facts, and the registry keeps both.

`alt_names` on **Person**, **Group**, **Label** and **Release** (and
`alt_titles` on **Song** and **Track**) are names the thing goes by at all: a
stage name, a name someone recorded under before, a spelling another catalogue
uses. They are what search has to match — `entitySearch` indexes `alt_names`
and `alt_titles`, and the substring fallback in `nodeSearchService` checks
both — so this is what makes typing "Dee Dee" find Kristen Gundred.

`credited_as` on **MEMBER_OF**, **GUEST_ON**, **PERFORMED_ON** and **WROTE** is
how *one release* billed somebody. It is a fact about that record, not about
the person, and it is why a reissue can credit the same player differently
without contradicting anything.

**Aliases accumulate; they are never replaced.** No submission knows which of a
node's existing aliases are wrong, so a bundle adds to the list and removing an
entry is EDIT_CLAIM's job. In Cypher that is:

```cypher
SET p.alt_names = coalesce(p.alt_names, []) + [alt IN coalesce($altNames, [])
    WHERE NOT toLower(alt) IN [have IN coalesce(p.alt_names, []) | toLower(have)]
      AND toLower(alt) <> toLower(coalesce(p.name, ''))]
```

Written once as `mergedAltNames()` in `graph/schema.js`, because the thing it
replaced looked like a guard and was not one. `coalesce($altNames, p.alt_names,
[])` reads as "the parameter, or what is already there" — but the caller sends
`alt_names || []`, an empty list is not null in Cypher, so the parameter always
won. Every release submitted without restating an act's alias erased it. The
comparison is case-insensitive, and a node's own name is not stored as an alias
of itself.

## Node Types Summary

CONSIDER THIS SECTION CANONICAL

| Node Type | Purpose | Key Properties |
|-----------|---------|----------------|
| Person | Individual musician/artist | person_id, name, alt_names, bio, status |
| Group | Band/ensemble/orchestra | group_id, name, formed_date, member_count |
| Song | Musical composition | song_id, title, alt_titles, iswc, writers |
| Track | Recording of a song | track_id, title, alt_titles, isrc, duration, listen_links, lyrics, trivia |
| Release | Album/EP/Single/LivePerformance | release_id, name, barcode, release_date, format, country, catalog_number *(release-wide fallback; see below)*, listen_links, master_id, is_master_release |
| Master | Canonical album grouping | master_id, name, status |
| Label | Record label | label_id, name |
| Account | Blockchain account | account_id |
| City | Geographic location | city_id, name, lat, lon |
| Genre | What a record sounds like | genre_id, key *(the identity)*, name |
| Claim | Audit trail | claim_id, node_id, field, value |
| Source | External reference | source_id, url |
<!-- Media should link to a URL and then fetches the media from the URL to produce an IPFS address for the media -->
| Media | Associated Media | url, media_id |


## Editions and the Master node

A **Release is one edition**, not a work: the original pressing, the CD
remaster and the deluxe reissue are three Release nodes with three tracklists.
A **Master** is the node that groups them, and every Release has exactly one
`IN_MASTER` edge to it — including an original that nothing reissues yet, which
self-links with `master_id` equal to its own `release_id`. That convention is
what makes the reissue flow work: the submit form's master field searches
**Releases**, so picking the original supplies its `release_id` and both
editions land on the same Master.

Two consequences worth stating, because both were violated in code:

1. **Editions must fingerprint apart.** The provisional id for a Release is
   built from normalized title + date + catalogue number + format + country
   (`IdentityService.releaseFingerprint`). Drop any of those and two editions
   MERGE onto one node, the second silently overwriting the first's properties.
   Catalogue number is the strongest discriminator; the submit form collects it.

   This deliberately trades false merges for false splits, and that trade is a
   settled decision rather than an oversight. Including `format` means a
   submitter who types "Compact Disc" where another typed "CD" creates a second
   node for one edition. That is the better failure: a false split leaves two
   nodes that `MERGE_ENTITY` (60) can join and `findPotentialDuplicates()` can
   surface, whereas a false merge is **lossy** — the Release SET clause
   overwrites the earlier edition's format, country and catalogue number, and
   nothing records what was there before. Splits are recoverable; merges are
   not.
2. **`is_master_release` means "this Release *is* its group's Master node"** —
   that its `master_id` equals its own `release_id` — not "the submitter ticked
   the master box". The two usually agree, but a submitter who says "this is a
   reissue" without naming a master still self-links, because there is no other
   master to point at; the release is provisionally its own until a curator
   joins the two with `MERGE_ENTITY`. The flag's only consumer is edition
   ordering, where it breaks a date tie toward the original, and for that the
   graph fact is the one that matters.

3. **`IN_MASTER` is exclusive.** Reassigning a release to a different master
   deletes the previous edge rather than adding a second, or a sibling query
   returns the union of two unrelated edition sets. Reassignment can leave an
   orphaned self-Master behind; that is harmless (Masters carry no other edges
   and are not searchable) and is a curation cleanup, not an ingest concern.

`GET /api/release/:releaseId` returns the siblings under `versions`, ordered
oldest first, each with an `edition_label` naming what distinguishes it. Note
that `label` on an edition row is the **record label**; the edition's own
descriptor is `edition_label`.

### Migration note: existing releases need a replay

Both changes are retroactive in intent but not in effect.

- **Release ids change.** The date was previously dropped from the release
  fingerprint (the caller passed `date`, the fingerprint read `release_date`),
  so every release already in the graph carries an id minted from its title
  alone. With the date, format, country and issuing labels now included, the
  same release fingerprints to a *different* provisional id. Nothing rewrites
  the old nodes.
- **Catalogue numbers move onto the `RELEASED` edge.** Existing edges carry no
  `catalog_number`, so readers fall back to the release-level scalar until a
  replay writes the edges.
- **Existing releases have no Master.** `IN_MASTER` is written at ingest, so
  releases already in the graph have no edge and no `master_id`, and the
  switcher will not appear for them however many editions exist.

The coherent fix for both is the same one the deployment runbook already
documents: **replay the anchored events and let the graph rebuild.** The events
are immutable on chain and the ids are deterministic, so a replay reconstructs
every node under the corrected identity rules. See "Three things to know first"
in `docs/deployment/testnet-deployment-plan.md` — in particular that the sink's
`START_BLOCK` defaults to a short recent window, that resubmitting is not an
option because the contract rejects a duplicate event hash, and that the API
must be restarted before the replay or it answers `duplicate` and rebuilds
nothing.

Until a replay happens, old releases keep their old ids and no Master; new
submissions get the corrected behaviour. The two coexist without error, they
simply do not group together.

## Labels are many, and the catalogue number belongs to the pairing

A release is issued **by one or more labels**, and each issuer stamps its own
catalogue number on it. A co-issue (two labels sharing a release), a licensed
reissue (a different label putting out the same record years later) and a
territorial split (one label in the US, another in the UK) are all ordinary,
and all three break a model that assumes one label and one number.

So:

- `RELEASED` is a **Label → Release** edge and there may be several per release.
  Every reader must return the whole set. Taking the first — which the sibling
  editions query originally did with `collect(DISTINCT l.name)[0]` — silently
  picks one issuer at random and discards the rest.
- **`catalog_number` lives on the `RELEASED` edge**, not on either node,
  because it is a fact about the pairing rather than about the label (which
  issues thousands) or the release (which may have several). The submit form
  collects it per label.
- `Release.catalog_number` is retained as a release-wide fallback: it is what
  the release-level form field writes, it is copied onto the edge when a label
  supplies no number of its own, and it is what readers fall back to for rows
  written before the number moved. When both exist, **the edge wins** — it is
  the more specific claim.
- The issuing labels participate in **release identity**. Sorted
  `name|catalog` pairs go into the fingerprint via
  `IdentityService.labelFingerprintPart`, so a Sub Pop original and a Geffen
  reissue of the same album, same year, same format are two Releases rather
  than one overwriting the other. Sorted because a release is co-issued *by a
  set*: the order two names happen to be typed must not fork the node. A
  release with no labels contributes nothing to the fingerprint, so it keeps
  the id it would have had before labels counted.

`editionLabel` names the issuing label whenever it is what differs across a
master's editions — frequently it is the only thing that does.

## A compilation is credited to its tracks, not to a band

CONSIDER THIS SECTION CANONICAL

Discogs credits a compilation to "Various" — their artist id 194 — and names
the real act on each track. Polaris has somewhere to put both: a Release
carries Groups, and every Track carries its own.

**"Various" is never a Group.** It is a placeholder for the absence of a single
credit, and a `Group` node for it is one that every compilation then hangs its
recordings on: a hub in the graph with no members, no history and no meaning,
sitting between a dozen unrelated acts. The import drops it, and a compilation
therefore has **no release-level Group at all**. That is the honest shape —
nobody performed the release; twelve acts performed one track each.

So on a compilation every Track carries its own `PERFORMED_ON`, and the form's
"same as release" inheritance is switched off per track as it is imported.
Elsewhere that inheritance stays on, deliberately: an inherited group carries
the node id the submitter bound at the top of the form, where a re-typed name
mints a fresh provisional Group. It is broken only where breaking it says
something true — on a compilation, and on the one track of an ordinary album
that Discogs credits to somebody else.

Two things that look like compilations and are not. A single act's own
retrospective carries Discogs' "Compilation" format description while every
track is theirs: it keeps its release-level credit. A split release credits two
acts and names each on its own tracks, which is the ordinary multi-artist case
and already worked.

`anv` — the name an act was billed under on this particular release, "Bob
Dylan" printed as "Blind Boy Grunt" — is recorded as an alternate name on the
Group rather than replacing the name or being discarded. Same reasoning as a
Track's `alt_titles`: it is the one thing the disagreement carries.

**The line-up is printed under the track, and is read from there.** Discogs
credits a compilation track as "Tan Sister Radio — Leap Year" with "Drums –
Andrew Ware, Guitar – Aaron Dennis, Vocals, Bass – Max Greenhalgh" underneath,
and those people become that Group's `MEMBER_OF` edges for this track. They are
classified by the same `parseCredits` the release level uses, so a producer
credited beside the band does not become a bandmate.

**A line-up named on a track is a membership, when nothing else says
otherwise.** `/api/graph` builds the main view from `MEMBER_OF` and nothing
else: a Person enters the graph *because* they are a member of a Group, and
MEMBER_OF is the only edge type the query returns — the `PERFORMED_ON` edges
from a Person to a Track are read for the donut's participation counts and
draw nothing. So a group whose only line-up is on a track used to reach the
graph as a bare node: the people were in the registry, the band was on screen,
and nothing joined them.

So `processReleaseBundle` writes `MEMBER_OF` for a track-level line-up **when
the release said nothing about that group's membership**, which is exactly the
compilation case. Where the release *does* declare a line-up, a track-level
list is an override — a member sitting out, a stand-in behind the kit — and no
membership is written for it, because promoting a stand-in to the band is the
confidently-wrong answer the model warns against. No dates are set either way:
a track credit says who played on this release, not when they joined.

Reading an instrument credit as membership is the call this project already
made for a release Discogs has no members list for, and it is the one in force
here: a compilation names ten acts and fetching a roster for each would be ten
more API calls against a rate limit, so none is fetched. That is wrong for a
session player and right for the far more common case of a band's own line-up
printed under its own track — and it is visible in the form before anything is
signed, which is where a submitter can fix it. Where a credited performer *is*
one of the acts, they are their own group of one rather than a member of the
other, which is how "The Paragraphs, Tori Rogg" comes out right.

---

## Correcting a Relationship

A member who was really a session player, or a guest who was really in the band,
is corrected with an `EDIT_RELATIONSHIP` event (type 33), processed by
`processRelationshipEdit`. **Not by resubmitting the bundle.**

Every relationship here is MERGEd on a `claim_id` derived from the submitting
event's own hash — `MERGE (p)-[m:MEMBER_OF {claim_id: $claimId}]->(g)` — so a
second submission cannot match the first submission's edge; it creates another
one beside it. And bundle processing deletes no relationship (its single DELETE
retires a stale `IN_MASTER` link). So a corrected resubmission leaves the
mistaken edge exactly where it was, and the person is credited as both a member
and a guest, in breach of the relationship-consistency invariant.

`dropContradictoryGuests` is not a defence against this. It runs over the
incoming bundle body during normalization, so it resolves a contradiction
*within one submission* — a bundle listing someone as both — and cannot see
what an earlier submission already wrote to the graph.

What the correction does to the surrounding edges, and why it is replay-safe,
is in `docs/03-event-storage.md` under EDIT_RELATIONSHIP.

## Relationship Types Summary

| Relationship | From → To | Purpose |
|--------------|-----------|---------|
| MEMBER_OF | Person → Group | Group membership with dates |
| PERFORMED_ON | Group → Track | Group performed this track |
| GUEST_ON | Person → Track or Release | Guest appearance (not a member). `scope` is `track` or `release` |
| WROTE | Person → Song | Songwriting credit |
| ARRANGED | Person → Track | Credited arranger for a track (group by default) |
| PRODUCED | Person → Track | Credited Producer for a track |
| RECORDING_OF | Track → Song | Track records this song |
| COVER_OF | Track → Song | Cover version |
| SAMPLES | Track → Track | Sampling relationship |
| IN_RELEASE | Track → Release | Track appears on release |
| IN_MASTER | Release → Master | Release variant of master (**exactly one per Release**) |
| RELEASED | Label → Release | Released by label. Carries `catalog_number` — the number **this** label issued |
| TAGGED | Group|Release → Genre | What a source says it sounds like. Keyed by `origin` (`musicbrainz:genre`, `musicbrainz:tag`, `account:<name>`); carries `count`, `source_url`, `claim_id` |
| ORIGIN | Person|Group|Release|Label → City | Geographic origin |
| SUBMITTED | Account → Any | Who submitted data |
| REPRESENTS | Media → Any | What is represented in the linked media |

## Testing Queries

```cypher
-- Find all groups and their current members
MATCH (g:Group)
OPTIONAL MATCH (p:Person)-[m:MEMBER_OF]->(g)
WHERE m.to_date IS NULL
RETURN g.name, collect(p.name) as current_members

-- Find tracks where someone was a guest (not a member)
MATCH (p:Person)-[:GUEST_ON]->(t:Track)
MATCH (t)-[:IN_RELEASE]->(r:Release)
RETURN p.name, t.title, r.name

-- Calculate group participation percentages
MATCH (g:Group {name: "The Beatles"})
MATCH (p:Person)-[m:MEMBER_OF]->(g)
MATCH (g)-[:PERFORMED_ON]->(t:Track)
WITH p, count(t) as track_count
MATCH (g:Group {name: "The Beatles"})-[:PERFORMED_ON]->(total:Track)
WITH p, track_count, count(distinct total) as total_tracks
RETURN p.name, toFloat(track_count) / toFloat(total_tracks) * 100 as percentage
```
---

## Genre tags

CONSIDER THIS SECTION CANONICAL

A genre is the one thing in this schema that is not a fact about who did what.
It is either a catalogue's editorial judgement or somebody's opinion, and the
schema is built so a reader can always tell which.

**Identity.** A `Genre` is its normalized key — `graph/genreVocabulary.js`
reduces case, accents, punctuation, `&` and a short table of orthographic
variants ("prog rock" → "progressive rock"). That table deliberately refuses
judgements: `R&B` is **not** merged into `rhythm and blues`, because doing so
merges 1950s jump blues with 1990s contemporary R&B, which is a claim about
music rather than about spelling. Claims about music belong in something
somebody signs.

Two spellings therefore share one node, which is the point: the overlap between
two genres is computed over sets, and a genre that splits in two halves every
overlap silently.

`genre_id` is `prov:genre:{hash}`, hashed from that key and nothing else
(`IdentityService.makeGenreId`). A genre is deliberately **not** an
`EntityType`, which is the one place this schema's identity machinery does not
apply to a node it contains: every other entity can acquire a canonical id
later, because two rows about one person may turn out to be the same person and
`MERGE_NODE` says so. A genre cannot — it is already defined by its key — and
both doors the identity service would open onto it (minting
`polaris:genre:{uuid}`, or resolving a MusicBrainz genre MBID through the
identity map) end in one genre holding two ids, which is the split this section
exists to prevent. The `prov:` shape is kept so that ids in this registry have
one of three documented forms and `parseId` still classifies them.

**Provenance lives on the edge, not the node.** `TAGGED` is keyed by `origin`:

| origin | What it means | Anchored? |
|---|---|---|
| `musicbrainz:genre` | MusicBrainz's controlled, voted genre list | No |
| `musicbrainz:tag` | MusicBrainz folksonomy — where "melancholy" lives, and the noise | No |
| `account:<name>` | A person's own tag, from a signed event | Yes |

`setGenreTags` replaces **only the given origin's** edges for a node. So
re-running the import reflects a genre MusicBrainz has since dropped without
touching a word anybody here typed, and one submitter retracting a tag cannot
remove another's.

**Why the imported half is not on chain.** It is a mirror, not an assertion: its
provenance is the MBID and the fetch date, anyone can verify it at the source,
and re-running the import reproduces it — which is the test for what may live in
the projection without being anchored. A tag somebody invents is the opposite,
and is anchored.

**Why not ADD_CLAIM for the human half.** `multiplier_add_claim` is 1,000,000
against `multiplier_edit_claim`'s 1,000, so a tag would mint as much as a real
credit — the cheapest possible emission faucet. ADD_CLAIM also *sets a field*,
so two taggers would overwrite each other instead of accumulating. A tag event
wants its own type in the 20–39 band, where the deployed contract anchors and
votes on it while `get_multiplier`'s `default: return 0` pays nothing for it.
Zero is arguably the right permanent setting: tags are wanted because people
want the tags.

**How a tag is reached.** By identifier, never by name — `api/genreImport.js`:

```
Release.barcode  →  MusicBrainz release (query=barcode:…)
                 →  its release-group  → genres for the Release
                 →  its artist-credit  → genres for the Group
```

Two release-groups under one barcode, or a release whose MusicBrainz artists
and whose registry Groups are not one-to-one, are **skipped and reported**
rather than guessed at. A gap in the data is visible and fixable; a wrong genre
attached to a band is neither.
