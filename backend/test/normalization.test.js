/**
 * ReleaseBundle Normalization Tests
 *
 * Verifies that frontend data with legacy field names gets normalized
 * to canonical schema format before graph ingestion.
 */

import { normalizeReleaseBundle } from '../src/graph/normalizeReleaseBundle.js';

describe('ReleaseBundle Normalization', () => {
    describe('Legacy Field Name Support', () => {
        test('Converts release_name to name', () => {
            const bundle = {
                release: {
                    release_name: 'Test Album'  // Legacy field name
                },
                groups: [],
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const normalized = normalizeReleaseBundle(bundle);

            expect(normalized.release.name).toBe('Test Album');
            expect(normalized.release.release_name).toBeUndefined();
        });

        test('Converts releaseDate to release_date', () => {
            const bundle = {
                release: {
                    name: 'Test Album',
                    releaseDate: '2024-01-15'  // camelCase (legacy)
                },
                groups: [],
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const normalized = normalizeReleaseBundle(bundle);

            expect(normalized.release.release_date).toBe('2024-01-15');
            expect(normalized.release.releaseDate).toBeUndefined();
        });

        test('Converts albumArt to album_art', () => {
            const bundle = {
                release: {
                    name: 'Test Album',
                    albumArt: 'https://example.com/art.jpg'  // camelCase
                },
                groups: [],
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const normalized = normalizeReleaseBundle(bundle);

            expect(normalized.release.album_art).toBe('https://example.com/art.jpg');
            expect(normalized.release.albumArt).toBeUndefined();
        });

        test('Handles both legacy and canonical field names (canonical wins)', () => {
            const bundle = {
                release: {
                    name: 'Canonical Name',
                    release_name: 'Legacy Name',  // Should be ignored
                    release_date: '2024-01-15',
                    releaseDate: '2024-12-25'     // Should be ignored
                },
                groups: [],
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const normalized = normalizeReleaseBundle(bundle);

            expect(normalized.release.name).toBe('Canonical Name');
            expect(normalized.release.release_date).toBe('2024-01-15');
        });
    });

    describe('Required Field Validation', () => {
        test('Throws error if release.name is missing', () => {
            const bundle = {
                release: {},  // Missing name
                groups: [],
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            expect(() => normalizeReleaseBundle(bundle)).toThrow(/name is required/);
        });

        test('Throws error if release.name is empty string', () => {
            const bundle = {
                release: { name: '   ' },  // Empty after trim
                groups: [],
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            expect(() => normalizeReleaseBundle(bundle)).toThrow(/name is required/);
        });

        test('Throws error if tracks array is missing', () => {
            const bundle = {
                release: { name: 'Test Album' },
                groups: []
                // Missing tracks
            };

            expect(() => normalizeReleaseBundle(bundle)).toThrow(/tracks: Must have at least one valid track/i);
        });

        test('Throws error if tracklist array is missing', () => {
            const bundle = {
                release: { name: 'Test Album' },
                groups: [],
                tracks: [{ title: 'Track 1' }]
                // Missing tracklist
            };

            expect(() => normalizeReleaseBundle(bundle)).toThrow(/tracklist: Must have at least one valid item/i);
        });

        test('Throws error if track is missing title', () => {
            const bundle = {
                release: { name: 'Test Album' },
                groups: [],
                tracks: [{ duration: 180 }],  // Missing title
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            expect(() => normalizeReleaseBundle(bundle)).toThrow(/title is required/);
        });
    });

    describe('Nested Object Normalization', () => {
        test('Normalizes group members', () => {
            const bundle = {
                release: { name: 'Test Album' },
                groups: [{
                    name: 'The Beatles',
                    members: [
                        { name: 'John Lennon', role: 'vocals' },
                        { name: 'Paul McCartney', role: 'bass' }
                    ]
                }],
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const normalized = normalizeReleaseBundle(bundle);

            expect(normalized.groups[0].members).toHaveLength(2);
            expect(normalized.groups[0].members[0].name).toBe('John Lennon');
            expect(normalized.groups[0].members[0].role).toBe('vocals');
        });

        test('Normalizes track guests', () => {
            const bundle = {
                release: { name: 'Test Album' },
                groups: [],
                tracks: [{
                    title: 'Track 1',
                    guests: [
                        { name: 'Eric Clapton', role: 'guitar' }
                    ]
                }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const normalized = normalizeReleaseBundle(bundle);

            expect(normalized.tracks[0].guests).toHaveLength(1);
            expect(normalized.tracks[0].guests[0].name).toBe('Eric Clapton');
            // Guest roles are now normalized to an array
            expect(normalized.tracks[0].guests[0].roles).toEqual(['guitar']);
        });

        test('Normalizes release labels with city (maps deprecated city to origin_city)', () => {
            const bundle = {
                release: {
                    name: 'Test Album',
                    labels: [{
                        name: 'Abbey Road Studios',
                        city: {
                            name: 'London',
                            lat: 51.5074,
                            lon: -0.1278
                        }
                    }]
                },
                groups: [],
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const normalized = normalizeReleaseBundle(bundle);

            expect(normalized.release.labels).toHaveLength(1);
            expect(normalized.release.labels[0].name).toBe('Abbey Road Studios');
            // Deprecated label.city is mapped to label.origin_city
            expect(normalized.release.labels[0].origin_city.name).toBe('London');
            expect(normalized.release.labels[0].origin_city.lat).toBe(51.5074);
        });
    });

    describe('Optional Fields', () => {
        test('Groups array is optional (defaults to empty)', () => {
            const bundle = {
                release: { name: 'Test Album' },
                // No groups field
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
            };

            const normalized = normalizeReleaseBundle(bundle);

            expect(normalized.groups).toEqual([]);
        });

        test('Songs array is optional', () => {
            const bundle = {
                release: { name: 'Test Album' },
                groups: [],
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }]
                // No songs field
            };

            const normalized = normalizeReleaseBundle(bundle);

            expect(normalized.songs).toBeUndefined();
        });

        test('Includes songs if provided', () => {
            const bundle = {
                release: { name: 'Test Album' },
                groups: [],
                tracks: [{ title: 'Track 1' }],
                tracklist: [{ position: '1', track_title: 'Track 1' }],
                songs: [{ title: 'Song Composition 1' }]
            };

            const normalized = normalizeReleaseBundle(bundle);

            expect(normalized.songs).toHaveLength(1);
            expect(normalized.songs[0].title).toBe('Song Composition 1');
        });
    });

    describe('Whitespace Handling', () => {
        test('Trims whitespace from names', () => {
            const bundle = {
                release: { name: '  Test Album  ' },
                groups: [{ name: '  The Beatles  ' }],
                tracks: [{ title: '  Track 1  ' }],
                tracklist: [{ position: '1', track_title: '  Track 1  ' }]
            };

            const normalized = normalizeReleaseBundle(bundle);

            expect(normalized.release.name).toBe('Test Album');
            expect(normalized.groups[0].name).toBe('The Beatles');
            expect(normalized.tracks[0].title).toBe('Track 1');
            expect(normalized.tracklist[0].track_title).toBe('Track 1');
        });
    });

    describe('Error Messages', () => {
        test('Provides detailed error messages for multiple validation failures', () => {
            const bundle = {
                release: {},  // Missing name
                groups: [],
                tracks: [
                    { title: 'Track 1' },
                    {}  // Missing title
                ]
                // Missing tracklist
            };

            let errorMessage;
            try {
                normalizeReleaseBundle(bundle);
                fail('Should have thrown error');
            } catch (err) {
                errorMessage = err.message;
            }

            expect(errorMessage).toMatch(/validation failed/);
            expect(errorMessage).toContain('release: name is required and cannot be empty');
            expect(errorMessage).toContain('tracks[1]: title is required and cannot be empty');
            expect(errorMessage).toMatch(/tracklist: Must have at least one valid item/i);
        });
    });

    describe('Real-World Example', () => {
        test('Normalizes Beatles White Album data from frontend', () => {
            const frontendData = {
                release: {
                    release_name: 'The Beatles',  // Legacy field
                    releaseDate: '1968-11-22',    // camelCase
                    albumArt: 'https://example.com/white-album.jpg',
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

            const normalized = normalizeReleaseBundle(frontendData);

            // Verify legacy fields converted to canonical
            expect(normalized.release.name).toBe('The Beatles');
            expect(normalized.release.release_date).toBe('1968-11-22');
            expect(normalized.release.album_art).toBe('https://example.com/white-album.jpg');
            expect(normalized.release.catalog_number).toBe('PCS 7067-8');

            // Verify nested data preserved
            expect(normalized.groups[0].members).toHaveLength(4);
            expect(normalized.tracks).toHaveLength(2);
            expect(normalized.tracklist).toHaveLength(2);
        });
    });
});
