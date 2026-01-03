/**
 * Signature Verification Tests
 *
 * Tests cryptographic signature verification for events.
 * Ensures authorship and integrity guarantees.
 */

import {
    verifyEventSignature,
    verifyEventSignatureOrThrow,
    createSigningPayload
} from '../../src/crypto/verifyEventSignature.js';
import { PrivateKey } from 'eosjs/dist/eosjs-key-conversions.js';
import stringify from 'fast-json-stable-stringify';
import { createHash } from 'crypto';

describe('Event Signature Verification', () => {
    // Test keypair (for testing only - never use in production!)
    const testPrivateKey = PrivateKey.fromString('5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3');
    const testPublicKey = testPrivateKey.getPublicKey().toString();

    /**
     * Helper: Create a signed test event
     */
    function createSignedEvent(eventData) {
        const event = {
            v: 1,
            type: 'TEST_EVENT',
            author_pubkey: testPublicKey,
            created_at: Math.floor(Date.now() / 1000),
            parents: [],
            body: eventData || { test: 'data' }
        };

        // Create canonical payload (without sig)
        const canonicalPayload = stringify(event);
        const payloadHash = createHash('sha256').update(canonicalPayload).digest();

        // Sign with private key
        const signature = testPrivateKey.sign(payloadHash);

        return {
            ...event,
            sig: signature.toString()
        };
    }

    describe('Valid Signatures', () => {
        test('Accepts event with valid signature', () => {
            const event = createSignedEvent({ message: 'Hello World' });

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(true);
            expect(result.reason).toBeUndefined();
        });

        test('Accepts event with valid signature (complex nested data)', () => {
            const complexData = {
                release: {
                    name: 'Test Album',
                    tracks: [
                        { title: 'Track 1', duration: 180 },
                        { title: 'Track 2', duration: 200 }
                    ]
                },
                metadata: {
                    source: 'discogs',
                    confidence: 0.95
                }
            };

            const event = createSignedEvent(complexData);
            const result = verifyEventSignature(event);

            expect(result.valid).toBe(true);
        });

        test('verifyEventSignatureOrThrow succeeds for valid signature', () => {
            const event = createSignedEvent({ test: 'data' });

            expect(() => {
                verifyEventSignatureOrThrow(event);
            }).not.toThrow();
        });
    });

    describe('Invalid Signatures', () => {
        test('Rejects event with missing signature', () => {
            const event = {
                v: 1,
                type: 'TEST_EVENT',
                author_pubkey: testPublicKey,
                created_at: 1234567890,
                body: { test: 'data' }
            };

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Event signature missing');
        });

        test('Rejects event with missing author_pubkey', () => {
            const event = createSignedEvent({ test: 'data' });
            delete event.author_pubkey;

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Event author_pubkey missing');
        });

        test('Rejects event with invalid signature format', () => {
            const event = createSignedEvent({ test: 'data' });
            event.sig = 'INVALID_SIGNATURE';

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toContain('Signature verification error');
        });

        test('Rejects event with wrong public key', () => {
            const event = createSignedEvent({ test: 'data' });

            // Change public key to different key (use another valid test key)
            const otherPrivateKey = PrivateKey.fromString('5KYZdUEo39z3FPrtuX2QbbwGnNP5zTd7yyr2SC1j299sBCnWjss');
            event.author_pubkey = otherPrivateKey.getPublicKey().toString();

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Signature verification failed');
        });

        test('verifyEventSignatureOrThrow throws for invalid signature', () => {
            const event = createSignedEvent({ test: 'data' });
            event.sig = 'INVALID';

            expect(() => {
                verifyEventSignatureOrThrow(event);
            }).toThrow('Invalid event signature');
        });
    });

    describe('Tampering Detection', () => {
        test('Rejects event with tampered body', () => {
            const event = createSignedEvent({ message: 'Original message' });

            // Tamper with body after signing
            event.body.message = 'Tampered message';

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Signature verification failed');
        });

        test('Rejects event with added fields', () => {
            const event = createSignedEvent({ test: 'data' });

            // Add field after signing
            event.malicious_field = 'injected';

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Signature verification failed');
        });

        test('Rejects event with removed fields', () => {
            const event = createSignedEvent({ field1: 'a', field2: 'b' });

            // Remove field after signing
            delete event.body.field2;

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Signature verification failed');
        });

        test('Rejects event with modified timestamp', () => {
            const event = createSignedEvent({ test: 'data' });

            // Change timestamp after signing
            event.created_at = event.created_at + 3600;

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Signature verification failed');
        });

        test('Rejects event with modified nested data', () => {
            const event = createSignedEvent({
                release: {
                    name: 'Original Album',
                    tracks: [
                        { title: 'Track 1' }
                    ]
                }
            });

            // Tamper with nested data
            event.body.release.tracks[0].title = 'Tampered Track';

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Signature verification failed');
        });
    });

    describe('Dev Mode', () => {
        test('Accepts unsigned event in dev mode', () => {
            const event = {
                v: 1,
                type: 'TEST_EVENT',
                author_pubkey: testPublicKey,
                created_at: 1234567890,
                body: { test: 'data' }
                // No signature
            };

            const result = verifyEventSignature(event, { devMode: true });

            expect(result.valid).toBe(true);
            expect(result.reason).toContain('DEV_MODE');
        });

        test('Rejects unsigned event when dev mode is false (default)', () => {
            const event = {
                v: 1,
                type: 'TEST_EVENT',
                author_pubkey: testPublicKey,
                created_at: 1234567890,
                body: { test: 'data' }
                // No signature
            };

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Event signature missing');
        });

        test('Dev mode does not bypass signature verification for signed events', () => {
            const event = createSignedEvent({ test: 'data' });

            // Tamper with event
            event.body.test = 'tampered';

            // Dev mode should not accept invalid signature
            const result = verifyEventSignature(event, { devMode: true });

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Signature verification failed');
        });
    });

    describe('Optional Signature Mode', () => {
        test('Accepts unsigned event when requireSignature=false', () => {
            const event = {
                v: 1,
                type: 'TEST_EVENT',
                author_pubkey: testPublicKey,
                created_at: 1234567890,
                body: { test: 'data' }
                // No signature
            };

            const result = verifyEventSignature(event, { requireSignature: false });

            expect(result.valid).toBe(true);
            expect(result.reason).toBe('Signature not required');
        });
    });

    describe('Signing Payload Creation', () => {
        test('Creates consistent signing payload', () => {
            const event = {
                v: 1,
                type: 'TEST_EVENT',
                author_pubkey: testPublicKey,
                created_at: 1234567890,
                body: { test: 'data' }
            };

            const payload1 = createSigningPayload(event);
            const payload2 = createSigningPayload(event);

            expect(payload1).toEqual(payload2);
            expect(payload1).toBeInstanceOf(Buffer);
            expect(payload1.length).toBe(32); // SHA256 = 32 bytes
        });

        test('Signing payload excludes signature field', () => {
            const eventWithSig = createSignedEvent({ test: 'data' });
            const eventWithoutSig = { ...eventWithSig };
            delete eventWithoutSig.sig;

            const payload1 = createSigningPayload(eventWithSig);
            const payload2 = createSigningPayload(eventWithoutSig);

            expect(payload1).toEqual(payload2);
        });

        test('Signing payload changes when event data changes', () => {
            const event1 = {
                v: 1,
                type: 'TEST_EVENT',
                author_pubkey: testPublicKey,
                created_at: 1234567890,
                body: { test: 'data1' }
            };

            const event2 = {
                v: 1,
                type: 'TEST_EVENT',
                author_pubkey: testPublicKey,
                created_at: 1234567890,
                body: { test: 'data2' }
            };

            const payload1 = createSigningPayload(event1);
            const payload2 = createSigningPayload(event2);

            expect(payload1).not.toEqual(payload2);
        });
    });

    describe('Edge Cases', () => {
        test('Rejects null event', () => {
            const result = verifyEventSignature(null);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Event must be an object');
        });

        test('Rejects undefined event', () => {
            const result = verifyEventSignature(undefined);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Event must be an object');
        });

        test('Rejects non-object event', () => {
            const result = verifyEventSignature('not an object');

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Event must be an object');
        });

        test('Handles empty body correctly', () => {
            const event = createSignedEvent({});

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(true);
        });

        test('Handles event with null values', () => {
            const event = createSignedEvent({ field: null });

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(true);
        });
    });
});
