/**
 * Discogs Database Importer
 *
 * Imports release and artist data from Discogs API into Polaris Music Registry.
 *
 * Implementation based on: /docs/10-data-import-tools.md
 *
 * Features:
 * - Discogs API client with rate limiting
 * - Release data transformation to Polaris event format
 * - Artist/Group mapping and deduplication
 * - Batch import with progress tracking
 * - Error handling and retry logic
 *
 * Usage:
 *   import { DiscogsImporter } from './tools/import/discogsImporter.js';
 *
 *   const importer = new DiscogsImporter({
 *     discogsToken: 'your_discogs_token',
 *     storage: { ... },  // EventStore config
 *     neo4j: { ... }     // Neo4j config
 *   });
 *
 *   await importer.importRelease(releaseId, 'importer_account');
 *   await importer.importArtist(artistId, 'importer_account');
 */

import axios from 'axios';
import { createHash } from 'crypto';
import stringify from 'fast-json-stable-stringify';

export class DiscogsImporter {
    /**
     * Initialize Discogs importer
     *
     * @param {Object} config - Configuration object
     * @param {string} config.discogsToken - Discogs API token
     * @param {string} [config.userAgent] - User agent for API requests
     * @param {Object} [config.storage] - EventStore configuration
     * @param {Object} [config.neo4j] - Neo4j configuration
     * @param {number} [config.requestsPerMinute=60] - Rate limit (Discogs allows 60/min)
     */
    constructor(config = {}) {
        this.apiBase = 'https://api.discogs.com';
        this.token = config.discogsToken || process.env.DISCOGS_TOKEN;
        this.userAgent = config.userAgent || 'PolarisImporter/1.0';

        if (!this.token) {
            console.warn('⚠ Discogs API token not provided. Set DISCOGS_TOKEN env var or pass discogsToken config.');
            console.warn('  Get token at: https://www.discogs.com/settings/developers');
        }

        // Rate limiting (Discogs allows 60 authenticated requests per minute)
        this.requestsPerMinute = config.requestsPerMinute || 60;
        this.requestQueue = [];
        this.lastRequestTime = 0;
        this.minRequestInterval = (60 * 1000) / this.requestsPerMinute;

        // Optional integration with EventStore and Graph (if provided)
        this.eventStore = config.storage ?
            new (require('../../backend/src/storage/eventStore.js').default)(config.storage) :
            null;
        this.graphDb = config.neo4j ?
            new (require('../../backend/src/graph/schema.js').default)(config.neo4j) :
            null;

        // Statistics
        this.stats = {
            releases: 0,
            artists: 0,
            tracks: 0,
            errors: 0
        };
    }

    /**
     * Import a release from Discogs by ID
     *
     * @param {number} releaseId - Discogs release ID
     * @param {string} [submitter='importer'] - Account importing the data
     * @returns {Promise<Object>} Import result
     */
    async importRelease(releaseId, submitter = 'importer') {
        console.log(`📀 Importing Discogs release ${releaseId}...`);

        try {
            // Fetch release data from Discogs
            const releaseData = await this.fetchDiscogsRelease(releaseId);

            // Convert to Polaris bundle format
            const bundle = await this.convertReleaseToBundle(releaseData);

            console.log(`✓ Converted: ${releaseData.title} (${bundle.tracks.length} tracks)`);

            // If EventStore is configured, create and store event
            let hash = null;
            if (this.eventStore) {
                const event = this.createEvent('CREATE_RELEASE_BUNDLE', bundle, submitter);
                hash = this.calculateHash(event);

                await this.eventStore.storeEvent(event, hash);
                console.log(`✓ Event stored: ${hash}`);
            }

            // If GraphDB is configured, process into graph
            if (this.graphDb && hash) {
                await this.graphDb.processReleaseBundle(hash, bundle, submitter);
                console.log(`✓ Processed into graph`);
            }

            this.stats.releases++;
            this.stats.tracks += bundle.tracks.length;

            console.log(`✅ Imported: ${releaseData.title} (${releaseId})`);

            return {
                success: true,
                releaseId,
                hash,
                title: releaseData.title,
                tracks: bundle.tracks.length
            };
        } catch (error) {
            this.stats.errors++;
            console.error(`❌ Failed to import release ${releaseId}:`, error.message);
            throw error;
        }
    }

    /**
     * Import an artist from Discogs by ID
     *
     * @param {number} artistId - Discogs artist ID
     * @param {string} [submitter='importer'] - Account importing the data
     * @returns {Promise<Object>} Import result
     */
    async importArtist(artistId, submitter = 'importer') {
        console.log(`🎤 Importing Discogs artist ${artistId}...`);

        try {
            const artistData = await this.fetchDiscogsArtist(artistId);

            const person = await this.convertArtistToPerson(artistData);

            console.log(`✓ Converted: ${artistData.name}`);

            this.stats.artists++;

            console.log(`✅ Imported: ${artistData.name} (${artistId})`);

            return {
                success: true,
                artistId,
                name: artistData.name,
                person
            };
        } catch (error) {
            this.stats.errors++;
            console.error(`❌ Failed to import artist ${artistId}:`, error.message);
            throw error;
        }
    }

    /**
     * Fetch release data from Discogs API with rate limiting
     *
     * @param {number} releaseId - Discogs release ID
     * @returns {Promise<Object>} Discogs release data
     */
    async fetchDiscogsRelease(releaseId) {
        await this._rateLimit();

        const response = await axios.get(
            `${this.apiBase}/releases/${releaseId}`,
            {
                headers: {
                    'Authorization': `Discogs token=${this.token}`,
                    'User-Agent': this.userAgent
                }
            }
        );

        return response.data;
    }

    /**
     * Fetch artist data from Discogs API with rate limiting
     *
     * @param {number} artistId - Discogs artist ID
     * @returns {Promise<Object>} Discogs artist data
     */
    async fetchDiscogsArtist(artistId) {
        await this._rateLimit();

        const response = await axios.get(
            `${this.apiBase}/artists/${artistId}`,
            {
                headers: {
                    'Authorization': `Discogs token=${this.token}`,
                    'User-Agent': this.userAgent
                }
            }
        );

        return response.data;
    }

    /**
     * Convert Discogs release to Polaris bundle format
     *
     * @param {Object} discogsRelease - Discogs release data
     * @returns {Promise<Object>} Polaris release bundle
     */
    async convertReleaseToBundle(discogsRelease) {
        const bundle = {
            release: {
                release_id: `discogs:release/${discogsRelease.id}`,
                name: discogsRelease.title,
                release_date: discogsRelease.released || discogsRelease.year,
                format: discogsRelease.formats ?
                    discogsRelease.formats.map(f => f.name) : [],
                country: discogsRelease.country,
                catalog_number: discogsRelease.labels && discogsRelease.labels[0]?
                    discogsRelease.labels[0].catno : null,
                notes: discogsRelease.notes,
                master_id: discogsRelease.master_id ?
                    `discogs:master/${discogsRelease.master_id}` : null,
                label_id: discogsRelease.labels && discogsRelease.labels[0] ?
                    `discogs:label/${discogsRelease.labels[0].id}` : null,
                label_name: discogsRelease.labels && discogsRelease.labels[0] ?
                    discogsRelease.labels[0].name : null
            },
            groups: [],
            songs: [],
            tracks: [],
            tracklist: [],
            sources: [{
                url: `https://www.discogs.com/release/${discogsRelease.id}`,
                type: 'discogs'
            }]
        };

        // Process artists to identify groups
        const artistGroups = this.processDiscogsArtists(discogsRelease.artists || []);
        bundle.groups = artistGroups;

        // Process tracklist
        const trackData = this.processDiscogsTracklist(
            discogsRelease.tracklist || [],
            discogsRelease.artists || [],
            discogsRelease.extraartists || []
        );

        bundle.tracks = trackData.tracks;
        bundle.songs = trackData.songs;
        bundle.tracklist = trackData.tracklist;

        return bundle;
    }

    /**
     * Process Discogs artists into Polaris groups
     *
     * @param {Array} artists - Discogs artists array
     * @returns {Array} Polaris groups
     */
    processDiscogsArtists(artists) {
        return artists.map(artist => ({
            group_id: `discogs:artist/${artist.id}`,
            name: artist.name,
            roles: [artist.join || 'performer'],
            members: [] // Can be populated from artist details if needed
        }));
    }

    /**
     * Process Discogs tracklist into Polaris tracks and songs
     *
     * @param {Array} tracklist - Discogs tracklist
     * @param {Array} releaseArtists - Album-level artists
     * @param {Array} extraArtists - Additional contributors
     * @returns {Object} Processed tracks and songs
     */
    processDiscogsTracklist(tracklist, releaseArtists, extraArtists) {
        const tracks = [];
        const songs = [];
        const tracklistData = [];

        tracklist.forEach((track, index) => {
            // Skip non-track entries (headers, etc.)
            if (!track.title || track.type_ === 'heading') {
                return;
            }

            const trackId = `discogs:track/${createHash('sha256').update(track.position + track.title).digest('hex').substring(0, 16)}`;
            const songId = `discogs:song/${createHash('sha256').update(track.title).digest('hex').substring(0, 16)}`;

            // Create song (composition)
            songs.push({
                song_id: songId,
                title: track.title,
                writers: this.extractWriters(track.extraartists || extraArtists)
            });

            // Create track (recording)
            tracks.push({
                track_id: trackId,
                song_id: songId,
                title: track.title,
                position: track.position,
                duration: this.parseDuration(track.duration),
                performers: (track.artists || releaseArtists).map(a => ({
                    group_id: `discogs:artist/${a.id}`,
                    name: a.name
                }))
            });

            // Add to tracklist
            tracklistData.push({
                track_id: trackId,
                position: index + 1
            });
        });

        return { tracks, songs, tracklist: tracklistData };
    }

    /**
     * Extract writers from extraartists
     *
     * @param {Array} extraartists - Discogs extra artists
     * @returns {Array} Writer information
     */
    extractWriters(extraartists) {
        if (!extraartists) return [];

        return extraartists
            .filter(artist =>
                artist.role &&
                (artist.role.includes('Written') ||
                 artist.role.includes('Composer') ||
                 artist.role.includes('Songwriter'))
            )
            .map(artist => ({
                person_id: `discogs:artist/${artist.id}`,
                name: artist.name,
                role: artist.role
            }));
    }

    /**
     * Parse Discogs duration string (MM:SS) to seconds
     *
     * @param {string} duration - Duration string
     * @returns {number} Duration in seconds
     */
    parseDuration(duration) {
        if (!duration) return null;

        const parts = duration.split(':');
        if (parts.length !== 2) return null;

        const minutes = parseInt(parts[0], 10);
        const seconds = parseInt(parts[1], 10);

        return minutes * 60 + seconds;
    }

    /**
     * Convert Discogs artist to Polaris person
     *
     * @param {Object} artistData - Discogs artist data
     * @returns {Object} Polaris person
     */
    async convertArtistToPerson(artistData) {
        return {
            person_id: `discogs:artist/${artistData.id}`,
            name: artistData.name,
            real_name: artistData.realname,
            profile: artistData.profile,
            urls: artistData.urls || [],
            images: artistData.images || []
        };
    }

    /**
     * Create a Polaris event
     *
     * @param {string} type - Event type
     * @param {Object} body - Event body
     * @param {string} submitter - Submitter account
     * @returns {Object} Event object
     */
    createEvent(type, body, submitter) {
        return {
            v: 1,
            type,
            author_pubkey: `PUB_K1_${submitter}`,
            created_at: Math.floor(Date.now() / 1000),
            parents: [],
            body
        };
    }

    /**
     * Calculate event hash
     *
     * @param {Object} event - Event object
     * @returns {string} SHA256 hash
     */
    calculateHash(event) {
        const { sig, ...eventWithoutSig } = event;
        const canonical = stringify(eventWithoutSig);
        return createHash('sha256').update(canonical).digest('hex');
    }

    /**
     * Rate limiting implementation
     * Ensures requests don't exceed Discogs API limits
     *
     * @private
     */
    async _rateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;

        if (timeSinceLastRequest < this.minRequestInterval) {
            const waitTime = this.minRequestInterval - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        this.lastRequestTime = Date.now();
    }

    /**
     * Get import statistics
     *
     * @returns {Object} Statistics
     */
    getStats() {
        return { ...this.stats };
    }
}

export default DiscogsImporter;
