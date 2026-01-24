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

    // Vocal variations
    'vox': 'vocals',
    'vocal': 'vocals',
    'voice': 'vocals',
    'singing': 'vocals',
    'lead vocals': 'vocals',
    'lead vocal': 'vocals',
    'backing vocals': 'backing vocals',
    'background vocals': 'backing vocals',
    'harmony vocals': 'backing vocals',

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

    // Other common roles
    'songwriter': 'songwriter',
    'writer': 'songwriter',
    'composer': 'composer',
    'arranger': 'arranger',
    'arrangement': 'arranger',
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
 * Convenience function that handles both cases
 *
 * @param {string|string[]} roleOrRoles - Single role or array of roles
 * @returns {string[]} Array of normalized role values
 */
export function normalizeRoleInput(roleOrRoles) {
    if (Array.isArray(roleOrRoles)) {
        return normalizeRoles(roleOrRoles);
    }

    const normalized = normalizeRole(roleOrRoles);
    return normalized ? [normalized] : [];
}

export default {
    normalizeRole,
    normalizeRoles,
    normalizeRoleInput,
    ROLE_SYNONYMS
};
