/**
 * Tests for DiscogsImporter utility functions
 *
 * Tests the pure transformation and utility logic of the Discogs importer
 * without requiring actual API calls or database connections.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { DiscogsImporter } from '../../../tools/import/discogsImporter.js';

describe('DiscogsImporter', () => {
    let importer;

    beforeEach(() => {
        // Create importer without storage/graph (we're testing utility methods)
        importer = new DiscogsImporter({ discogsToken: 'fake_token_for_test' });
    });

    describe('parseDuration', () => {

        test('should parse standard MM:SS format', () => {
            expect(importer.parseDuration('3:45')).toBe(225);
            expect(importer.parseDuration('0:30')).toBe(30);
            expect(importer.parseDuration('10:00')).toBe(600);
        });

        test('should handle single-digit minutes and seconds', () => {
            expect(importer.parseDuration('1:05')).toBe(65);
            expect(importer.parseDuration('0:01')).toBe(1);
        });

        test('should return null for null/undefined input', () => {
            expect(importer.parseDuration(null)).toBeNull();
            expect(importer.parseDuration(undefined)).toBeNull();
        });

        test('should return null for empty string', () => {
            expect(importer.parseDuration('')).toBeNull();
        });

        test('should return null for invalid format', () => {
            expect(importer.parseDuration('3:45:00')).toBeNull(); // HH:MM:SS
            expect(importer.parseDuration('abc')).toBeNull();
        });
    });

    describe('processDiscogsArtists', () => {

        test('should convert Discogs artists to Polaris groups', () => {
            const artists = [
                { id: 82730, name: 'The Beatles', join: '' },
                { id: 45467, name: 'Pink Floyd', join: '' },
            ];

            const groups = importer.processDiscogsArtists(artists);

            expect(groups).toHaveLength(2);
            expect(groups[0]).toEqual({
                group_id: 'discogs:artist/82730',
                name: 'The Beatles',
                roles: ['performer'],
                members: [],
            });
            expect(groups[1].group_id).toBe('discogs:artist/45467');
        });

        test('should use join role when provided', () => {
            const artists = [
                { id: 100, name: 'Artist A', join: 'featuring' },
            ];

            const groups = importer.processDiscogsArtists(artists);
            expect(groups[0].roles).toEqual(['featuring']);
        });

        test('should default to performer when join is empty', () => {
            const artists = [
                { id: 100, name: 'Artist A', join: '' },
            ];

            const groups = importer.processDiscogsArtists(artists);
            expect(groups[0].roles).toEqual(['performer']);
        });

        test('should handle empty artists array', () => {
            const groups = importer.processDiscogsArtists([]);
            expect(groups).toEqual([]);
        });
    });

    describe('extractWriters', () => {

        test('should extract writers from extra artists', () => {
            const extraartists = [
                { id: 1, name: 'John Lennon', role: 'Written-By' },
                { id: 2, name: 'Paul McCartney', role: 'Written-By' },
                { id: 3, name: 'George Martin', role: 'Producer' },
            ];

            const writers = importer.extractWriters(extraartists);

            expect(writers).toHaveLength(2);
            expect(writers[0].name).toBe('John Lennon');
            expect(writers[0].person_id).toBe('discogs:artist/1');
            expect(writers[1].name).toBe('Paul McCartney');
        });

        test('should match Composer role', () => {
            const extraartists = [
                { id: 10, name: 'Bach', role: 'Composer' },
            ];

            const writers = importer.extractWriters(extraartists);
            expect(writers).toHaveLength(1);
            expect(writers[0].name).toBe('Bach');
        });

        test('should match Songwriter role', () => {
            const extraartists = [
                { id: 20, name: 'Bob Dylan', role: 'Songwriter' },
            ];

            const writers = importer.extractWriters(extraartists);
            expect(writers).toHaveLength(1);
        });

        test('should exclude non-writer roles', () => {
            const extraartists = [
                { id: 3, name: 'George Martin', role: 'Producer' },
                { id: 4, name: 'Geoff Emerick', role: 'Engineer' },
                { id: 5, name: 'Klaus Voormann', role: 'Bass' },
            ];

            const writers = importer.extractWriters(extraartists);
            expect(writers).toHaveLength(0);
        });

        test('should return empty array for null/undefined input', () => {
            expect(importer.extractWriters(null)).toEqual([]);
            expect(importer.extractWriters(undefined)).toEqual([]);
        });
    });

    describe('processDiscogsTracklist', () => {

        test('should convert tracklist to Polaris tracks and songs', () => {
            const tracklist = [
                { position: 'A1', title: 'Come Together', duration: '4:19', type_: 'track' },
                { position: 'A2', title: 'Something', duration: '3:02', type_: 'track' },
            ];
            const releaseArtists = [{ id: 82730, name: 'The Beatles' }];

            const result = importer.processDiscogsTracklist(tracklist, releaseArtists, []);

            expect(result.tracks).toHaveLength(2);
            expect(result.songs).toHaveLength(2);
            expect(result.tracklist).toHaveLength(2);

            expect(result.songs[0].title).toBe('Come Together');
            expect(result.tracks[0].title).toBe('Come Together');
            expect(result.tracks[0].duration).toBe(259); // 4:19
            expect(result.tracks[0].performers[0].group_id).toBe('discogs:artist/82730');
        });

        test('should skip heading entries', () => {
            const tracklist = [
                { position: '', title: 'Side A', type_: 'heading' },
                { position: 'A1', title: 'Track One', duration: '3:00', type_: 'track' },
            ];

            const result = importer.processDiscogsTracklist(tracklist, [], []);
            expect(result.tracks).toHaveLength(1);
            expect(result.tracks[0].title).toBe('Track One');
        });

        test('should skip entries without title', () => {
            const tracklist = [
                { position: 'A1', title: '', duration: '3:00', type_: 'track' },
                { position: 'A2', title: 'Real Track', duration: '4:00', type_: 'track' },
            ];

            const result = importer.processDiscogsTracklist(tracklist, [], []);
            expect(result.tracks).toHaveLength(1);
        });

        test('should generate deterministic track and song IDs', () => {
            const tracklist = [
                { position: 'A1', title: 'Come Together', duration: '4:19', type_: 'track' },
            ];

            const result1 = importer.processDiscogsTracklist(tracklist, [], []);
            const result2 = importer.processDiscogsTracklist(tracklist, [], []);

            expect(result1.tracks[0].track_id).toBe(result2.tracks[0].track_id);
            expect(result1.songs[0].song_id).toBe(result2.songs[0].song_id);
        });

        test('should use track-specific artists when provided', () => {
            const tracklist = [
                {
                    position: 'A1',
                    title: 'Track With Guest',
                    duration: '3:00',
                    type_: 'track',
                    artists: [{ id: 999, name: 'Guest Artist' }],
                },
            ];
            const releaseArtists = [{ id: 82730, name: 'The Beatles' }];

            const result = importer.processDiscogsTracklist(tracklist, releaseArtists, []);
            expect(result.tracks[0].performers[0].group_id).toBe('discogs:artist/999');
        });
    });

    describe('calculateHash', () => {

        test('should produce a 64-character hex string', () => {
            const event = {
                v: 1,
                type: 'CREATE_RELEASE_BUNDLE',
                author_pubkey: 'PUB_K1_test',
                created_at: 1700000000,
                parents: [],
                body: { release: { name: 'Test' } },
            };

            const hash = importer.calculateHash(event);
            expect(hash).toMatch(/^[a-f0-9]{64}$/);
        });

        test('should produce deterministic hashes', () => {
            const event = {
                v: 1,
                type: 'CREATE_RELEASE_BUNDLE',
                created_at: 1700000000,
                body: { data: 'test' },
            };

            const hash1 = importer.calculateHash(event);
            const hash2 = importer.calculateHash(event);
            expect(hash1).toBe(hash2);
        });

        test('should exclude signature from hash calculation', () => {
            const event = {
                v: 1,
                type: 'CREATE_RELEASE_BUNDLE',
                created_at: 1700000000,
                body: { data: 'test' },
            };

            const eventWithSig = {
                ...event,
                sig: 'SIG_K1_fakesignature',
            };

            expect(importer.calculateHash(event)).toBe(importer.calculateHash(eventWithSig));
        });
    });

    describe('createEvent', () => {

        test('should create a properly structured event', () => {
            const body = { release: { name: 'Test Album' } };
            const event = importer.createEvent('CREATE_RELEASE_BUNDLE', body, 'alice');

            expect(event.v).toBe(1);
            expect(event.type).toBe('CREATE_RELEASE_BUNDLE');
            expect(event.author_pubkey).toBe('PUB_K1_alice');
            expect(event.parents).toEqual([]);
            expect(event.body).toBe(body);
            expect(event.created_at).toBeGreaterThan(0);
        });
    });

    describe('convertReleaseToBundle', () => {

        test('should convert a Discogs release to Polaris bundle format', async () => {
            const discogsRelease = {
                id: 12345,
                title: 'Abbey Road',
                released: '1969-09-26',
                year: 1969,
                country: 'UK',
                formats: [{ name: 'Vinyl' }],
                labels: [{ id: 100, name: 'Apple Records', catno: 'PCS 7088' }],
                master_id: 9999,
                notes: 'Remastered',
                artists: [{ id: 82730, name: 'The Beatles', join: '' }],
                tracklist: [
                    { position: 'A1', title: 'Come Together', duration: '4:19', type_: 'track' },
                    { position: 'A2', title: 'Something', duration: '3:02', type_: 'track' },
                ],
                extraartists: [],
            };

            const bundle = await importer.convertReleaseToBundle(discogsRelease);

            expect(bundle.release.release_id).toBe('discogs:release/12345');
            expect(bundle.release.name).toBe('Abbey Road');
            expect(bundle.release.master_id).toBe('discogs:master/9999');
            expect(bundle.release.label_id).toBe('discogs:label/100');
            expect(bundle.release.label_name).toBe('Apple Records');
            expect(bundle.groups).toHaveLength(1);
            expect(bundle.tracks).toHaveLength(2);
            expect(bundle.songs).toHaveLength(2);
            expect(bundle.sources[0].type).toBe('discogs');
        });
    });

    describe('getStats', () => {

        test('should return copy of stats', () => {
            const stats = importer.getStats();
            expect(stats).toEqual({ releases: 0, artists: 0, tracks: 0, errors: 0 });

            // Modifying returned stats should not affect internal state
            stats.releases = 999;
            expect(importer.getStats().releases).toBe(0);
        });
    });
});
