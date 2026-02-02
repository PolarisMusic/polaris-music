/**
 * Event Signature Verification
 *
 * Verifies cryptographic signatures on events to ensure:
 * - Authorship: Event was signed by claimed author_pubkey
 * - Integrity: Event content has not been tampered with
 * - Non-repudiation: Author cannot deny creating the event
 *
 * Signing payload: Canonical JSON of event excluding the signature field
 */

import { createHash } from 'crypto';
import stringify from 'fast-json-stable-stringify';
import { PublicKey, Signature } from 'eosjs/dist/eosjs-key-conversions.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('crypto.verifySignature');

/**
 * Verify an event's signature against its author_pubkey
 *
 * @param {Object} event - Event to verify
 * @param {Object} options - Verification options
 * @param {boolean} options.requireSignature - If true, reject unsigned events (default: true)
 * @param {boolean} options.allowUnsigned - If true, allow unsigned events (default: false, only for testing)
 * @returns {Object} Verification result { valid: boolean, reason?: string }
 */
export function verifyEventSignature(event, options = {}) {
    const {
        requireSignature = true,
        allowUnsigned = false
    } = options;

    const timer = log.startTimer();

    // Explicit bypass: allow unsigned events ONLY when explicitly enabled
    // This requires setting ALLOW_UNSIGNED_EVENTS=true environment variable
    // DO NOT use in production - undermines verifiability guarantees
    if (allowUnsigned && (!event.sig || !event.author_pubkey)) {
        log.warn('unsigned_event_bypass', { has_sig: !!event?.sig, has_pubkey: !!event?.author_pubkey });
        return {
            valid: true,
            reason: 'UNSIGNED_EVENT_ALLOWED: Bypassing signature verification (testing only!)'
        };
    }

    // Validate event structure
    if (!event || typeof event !== 'object') {
        log.error('verify_fail', { reason: 'not_an_object' });
        return { valid: false, reason: 'Event must be an object' };
    }

    // Check for signature
    if (!event.sig) {
        if (requireSignature) {
            log.error('verify_fail', { reason: 'missing_sig' });
            return { valid: false, reason: 'Event signature missing' };
        }
        return { valid: true, reason: 'Signature not required' };
    }

    // Check for author_pubkey
    if (!event.author_pubkey) {
        log.error('verify_fail', { reason: 'missing_pubkey' });
        return { valid: false, reason: 'Event author_pubkey missing' };
    }

    try {
        // Create canonical payload (exclude signature)
        const { sig, ...eventWithoutSig } = event;
        const canonicalPayload = stringify(eventWithoutSig);

        // Hash the canonical payload
        const payloadHash = createHash('sha256')
            .update(canonicalPayload)
            .digest();

        // Parse public key (EOSIO format: EOS...)
        const publicKey = PublicKey.fromString(event.author_pubkey);

        // Parse signature (EOSIO format: SIG_K1_...)
        const signature = Signature.fromString(event.sig);

        // Verify signature
        const isValid = signature.verify(payloadHash, publicKey);

        if (!isValid) {
            timer.endError('verify_fail', {
                reason: 'bad_sig',
                pubkey: event.author_pubkey.substring(0, 12) + '...'
            });
            return { valid: false, reason: 'Signature verification failed' };
        }

        timer.end('verify_pass', {});
        return { valid: true };

    } catch (error) {
        timer.endError('verify_fail', {
            reason: error.message.includes('parse') ? 'pubkey_parse_fail' : 'verify_error',
            error: error.message
        });
        return {
            valid: false,
            reason: `Signature verification error: ${error.message}`
        };
    }
}

/**
 * Verify event signature and throw on failure
 *
 * Convenience wrapper that throws instead of returning result object
 *
 * @param {Object} event - Event to verify
 * @param {Object} options - Verification options
 * @throws {Error} If signature is invalid
 */
export function verifyEventSignatureOrThrow(event, options = {}) {
    const result = verifyEventSignature(event, options);

    if (!result.valid) {
        throw new Error(`Invalid event signature: ${result.reason}`);
    }

    return true;
}

/**
 * Create signing payload for an event (for reference/testing)
 *
 * This shows what needs to be signed to create a valid signature.
 * The actual signing should happen client-side with the user's private key.
 *
 * @param {Object} event - Event without signature
 * @returns {Buffer} SHA256 hash of canonical payload to sign
 */
export function createSigningPayload(event) {
    // Remove signature if present
    const { sig, ...eventWithoutSig } = event;

    // Create canonical representation
    const canonicalPayload = stringify(eventWithoutSig);

    // Hash for signing
    return createHash('sha256')
        .update(canonicalPayload)
        .digest();
}

export default verifyEventSignature;
