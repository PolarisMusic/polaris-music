/**
 * @fileoverview Integration test for ReleaseBundle normalization + validation
 *
 * Verifies the complete flow:
 * 1. Frontend submits bundle with legacy field names
 * 2. normalizeReleaseBundle() converts to canonical
 * 3. validateReleaseBundle() ensures correctness
 * 4. Graph ingestion processes canonical bundle
 */

import { normalizeReleaseBundle } from '../../src/graph/normalizeReleaseBundle.js';
import { validateReleaseBundle, validateReleaseBundleOrThrow } from '../../src/schema/validateReleaseBundle.js';

describe('ReleaseBundle Normalization + Validation Integration', () => {
    test('Frontend bundle with legacy fields → normalize → validate → passes', () => {
        // Step 1: Frontend submits with legacy field names
        const frontendBundle = {
            release: {
                release_name: 'The Beatles',  // Legacy field
                releaseDate: '1968-11-22',    // camelCase
                albumArt: 'https://example.com/white-album.jpg',  // camelCase
                catalog_number: 'PCS 7067-8'
            },
            groups: [{
                name: 'The Beatles',
                members: [
                    { name: 'John Lennon', role: 'vocals, guitar' },
                    { name: 'Paul McCartney', role: 'vocals, bass' }
                ]
            }],
            tracks: [
                { title: 'Back in the U.S.S.R.', duration: 164 }
            ],
            tracklist: [
                { position: 'A1', track_title: 'Back in the U.S.S.R.' }
            ]
        };

        // Step 2: Normalize legacy → canonical
        const canonicalBundle = normalizeReleaseBundle(frontendBundle);

        // Verify conversion
        expect(canonicalBundle.release.name).toBe('The Beatles');
        expect(canonicalBundle.release.release_name).toBeUndefined();
        expect(canonicalBundle.release.release_date).toBe('1968-11-22');
        expect(canonicalBundle.release.releaseDate).toBeUndefined();
        expect(canonicalBundle.release.album_art).toBe('https://example.com/white-album.jpg');
        expect(canonicalBundle.release.albumArt).toBeUndefined();

        // Step 3: Validate canonical bundle
        const validationResult = validateReleaseBundle(canonicalBundle);

        // Acceptance criteria: Bundle passes validation
        expect(validationResult.valid).toBe(true);
        expect(validationResult.errors).toBeUndefined();

        // Should not throw
        expect(() => validateReleaseBundleOrThrow(canonicalBundle)).not.toThrow();
    });

    test('Malformed frontend bundle → normalize fails → no partial writes', () => {
        const malformedBundle = {
            release: {},  // Missing name
            tracks: [{ title: 'Track 1' }],
            tracklist: [{ position: '1', track_title: 'Track 1' }]
        };

        // Acceptance criteria: Normalization rejects deterministically
        expect(() => normalizeReleaseBundle(malformedBundle)).toThrow(/validation failed/);
        expect(() => normalizeReleaseBundle(malformedBundle)).toThrow(/name is required/);
    });

    test('Normalized but invalid bundle → validation fails with actionable errors', () => {
        // Already normalized but missing required fields
        const invalidBundle = {
            release: { name: 'Test' },
            tracks: []  // Empty - violates minItems: 1
            // Missing tracklist
        };

        const result = validateReleaseBundle(invalidBundle);

        // Acceptance criteria: Deterministic validation errors
        expect(result.valid).toBe(false);
        expect(result.errors).toBeDefined();
        expect(result.errors.length).toBeGreaterThan(0);

        // Error messages are actionable
        expect(result.errors.some(e => e.includes('at least 1 item'))).toBe(true);
        expect(result.errors.some(e => e.includes("Missing required field 'tracklist'"))).toBe(true);

        // validateOrThrow provides clear error message
        try {
            validateReleaseBundleOrThrow(invalidBundle);
            fail('Should have thrown');
        } catch (err) {
            expect(err.message).toContain('ReleaseBundle validation failed');
            expect(err.message).toContain('canonical schema');
            expect(err.message).toContain('at least 1 item');
            expect(err.message).toContain('tracklist');
        }
    });

    test('Valid canonical bundle (already normalized) → validation passes', () => {
        const canonicalBundle = {
            release: {
                name: 'Test Album',
                release_date: '2024-01-15',
                album_art: 'https://example.com/art.jpg'
            },
            groups: [],
            tracks: [{ title: 'Track 1', duration: 180 }],
            tracklist: [{ position: '1', track_title: 'Track 1', duration: 180 }]
        };

        // Acceptance criteria: Canonical bundle passes validation directly
        const result = validateReleaseBundle(canonicalBundle);

        expect(result.valid).toBe(true);
        expect(result.errors).toBeUndefined();
    });

    test('Bundle with unknown canonical field → validation rejects', () => {
        const bundleWithExtraField = {
            release: {
                name: 'Test',
                unknownField: 'value'  // Not in schema
            },
            tracks: [{ title: 'Track 1' }],
            tracklist: [{ position: '1', track_title: 'Track 1' }]
        };

        const result = validateReleaseBundle(bundleWithExtraField);

        // Acceptance criteria: Unknown fields rejected deterministically
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes("Unknown field 'unknownField'"))).toBe(true);
    });

    test('Deeply nested invalid data → validation catches it', () => {
        const bundle = {
            release: {
                name: 'Test',
                labels: [{
                    name: 'Label',
                    city: {
                        // Missing required 'name' field
                        lat: 40.7128
                    }
                }]
            },
            tracks: [{ title: 'Track 1' }],
            tracklist: [{ position: '1', track_title: 'Track 1' }]
        };

        const result = validateReleaseBundle(bundle);

        // Acceptance criteria: Nested validation errors are caught
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('name'))).toBe(true);
    });
});
