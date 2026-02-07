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

    describe('Unsigned Event Handling', () => {
        test('Accepts unsigned event when allowUnsigned is true', () => {
            const event = {
                v: 1,
                type: 'TEST_EVENT',
                author_pubkey: testPublicKey,
                created_at: 1234567890,
                body: { test: 'data' }
                // No signature
            };

            const result = verifyEventSignature(event, { allowUnsigned: true });

            expect(result.valid).toBe(true);
            expect(result.reason).toContain('UNSIGNED_EVENT_ALLOWED');
        });

        test('Rejects unsigned event when allowUnsigned is false (default)', () => {
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

        test('allowUnsigned does not bypass signature verification for signed events', () => {
            const event = createSignedEvent({ test: 'data' });

            // Tamper with event
            event.body.test = 'tampered';

            // allowUnsigned should not accept invalid signature (only missing signatures)
            const result = verifyEventSignature(event, { allowUnsigned: true });

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

        test('Rejects event with empty string signature', () => {
            const event = {
                v: 1,
                type: 'TEST_EVENT',
                author_pubkey: testPublicKey,
                created_at: 1234567890,
                body: { test: 'data' },
                sig: '' // Empty string (falsy)
            };

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Event signature missing');
        });

        test('Rejects event with empty string author_pubkey', () => {
            const event = createSignedEvent({ test: 'data' });
            event.author_pubkey = ''; // Empty string (falsy)

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Event author_pubkey missing');
        });

        test('Handles malformed public key gracefully', () => {
            const event = createSignedEvent({ test: 'data' });
            event.author_pubkey = 'NOT_A_VALID_PUBLIC_KEY_FORMAT';

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toContain('Signature verification error');
        });

        test('Handles truncated signature gracefully', () => {
            const event = createSignedEvent({ test: 'data' });
            event.sig = 'SIG_K1_'; // Truncated signature

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toContain('Signature verification error');
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

        test('Handles event with special characters in body', () => {
            const event = createSignedEvent({
                text: 'Special chars: 日本語 🎵 <script>alert("xss")</script>'
            });

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(true);
        });

        test('Handles event with very deep nesting', () => {
            const deepData = {
                level1: {
                    level2: {
                        level3: {
                            level4: {
                                level5: {
                                    value: 'deep'
                                }
                            }
                        }
                    }
                }
            };

            const event = createSignedEvent(deepData);
            const result = verifyEventSignature(event);

            expect(result.valid).toBe(true);
        });
    });

    // SEC-07: Additional negative tests for enhanced security coverage
    describe('Advanced Attack Scenarios', () => {
        test('Rejects signature replay attack (reusing signature for different event)', () => {
            const event1 = createSignedEvent({ message: 'Original message' });
            const event2 = createSignedEvent({ message: 'Different message' });

            // Attempt to reuse signature from event1 on event2
            event2.sig = event1.sig;

            const result = verifyEventSignature(event2);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Signature verification failed');
        });

        test('Rejects signature with modified case (case sensitivity)', () => {
            const event = createSignedEvent({ test: 'data' });

            // Modify signature case (if it contains hex characters)
            const originalSig = event.sig;
            event.sig = originalSig.split('').map((char, idx) => {
                if (idx > 10 && idx < 20 && char >= 'A' && char <= 'F') {
                    return char.toLowerCase();
                } else if (idx > 10 && idx < 20 && char >= 'a' && char <= 'f') {
                    return char.toUpperCase();
                }
                return char;
            }).join('');

            // Only test if signature was actually modified
            if (event.sig !== originalSig) {
                const result = verifyEventSignature(event);
                expect(result.valid).toBe(false);
            }
        });

        test('Rejects signature with extra characters appended', () => {
            const event = createSignedEvent({ test: 'data' });
            event.sig = event.sig + '00';

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toContain('Signature verification error');
        });

        test('Rejects signature with characters removed', () => {
            const event = createSignedEvent({ test: 'data' });
            event.sig = event.sig.substring(0, event.sig.length - 5);

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toContain('Signature verification error');
        });

        test('Rejects signature from wrong elliptic curve', () => {
            const event = createSignedEvent({ test: 'data' });

            // Replace with a Bitcoin-style signature prefix (wrong curve)
            event.sig = 'SIG_BTC_' + event.sig.substring(8);

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toContain('Signature verification error');
        });

        test('Handles concurrent modifications correctly', () => {
            const event = createSignedEvent({ field1: 'value1', field2: 'value2' });

            // Multiple tampering attempts
            event.body.field1 = 'tampered1';
            event.body.field2 = 'tampered2';
            event.created_at += 100;

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Signature verification failed');
        });

        test('Rejects event with zero-byte signature', () => {
            const event = createSignedEvent({ test: 'data' });
            event.sig = '\x00\x00\x00';

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toContain('Signature verification error');
        });

        test('Rejects event with signature containing control characters', () => {
            const event = createSignedEvent({ test: 'data' });
            event.sig = 'SIG_K1_\n\r\t' + event.sig.substring(10);

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toContain('Signature verification error');
        });

        test('Handles large payload correctly', () => {
            // Create a large event body (10KB of data)
            const largeData = {
                tracks: Array.from({ length: 100 }, (_, i) => ({
                    title: `Track ${i}`.padEnd(100, 'x'),
                    metadata: { index: i, data: 'x'.repeat(50) }
                }))
            };

            const event = createSignedEvent(largeData);
            const result = verifyEventSignature(event);

            expect(result.valid).toBe(true);
        });

        test('Detects subtle tampering in deeply nested arrays', () => {
            const event = createSignedEvent({
                items: [
                    [1, 2, 3],
                    [4, 5, 6],
                    [7, 8, 9]
                ]
            });

            // Subtle change deep in array
            event.body.items[1][1] = 99;

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Signature verification failed');
        });

        test('Rejects event with swapped public key and signature from same keypair', () => {
            // Create two events with different keypairs
            const event1 = createSignedEvent({ message: 'Event 1' });

            const otherPrivateKey = PrivateKey.fromString('5KYZdUEo39z3FPrtuX2QbbwGnNP5zTd7yyr2SC1j299sBCnWjss');
            const otherPublicKey = otherPrivateKey.getPublicKey().toString();

            // Create event2 with different key
            const canonicalPayload = stringify({
                v: 1,
                type: 'TEST_EVENT',
                author_pubkey: otherPublicKey,
                created_at: Math.floor(Date.now() / 1000),
                parents: [],
                body: { message: 'Event 2' }
            });
            const payloadHash = createHash('sha256').update(canonicalPayload).digest();
            const event2Sig = otherPrivateKey.sign(payloadHash).toString();

            // Try to use event2's signature with event1's data and event2's pubkey
            event1.author_pubkey = otherPublicKey;
            event1.sig = event2Sig;

            const result = verifyEventSignature(event1);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('Signature verification failed');
        });

        test('Rejects event with numeric signature', () => {
            const event = createSignedEvent({ test: 'data' });
            event.sig = 123456;

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toContain('Signature verification error');
        });

        test('Rejects event with object as signature', () => {
            const event = createSignedEvent({ test: 'data' });
            event.sig = { signature: 'fake' };

            const result = verifyEventSignature(event);

            expect(result.valid).toBe(false);
            expect(result.reason).toContain('Signature verification error');
        });
    });
});
