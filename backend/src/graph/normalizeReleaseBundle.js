/**
 * ReleaseBundle Normalization Layer
 *
 * Converts frontend data to canonical schema format before graph ingestion.
 * Handles legacy field names and validates against canonical schema.
 *
 * Field Mappings:
 * - release_name � name
 * - releaseDate � release_date
 * - albumArt � album_art
 * - camelCase � snake_case (general pattern)
 */

/**
 * Normalize a ReleaseBundle from frontend format to canonical format
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

    // Normalize tracks (required, at least 1)
    const normalizedTracks = [];
    if (bundle.tracks && Array.isArray(bundle.tracks)) {
        bundle.tracks.forEach((track, idx) => {
            try {
                normalizedTracks.push(normalizeTrack(track));
            } catch (err) {
                errors.push(`tracks[${idx}]: ${err.message}`);
            }
        });
    } else {
        errors.push('tracks: Required field, must be non-empty array');
    }

    // Normalize tracklist (required, at least 1)
    const normalizedTracklist = [];
    if (bundle.tracklist && Array.isArray(bundle.tracklist)) {
        bundle.tracklist.forEach((item, idx) => {
            try {
                normalizedTracklist.push(normalizeTracklistItem(item));
            } catch (err) {
                errors.push(`tracklist[${idx}]: ${err.message}`);
            }
        });
    } else {
        errors.push('tracklist: Required field, must be non-empty array');
    }

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
        normalized.guests = release.guests.map(normalizePerson);
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
            if (member.role) normalizedPerson.role = member.role;
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
                    ...(group.role && { role: group.role })
                };
            })
            .filter(group => group !== null); // Remove invalid entries
    }

    if (track.guests && Array.isArray(track.guests)) {
        normalized.guests = track.guests.map(guest => {
            const normalizedPerson = normalizePerson(guest);
            if (guest.role) normalizedPerson.role = guest.role;
            return normalizedPerson;
        });
    }

    return normalized;
}

/**
 * Normalize TracklistItem object
 */
function normalizeTracklistItem(item) {
    if (!item || typeof item !== 'object') {
        throw new Error('Must be an object');
    }

    if (!item.position) {
        throw new Error('position is required');
    }

    if (!item.track_title || item.track_title.trim() === '') {
        throw new Error('track_title is required and cannot be empty');
    }

    const normalized = {
        position: item.position,
        track_title: item.track_title.trim()
    };

    if (item.track_id) normalized.track_id = item.track_id;
    if (item.duration !== undefined) normalized.duration = item.duration;

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
