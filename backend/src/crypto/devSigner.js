/**
 * Development Signer (DEV/TEST ONLY)
 *
 * Provides server-side event signing for development and smoke testing.
 *
 * WARNING: This module is for development/testing only!
 * - NEVER use in production
 * - NEVER commit real private keys to version control
 * - Only enabled when DEV_SIGNER_PRIVATE_KEY is set and NODE_ENV !== 'production'
 *
 * In production, signing should happen client-side with user's wallet/keys.
 */

import { createHash } from 'crypto';
import stringify from 'fast-json-stable-stringify';
import { PrivateKey } from 'eosjs/dist/eosjs-key-conversions.js';

/**
 * Dev Signer class
 * Handles server-side signing for development/testing
 */
export class DevSigner {
    constructor(privateKeyWif = null) {
        this.enabled = false;
        this.privateKey = null;
        this.publicKey = null;

        // Only allow in non-production environments
        if (process.env.NODE_ENV === 'production') {
            console.warn('⚠️  DevSigner disabled: Cannot use in production');
            return;
        }

        // Try to initialize from provided key or environment
        const keyWif = privateKeyWif || process.env.DEV_SIGNER_PRIVATE_KEY;

        if (!keyWif) {
            console.log('ℹ️  DevSigner disabled: No DEV_SIGNER_PRIVATE_KEY provided');
            return;
        }

        try {
            this.privateKey = PrivateKey.fromString(keyWif);
            this.publicKey = this.privateKey.getPublicKey().toString();
            this.enabled = true;

            console.log(`✓ DevSigner initialized (pubkey: ${this.publicKey.substring(0, 20)}...)`);
        } catch (error) {
            console.error(`❌ DevSigner initialization failed: ${error.message}`);
            this.enabled = false;
        }
    }

    /**
     * Check if dev signer is enabled and ready
     * @returns {boolean}
     */
    isEnabled() {
        return this.enabled && this.privateKey !== null;
    }

    /**
     * Get the public key associated with the dev signer
     * @returns {string|null} Public key in EOSIO format (EOS...) or null if disabled
     */
    getPublicKey() {
        return this.publicKey;
    }

    /**
     * Sign a canonical payload string
     *
     * @param {string} canonicalPayload - Canonical JSON string to sign
     * @returns {Object} { sig, author_pubkey }
     * @throws {Error} If signer is not enabled or signing fails
     */
    signCanonicalPayload(canonicalPayload) {
        if (!this.isEnabled()) {
            throw new Error('DevSigner not enabled. Set DEV_SIGNER_PRIVATE_KEY and ensure NODE_ENV !== production');
        }

        if (typeof canonicalPayload !== 'string' || canonicalPayload.length === 0) {
            throw new Error('canonicalPayload must be a non-empty string');
        }

        try {
            // Hash the canonical payload
            const payloadHash = createHash('sha256')
                .update(canonicalPayload)
                .digest();

            // Sign the hash
            const signature = this.privateKey.sign(payloadHash);

            return {
                sig: signature.toString(),
                author_pubkey: this.publicKey
            };
        } catch (error) {
            throw new Error(`Signing failed: ${error.message}`);
        }
    }

    /**
     * Sign an event object (creates canonical payload internally)
     *
     * @param {Object} event - Event object to sign (without sig field)
     * @returns {Object} Event with sig and author_pubkey added
     * @throws {Error} If signer is not enabled or signing fails
     */
    signEvent(event) {
        if (!this.isEnabled()) {
            throw new Error('DevSigner not enabled');
        }

        if (!event || typeof event !== 'object') {
            throw new Error('Event must be an object');
        }

        // Remove sig if present (should not be, but be safe)
        const { sig, ...eventWithoutSig } = event;

        // Create canonical payload
        const canonicalPayload = stringify(eventWithoutSig);

        // Sign
        const { sig: signature, author_pubkey } = this.signCanonicalPayload(canonicalPayload);

        // Return event with signature
        return {
            ...eventWithoutSig,
            author_pubkey,
            sig: signature
        };
    }
}

/**
 * Singleton instance (initialized lazily)
 */
let devSignerInstance = null;

/**
 * Get or create the dev signer singleton
 * @returns {DevSigner}
 */
export function getDevSigner() {
    if (!devSignerInstance) {
        devSignerInstance = new DevSigner();
    }
    return devSignerInstance;
}

export default DevSigner;
