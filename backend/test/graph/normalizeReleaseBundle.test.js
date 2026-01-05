/**
 * @fileoverview Tests for ReleaseBundle normalization
 *
 * Verifies that frontend data is correctly normalized to canonical schema format,
 * including:
 * - Accepting legacy shape (release.tracks) and canonical shape (top-level tracks)
 * - Mapping track.groups → track.performed_by_groups for graph ingestion
 * - Generating deterministic track_id when missing
 * - Deduplicating tracks
 * - Normalizing tracklist to reference track_id
 */

import { describe, it, expect } from '@jest/globals';
import { normalizeReleaseBundle } from '../../src/graph/normalizeReleaseBundle.js';

describe('normalizeReleaseBundle', () => {
    describe('Legacy input handling (Item 5)', () => {
        it('should accept legacy shape with release.tracks and produce canonical output', () => {
            // Legacy frontend shape: { release: { tracks: [...] }, tracklist: [...] }
            const legacyBundle = {
                release: {
                    name: 'Abbey Road',
                    release_date: '1969-09-26',
                    tracks: [
                        {
                            title: 'Come Together',
                            duration: 259,
                            isrc: 'GBAYE0601729'
                        },
                        {
                            title: 'Something',
                            duration: 182,
                            isrc: 'GBAYE0601730'
                        }
                    ]
                },
                tracklist: [
                    { position: '1', track_title: 'Come Together', duration: 259 },
                    { position: '2', track_title: 'Something', duration: 182 }
                ]
            };

            const normalized = normalizeReleaseBundle(legacyBundle);

            // Should have canonical structure
            expect(normalized.release).toBeDefined();
            expect(normalized.tracks).toBeDefined();
            expect(normalized.tracklist).toBeDefined();

            // Tracks should be at top-level
            expect(normalized.tracks).toHaveLength(2);
            expect(normalized.tracks[0].title).toBe('Come Together');
            expect(normalized.tracks[1].title).toBe('Something');

            // Each track should have track_id (ISRC-based)
            expect(normalized.tracks[0].track_id).toBe('track:isrc:GBAYE0601729');
            expect(normalized.tracks[1].track_id).toBe('track:isrc:GBAYE0601730');

            // Tracklist should reference track_id
            expect(normalized.tracklist).toHaveLength(2);
            expect(normalized.tracklist[0].track_id).toBe('track:isrc:GBAYE0601729');
            expect(normalized.tracklist[1].track_id).toBe('track:isrc:GBAYE0601730');
            expect(normalized.tracklist[0].position).toBe('1');
        });

        it('should accept canonical shape and pass through unchanged', () => {
            // Canonical shape: { release, tracks, tracklist, groups }
            const canonicalBundle = {
                release: {
                    name: 'Test Album'
                },
                groups: [
                    { group_id: 'grp_test', name: 'Test Band' }
                ],
                tracks: [
                    {
                        track_id: 'track_explicit_id',
                        title: 'Test Track',
                        duration: 180
                    }
                ],
                tracklist: [
                    {
                        position: '1',
                        track_title: 'Test Track',
                        track_id: 'track_explicit_id'
                    }
                ]
            };

            const normalized = normalizeReleaseBundle(canonicalBundle);

            // Should preserve track_id
            expect(normalized.tracks[0].track_id).toBe('track_explicit_id');
            expect(normalized.tracklist[0].track_id).toBe('track_explicit_id');
        });

        it('should generate deterministic track_id when missing (hash-based)', () => {
            const bundle = {
                release: {
                    name: 'Test Album',
                    tracks: [
                        {
                            title: 'No ID Track',
                            duration: 200
                            // No track_id or ISRC
                        }
                    ]
                },
                tracklist: [
                    { position: '1', track_title: 'No ID Track' }
                ]
            };

            const normalized = normalizeReleaseBundle(bundle);

            // Should generate track_id
            expect(normalized.tracks[0].track_id).toBeDefined();
            expect(normalized.tracks[0].track_id).toMatch(/^track:gen:/);

            // Tracklist should reference generated track_id
            expect(normalized.tracklist[0].track_id).toBe(normalized.tracks[0].track_id);
        });

        it('should deduplicate tracks by track_id', () => {
            const bundle = {
                release: {
                    name: 'Test Album',
                    tracks: [
                        { track_id: 'trk_1', title: 'Track 1', duration: 180 },
                        { track_id: 'trk_1', title: 'Track 1 Duplicate', duration: 180 }, // Duplicate
                        { track_id: 'trk_2', title: 'Track 2', duration: 200 }
                    ]
                },
                tracklist: [
                    { position: '1', track_title: 'Track 1', track_id: 'trk_1' },
                    { position: '2', track_title: 'Track 2', track_id: 'trk_2' }
                ]
            };

            const normalized = normalizeReleaseBundle(bundle);

            // Should only have 2 tracks (duplicate removed)
            expect(normalized.tracks).toHaveLength(2);
            expect(normalized.tracks[0].track_id).toBe('trk_1');
            expect(normalized.tracks[1].track_id).toBe('trk_2');

            // Tracklist should still be valid
            expect(normalized.tracklist).toHaveLength(2);
        });

        it('should match tracklist items to track catalog by title', () => {
            const bundle = {
                release: {
                    name: 'Test Album',
                    tracks: [
                        { title: 'Come Together', duration: 259, isrc: 'ABC123' }
                    ]
                },
                tracklist: [
                    // Tracklist doesn't have track_id, only title
                    { position: '1', track_title: 'Come Together', duration: 259 }
                ]
            };

            const normalized = normalizeReleaseBundle(bundle);

            // Should match by title and add track_id to tracklist
            expect(normalized.tracklist[0].track_id).toBe('track:isrc:ABC123');
        });

        it('should error on tracklist item that cannot be resolved to catalog', () => {
            const bundle = {
                release: {
                    name: 'Test Album',
                    tracks: [
                        { title: 'Track A', duration: 180 }
                    ]
                },
                tracklist: [
                    { position: '1', track_title: 'Non Existent Track' } // Doesn't match catalog
                ]
            };

            // Should throw validation error
            expect(() => {
                normalizeReleaseBundle(bundle);
            }).toThrow(/Could not resolve track_id/);
        });
    });

    describe('Track normalization', () => {
        it('should map track.groups to performed_by_groups', () => {
            // Frontend data with track.groups
            const frontendBundle = {
                release: {
                    name: 'Test Album',
                    release_date: '2024-01-01'
                },
                groups: [
                    {
                        group_id: 'grp_beatles',
                        name: 'The Beatles'
                    }
                ],
                tracks: [
                    {
                        title: 'Come Together',
                        duration: 259,
                        groups: [
                            {
                                group_id: 'grp_beatles',
                                name: 'The Beatles',
                                credited_as: 'The Beatles'
                            }
                        ]
                    }
                ],
                tracklist: [
                    {
                        position: '1',
                        track_title: 'Come Together'
                    }
                ]
            };

            // Normalize
            const normalized = normalizeReleaseBundle(frontendBundle);

            // Verify track.performed_by_groups exists
            expect(normalized.tracks).toHaveLength(1);
            expect(normalized.tracks[0].performed_by_groups).toBeDefined();
            expect(normalized.tracks[0].performed_by_groups).toHaveLength(1);

            // Verify group mapping
            const performingGroup = normalized.tracks[0].performed_by_groups[0];
            expect(performingGroup.group_id).toBe('grp_beatles');
            expect(performingGroup.name).toBe('The Beatles');
            expect(performingGroup.credited_as).toBe('The Beatles');
        });

        it('should handle tracks with multiple performing groups', () => {
            const frontendBundle = {
                release: {
                    name: 'Collaboration Album'
                },
                groups: [
                    { group_id: 'grp_1', name: 'Band A' },
                    { group_id: 'grp_2', name: 'Band B' }
                ],
                tracks: [
                    {
                        title: 'Collab Song',
                        groups: [
                            { group_id: 'grp_1', name: 'Band A' },
                            { group_id: 'grp_2', name: 'Band B', role: 'Featured' }
                        ]
                    }
                ],
                tracklist: [
                    { position: '1', track_title: 'Collab Song' }
                ]
            };

            const normalized = normalizeReleaseBundle(frontendBundle);

            expect(normalized.tracks[0].performed_by_groups).toHaveLength(2);
            expect(normalized.tracks[0].performed_by_groups[0].group_id).toBe('grp_1');
            expect(normalized.tracks[0].performed_by_groups[1].group_id).toBe('grp_2');
            expect(normalized.tracks[0].performed_by_groups[1].role).toBe('Featured');
        });

        it('should filter out groups without identifiers', () => {
            const frontendBundle = {
                release: {
                    name: 'Test Album'
                },
                groups: [],
                tracks: [
                    {
                        title: 'Test Track',
                        groups: [
                            { group_id: 'grp_valid', name: 'Valid Group' },
                            {}, // Invalid: no id or name
                            { role: 'Featured' } // Invalid: only role, no id/name
                        ]
                    }
                ],
                tracklist: [
                    { position: '1', track_title: 'Test Track' }
                ]
            };

            const normalized = normalizeReleaseBundle(frontendBundle);

            // Should only have 1 valid group
            expect(normalized.tracks[0].performed_by_groups).toHaveLength(1);
            expect(normalized.tracks[0].performed_by_groups[0].group_id).toBe('grp_valid');
        });

        it('should handle tracks without groups field', () => {
            const frontendBundle = {
                release: {
                    name: 'Test Album'
                },
                groups: [],
                tracks: [
                    {
                        title: 'Solo Track',
                        duration: 180
                        // No groups field
                    }
                ],
                tracklist: [
                    { position: '1', track_title: 'Solo Track' }
                ]
            };

            const normalized = normalizeReleaseBundle(frontendBundle);

            // Should not have performed_by_groups if no groups provided
            expect(normalized.tracks[0].performed_by_groups).toBeUndefined();
        });

        it('should support legacy field name variations', () => {
            const frontendBundle = {
                release: {
                    name: 'Test Album'
                },
                groups: [],
                tracks: [
                    {
                        title: 'Test Track',
                        groups: [
                            {
                                id: 'grp_legacy',           // Legacy: id instead of group_id
                                group_name: 'Legacy Band'   // Legacy: group_name instead of name
                            }
                        ]
                    }
                ],
                tracklist: [
                    { position: '1', track_title: 'Test Track' }
                ]
            };

            const normalized = normalizeReleaseBundle(frontendBundle);

            expect(normalized.tracks[0].performed_by_groups).toHaveLength(1);
            expect(normalized.tracks[0].performed_by_groups[0].group_id).toBe('grp_legacy');
            expect(normalized.tracks[0].performed_by_groups[0].name).toBe('Legacy Band');
        });
    });

    describe('Frontend tracklist shape (Item 5 Revised)', () => {
        it('should accept frontend tracklist shape with track_id, disc_side, track_number', () => {
            // Frontend sends: { track_id, disc_side, track_number }
            // Backend needs: { position, track_title, track_id }
            const frontendBundle = {
                release: {
                    name: 'Abbey Road'
                },
                tracks: [
                    { track_id: 'trk_1', title: 'Come Together', duration: 259, isrc: 'GBAYE0601729' },
                    { track_id: 'trk_2', title: 'Something', duration: 182, isrc: 'GBAYE0601730' }
                ],
                tracklist: [
                    // Frontend shape: no position or track_title
                    { track_id: 'trk_1', disc_side: 'A', track_number: 1, duration: 259 },
                    { track_id: 'trk_2', disc_side: 'A', track_number: 2, duration: 182 }
                ]
            };

            const normalized = normalizeReleaseBundle(frontendBundle);

            // Should derive position from disc_side + track_number
            expect(normalized.tracklist[0].position).toBe('A-1');
            expect(normalized.tracklist[1].position).toBe('A-2');

            // Should derive track_title from catalog
            expect(normalized.tracklist[0].track_title).toBe('Come Together');
            expect(normalized.tracklist[1].track_title).toBe('Something');

            // Should preserve track_id
            expect(normalized.tracklist[0].track_id).toBe('trk_1');
            expect(normalized.tracklist[1].track_id).toBe('trk_2');

            // Should NOT include non-canonical fields (disc_side, track_number)
            expect(normalized.tracklist[0].disc_side).toBeUndefined();
            expect(normalized.tracklist[0].track_number).toBeUndefined();
        });

        it('should derive position from track_number alone when disc_side missing', () => {
            const frontendBundle = {
                release: {
                    name: 'Test Album'
                },
                tracks: [
                    { track_id: 'trk_1', title: 'Track 1' },
                    { track_id: 'trk_2', title: 'Track 2' }
                ],
                tracklist: [
                    { track_id: 'trk_1', track_number: 1 },
                    { track_id: 'trk_2', track_number: 2 }
                ]
            };

            const normalized = normalizeReleaseBundle(frontendBundle);

            // Should use track_number as position
            expect(normalized.tracklist[0].position).toBe('1');
            expect(normalized.tracklist[1].position).toBe('2');
        });

        it('should fallback to index+1 when both disc_side and track_number missing', () => {
            const frontendBundle = {
                release: {
                    name: 'Test Album'
                },
                tracks: [
                    { track_id: 'trk_1', title: 'Track 1' },
                    { track_id: 'trk_2', title: 'Track 2' }
                ],
                tracklist: [
                    { track_id: 'trk_1' },
                    { track_id: 'trk_2' }
                ]
            };

            const normalized = normalizeReleaseBundle(frontendBundle);

            // Should fallback to 1-based index
            expect(normalized.tracklist[0].position).toBe('1');
            expect(normalized.tracklist[1].position).toBe('2');
        });

        it('should handle multi-disc frontend tracklist', () => {
            const frontendBundle = {
                release: {
                    name: 'The Beatles (White Album)'
                },
                tracks: [
                    { track_id: 'trk_1', title: 'Back in the U.S.S.R.' },
                    { track_id: 'trk_2', title: 'Dear Prudence' },
                    { track_id: 'trk_3', title: 'Revolution 1' },
                    { track_id: 'trk_4', title: 'Honey Pie' }
                ],
                tracklist: [
                    { track_id: 'trk_1', disc_side: '1A', track_number: 1 },
                    { track_id: 'trk_2', disc_side: '1A', track_number: 2 },
                    { track_id: 'trk_3', disc_side: '2B', track_number: 1 },
                    { track_id: 'trk_4', disc_side: '2B', track_number: 2 }
                ]
            };

            const normalized = normalizeReleaseBundle(frontendBundle);

            expect(normalized.tracklist[0].position).toBe('1A-1');
            expect(normalized.tracklist[1].position).toBe('1A-2');
            expect(normalized.tracklist[2].position).toBe('2B-1');
            expect(normalized.tracklist[3].position).toBe('2B-2');

            // All should have track_title derived
            expect(normalized.tracklist[0].track_title).toBe('Back in the U.S.S.R.');
            expect(normalized.tracklist[3].track_title).toBe('Honey Pie');
        });

        it('should error if track_id references non-existent catalog track', () => {
            const frontendBundle = {
                release: {
                    name: 'Test Album'
                },
                tracks: [
                    { track_id: 'trk_1', title: 'Track 1' }
                ],
                tracklist: [
                    { track_id: 'trk_999' } // Does not exist in catalog
                ]
            };

            expect(() => {
                normalizeReleaseBundle(frontendBundle);
            }).toThrow(/Referenced track_id not found in catalog: trk_999/);
        });

        it('should output ONLY canonical fields (position, track_title, track_id, duration)', () => {
            const frontendBundle = {
                release: {
                    name: 'Test Album'
                },
                tracks: [
                    { track_id: 'trk_1', title: 'Track 1', duration: 180 }
                ],
                tracklist: [
                    { track_id: 'trk_1', disc_side: 'A', track_number: 1, duration: 180 }
                ]
            };

            const normalized = normalizeReleaseBundle(frontendBundle);

            // Verify exact keys present (no extra fields)
            const tracklistItem = normalized.tracklist[0];
            const keys = Object.keys(tracklistItem).sort();

            // Should have exactly: duration, position, track_id, track_title
            expect(keys).toEqual(['duration', 'position', 'track_id', 'track_title']);

            // Verify helper fields are NOT present
            expect(tracklistItem).not.toHaveProperty('disc_side');
            expect(tracklistItem).not.toHaveProperty('track_number');
        });
    });
});
