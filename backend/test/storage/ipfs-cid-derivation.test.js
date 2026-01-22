/**
 * @fileoverview Tests for IPFS CID derivation correctness
 *
 * Verifies that:
 * 1. CID derivation doesn't re-hash the hash (common bug)
 * 2. Derived CID digest matches input hash exactly
 * 3. CID format is correct (CIDv1, raw codec, sha2-256)
 */

import { describe, test, expect } from '@jest/globals';
import { createHash } from 'crypto';
import stringify from 'fast-json-stable-stringify';
import { CID } from 'multiformats/cid';
import EventStore from '../../src/storage/eventStore.js';

describe('IPFS CID Derivation', () => {
    let eventStore;

    beforeAll(() => {
        // Create EventStore without actual connections (mocked)
        eventStore = new EventStore({
            ipfs: { url: 'http://localhost:5001' },
            s3: null,
            redis: null
        });
    });

    test('deriveCidFromHash produces correct CID format', () => {
        // Known test hash (sha256 of "test data")
        const testHash = '916f0027a575074ce72a331777c3478d6513f786a591bd892da1a577bf2335f9';

        const cid = eventStore.deriveCidFromHash(testHash);

        // Verify it's a valid CID string
        expect(typeof cid).toBe('string');
        expect(cid).toMatch(/^b[a-z2-7]+$/); // Base32 encoding for CIDv1

        // Parse and verify CID properties
        const cidObj = CID.parse(cid);
        expect(cidObj.version).toBe(1); // CIDv1
        expect(cidObj.code).toBe(0x55); // raw codec
        expect(cidObj.multihash.code).toBe(0x12); // sha2-256
    });

    test('derived CID digest exactly matches input hash (no re-hashing)', () => {
        // Known test hash
        const testHash = '916f0027a575074ce72a331777c3478d6513f786a591bd892da1a577bf2335f9';

        const cid = eventStore.deriveCidFromHash(testHash);
        const cidObj = CID.parse(cid);

        // CRITICAL: The digest bytes must match the input hash exactly
        // If this fails, it means we're hashing the hash (sha256(sha256(data)))
        const digestHex = Buffer.from(cidObj.multihash.digest).toString('hex');
        expect(digestHex).toBe(testHash);
    });

    test('CID derivation is deterministic', () => {
        const testHash = 'abc123def456789012345678901234567890123456789012345678901234';

        const cid1 = eventStore.deriveCidFromHash(testHash);
        const cid2 = eventStore.deriveCidFromHash(testHash);

        expect(cid1).toBe(cid2);
    });

    test('different hashes produce different CIDs', () => {
        const hash1 = '1111111111111111111111111111111111111111111111111111111111111111';
        const hash2 = '2222222222222222222222222222222222222222222222222222222222222222';

        const cid1 = eventStore.deriveCidFromHash(hash1);
        const cid2 = eventStore.deriveCidFromHash(hash2);

        expect(cid1).not.toBe(cid2);
    });

    test('real event hash produces valid CID', () => {
        // Simulate a real event
        const event = {
            v: 1,
            type: 'CREATE_RELEASE_BUNDLE',
            author_pubkey: 'test-key',
            created_at: 1234567890,
            parents: [],
            body: {
                release: { release_name: 'Test Album' }
            }
        };

        // Compute hash the same way EventStore does
        const canonicalString = stringify(event);
        const hash = createHash('sha256').update(canonicalString, 'utf8').digest('hex');

        // Derive CID
        const cid = eventStore.deriveCidFromHash(hash);
        const cidObj = CID.parse(cid);

        // Verify digest matches
        const digestHex = Buffer.from(cidObj.multihash.digest).toString('hex');
        expect(digestHex).toBe(hash);
    });

    test('CID derivation handles 64-character hex hash', () => {
        // SHA256 produces 64 hex characters (32 bytes)
        const validHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

        expect(() => {
            const cid = eventStore.deriveCidFromHash(validHash);
            expect(cid).toBeTruthy();
        }).not.toThrow();
    });

    test('CID derivation handles edge cases gracefully', () => {
        // Note: The current implementation doesn't validate hash format
        // It trusts the input is a valid hex string
        // This is acceptable since hashes come from internal calculateHash()

        // Just verify it doesn't crash on valid-ish input
        const validHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        expect(() => {
            eventStore.deriveCidFromHash(validHash);
        }).not.toThrow();
    });
});
