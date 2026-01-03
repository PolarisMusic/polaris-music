/**
 * @fileoverview ReleaseBundle Schema Validation Tests
 *
 * Tests the canonical JSON Schema validation for ReleaseBundle objects.
 * Ensures deterministic validation errors and prevents partial writes.
 */

import { validateReleaseBundle, validateReleaseBundleOrThrow } from '../../src/schema/validateReleaseBundle.js';

describe('ReleaseBundle Schema Validation', () => {
    describe('Valid Bundles', () => {
        test('Accepts minimal valid bundle', () => {
            const bundle = {
                release: {
                    name: 'Test Album'
                },
                tracks: [
                    { title: 'Track 1' }
                ],
                tracklist: [
                    { position: '1', track_title: 'Track 1' }
                ]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(true);
            expect(result.errors).toBeUndefined();
        });

        test('Accepts bundle with all optional fields', () => {
            const bundle = {
                release: {
                    release_id: 'rel_123',
                    name: 'Complete Album',
                    alt_names: ['Alternate Name'],
                    release_date: '2024-01-15',
                    format: 'CD',
                    country: 'US',
                    catalog_number: 'CAT-001',
                    liner_notes: 'Notes',
                    trivia: 'Trivia',
                    album_art: 'https://example.com/art.jpg',
                    master_id: 'master_123',
                    master_name: 'Master Release',
                    labels: [{
                        name: 'Test Label',
                        city: { name: 'New York', lat: 40.7128, lon: -74.0060 }
                    }],
                    guests: [{
                        name: 'Guest Artist',
                        role: 'guitar'
                    }]
                },
                groups: [{
                    name: 'Test Band',
                    members: [{
                        name: 'Member 1',
                        role: 'vocals'
                    }]
                }],
                tracks: [{
                    title: 'Track 1',
                    duration: 180,
                    isrc: 'US1234567890'
                }],
                tracklist: [{
                    position: '1',
                    track_title: 'Track 1',
                    duration: 180
                }],
                songs: [{
                    title: 'Song 1',
                    writers: [{ name: 'Songwriter' }]
                }],
                sources: [{
                    type: 'discogs',
                    url: 'https://www.discogs.com/release/123',
                    accessed_at: '2024-01-15T10:00:00Z'
                }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(true);
        });

        test('validateOrThrow does not throw for valid bundle', () => {
            const bundle = {
                release: { name: 'Test' },
                tracks: [{ title: 'Track' }],
                tracklist: [{ position: '1', track_title: 'Track' }]
            };

            expect(() => validateReleaseBundleOrThrow(bundle)).not.toThrow();
        });
    });

    describe('Required Field Validation', () => {
        test('Rejects bundle missing release', () => {
            const bundle = {
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain("root: Missing required field 'release'");
        });

        test('Rejects bundle missing release.name', () => {
            const bundle = {
                release: {},
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes("Missing required field 'name'"))).toBe(true);
        });

        test('Rejects bundle with empty release.name', () => {
            const bundle = {
                release: { name: '' },
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('at least 1 characters'))).toBe(true);
        });

        test('Rejects bundle missing tracks', () => {
            const bundle = {
                release: { name: 'Test' },
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain("root: Missing required field 'tracks'");
        });

        test('Rejects bundle with empty tracks array', () => {
            const bundle = {
                release: { name: 'Test' },
                tracks: [],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('at least 1 item'))).toBe(true);
        });

        test('Rejects bundle missing tracklist', () => {
            const bundle = {
                release: { name: 'Test' },
                tracks: [{ title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain("root: Missing required field 'tracklist'");
        });

        test('Rejects track missing title', () => {
            const bundle = {
                release: { name: 'Test' },
                tracks: [{ duration: 180 }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes("Missing required field 'title'"))).toBe(true);
        });

        test('Rejects tracklist item missing position', () => {
            const bundle = {
                release: { name: 'Test' },
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes("Missing required field 'position'"))).toBe(true);
        });

        test('Rejects tracklist item missing track_title', () => {
            const bundle = {
                release: { name: 'Test' },
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes("Missing required field 'track_title'"))).toBe(true);
        });
    });

    describe('Type Validation', () => {
        test('Rejects release.name as number', () => {
            const bundle = {
                release: { name: 123 },
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('Must be string'))).toBe(true);
        });

        test('Rejects tracks as non-array', () => {
            const bundle = {
                release: { name: 'Test' },
                tracks: { title: 'Track 1' },
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('Must be array'))).toBe(true);
        });

        test('Rejects track.duration as negative number', () => {
            const bundle = {
                release: { name: 'Test' },
                tracks: [{ title: 'Track 1', duration: -10 }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('out of range'))).toBe(true);
        });
    });

    describe('Unknown Field Detection', () => {
        test('Rejects bundle with unknown top-level field', () => {
            const bundle = {
                release: { name: 'Test' },
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }],
                unknownField: 'value'
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes("Unknown field 'unknownField'"))).toBe(true);
        });

        test('Rejects release with legacy field name (release_name)', () => {
            const bundle = {
                release: {
                    name: 'Test',
                    release_name: 'Legacy'  // Should be normalized before validation
                },
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes("Unknown field 'release_name'"))).toBe(true);
        });

        test('Rejects release with camelCase field (releaseDate)', () => {
            const bundle = {
                release: {
                    name: 'Test',
                    releaseDate: '2024-01-15'  // Should be release_date
                },
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes("Unknown field 'releaseDate'"))).toBe(true);
        });
    });

    describe('Nested Object Validation', () => {
        test('Rejects group without name', () => {
            const bundle = {
                release: { name: 'Test' },
                groups: [{ bio: 'A band' }],
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('groups') && e.includes('name'))).toBe(true);
        });

        test('Rejects person without name', () => {
            const bundle = {
                release: {
                    name: 'Test',
                    guests: [{ role: 'guitar' }]
                },
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('name'))).toBe(true);
        });

        test('Rejects city with invalid coordinates', () => {
            const bundle = {
                release: {
                    name: 'Test',
                    labels: [{
                        name: 'Label',
                        city: {
                            name: 'City',
                            lat: 100  // Invalid: > 90
                        }
                    }]
                },
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('out of range'))).toBe(true);
        });
    });

    describe('Error Message Quality', () => {
        test('Provides actionable error messages', () => {
            const bundle = {
                release: {},  // Missing name
                tracks: [],   // Empty array
                // Missing tracklist
                extraField: 'value'
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);

            // Verify each error is actionable
            result.errors.forEach(error => {
                expect(error).toMatch(/Missing required field|Must be|at least|Unknown field/);
            });
        });

        test('validateOrThrow includes all errors in message', () => {
            const bundle = {
                release: {},
                tracks: []
            };

            try {
                validateReleaseBundleOrThrow(bundle);
                fail('Should have thrown validation error');
            } catch (err) {
                expect(err.message).toContain('ReleaseBundle validation failed');
                expect(err.message).toContain('canonical schema');
                expect(err.message).toMatch(/Missing required field|at least/);
            }
        });
    });

    describe('Real-World Scenarios', () => {
        test('Accepts Beatles White Album canonical bundle', () => {
            const bundle = {
                release: {
                    name: 'The Beatles',
                    release_date: '1968-11-22',
                    album_art: 'https://example.com/white-album.jpg',
                    catalog_number: 'PCS 7067-8'
                },
                groups: [{
                    name: 'The Beatles',
                    members: [
                        { name: 'John Lennon', role: 'vocals, guitar' },
                        { name: 'Paul McCartney', role: 'vocals, bass' },
                        { name: 'George Harrison', role: 'guitar' },
                        { name: 'Ringo Starr', role: 'drums' }
                    ]
                }],
                tracks: [
                    { title: 'Back in the U.S.S.R.', duration: 164 },
                    { title: 'Dear Prudence', duration: 226 }
                ],
                tracklist: [
                    { position: 'A1', track_title: 'Back in the U.S.S.R.' },
                    { position: 'A2', track_title: 'Dear Prudence' }
                ]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(true);
        });

        test('Rejects bundle with mix of canonical and legacy fields', () => {
            const bundle = {
                release: {
                    name: 'Test',
                    release_name: 'Legacy',  // Should not have both
                    release_date: '2024-01-15'
                },
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            // Should fail because release_name is not in canonical schema
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('release_name'))).toBe(true);
        });
    });

    describe('Optional Fields', () => {
        test('Accepts bundle without groups', () => {
            const bundle = {
                release: { name: 'Test' },
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(true);
        });

        test('Accepts bundle without songs', () => {
            const bundle = {
                release: { name: 'Test' },
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(true);
        });

        test('Accepts bundle without sources', () => {
            const bundle = {
                release: { name: 'Test' },
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const result = validateReleaseBundle(bundle);

            expect(result.valid).toBe(true);
        });
    });
});
