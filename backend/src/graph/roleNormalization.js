/**
 * Role Normalization Utility
 *
 * Normalizes role values for consistent storage and querying in Neo4j.
 * Used across relationship types: PERFORMED_ON, MEMBER_OF, WROTE, GUEST_ON
 *
 * @module graph/roleNormalization
 */

/**
 * Common role synonyms mapped to canonical forms
 * Keep this mapping small and add as needed
 */
const ROLE_SYNONYMS = {
    // Instrument variations
    'guitars': 'guitar',
    'electric guitar': 'guitar',
    'acoustic guitar': 'guitar',
    'bass': 'bass guitar',
    'electric bass': 'bass guitar',
    'drums': 'drums',
    'drum': 'drums',
    'percussion': 'percussion',
    'keys': 'keyboards',
    'keyboard': 'keyboards',
    'piano': 'piano',
    'synth': 'synthesizer',
    'synths': 'synthesizer',

    // Vocal variations - preserve lead/backing distinction
    'vox': 'vocals',
    'vocal': 'vocals',
    'voice': 'vocals',
    'singing': 'vocals',
    'lead vocal': 'lead vocals',
    'lead vox': 'lead vocals',
    // Note: 'lead vocals' stays as-is (no mapping needed)
    'backing vocals': 'backing vocals',
    'background vocals': 'backing vocals',
    'harmony vocals': 'backing vocals',
    'backup vocals': 'backing vocals',
    'bvs': 'backing vocals',

    // Production/engineering
    'producer': 'producer',
    'prod': 'producer',
    'production': 'producer',
    'engineer': 'engineer',
    'recording engineer': 'engineer',
    'mixing engineer': 'mixing',
    'mix': 'mixing',
    'mastering engineer': 'mastering',
    'master': 'mastering',

    // Writing/composition roles
    'songwriter': 'songwriter',
    'writer': 'songwriter',
    'lyricist': 'lyrics',
    'words': 'lyrics',
    'text': 'lyrics',
    'libretto': 'lyrics',
    'composition': 'music',
    'composer': 'composer',
    'arranger': 'arrangement',
    'arrangement': 'arrangement',
    'orchestration': 'arrangement',
    'adapted by': 'arrangement',
};

/**
 * Normalize a single role value
 *
 * @param {string} role - Raw role value
 * @returns {string} Normalized role value
 */
export function normalizeRole(role) {
    if (!role || typeof role !== 'string') {
        return null;
    }

    // Trim whitespace and convert to lowercase
    let normalized = role.trim().toLowerCase();

    // Skip empty strings
    if (!normalized) {
        return null;
    }

    // Apply synonym mapping if exists
    if (ROLE_SYNONYMS[normalized]) {
        normalized = ROLE_SYNONYMS[normalized];
    }

    return normalized;
}

/**
 * Split a comma/semicolon-separated role string into individual roles
 * Handles strings like "drums, backing vocals" or "guitar; bass"
 *
 * @param {string} roleString - Role string potentially containing multiple roles
 * @returns {string[]} Array of individual role strings (not yet normalized)
 */
export function splitRoleString(roleString) {
    if (!roleString || typeof roleString !== 'string') {
        return [];
    }

    // Split on comma or semicolon, trim each part
    return roleString
        .split(/[,;]/)
        .map(r => r.trim())
        .filter(r => r.length > 0);
}

/**
 * Normalize an array of role values
 *
 * @param {string[]} roles - Array of raw role values
 * @returns {string[]} Array of normalized, deduplicated role values
 */
export function normalizeRoles(roles) {
    if (!Array.isArray(roles)) {
        return [];
    }

    const normalized = roles
        .map(normalizeRole)
        .filter(r => r !== null);

    // Deduplicate
    return [...new Set(normalized)];
}

/**
 * Normalize a single role or array of roles
 * Handles comma-separated role strings like "drums, backing vocals"
 *
 * @param {string|string[]} roleOrRoles - Single role, comma-separated string, or array of roles
 * @returns {string[]} Array of normalized role values
 */
export function normalizeRoleInput(roleOrRoles) {
    if (Array.isArray(roleOrRoles)) {
        // Flatten in case any array element contains comma-separated roles
        const expanded = roleOrRoles.flatMap(r =>
            typeof r === 'string' ? splitRoleString(r) : []
        );
        return normalizeRoles(expanded);
    }

    if (typeof roleOrRoles === 'string') {
        // Split comma-separated roles and normalize each
        const parts = splitRoleString(roleOrRoles);
        return normalizeRoles(parts);
    }

    return [];
}

export default {
    normalizeRole,
    normalizeRoles,
    normalizeRoleInput,
    splitRoleString,
    ROLE_SYNONYMS
};
