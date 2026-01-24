/**
 * ReleaseBundle Normalization Layer
 *
 * Converts frontend data to canonical schema format before graph ingestion.
 * Handles legacy field names and validates against canonical schema.
 *
 * Data Model:
 * - tracks: Unique track entities (reusable across releases)
 * - tracklist: Release-specific references to tracks (order, disc/side)
 *
 * Field Mappings:
 * - release_name → name
 * - releaseDate → release_date
 * - albumArt → album_art
 * - camelCase → snake_case (general pattern)
 */

import crypto from 'crypto';
import { normalizeRoles, normalizeRole } from './roleNormalization.js';

/**
 * Normalize a ReleaseBundle from frontend format to canonical format
 *
 * Accepts both:
 * - Legacy shape: { release: { tracks: [...] }, tracklist: [...] }
 * - Canonical shape: { release, tracks: [...], tracklist: [...], groups: [...] }
 *
 * @param {Object} bundle - ReleaseBundle from frontend
 * @returns {Object} Normalized bundle matching canonical schema
 * @throws {Error} Validation errors with detailed messages
 */
export function normalizeReleaseBundle(bundle) {
    const errors = [];

    // Validate bundle structure
    if (!bundle || typeof bundle !== 'object') {
        throw new Error('ReleaseBundle must be an object');
    }

    // Normalize release (required)
    let normalizedRelease;
    try {
        normalizedRelease = normalizeRelease(bundle.release);
    } catch (err) {
        errors.push(`release: ${err.message}`);
    }

    // Normalize groups (optional, defaults to empty array)
    const normalizedGroups = [];
    if (bundle.groups && Array.isArray(bundle.groups)) {
        bundle.groups.forEach((group, idx) => {
            try {
                normalizedGroups.push(normalizeGroup(group));
            } catch (err) {
                errors.push(`groups[${idx}]: ${err.message}`);
            }
        });
    }

    // ========== TRACK CATALOG NORMALIZATION ==========
    // Determine track definitions from various input sources
    // Priority: bundle.tracks > bundle.release.tracks > derive from tracklist
    const trackDefs = bundle.tracks || bundle.release?.tracks || [];

    if (!Array.isArray(trackDefs)) {
        errors.push('tracks: Must be an array');
    }

    // Normalize and deduplicate tracks into catalog
    const { tracks: normalizedTracks, trackIdMap } = normalizeTrackCatalog(trackDefs, errors);

    // ========== TRACKLIST NORMALIZATION ==========
    // Normalize tracklist to reference track_id (not embedded track objects)
    const tracklistInput = bundle.tracklist || [];

    if (!Array.isArray(tracklistInput)) {
        errors.push('tracklist: Must be an array');
    }

    const normalizedTracklist = normalizeTracklist(tracklistInput, trackIdMap, normalizedTracks, errors);

    // Normalize songs (optional)
    const normalizedSongs = [];
    if (bundle.songs && Array.isArray(bundle.songs)) {
        bundle.songs.forEach((song, idx) => {
            try {
                normalizedSongs.push(normalizeSong(song));
            } catch (err) {
                errors.push(`songs[${idx}]: ${err.message}`);
            }
        });
    }

    // Normalize sources (optional)
    const normalizedSources = [];
    if (bundle.sources && Array.isArray(bundle.sources)) {
        bundle.sources.forEach((source, idx) => {
            try {
                normalizedSources.push(normalizeSource(source));
            } catch (err) {
                errors.push(`sources[${idx}]: ${err.message}`);
            }
        });
    }

    // If any errors occurred, throw detailed message
    if (errors.length > 0) {
        throw new Error(`ReleaseBundle validation failed:\n  - ${errors.join('\n  - ')}`);
    }

    // Return normalized bundle
    return {
        release: normalizedRelease,
        groups: normalizedGroups,
        tracks: normalizedTracks,
        tracklist: normalizedTracklist,
        ...(normalizedSongs.length > 0 && { songs: normalizedSongs }),
        ...(normalizedSources.length > 0 && { sources: normalizedSources })
    };
}

/**
 * Normalize track catalog: deduplicate tracks and ensure stable track_id
 *
 * @param {Array} trackDefs - Track definitions from input
 * @param {Array} errors - Error collection
 * @returns {Object} { tracks: Array, trackIdMap: Map }
 */
function normalizeTrackCatalog(trackDefs, errors) {
    const tracks = [];
    const trackIdMap = new Map(); // Maps track_id → track index
    const seenIds = new Set();

    for (let idx = 0; idx < trackDefs.length; idx++) {
        try {
            const trackDef = trackDefs[idx];
            const normalized = normalizeTrack(trackDef);

            // Ensure track has a stable track_id
            if (!normalized.track_id) {
                normalized.track_id = generateTrackId(normalized);
            }

            // Deduplicate by track_id
            if (seenIds.has(normalized.track_id)) {
                // Skip duplicate, but note it in console (not an error) - suppress in tests
                if (process.env.NODE_ENV !== 'test') {
                    console.log(`Note: Skipping duplicate track_id: ${normalized.track_id}`);
                }
                continue;
            }

            seenIds.add(normalized.track_id);
            trackIdMap.set(normalized.track_id, tracks.length);
            tracks.push(normalized);

        } catch (err) {
            errors.push(`tracks[${idx}]: ${err.message}`);
        }
    }

    if (tracks.length === 0) {
        errors.push('tracks: Must have at least one valid track');
    }

    return { tracks, trackIdMap };
}

/**
 * Generate deterministic track_id when missing
 *
 * All generated IDs use the provisional format (prov:track:*) so that
 * IdentityService.parseId() correctly classifies them as PROVISIONAL,
 * ensuring consistent ID handling throughout the graph pipeline.
 *
 * Priority:
 * 1. ISRC if available (stored as property, ID is still provisional)
 * 2. Hash of normalized title + duration
 *
 * @param {Object} track - Normalized track
 * @returns {string} Deterministic track_id with prov: prefix
 */
function generateTrackId(track) {
    // Priority 1: ISRC-based provisional ID
    if (track.isrc) {
        return `prov:track:isrc:${track.isrc}`;
    }

    // Priority 2: Hash of canonical identity (title + duration)
    const normalizedTitle = track.title.toLowerCase().trim().replace(/\s+/g, ' ');
    const duration = track.duration || 0;
    const identityString = `track:${normalizedTitle}:${duration}`;

    // Generate short hash (first 16 chars of SHA256)
    const hash = crypto.createHash('sha256')
        .update(identityString)
        .digest('hex')
        .substring(0, 16);

    return `prov:track:${hash}`;
}

/**
 * Normalize tracklist to reference track_id (not embedded track objects)
 *
 * @param {Array} tracklistInput - Tracklist items from input
 * @param {Map} trackIdMap - Map of track_id → track index
 * @param {Array} tracks - Normalized tracks catalog
 * @param {Array} errors - Error collection
 * @returns {Array} Normalized tracklist
 */
function normalizeTracklist(tracklistInput, trackIdMap, tracks, errors) {
    const tracklist = [];

    for (let idx = 0; idx < tracklistInput.length; idx++) {
        try {
            const item = tracklistInput[idx];

            // Normalize the base tracklist item (accepts frontend shape)
            const normalized = normalizeTracklistItem(item, idx);

            // Ensure tracklist item has track_id reference
            if (!normalized.track_id) {
                // Try to resolve track_id from track_title by matching catalog
                if (normalized.track_title) {
                    const matchedTrack = tracks.find(t =>
                        t.title.toLowerCase() === normalized.track_title.toLowerCase()
                    );

                    if (matchedTrack) {
                        normalized.track_id = matchedTrack.track_id;
                    } else {
                        errors.push(`tracklist[${idx}]: Could not resolve track_id for track_title: ${normalized.track_title}`);
                        continue; // Skip this item
                    }
                } else {
                    errors.push(`tracklist[${idx}]: Missing track_id and cannot derive from track_title`);
                    continue;
                }
            }

            // Verify track_id exists in catalog
            if (!trackIdMap.has(normalized.track_id)) {
                errors.push(`tracklist[${idx}]: Referenced track_id not found in catalog: ${normalized.track_id}`);
                continue; // Skip this item
            }

            // Derive track_title from catalog if missing
            if (!normalized.track_title) {
                const catalogTrack = tracks[trackIdMap.get(normalized.track_id)];
                normalized.track_title = catalogTrack.title;
            }

            // Derive position if missing (from frontend shape)
            if (!normalized.position) {
                if (item.disc_side && item.track_number) {
                    normalized.position = `${item.disc_side}-${item.track_number}`;
                } else if (item.track_number) {
                    normalized.position = String(item.track_number);
                } else {
                    // Fallback to 1-based index
                    normalized.position = String(idx + 1);
                }
            }

            // Strip non-canonical fields (schema has additionalProperties: false)
            const canonical = {
                position: normalized.position,
                track_title: normalized.track_title,
                track_id: normalized.track_id
            };

            // Include optional duration if present
            if (normalized.duration !== undefined) {
                canonical.duration = normalized.duration;
            }

            tracklist.push(canonical);

        } catch (err) {
            errors.push(`tracklist[${idx}]: ${err.message}`);
        }
    }

    if (tracklist.length === 0) {
        errors.push('tracklist: Must have at least one valid item');
    }

    return tracklist;
}

/**
 * Normalize Release object
 */
function normalizeRelease(release) {
    if (!release || typeof release !== 'object') {
        throw new Error('Must be an object');
    }

    // Map legacy field names to canonical names
    const name = release.name || release.release_name;
    if (!name || name.trim() === '') {
        throw new Error('name is required and cannot be empty');
    }

    const normalized = {
        name: name.trim()
    };

    // Optional fields with legacy support
    if (release.release_id) normalized.release_id = release.release_id;
    if (release.alt_names) normalized.alt_names = release.alt_names;

    // Date field (releaseDate � release_date)
    const releaseDate = release.release_date || release.releaseDate;
    if (releaseDate) {
        normalized.release_date = releaseDate;
    }

    if (release.format) normalized.format = release.format;
    if (release.country) normalized.country = release.country;
    if (release.catalog_number) normalized.catalog_number = release.catalog_number;
    if (release.liner_notes) normalized.liner_notes = release.liner_notes;
    if (release.trivia) normalized.trivia = release.trivia;

    // Album art (albumArt � album_art)
    const albumArt = release.album_art || release.albumArt;
    if (albumArt) normalized.album_art = albumArt;

    if (release.master_id) normalized.master_id = release.master_id;
    if (release.master_name) normalized.master_name = release.master_name;

    // Nested arrays
    if (release.labels && Array.isArray(release.labels)) {
        normalized.labels = release.labels.map(normalizeLabel);
    }
    if (release.guests && Array.isArray(release.guests)) {
        normalized.guests = release.guests.map(guest => {
            const normalizedPerson = normalizePerson(guest);
            // Collect roles from both role (singular) and roles (plural) inputs
            const rawRoles = [];
            if (Array.isArray(guest.roles)) {
                rawRoles.push(...guest.roles);
            }
            if (guest.role && typeof guest.role === 'string') {
                rawRoles.push(guest.role);
            }
            // Normalize and dedupe roles
            normalizedPerson.roles = normalizeRoles(rawRoles);
            if (guest.credited_as) {
                normalizedPerson.credited_as = guest.credited_as;
            }
            return normalizedPerson;
        });
    }

    return normalized;
}

/**
 * Normalize Group object
 */
function normalizeGroup(group) {
    if (!group || typeof group !== 'object') {
        throw new Error('Must be an object');
    }

    if (!group.name || group.name.trim() === '') {
        throw new Error('name is required and cannot be empty');
    }

    const normalized = {
        name: group.name.trim()
    };

    if (group.group_id) normalized.group_id = group.group_id;
    if (group.alt_names) normalized.alt_names = group.alt_names;
    if (group.bio) normalized.bio = group.bio;
    if (group.formed_date) normalized.formed_date = group.formed_date;
    if (group.disbanded_date) normalized.disbanded_date = group.disbanded_date;
    if (group.origin_city) normalized.origin_city = normalizeCity(group.origin_city);

    if (group.members && Array.isArray(group.members)) {
        normalized.members = group.members.map(member => {
            const normalizedPerson = normalizePerson(member);
            // Add membership-specific fields
            if (member.from_date) normalizedPerson.from_date = member.from_date;
            if (member.to_date) normalizedPerson.to_date = member.to_date;
            // Normalize role for consistent querying
            if (member.role) normalizedPerson.role = normalizeRole(member.role);
            if (Array.isArray(member.instruments)) {
                normalizedPerson.instruments = member.instruments;
            }
            return normalizedPerson;
        });
    }

    return normalized;
}

/**
 * Normalize Track object
 */
function normalizeTrack(track) {
    if (!track || typeof track !== 'object') {
        throw new Error('Must be an object');
    }

    if (!track.title || track.title.trim() === '') {
        throw new Error('title is required and cannot be empty');
    }

    const normalized = {
        title: track.title.trim()
    };

    if (track.track_id) normalized.track_id = track.track_id;
    if (track.duration !== undefined) normalized.duration = track.duration;
    if (track.isrc) normalized.isrc = track.isrc;
    if (track.performed_by) normalized.performed_by = track.performed_by;
    if (track.recording_of) normalized.recording_of = track.recording_of;
    if (track.samples) normalized.samples = track.samples;

    // Map track.groups → performed_by_groups for graph ingestion
    // Frontend sends track.groups, graph expects performed_by_groups
    if (track.groups && Array.isArray(track.groups)) {
        normalized.performed_by_groups = track.groups
            .map(group => {
                // Ensure we have at least a group_id or name to identify the group
                const group_id = group.group_id || group.id;
                const name = group.name || group.group_name;

                if (!group_id && !name) {
                    // Skip groups without any identifier
                    return null;
                }

                return {
                    group_id,
                    name,
                    ...(group.credited_as && { credited_as: group.credited_as }),
                    ...(group.role && { role: group.role }),
                    // Preserve per-track member overrides for lineup attribution
                    ...(Array.isArray(group.members) && group.members.length > 0 && {
                        members: group.members.map(m => normalizePerson(m))
                    })
                };
            })
            .filter(group => group !== null); // Remove invalid entries
    }

    // Fallback: older payloads use performed_by as a string (often the group name).
    // Promote it to performed_by_groups so ingestion can create PERFORMED_ON edges.
    if (
        (!normalized.performed_by_groups || normalized.performed_by_groups.length === 0) &&
        typeof track.performed_by === 'string' &&
        track.performed_by.trim()
    ) {
        normalized.performed_by_groups = [{ name: track.performed_by.trim() }];
    }

    if (track.guests && Array.isArray(track.guests)) {
        normalized.guests = track.guests.map(guest => {
            const normalizedPerson = normalizePerson(guest);
            // Collect roles from both role (singular) and roles (plural) inputs
            const rawRoles = [];
            if (Array.isArray(guest.roles)) {
                rawRoles.push(...guest.roles);
            }
            if (guest.role && typeof guest.role === 'string') {
                rawRoles.push(guest.role);
            }
            // Normalize and dedupe roles
            normalizedPerson.roles = normalizeRoles(rawRoles);
            // Also preserve instruments if present
            if (Array.isArray(guest.instruments)) {
                normalizedPerson.instruments = guest.instruments;
            }
            if (guest.credited_as) {
                normalizedPerson.credited_as = guest.credited_as;
            }
            return normalizedPerson;
        });
    }

    return normalized;
}

/**
 * Normalize TracklistItem object
 * Accepts both canonical shape (position, track_title) and frontend shape (track_id, disc_side, track_number)
 * Missing fields will be derived by parent normalizeTracklist() function
 *
 * @param {Object} item - Tracklist item from input
 * @param {number} idx - Index in tracklist array (for fallback position)
 * @returns {Object} Partially normalized item (may be missing required fields)
 */
function normalizeTracklistItem(item, idx) {
    if (!item || typeof item !== 'object') {
        throw new Error('Must be an object');
    }

    const normalized = {};

    // Accept canonical shape
    if (item.position) normalized.position = item.position;
    if (item.track_title) normalized.track_title = item.track_title.trim();

    // Accept frontend shape (for derivation by parent)
    if (item.track_id) normalized.track_id = item.track_id;
    if (item.duration !== undefined) normalized.duration = item.duration;

    // NOTE: disc_side and track_number are NOT stored here
    // They are read directly from the original item in normalizeTracklist()
    // and used only for deriving position, never included in output

    return normalized;
}

/**
 * Normalize Song object
 */
function normalizeSong(song) {
    if (!song || typeof song !== 'object') {
        throw new Error('Must be an object');
    }

    if (!song.title || song.title.trim() === '') {
        throw new Error('title is required and cannot be empty');
    }

    const normalized = {
        title: song.title.trim()
    };

    if (song.song_id) normalized.song_id = song.song_id;
    if (song.alt_titles) normalized.alt_titles = song.alt_titles;
    if (song.iswc) normalized.iswc = song.iswc;

    if (song.writers && Array.isArray(song.writers)) {
        normalized.writers = song.writers.map(normalizePerson);
    }

    return normalized;
}

/**
 * Normalize Person object
 */
function normalizePerson(person) {
    if (!person || typeof person !== 'object') {
        throw new Error('Must be an object');
    }

    if (!person.name || person.name.trim() === '') {
        throw new Error('name is required and cannot be empty');
    }

    const normalized = {
        name: person.name.trim()
    };

    if (person.person_id) normalized.person_id = person.person_id;
    if (person.birth_name) normalized.birth_name = person.birth_name;
    if (person.birth_date) normalized.birth_date = person.birth_date;
    if (person.birth_city) normalized.birth_city = normalizeCity(person.birth_city);
    if (person.roles) normalized.roles = person.roles;

    return normalized;
}

/**
 * Normalize Label object
 */
function normalizeLabel(label) {
    if (!label || typeof label !== 'object') {
        throw new Error('Must be an object');
    }

    if (!label.name || label.name.trim() === '') {
        throw new Error('name is required and cannot be empty');
    }

    const normalized = {
        name: label.name.trim()
    };

    if (label.label_id) normalized.label_id = label.label_id;
    if (label.city) normalized.city = normalizeCity(label.city);

    return normalized;
}

/**
 * Normalize City object
 */
function normalizeCity(city) {
    if (!city || typeof city !== 'object') {
        throw new Error('Must be an object');
    }

    if (!city.name || city.name.trim() === '') {
        throw new Error('name is required and cannot be empty');
    }

    const normalized = {
        name: city.name.trim()
    };

    if (city.city_id) normalized.city_id = city.city_id;
    if (city.lat !== undefined) normalized.lat = city.lat;
    if (city.lon !== undefined) normalized.lon = city.lon;

    return normalized;
}

/**
 * Normalize Source object
 */
function normalizeSource(source) {
    if (!source || typeof source !== 'object') {
        throw new Error('Must be an object');
    }

    const normalized = {};

    if (source.type) normalized.type = source.type;
    if (source.url) normalized.url = source.url;
    if (source.accessed_at) normalized.accessed_at = source.accessed_at;

    return normalized;
}

export default normalizeReleaseBundle;
