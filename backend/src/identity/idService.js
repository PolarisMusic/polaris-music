/**
 * Identity Service for Polaris Music Registry
 *
 * Manages canonical vs provisional ID generation and parsing.
 *
 * Core principles:
 * - Canonical IDs (CID) are stable forever - never change
 * - Provisional IDs (PID) are temporary during import - can be merged
 * - External IDs map to canonical IDs via IdentityMap
 *
 * ID Formats:
 * - Canonical: polaris:{type}:{uuid}
 * - Provisional: prov:{type}:{hash}
 * - External: {source}:{type}:{id}
 */

import { randomUUID } from 'crypto';
import { createHash } from 'crypto';

/**
 * Entity types supported by the identity system
 */
export const EntityType = {
    PERSON: 'person',
    GROUP: 'group',
    SONG: 'song',
    TRACK: 'track',
    RELEASE: 'release',
    MASTER: 'master',
    LABEL: 'label',
    CITY: 'city',
    SOURCE: 'source'
};

/**
 * ID kinds
 */
export const IDKind = {
    CANONICAL: 'canonical',
    PROVISIONAL: 'provisional',
    EXTERNAL: 'external'
};

/**
 * Identity Service
 */
export class IdentityService {
    /**
     * Generate a new canonical ID (stable forever)
     *
     * @param {string} entityType - Entity type (person, group, etc.)
     * @returns {string} Canonical ID (polaris:{type}:{uuid})
     */
    static mintCanonicalId(entityType) {
        if (!Object.values(EntityType).includes(entityType)) {
            throw new Error(`Invalid entity type: ${entityType}`);
        }

        // Use UUIDv4 (could switch to UUIDv7 for sortability)
        const uuid = randomUUID();
        return `polaris:${entityType}:${uuid}`;
    }

    /**
     * Generate a provisional ID from a fingerprint
     * Used during import when we don't know if entity already exists
     *
     * @param {string} entityType - Entity type
     * @param {Object} fingerprint - Key fields to hash
     * @returns {string} Provisional ID (prov:{type}:{hash})
     */
    static makeProvisionalId(entityType, fingerprint) {
        if (!Object.values(EntityType).includes(entityType)) {
            throw new Error(`Invalid entity type: ${entityType}`);
        }

        // Create deterministic hash from fingerprint
        const canonical = JSON.stringify(fingerprint, Object.keys(fingerprint).sort());
        const hash = createHash('sha256')
            .update(canonical)
            .digest('hex')
            .substring(0, 16); // Use first 16 chars for readability

        return `prov:${entityType}:${hash}`;
    }

    /**
     * Create an external ID reference
     *
     * @param {string} source - Source system (discogs, musicbrainz, etc.)
     * @param {string} externalType - Type in external system
     * @param {string} externalId - ID in external system
     * @returns {string} External ID reference
     */
    static makeExternalId(source, externalType, externalId) {
        return `${source}:${externalType}:${externalId}`;
    }

    /**
     * Parse an ID and determine its kind and components
     *
     * @param {string} id - ID to parse
     * @returns {Object} Parsed ID info
     */
    static parseId(id) {
        if (!id || typeof id !== 'string') {
            throw new Error('Invalid ID: must be a non-empty string');
        }

        const parts = id.split(':');

        if (parts.length < 3) {
            return {
                kind: IDKind.EXTERNAL,
                raw: id,
                valid: false
            };
        }

        const [prefix, entityType, ...rest] = parts;
        const identifier = rest.join(':'); // Handle IDs with multiple colons

        // Canonical ID
        if (prefix === 'polaris') {
            return {
                kind: IDKind.CANONICAL,
                entityType,
                uuid: identifier,
                raw: id,
                valid: this.isValidUUID(identifier)
            };
        }

        // Provisional ID
        if (prefix === 'prov') {
            return {
                kind: IDKind.PROVISIONAL,
                entityType,
                hash: identifier,
                raw: id,
                valid: /^[a-f0-9]{16}$/.test(identifier)
            };
        }

        // External ID
        return {
            kind: IDKind.EXTERNAL,
            source: prefix,
            externalType: entityType,
            externalId: identifier,
            raw: id,
            valid: true
        };
    }

    /**
     * Check if a string is a valid UUID
     *
     * @param {string} uuid - UUID to validate
     * @returns {boolean} True if valid UUID
     */
    static isValidUUID(uuid) {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return uuidRegex.test(uuid);
    }

    /**
     * Check if an ID is canonical
     *
     * @param {string} id - ID to check
     * @returns {boolean} True if canonical
     */
    static isCanonical(id) {
        const parsed = this.parseId(id);
        return parsed.kind === IDKind.CANONICAL && parsed.valid;
    }

    /**
     * Check if an ID is provisional
     *
     * @param {string} id - ID to check
     * @returns {boolean} True if provisional
     */
    static isProvisional(id) {
        const parsed = this.parseId(id);
        return parsed.kind === IDKind.PROVISIONAL;
    }

    /**
     * Check if an ID is external
     *
     * @param {string} id - ID to check
     * @returns {boolean} True if external
     */
    static isExternal(id) {
        const parsed = this.parseId(id);
        return parsed.kind === IDKind.EXTERNAL;
    }

    /**
     * Generate fingerprints for common entity types
     * These are used for provisional ID generation
     */

    /**
     * Generate person fingerprint
     *
     * @param {Object} data - Person data
     * @returns {Object} Fingerprint
     */
    static personFingerprint(data) {
        return {
            type: 'person',
            name: this.normalizeName(data.name || data.person_name),
            // Optional: birth year if known
            ...(data.birth_year && { birth_year: data.birth_year })
        };
    }

    /**
     * Generate group fingerprint
     *
     * @param {Object} data - Group data
     * @returns {Object} Fingerprint
     */
    static groupFingerprint(data) {
        return {
            type: 'group',
            name: this.normalizeName(data.name || data.group_name)
        };
    }

    /**
     * Generate song fingerprint
     *
     * @param {Object} data - Song data
     * @returns {Object} Fingerprint
     */
    static songFingerprint(data) {
        return {
            type: 'song',
            title: this.normalizeName(data.title || data.song_title),
            // Optional: include primary songwriter if known
            ...(data.primary_writer && { writer: this.normalizeName(data.primary_writer) })
        };
    }

    /**
     * Generate track fingerprint
     *
     * @param {Object} data - Track data
     * @returns {Object} Fingerprint
     */
    static trackFingerprint(data) {
        return {
            type: 'track',
            title: this.normalizeName(data.title || data.track_title),
            release: data.release_id,
            position: data.track_number || data.position
        };
    }

    /**
     * Generate release fingerprint
     *
     * @param {Object} data - Release data
     * @returns {Object} Fingerprint
     */
    static releaseFingerprint(data) {
        return {
            type: 'release',
            title: this.normalizeName(data.title || data.release_name),
            date: data.release_date || data.year,
            // Optional: catalog number if available
            ...(data.catalog_number && { catalog: data.catalog_number })
        };
    }

    /**
     * Normalize a name for fingerprinting
     * Removes common variations that shouldn't create different IDs
     *
     * @param {string} name - Name to normalize
     * @returns {string} Normalized name
     */
    static normalizeName(name) {
        if (!name) return '';

        return name
            .toLowerCase()
            .trim()
            // Remove "The" prefix
            .replace(/^the\s+/i, '')
            // Remove parenthetical disambiguators (e.g., "Bob Dylan (2)" from Discogs)
            .replace(/\s*\(\d+\)$/, '')
            // Normalize whitespace
            .replace(/\s+/g, ' ')
            // Remove common punctuation
            .replace(/[.,;:!?'"]/g, '');
    }
}

export default IdentityService;
