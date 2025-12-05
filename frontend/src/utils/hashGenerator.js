/**
 * Generate deterministic hashes for entity IDs
 * Uses SHA-256 to create consistent identifiers
 */

import CryptoJS from 'crypto-js';

export class HashGenerator {
    /**
     * Generate a hash for an entity based on its properties
     * Creates deterministic IDs that will be the same for identical data
     */
    static generateHash(data) {
        // Canonicalize the data (sort keys, remove whitespace)
        const canonical = this.canonicalize(data);
        // Generate SHA-256 hash
        const hash = CryptoJS.SHA256(canonical);
        return hash.toString(CryptoJS.enc.Hex);
    }

    /**
     * Canonicalize data for deterministic hashing
     */
    static canonicalize(obj) {
        if (obj === null || obj === undefined) {
            return JSON.stringify(obj);
        }

        if (typeof obj !== 'object') {
            return JSON.stringify(obj);
        }

        if (Array.isArray(obj)) {
            return '[' + obj.map(item => this.canonicalize(item)).join(',') + ']';
        }

        // Sort object keys for determinism
        const sortedKeys = Object.keys(obj).sort();
        const pairs = sortedKeys.map(key => {
            return JSON.stringify(key) + ':' + this.canonicalize(obj[key]);
        });

        return '{' + pairs.join(',') + '}';
    }

    /**
     * Generate a person ID from name and optional birth data
     */
    static generatePersonId(name, city = null) {
        const data = { type: 'person', name: name.toLowerCase().trim() };
        if (city) {
            data.city = city;
        }
        return this.generateHash(data);
    }

    /**
     * Generate a group ID from name
     */
    static generateGroupId(name) {
        return this.generateHash({ type: 'group', name: name.toLowerCase().trim() });
    }

    /**
     * Generate a label ID from name and city
     */
    static generateLabelId(name, city = null) {
        const data = { type: 'label', name: name.toLowerCase().trim() };
        if (city) {
            data.city = city;
        }
        return this.generateHash(data);
    }

    /**
     * Generate a city ID from name and coordinates
     */
    static generateCityId(name, lat = null, long = null) {
        const data = { type: 'city', name: name.toLowerCase().trim() };
        if (lat !== null && long !== null) {
            data.lat = lat;
            data.long = long;
        }
        return this.generateHash(data);
    }

    /**
     * Generate a role ID from role name
     */
    static generateRoleId(roleName) {
        return this.generateHash({ type: 'role', name: roleName.toLowerCase().trim() });
    }

    /**
     * Generate a track ID from title and other properties
     */
    static generateTrackId(title, groupName = null) {
        const data = { type: 'track', title: title.toLowerCase().trim() };
        if (groupName) {
            data.group = groupName.toLowerCase().trim();
        }
        return this.generateHash(data);
    }
}
