/**
 * @fileoverview Tests for ReleaseBundle normalization
 *
 * Verifies that frontend data is correctly normalized to canonical schema format,
 * including mapping track.groups → track.performed_by_groups for graph ingestion.
 */

import { describe, it, expect } from '@jest/globals';
import { normalizeReleaseBundle } from '../../src/graph/normalizeReleaseBundle.js';

describe('normalizeReleaseBundle', () => {
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
});
