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
import { normalizeReleaseBundle, extractRelationships } from '../../src/graph/normalizeReleaseBundle.js';

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

            // Each track should have track_id (ISRC-based provisional)
            expect(normalized.tracks[0].track_id).toBe('prov:track:isrc:GBAYE0601729');
            expect(normalized.tracks[1].track_id).toBe('prov:track:isrc:GBAYE0601730');

            // Tracklist should reference track_id
            expect(normalized.tracklist).toHaveLength(2);
            expect(normalized.tracklist[0].track_id).toBe('prov:track:isrc:GBAYE0601729');
            expect(normalized.tracklist[1].track_id).toBe('prov:track:isrc:GBAYE0601730');
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

            // Should generate track_id with prov: prefix
            expect(normalized.tracks[0].track_id).toBeDefined();
            expect(normalized.tracks[0].track_id).toMatch(/^prov:track:/);

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
            expect(normalized.tracklist[0].track_id).toBe('prov:track:isrc:ABC123');
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

    describe('Sample coercion (samples-as-objects)', () => {
        it('should coerce string sample IDs into SampleCredit objects', () => {
            const bundle = {
                release: { name: 'Sample Album' },
                tracks: [
                    {
                        track_id: 'trk_1',
                        title: 'Beat Track',
                        samples: [
                            'polaris:track:abc123',
                            'polaris:track:def456'
                        ]
                    }
                ],
                tracklist: [
                    { position: '1', track_title: 'Beat Track', track_id: 'trk_1' }
                ]
            };

            const normalized = normalizeReleaseBundle(bundle);

            expect(normalized.tracks[0].samples).toHaveLength(2);
            expect(normalized.tracks[0].samples[0]).toEqual({
                sampled_track_id: 'polaris:track:abc123'
            });
            expect(normalized.tracks[0].samples[1]).toEqual({
                sampled_track_id: 'polaris:track:def456'
            });
        });

        it('should coerce legacy { track_id } to { sampled_track_id }', () => {
            const bundle = {
                release: { name: 'Sample Album' },
                tracks: [
                    {
                        track_id: 'trk_1',
                        title: 'Beat Track',
                        samples: [
                            { track_id: 'polaris:track:legacy1', title: 'Old Sample' }
                        ]
                    }
                ],
                tracklist: [
                    { position: '1', track_title: 'Beat Track', track_id: 'trk_1' }
                ]
            };

            const normalized = normalizeReleaseBundle(bundle);

            expect(normalized.tracks[0].samples).toHaveLength(1);
            expect(normalized.tracks[0].samples[0].sampled_track_id).toBe('polaris:track:legacy1');
            expect(normalized.tracks[0].samples[0].sampled_track_title).toBe('Old Sample');
            // Legacy key should not be present
            expect(normalized.tracks[0].samples[0].track_id).toBeUndefined();
            expect(normalized.tracks[0].samples[0].title).toBeUndefined();
        });

        it('should pass through canonical SampleCredit objects', () => {
            const bundle = {
                release: { name: 'Sample Album' },
                tracks: [
                    {
                        track_id: 'trk_1',
                        title: 'Beat Track',
                        samples: [
                            {
                                sampled_track_id: 'polaris:track:canonical1',
                                sampled_track_title: 'Original Song',
                                portion_used: 'chorus melody',
                                cleared: true,
                                source: {
                                    type: 'whosampled',
                                    url: 'https://whosampled.com/example'
                                }
                            }
                        ]
                    }
                ],
                tracklist: [
                    { position: '1', track_title: 'Beat Track', track_id: 'trk_1' }
                ]
            };

            const normalized = normalizeReleaseBundle(bundle);

            const sample = normalized.tracks[0].samples[0];
            expect(sample.sampled_track_id).toBe('polaris:track:canonical1');
            expect(sample.sampled_track_title).toBe('Original Song');
            expect(sample.portion_used).toBe('chorus melody');
            expect(sample.cleared).toBe(true);
            expect(sample.source).toEqual({
                type: 'whosampled',
                url: 'https://whosampled.com/example'
            });
        });

        it('should filter out invalid sample entries (no ID)', () => {
            const bundle = {
                release: { name: 'Sample Album' },
                tracks: [
                    {
                        track_id: 'trk_1',
                        title: 'Beat Track',
                        samples: [
                            { sampled_track_id: 'polaris:track:valid1' },
                            { portion_used: 'drums' },  // Missing ID — should be filtered
                            null,
                            42
                        ]
                    }
                ],
                tracklist: [
                    { position: '1', track_title: 'Beat Track', track_id: 'trk_1' }
                ]
            };

            const normalized = normalizeReleaseBundle(bundle);

            expect(normalized.tracks[0].samples).toHaveLength(1);
            expect(normalized.tracks[0].samples[0].sampled_track_id).toBe('polaris:track:valid1');
        });

        it('should sanitize source to only allowed keys (type, url, accessed_at)', () => {
            const bundle = {
                release: { name: 'Sample Album' },
                tracks: [
                    {
                        track_id: 'trk_1',
                        title: 'Beat Track',
                        samples: [
                            {
                                sampled_track_id: 'polaris:track:src1',
                                source: {
                                    type: 'whosampled',
                                    url: 'https://whosampled.com/example',
                                    accessed_at: '2025-01-01T00:00:00Z',
                                    foo: 'bar',
                                    extra_key: 'should be stripped'
                                }
                            }
                        ]
                    }
                ],
                tracklist: [
                    { position: '1', track_title: 'Beat Track', track_id: 'trk_1' }
                ]
            };

            const normalized = normalizeReleaseBundle(bundle);

            const source = normalized.tracks[0].samples[0].source;
            expect(source.type).toBe('whosampled');
            expect(source.url).toBe('https://whosampled.com/example');
            expect(source.accessed_at).toBe('2025-01-01T00:00:00Z');
            // Extra keys should be stripped
            expect(source.foo).toBeUndefined();
            expect(source.extra_key).toBeUndefined();
        });

        it('should not include samples key when track has no samples', () => {
            const bundle = {
                release: { name: 'Clean Album' },
                tracks: [
                    {
                        track_id: 'trk_1',
                        title: 'Original Song'
                    }
                ],
                tracklist: [
                    { position: '1', track_title: 'Original Song', track_id: 'trk_1' }
                ]
            };

            const normalized = normalizeReleaseBundle(bundle);

            expect(normalized.tracks[0].samples).toBeUndefined();
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

    describe('Explicit relationships extraction (cross-bundle merging)', () => {
        it('should extract MEMBER_OF relationships from groups.members', () => {
            const bundle = {
                release: { name: 'Test Album' },
                groups: [
                    {
                        group_id: 'grp_foo',
                        name: 'Foo Fighters',
                        members: [
                            { person_id: 'person_grohl', name: 'Dave Grohl', roles: ['vocals', 'guitar'] },
                            { person_id: 'person_hawkins', name: 'Taylor Hawkins', role: 'drums' }
                        ]
                    }
                ],
                tracks: [
                    { track_id: 'trk_1', title: 'Everlong', duration: 250 }
                ],
                tracklist: [
                    { track_id: 'trk_1', position: '1', track_title: 'Everlong' }
                ]
            };

            const normalized = normalizeReleaseBundle(bundle);
            const relationships = extractRelationships(
                normalized.release, normalized.groups, normalized.tracks, normalized.songs || []
            );

            expect(relationships).toBeDefined();
            expect(Array.isArray(relationships)).toBe(true);

            const memberOfRels = relationships.filter(r => r.type === 'MEMBER_OF');
            expect(memberOfRels).toHaveLength(2);

            // Dave Grohl -> Foo Fighters
            const grohlRel = memberOfRels.find(r => r.from.id === 'person_grohl');
            expect(grohlRel).toBeDefined();
            expect(grohlRel.to.id).toBe('grp_foo');
            expect(grohlRel.to.label).toBe('Group');
            expect(grohlRel.props.roles).toEqual(['vocals', 'guitar']);

            // Taylor Hawkins -> Foo Fighters
            const hawkinsRel = memberOfRels.find(r => r.from.id === 'person_hawkins');
            expect(hawkinsRel).toBeDefined();
            expect(hawkinsRel.to.id).toBe('grp_foo');
        });

        it('should extract GUEST_ON relationships from release.guests', () => {
            const bundle = {
                release: {
                    name: 'Test Album',
                    release_id: 'rel_1',
                    guests: [
                        { person_id: 'person_engineer', name: 'Bob Rock', roles: ['engineer'] }
                    ]
                },
                tracks: [
                    { track_id: 'trk_1', title: 'Track One', duration: 180 }
                ],
                tracklist: [
                    { track_id: 'trk_1', position: '1', track_title: 'Track One' }
                ]
            };

            const normalized = normalizeReleaseBundle(bundle);
            const relationships = extractRelationships(
                normalized.release, normalized.groups, normalized.tracks, normalized.songs || []
            );

            const guestRels = relationships.filter(r => r.type === 'GUEST_ON');
            expect(guestRels.length).toBeGreaterThanOrEqual(1);

            const releaseGuest = guestRels.find(r => r.props.scope === 'release');
            expect(releaseGuest).toBeDefined();
            expect(releaseGuest.from.id).toBe('person_engineer');
            expect(releaseGuest.to.label).toBe('Release');
        });

        it('should extract PERFORMED_ON relationships from track.performed_by_groups', () => {
            const bundle = {
                release: { name: 'Test Album' },
                tracks: [
                    {
                        track_id: 'trk_1',
                        title: 'Track One',
                        duration: 180,
                        performed_by_groups: [
                            { group_id: 'grp_1', name: 'The Band' }
                        ]
                    }
                ],
                tracklist: [
                    { track_id: 'trk_1', position: '1', track_title: 'Track One' }
                ]
            };

            const normalized = normalizeReleaseBundle(bundle);
            const relationships = extractRelationships(
                normalized.release, normalized.groups, normalized.tracks, normalized.songs || []
            );

            const perfRels = relationships.filter(r => r.type === 'PERFORMED_ON');
            expect(perfRels).toHaveLength(1);
            expect(perfRels[0].from.id).toBe('grp_1');
            expect(perfRels[0].to.id).toBe('trk_1');
        });

        it('should extract WROTE relationships from songs.writers', () => {
            const bundle = {
                release: { name: 'Test Album' },
                tracks: [
                    { track_id: 'trk_1', title: 'My Song', duration: 200 }
                ],
                tracklist: [
                    { track_id: 'trk_1', position: '1', track_title: 'My Song' }
                ],
                songs: [
                    {
                        song_id: 'song_1',
                        title: 'My Song',
                        writers: [
                            { person_id: 'person_writer', name: 'John Doe', role: 'songwriter' }
                        ]
                    }
                ]
            };

            const normalized = normalizeReleaseBundle(bundle);
            const relationships = extractRelationships(
                normalized.release, normalized.groups, normalized.tracks, normalized.songs || []
            );

            const wroteRels = relationships.filter(r => r.type === 'WROTE');
            expect(wroteRels).toHaveLength(1);
            expect(wroteRels[0].from.id).toBe('person_writer');
            expect(wroteRels[0].to.id).toBe('song_1');
        });

        it('should extract PRODUCED relationships from track.producers', () => {
            const bundle = {
                release: { name: 'Test Album' },
                tracks: [
                    {
                        track_id: 'trk_1',
                        title: 'Track One',
                        duration: 180,
                        producers: [
                            { person_id: 'person_prod', name: 'Rick Rubin' }
                        ]
                    }
                ],
                tracklist: [
                    { track_id: 'trk_1', position: '1', track_title: 'Track One' }
                ]
            };

            const normalized = normalizeReleaseBundle(bundle);
            const relationships = extractRelationships(
                normalized.release, normalized.groups, normalized.tracks, normalized.songs || []
            );

            const prodRels = relationships.filter(r => r.type === 'PRODUCED');
            expect(prodRels).toHaveLength(1);
            expect(prodRels[0].from.id).toBe('person_prod');
            expect(prodRels[0].to.id).toBe('trk_1');
        });

        it('should handle bundle with no relationships gracefully', () => {
            const bundle = {
                release: { name: 'Minimal Album' },
                tracks: [
                    { track_id: 'trk_1', title: 'Solo Track', duration: 120 }
                ],
                tracklist: [
                    { track_id: 'trk_1', position: '1', track_title: 'Solo Track' }
                ]
            };

            const normalized = normalizeReleaseBundle(bundle);
            const relationships = extractRelationships(
                normalized.release, normalized.groups, normalized.tracks, normalized.songs || []
            );

            expect(relationships).toBeDefined();
            expect(relationships).toHaveLength(0);
        });

        it('should handle cross-bundle scenario: same person in multiple groups', () => {
            // Bundle 1: Dave Grohl in Nirvana
            const bundle1 = {
                release: { name: 'Nevermind' },
                groups: [
                    {
                        group_id: 'grp_nirvana',
                        name: 'Nirvana',
                        members: [
                            { person_id: 'person_grohl', name: 'Dave Grohl', role: 'drums' }
                        ]
                    }
                ],
                tracks: [
                    { track_id: 'trk_teen_spirit', title: 'Smells Like Teen Spirit', duration: 301 }
                ],
                tracklist: [
                    { track_id: 'trk_teen_spirit', position: '1', track_title: 'Smells Like Teen Spirit' }
                ]
            };

            // Bundle 2: Dave Grohl in Foo Fighters
            const bundle2 = {
                release: { name: 'The Colour and the Shape' },
                groups: [
                    {
                        group_id: 'grp_foo',
                        name: 'Foo Fighters',
                        members: [
                            { person_id: 'person_grohl', name: 'Dave Grohl', role: 'vocals' }
                        ]
                    }
                ],
                tracks: [
                    { track_id: 'trk_everlong', title: 'Everlong', duration: 250 }
                ],
                tracklist: [
                    { track_id: 'trk_everlong', position: '1', track_title: 'Everlong' }
                ]
            };

            const norm1 = normalizeReleaseBundle(bundle1);
            const rels1 = extractRelationships(
                norm1.release, norm1.groups, norm1.tracks, norm1.songs || []
            );
            const norm2 = normalizeReleaseBundle(bundle2);
            const rels2 = extractRelationships(
                norm2.release, norm2.groups, norm2.tracks, norm2.songs || []
            );

            // Both bundles should have MEMBER_OF for Dave Grohl
            const grohl1 = rels1.find(
                r => r.type === 'MEMBER_OF' && r.from.id === 'person_grohl'
            );
            const grohl2 = rels2.find(
                r => r.type === 'MEMBER_OF' && r.from.id === 'person_grohl'
            );

            expect(grohl1).toBeDefined();
            expect(grohl1.to.id).toBe('grp_nirvana');

            expect(grohl2).toBeDefined();
            expect(grohl2.to.id).toBe('grp_foo');

            // Same person_id in both, different groups
            expect(grohl1.from.id).toBe(grohl2.from.id);
            expect(grohl1.to.id).not.toBe(grohl2.to.id);
        });
    });
});

describe('a track is a recording on a release, not a title', () => {
    /*
     * Reported from production: the release page for Pearl Jam's "Ten" credited
     * Pearl Jam, Queens Of The Stone Age and The Aquabats! as performers.
     *
     * Track ids were a hash of title + duration. Discogs imports carry no
     * durations, so that is a hash of the title, and a hidden track called
     * "Untitled" is one node for the entire registry — shared by every release
     * that has one, with every one of their performers attached. The release
     * page reads performers through (Group)-[:PERFORMED_ON]->(:Track)-[:IN_RELEASE]->(r),
     * so all three bands came back.
     *
     * Generic titles are not rare here: Untitled, (silence), Intro, Outro,
     * Reprise, Release, Black, Deep.
     */
    const release = (over = {}) => ({
        name: 'Ten',
        release_date: '1991/08/27',
        format: 'CD',
        labels: [{ name: 'Epic Associated' }],
        ...over
    });

    const bundle = (releaseOver, titles) => ({
        release: release(releaseOver),
        tracks: titles.map(t => (typeof t === 'string' ? { title: t } : t)),
        tracklist: titles.map((t, i) => ({
            position: String(i + 1),
            track_title: typeof t === 'string' ? t : t.title
        }))
    });

    const idsByTitle = (normalized) =>
        Object.fromEntries(normalized.tracks.map(t => [t.title, t.track_id]));

    it('gives the same track title on two different releases two different ids', () => {
        const ten = normalizeReleaseBundle(bundle({}, ['Untitled', '(silence)']));
        const deaf = normalizeReleaseBundle(bundle({
            name: 'Songs For The Deaf',
            release_date: '2002/08/27',
            labels: [{ name: 'Interscope Records' }]
        }, ['Untitled', '(silence)']));

        expect(idsByTitle(ten)['Untitled'])
            .not.toBe(idsByTitle(deaf)['Untitled']);
        expect(idsByTitle(ten)['(silence)'])
            .not.toBe(idsByTitle(deaf)['(silence)']);
    });

    it('gives the same release resubmitted the same ids', () => {
        // The hard invariant: replaying an event must not fork the graph.
        const once = normalizeReleaseBundle(bundle({}, ['Untitled', 'Alive']));
        const twice = normalizeReleaseBundle(bundle({}, ['Untitled', 'Alive']));
        expect(idsByTitle(twice)).toEqual(idsByTitle(once));
    });

    it('keeps a reissue on another label apart from the original', () => {
        // Release identity already treats a licensed reissue as its own
        // edition. Track identity inherits that rather than inventing a
        // second, coarser rule that would drift away from it.
        const original = normalizeReleaseBundle(bundle({}, ['Alive']));
        const reissue = normalizeReleaseBundle(bundle({
            labels: [{ name: 'Legacy Recordings' }]
        }, ['Alive']));

        expect(idsByTitle(original)['Alive']).not.toBe(idsByTitle(reissue)['Alive']);
    });

    it('still shares one id across releases when an ISRC says to', () => {
        // An ISRC identifies a *recording* globally, so the same recording
        // issued on two releases genuinely is one node. It is the one signal
        // trustworthy enough to say so, and it stays unscoped on purpose —
        // this is how a re-release is meant to share a track.
        const comp = normalizeReleaseBundle(bundle(
            { name: 'Rearviewmirror', release_date: '2004/11/16' },
            [{ title: 'Alive', isrc: 'USSM19100123' }]
        ));
        const orig = normalizeReleaseBundle(bundle({}, [{ title: 'Alive', isrc: 'USSM19100123' }]));

        expect(idsByTitle(orig)['Alive']).toBe('prov:track:isrc:USSM19100123');
        expect(idsByTitle(comp)['Alive']).toBe(idsByTitle(orig)['Alive']);
    });

    it('leaves an id the submitter supplied exactly as it is', () => {
        // A track the submitter picked out of a typeahead is evidence about
        // which node they meant. A generated id is not, and must never be
        // mistaken for one.
        const normalized = normalizeReleaseBundle(bundle({}, [
            { title: 'Alive', track_id: 'prov:track:picked-by-hand' }
        ]));
        expect(idsByTitle(normalized)['Alive']).toBe('prov:track:picked-by-hand');
    });

    it('does not depend on duration, which imports do not carry', () => {
        // Duration was half of the old identity and is absent from every
        // Discogs import, which is why the old rule degenerated to the title.
        // Adding one later must not fork the node.
        const without = normalizeReleaseBundle(bundle({}, [{ title: 'Alive' }]));
        const with_ = normalizeReleaseBundle(bundle({}, [{ title: 'Alive', duration: 341 }]));
        expect(idsByTitle(with_)['Alive']).toBe(idsByTitle(without)['Alive']);
    });

    it('known limit: one title twice on one release is still one track', () => {
        // Position would separate them, and is deliberately not in the
        // fingerprint: correcting a tracklist position would then mint a new
        // node and orphan the old one, which is a worse failure than this one.
        // Two tracks of the same name on a single release need curation.
        const normalized = normalizeReleaseBundle({
            release: release(),
            tracks: [{ title: 'Intro' }, { title: 'Intro' }],
            tracklist: [
                { position: '1', track_title: 'Intro' },
                { position: '9', track_title: 'Intro' }
            ]
        });
        expect(normalized.tracks).toHaveLength(1);
    });

    it('reports the release error rather than crashing on the scope', () => {
        // The scope is computed from the release, which may itself have failed
        // to normalize. The caller must still get the validation message.
        expect(() => normalizeReleaseBundle({
            release: { name: '' },
            tracks: [{ title: 'Alive' }],
            tracklist: [{ position: '1', track_title: 'Alive' }]
        })).toThrow(/release/);
    });
});

describe('a track can carry the other spellings of its title', () => {
    /**
     * These arrive from the Spotify cross-check on the submission form, which
     * pairs "Mystic Lover" on a Discogs pressing with "Mystic Lovers" in a
     * streaming catalogue. Before it existed the disagreement was discarded
     * along with the link; the point of carrying it is that the alternate
     * spelling is how somebody else will search for the recording.
     */
    const bundleWith = (track) => ({
        release: { name: 'Fire of Unknown Origin', release_date: '1981', format: 'LP' },
        tracks: [track],
        tracklist: [{ position: '1', track_title: track.title }]
    });

    it('keeps an alternate title through normalization', () => {
        const normalized = normalizeReleaseBundle(bundleWith({
            title: 'Veteran Of The Psychic Wars',
            alt_titles: ['Veteran of the Psychic War']
        }));

        expect(normalized.tracks[0].alt_titles).toEqual(['Veteran of the Psychic War']);
    });

    it('drops the track’s own title from the list', () => {
        // Holding a title twice says nothing, and makes the node's own title
        // look like one candidate among several.
        const normalized = normalizeReleaseBundle(bundleWith({
            title: 'Burnin’ For You',
            alt_titles: ['Burnin’ For You', 'Burning For You']
        }));

        expect(normalized.tracks[0].alt_titles).toEqual(['Burning For You']);
    });

    it('drops blanks, whitespace and non-strings', () => {
        const normalized = normalizeReleaseBundle(bundleWith({
            title: 'Joan Crawford',
            alt_titles: ['  Joan Crawford Has Risen  ', '', '   ', null, 42, { title: 'no' }]
        }));

        expect(normalized.tracks[0].alt_titles).toEqual(['Joan Crawford Has Risen']);
    });

    it('does not repeat the same alternate title', () => {
        const normalized = normalizeReleaseBundle(bundleWith({
            title: 'Vengeance',
            alt_titles: ['Vengeance (The Pact)', 'Vengeance (The Pact)']
        }));

        expect(normalized.tracks[0].alt_titles).toEqual(['Vengeance (The Pact)']);
    });

    it('omits the field entirely when nothing survives', () => {
        // Rather than an empty array: the bundle is hashed and anchored, so a
        // key that carries no information should not be in it.
        const normalized = normalizeReleaseBundle(bundleWith({
            title: 'Sole Survivor',
            alt_titles: ['Sole Survivor', '']
        }));

        expect(normalized.tracks[0].alt_titles).toBeUndefined();
    });

    it('is absent when the submission says nothing about it', () => {
        const normalized = normalizeReleaseBundle(bundleWith({ title: 'Heavy Metal' }));
        expect(normalized.tracks[0]).not.toHaveProperty('alt_titles');
    });

    it('tolerates a non-array', () => {
        const normalized = normalizeReleaseBundle(bundleWith({
            title: 'Don’t Turn Your Back',
            alt_titles: 'Dont Turn Your Back'
        }));

        expect(normalized.tracks[0].alt_titles).toBeUndefined();
    });
});

describe('a release carries the barcode off its sleeve', () => {
    /**
     * The barcode is the registry's one identifier-based route into another
     * catalogue. It already found the streaming release at submission time;
     * stored on the node it also finds the MusicBrainz release, whose
     * artist-credit then names the artists by MBID — so genre tags for both a
     * Release and its Groups resolve from an identifier rather than from
     * matching artist and title, which is the guesswork this registry exists
     * to referee.
     *
     * It belongs on Release and not on Master: it identifies an edition, and a
     * reissue carries its own.
     */
    const bundleWith = (release) => ({
        release: { name: 'Fire of Unknown Origin', release_date: '1981', format: 'LP', ...release },
        tracks: [{ title: 'Burnin For You' }],
        tracklist: [{ position: '1', track_title: 'Burnin For You' }]
    });

    it('keeps a plain barcode', () => {
        const normalized = normalizeReleaseBundle(bundleWith({ barcode: '07464373891' }));
        expect(normalized.release.barcode).toBe('07464373891');
    });

    it('reduces a printed barcode to digits', () => {
        // "0 7464-37389-1" on the cover and 07464373891 in a catalogue are the
        // same article; two spellings of one key are no use as a lookup.
        const normalized = normalizeReleaseBundle(bundleWith({ barcode: '0 7464-37389-1' }));
        expect(normalized.release.barcode).toBe('07464373891');
    });

    it.each([
        ['the word submitters type for none', 'none'],
        ['a catalogue number',                'FC 37389'],
        ['a price code',                      '7.98'],
        ['too few digits',                    '1234567'],
        ['too many digits',                   '123456789012345'],
        ['an empty string',                   ''],
    ])('drops %s', (_label, value) => {
        // The same length rule the barcode helpers use: a digit run shorter
        // than an EAN-8 is a catalogue number or a price, and looking one up
        // returns somebody else's release.
        expect(normalizeReleaseBundle(bundleWith({ barcode: value })).release)
            .not.toHaveProperty('barcode');
    });

    it('is absent when the submission says nothing about it', () => {
        expect(normalizeReleaseBundle(bundleWith({})).release).not.toHaveProperty('barcode');
    });

    it('tolerates a number rather than a string', () => {
        // FormData gives strings, but a programmatic caller may not.
        const normalized = normalizeReleaseBundle(bundleWith({ barcode: 7464373891 }));
        expect(normalized.release.barcode).toBe('7464373891');
    });
});

describe('alternate names on a person', () => {
    const withMember = (member) => normalizeReleaseBundle({
        release: { name: 'R' },
        groups: [{ name: 'G', members: [member] }],
        tracks: [{ title: 'T' }],
        tracklist: [{ position: '1', track_title: 'T' }],
    });

    test('they survive normalization', () => {
        const bundle = withMember({ name: 'Kristen Gundred', alt_names: ['Dee Dee'] });

        expect(bundle.groups[0].members[0].alt_names).toEqual(['Dee Dee']);
    });

    test('blanks and non-strings are dropped, the rest trimmed', () => {
        const bundle = withMember({
            name: 'Kristen Gundred',
            alt_names: ['  Dee Dee  ', '', '   ', null, 42, 'Kristin Welchez'],
        });

        expect(bundle.groups[0].members[0].alt_names)
            .toEqual(['Dee Dee', 'Kristin Welchez']);
    });

    test('a list that cleans down to nothing leaves the field off entirely', () => {
        // Rather than an empty array, which would read as "this person has no
        // other names" where the truth is that none were given.
        const bundle = withMember({ name: 'Kristen Gundred', alt_names: ['', '  '] });

        expect(bundle.groups[0].members[0]).not.toHaveProperty('alt_names');
    });

    test('they are kept alongside credited_as, not instead of it', () => {
        // Different questions: credited_as is how this release billed someone,
        // alt_names are names they go by at all. A search has to match the
        // second; the first is a fact about this record.
        const bundle = withMember({
            name: 'Kristen Gundred',
            alt_names: ['Dee Dee'],
            credited_as: 'Dee Dee Penny',
        });

        expect(bundle.groups[0].members[0].alt_names).toEqual(['Dee Dee']);
        expect(bundle.groups[0].members[0].credited_as).toBe('Dee Dee Penny');
    });

    test('a songwriter may carry them too', () => {
        const bundle = normalizeReleaseBundle({
            release: { name: 'R' },
            tracks: [{ title: 'T' }],
            tracklist: [{ position: '1', track_title: 'T' }],
            songs: [{ title: 'T', writers: [
                { name: 'Kristen Gundred', alt_names: ['  Dee Dee '] }] }],
        });

        expect(bundle.songs[0].writers[0].alt_names).toEqual(['Dee Dee']);
    });

    test('the validator accepts the field', () => {
        // Person and WriterCredit are additionalProperties:false, so an
        // unlisted field is not ignored — the whole bundle is rejected.
        expect(() => withMember({ name: 'K', alt_names: ['Dee Dee'] })).not.toThrow();
    });
});
