/**
 * Smoke tests - critical functionality verification
 *
 * These tests catch catastrophic bugs like hash collisions.
 * If these fail, the entire system is broken.
 */

import EventStore from '../src/storage/eventStore.js';

describe('Smoke Tests - Critical Functionality', () => {
    let eventStore;

    beforeAll(() => {
        // Create EventStore with minimal config (no actual storage needed for hash tests)
        eventStore = new EventStore({
            ipfs: null,
            s3: null,
            redis: null
        });
    });

    describe('Event Hashing - CRITICAL', () => {
        test('Different nested data produces different hashes (prevents hash collisions)', () => {
            // This test catches the catastrophic bug where JSON.stringify(obj, keys.sort())
            // drops nested keys, causing all events to have the same hash

            const event1 = {
                v: 1,
                type: 'CREATE_RELEASE_BUNDLE',
                author_pubkey: 'test_pubkey',
                created_at: 1234567890,
                parents: [],
                body: {
                    release: {
                        name: 'Test Album'
                    },
                    tracklist: [
                        { title: 'Track 1', duration: 180 }
                    ]
                },
                sig: 'signature1'
            };

            const event2 = {
                v: 1,
                type: 'CREATE_RELEASE_BUNDLE',
                author_pubkey: 'test_pubkey',
                created_at: 1234567890,
                parents: [],
                body: {
                    release: {
                        name: 'Test Album'
                    },
                    tracklist: [
                        { title: 'Track 2', duration: 200 } // DIFFERENT NESTED DATA
                    ]
                },
                sig: 'signature2'
            };

            const hash1 = eventStore.calculateHash(event1);
            const hash2 = eventStore.calculateHash(event2);

            // CRITICAL: These MUST be different
            expect(hash1).not.toBe(hash2);
            expect(hash1).toHaveLength(64); // SHA256 hex length
            expect(hash2).toHaveLength(64);
        });

        test('Same data produces same hash (deterministic)', () => {
            const event = {
                v: 1,
                type: 'CREATE_RELEASE_BUNDLE',
                author_pubkey: 'test_pubkey',
                created_at: 1234567890,
                parents: [],
                body: {
                    release: { name: 'Album' },
                    tracklist: [{ title: 'Track', duration: 180 }]
                },
                sig: 'sig'
            };

            const hash1 = eventStore.calculateHash(event);
            const hash2 = eventStore.calculateHash(event);

            expect(hash1).toBe(hash2);
        });

        test('Signature excluded from hash (so event can be signed after hash)', () => {
            const eventWithSig1 = {
                v: 1,
                type: 'TEST',
                author_pubkey: 'pubkey',
                created_at: 1234567890,
                parents: [],
                body: { data: 'test' },
                sig: 'signature_A'
            };

            const eventWithSig2 = {
                v: 1,
                type: 'TEST',
                author_pubkey: 'pubkey',
                created_at: 1234567890,
                parents: [],
                body: { data: 'test' },
                sig: 'signature_B' // DIFFERENT SIGNATURE
            };

            const hash1 = eventStore.calculateHash(eventWithSig1);
            const hash2 = eventStore.calculateHash(eventWithSig2);

            // Hashes should be same despite different signatures
            expect(hash1).toBe(hash2);
        });

        test('Key order does not matter (canonical)', () => {
            const event1 = {
                v: 1,
                type: 'TEST',
                author_pubkey: 'pubkey',
                created_at: 1234567890,
                parents: [],
                body: { a: 1, b: 2, c: 3 },
                sig: 'sig'
            };

            const event2 = {
                body: { c: 3, a: 1, b: 2 }, // Different key order
                type: 'TEST',
                v: 1,
                created_at: 1234567890,
                author_pubkey: 'pubkey',
                sig: 'sig',
                parents: []
            };

            const hash1 = eventStore.calculateHash(event1);
            const hash2 = eventStore.calculateHash(event2);

            expect(hash1).toBe(hash2);
        });

        test('Deep nested objects are handled correctly', () => {
            const event1 = {
                v: 1,
                type: 'TEST',
                author_pubkey: 'pubkey',
                created_at: 1234567890,
                parents: [],
                body: {
                    level1: {
                        level2: {
                            level3: {
                                data: 'value_A'
                            }
                        }
                    }
                },
                sig: 'sig'
            };

            const event2 = {
                v: 1,
                type: 'TEST',
                author_pubkey: 'pubkey',
                created_at: 1234567890,
                parents: [],
                body: {
                    level1: {
                        level2: {
                            level3: {
                                data: 'value_B' // DIFFERENT DEEP VALUE
                            }
                        }
                    }
                },
                sig: 'sig'
            };

            const hash1 = eventStore.calculateHash(event1);
            const hash2 = eventStore.calculateHash(event2);

            expect(hash1).not.toBe(hash2);
        });
    });
});
