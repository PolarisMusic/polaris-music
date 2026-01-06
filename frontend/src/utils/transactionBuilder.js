/**
 * Transaction Builder for Polaris Music Registry
 *
 * Packages release data into blockchain transaction actions
 * for submission via WharfKit
 */

import CryptoJS from 'crypto-js';
import { CONTRACT_ACCOUNT } from '../config/chain.js';

export class TransactionBuilder {
    constructor(config = {}) {
        // Use centralized chain config (prevents config drift with WalletManager)
        const contractAccount = config.contractAccount || CONTRACT_ACCOUNT;

        this.config = {
            contractAccount,
            ...config
        };
    }

    /**
     * Build CREATE_RELEASE_BUNDLE event structure
     * @param {Object} releaseData - Release bundle data from form
     * @param {string} authorPubkey - Author's public key from wallet
     * @param {Array} sourceLinks - Source attribution links
     * @returns {Object} Event structure ready for signing
     */
    buildReleaseBundleEvent(releaseData, authorPubkey, sourceLinks = []) {
        const event = {
            v: 1,
            type: 'CREATE_RELEASE_BUNDLE',
            author_pubkey: authorPubkey,
            created_at: Math.floor(Date.now() / 1000),
            parents: [],
            body: {
                release: releaseData.release,
                tracklist: releaseData.tracklist || []
            },
            proofs: {
                source_links: sourceLinks
            }
        };

        return event;
    }

    /**
     * Calculate SHA-256 hash of canonical event
     * @param {Object} event - Event object
     * @returns {string} Hex-encoded SHA-256 hash
     */
    calculateEventHash(event) {
        // Canonicalize the event (deterministic JSON)
        const canonical = this.canonicalizeJSON(event);

        // Calculate SHA-256 hash
        const hash = CryptoJS.SHA256(canonical);
        return hash.toString(CryptoJS.enc.Hex);
    }

    /**
     * Canonicalize JSON for deterministic hashing
     * Simple implementation - in production, use RFC 8785
     * @param {Object} obj - Object to canonicalize
     * @returns {string} Canonical JSON string
     */
    canonicalizeJSON(obj) {
        // Sort keys recursively and stringify
        const sortedObj = this.sortKeysDeep(obj);
        return JSON.stringify(sortedObj);
    }

    /**
     * Recursively sort object keys
     * @param {*} obj - Object to sort
     * @returns {*} Object with sorted keys
     */
    sortKeysDeep(obj) {
        if (Array.isArray(obj)) {
            return obj.map(item => this.sortKeysDeep(item));
        } else if (obj !== null && typeof obj === 'object') {
            return Object.keys(obj)
                .sort()
                .reduce((result, key) => {
                    result[key] = this.sortKeysDeep(obj[key]);
                    return result;
                }, {});
        }
        return obj;
    }

    /**
     * Convert hex string to checksum256 format (array of hex pairs)
     * @param {string} hexString - Hex string (64 characters)
     * @returns {string} Checksum256 format for blockchain
     */
    hexToChecksum256(hexString) {
        // Remove any 0x prefix
        const hex = hexString.replace(/^0x/, '');

        // Ensure it's 64 characters (32 bytes)
        if (hex.length !== 64) {
            throw new Error('Hash must be 64 hex characters (32 bytes)');
        }

        return hex.toLowerCase();
    }

    /**
     * Convert tag strings to valid blockchain name types
     * Names must be 3-12 characters, lowercase a-z, 1-5, and dots
     * @param {Array<string>} tags - Tag strings
     * @returns {Array<string>} Valid blockchain names (deduplicated)
     */
    sanitizeTags(tags) {
        const sanitized = tags.map(tag => {
            // Convert to lowercase, remove invalid characters, truncate to 12
            const cleaned = tag
                .toLowerCase()
                .replace(/[^a-z1-5.]/g, '')
                .slice(0, 12);

            // Enforce minimum length of 3 to prevent contract rejection
            // Replace invalid/too-short tags with 'tag' (deterministic)
            if (cleaned.length < 3) {
                return 'tag';
            }

            return cleaned;
        }).filter(tag => tag.length >= 3 && tag.length <= 12);

        // Deduplicate and return
        return Array.from(new Set(sanitized));
    }

    /**
     * Build blockchain transaction action for anchoring event
     * @param {string} eventHash - SHA-256 hash of event
     * @param {string} authorAccount - Author's blockchain account name
     * @param {Object} metadata - Additional metadata
     * @returns {Object} Transaction action for WharfKit
     */
    buildAnchorAction(eventHash, authorAccount, metadata = {}) {
        // Convert hash to proper checksum256 format
        const hash = this.hexToChecksum256(eventHash);

        // Sanitize tags to valid blockchain names
        const tags = this.sanitizeTags(metadata.tags || ['release']);

        return {
            account: this.config.contractAccount,
            name: 'put',
            authorization: [{
                actor: authorAccount,
                permission: 'active'
            }],
            data: {
                author: authorAccount,
                type: 21, // CREATE_RELEASE_BUNDLE event type
                hash: hash,
                parent: metadata.parent || null, // Use null for optional, not empty string
                ts: metadata.timestamp || Math.floor(Date.now() / 1000),
                tags: tags
            }
        };
    }

    /**
     * Build complete transaction for release submission
     * NOTE: This method builds the event WITHOUT calculating the hash.
     * The hash must be obtained from the server via /api/events/prepare
     * to ensure it matches the canonical normalized hash.
     *
     * @param {Object} releaseData - Release bundle from form
     * @param {string} authorAccount - Author's blockchain account
     * @param {string} authorPubkey - Author's public key
     * @param {Array} sourceLinks - Source attribution links
     * @returns {Object} Transaction package WITHOUT eventHash (call prepareEvent to get hash)
     */
    buildReleaseTransaction(releaseData, authorAccount, authorPubkey, sourceLinks = []) {
        // 1. Create event structure (without sig)
        const event = this.buildReleaseBundleEvent(releaseData, authorPubkey, sourceLinks);

        // 2. Hash will be obtained from server via /api/events/prepare
        // This ensures the hash matches the canonical normalized version

        // 3. Return event and author account (hash and action will be built after prepare)
        return {
            event,
            authorAccount,
            // eventHash will be set after calling /api/events/prepare
            // action will be built after getting hash from server
        };
    }

    /**
     * Build blockchain action after receiving canonical hash from server
     * @param {string} eventHash - Canonical hash from /api/events/prepare
     * @param {string} authorAccount - Author's blockchain account
     * @returns {Object} Blockchain action for anchoring
     */
    buildActionFromHash(eventHash, authorAccount) {
        return this.buildAnchorAction(eventHash, authorAccount, {
            tags: ['release', 'submission']
        });
    }

    /**
     * Validate release data has all required fields
     * @param {Object} releaseData - Release data to validate
     * @returns {Object} { valid: boolean, errors: string[] }
     */
    validateReleaseData(releaseData) {
        const errors = [];

        // Validate release object exists
        if (!releaseData.release) {
            errors.push('Release object is required');
            return { valid: false, errors };
        }

        const release = releaseData.release;

        // Required fields based on screenshot
        if (!release.release_name || release.release_name.trim() === '') {
            errors.push('Project Name is required');
        }

        // At least one track required
        if (!release.tracks || release.tracks.length === 0) {
            errors.push('At least one track/song is required');
        } else {
            // Validate each track
            release.tracks.forEach((track, index) => {
                if (!track.title || track.title.trim() === '') {
                    errors.push(`Track ${index + 1}: Song Name is required`);
                }

                // Check for groups
                if (!track.groups || track.groups.length === 0) {
                    errors.push(`Track ${index + 1}: At least one Group is required`);
                }

                // Check for songwriters
                if (!track.songwriters || track.songwriters.length === 0) {
                    errors.push(`Track ${index + 1}: At least one Songwriter is required`);
                }
            });
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }
}

export const transactionBuilder = new TransactionBuilder();
