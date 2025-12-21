/**
 * Transaction Builder for Polaris Music Registry
 *
 * Packages release data into blockchain transaction actions
 * for submission via WharfKit
 */

import CryptoJS from 'crypto-js';

export class TransactionBuilder {
    constructor(config = {}) {
        this.config = {
            contractAccount: config.contractAccount || 'polaris',
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
     * Build blockchain transaction action for anchoring event
     * @param {string} eventHash - SHA-256 hash of event
     * @param {string} authorAccount - Author's blockchain account name
     * @param {Object} metadata - Additional metadata
     * @returns {Object} Transaction action for WharfKit
     */
    buildAnchorAction(eventHash, authorAccount, metadata = {}) {
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
                hash: eventHash,
                parent: metadata.parent || '',
                ts: metadata.timestamp || Math.floor(Date.now() / 1000),
                tags: metadata.tags || ['release']
            }
        };
    }

    /**
     * Build complete transaction for release submission
     * Combines event creation, hashing, and blockchain action
     *
     * @param {Object} releaseData - Release bundle from form
     * @param {string} authorAccount - Author's blockchain account
     * @param {string} authorPubkey - Author's public key
     * @param {Array} sourceLinks - Source attribution links
     * @returns {Object} Complete transaction package
     */
    buildReleaseTransaction(releaseData, authorAccount, authorPubkey, sourceLinks = []) {
        // 1. Create event structure
        const event = this.buildReleaseBundleEvent(releaseData, authorPubkey, sourceLinks);

        // 2. Calculate event hash
        const eventHash = this.calculateEventHash(event);

        // 3. Build blockchain action
        const action = this.buildAnchorAction(eventHash, authorAccount, {
            tags: ['release', 'submission']
        });

        // 4. Return complete package
        return {
            event,
            eventHash,
            action,
            transaction: {
                actions: [action]
            }
        };
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
