/**
 * Load and Performance Tests
 *
 * Benchmarks for core computation paths that must stay within targets:
 * - Hash calculation: <1ms per event
 * - Data transformation: <5ms per release bundle
 * - Validation logic: <0.5ms per check
 * - Batch processing throughput: >1000 validations/sec
 */

import { createHash } from 'crypto';
import stringify from 'fast-json-stable-stringify';

/**
 * Helper: create a realistic release bundle for benchmarking
 */
function createSampleBundle(trackCount = 12) {
    const groups = [{
        group_id: 'grp_beatles',
        name: 'The Beatles',
        members: [
            { person_id: 'per_lennon', name: 'John Lennon', roles: ['vocals', 'guitar'] },
            { person_id: 'per_mccartney', name: 'Paul McCartney', roles: ['vocals', 'bass'] },
            { person_id: 'per_harrison', name: 'George Harrison', roles: ['guitar'] },
            { person_id: 'per_starr', name: 'Ringo Starr', roles: ['drums'] },
        ]
    }];

    const tracks = [];
    const songs = [];
    for (let i = 1; i <= trackCount; i++) {
        const songId = `song_${i}`;
        const trackId = `track_${i}`;
        songs.push({
            song_id: songId,
            title: `Song Number ${i}`,
            writers: [
                { person_id: 'per_lennon', name: 'John Lennon' },
                { person_id: 'per_mccartney', name: 'Paul McCartney' },
            ]
        });
        tracks.push({
            track_id: trackId,
            song_id: songId,
            title: `Song Number ${i}`,
            position: `${i}`,
            duration: 180 + i * 10,
            performers: [{ group_id: 'grp_beatles', name: 'The Beatles' }]
        });
    }

    return {
        release: {
            release_id: 'rel_white_album',
            name: 'The White Album',
            release_date: '1968-11-22',
            format: ['Vinyl', 'CD'],
            country: 'UK',
        },
        groups,
        songs,
        tracks,
        tracklist: tracks.map((t, i) => ({ track_id: t.track_id, position: i + 1 })),
    };
}

describe('Performance Tests', () => {

    describe('Hash Calculation Performance', () => {

        test('should compute SHA256 hash in <1ms per event', () => {
            const bundle = createSampleBundle();
            const event = {
                v: 1,
                type: 'CREATE_RELEASE_BUNDLE',
                author_pubkey: 'PUB_K1_testkey',
                created_at: Math.floor(Date.now() / 1000),
                parents: [],
                body: bundle,
            };

            const iterations = 1000;
            const start = performance.now();

            for (let i = 0; i < iterations; i++) {
                const canonical = stringify(event);
                createHash('sha256').update(canonical).digest('hex');
            }

            const elapsed = performance.now() - start;
            const perOp = elapsed / iterations;

            expect(perOp).toBeLessThan(1); // <1ms per hash
        });

        test('should handle 1000+ hashes per second', () => {
            const payload = JSON.stringify({ data: 'x'.repeat(1024) });
            const iterations = 2000;

            const start = performance.now();
            for (let i = 0; i < iterations; i++) {
                createHash('sha256').update(payload).digest('hex');
            }
            const elapsed = performance.now() - start;

            const opsPerSecond = (iterations / elapsed) * 1000;
            expect(opsPerSecond).toBeGreaterThan(1000);
        });
    });

    describe('Data Transformation Performance', () => {

        test('should serialize a 12-track bundle in <5ms', () => {
            const bundle = createSampleBundle(12);
            const iterations = 500;

            const start = performance.now();
            for (let i = 0; i < iterations; i++) {
                stringify(bundle);
            }
            const elapsed = performance.now() - start;
            const perOp = elapsed / iterations;

            expect(perOp).toBeLessThan(5);
        });

        test('should serialize a 30-track bundle in <10ms', () => {
            const bundle = createSampleBundle(30);
            const iterations = 200;

            const start = performance.now();
            for (let i = 0; i < iterations; i++) {
                stringify(bundle);
            }
            const elapsed = performance.now() - start;
            const perOp = elapsed / iterations;

            expect(perOp).toBeLessThan(10);
        });
    });

    describe('Validation Logic Performance', () => {

        const MIN_EVENT_TYPE = 1;
        const MAX_EVENT_TYPE = 99;
        const MIN_VALID_TIMESTAMP = 1672531200;
        const MAX_TAGS = 10;

        function validateEvent(event) {
            if (event.type < MIN_EVENT_TYPE || event.type > MAX_EVENT_TYPE) return false;
            if (event.timestamp < MIN_VALID_TIMESTAMP) return false;
            if (event.timestamp > Math.floor(Date.now() / 1000) + 300) return false;
            if (event.tags && event.tags.length > MAX_TAGS) return false;
            if (!event.hash || typeof event.hash !== 'string') return false;
            if (event.hash.length !== 64) return false;
            return true;
        }

        test('should validate >10000 events per second', () => {
            const event = {
                type: 21,
                timestamp: Math.floor(Date.now() / 1000),
                tags: ['rock', 'album'],
                hash: 'a'.repeat(64),
            };

            const iterations = 50000;
            const start = performance.now();
            for (let i = 0; i < iterations; i++) {
                validateEvent(event);
            }
            const elapsed = performance.now() - start;

            const opsPerSecond = (iterations / elapsed) * 1000;
            expect(opsPerSecond).toBeGreaterThan(10000);
        });

        test('should validate <0.5ms per event', () => {
            const event = {
                type: 21,
                timestamp: Math.floor(Date.now() / 1000),
                tags: ['rock', 'album', '1970s', 'progressive'],
                hash: 'b'.repeat(64),
            };

            const iterations = 10000;
            const start = performance.now();
            for (let i = 0; i < iterations; i++) {
                validateEvent(event);
            }
            const elapsed = performance.now() - start;
            const perOp = elapsed / iterations;

            expect(perOp).toBeLessThan(0.5);
        });
    });

    describe('Approval Calculation Performance', () => {

        function calculateApproval(upVotes, totalVotes, thresholdBP) {
            return (totalVotes > 0) && (upVotes * 10000 >= totalVotes * thresholdBP);
        }

        test('should compute 100000+ approval checks per second', () => {
            const iterations = 100000;
            const start = performance.now();

            for (let i = 0; i < iterations; i++) {
                calculateApproval(90 + (i % 10), 100, 9000);
            }

            const elapsed = performance.now() - start;
            const opsPerSecond = (iterations / elapsed) * 1000;
            expect(opsPerSecond).toBeGreaterThan(100000);
        });
    });

    describe('JSON Parse/Stringify Throughput', () => {

        test('should parse+stringify event payloads at >500 ops/sec', () => {
            const bundle = createSampleBundle(12);
            const json = JSON.stringify(bundle);
            const iterations = 1000;

            const start = performance.now();
            for (let i = 0; i < iterations; i++) {
                const parsed = JSON.parse(json);
                JSON.stringify(parsed);
            }
            const elapsed = performance.now() - start;

            const opsPerSecond = (iterations / elapsed) * 1000;
            expect(opsPerSecond).toBeGreaterThan(500);
        });
    });

    describe('Relationship Extraction Performance', () => {
        test('should extract relationships from 100+ bundles in <5s', async () => {
            const { normalizeReleaseBundle } = await import('../../src/graph/normalizeReleaseBundle.js');

            const bundles = [];
            for (let i = 0; i < 100; i++) {
                bundles.push({
                    release: {
                        name: `Album ${i}`,
                        release_id: `rel_${i}`
                    },
                    groups: [{
                        group_id: `grp_${i}`,
                        name: `Band ${i}`,
                        members: [
                            { person_id: 'shared_person_1', name: 'Shared Artist', roles: ['vocals'] },
                            { person_id: `person_${i}`, name: `Artist ${i}`, roles: ['guitar'] }
                        ]
                    }],
                    tracks: [{
                        track_id: `trk_${i}_1`,
                        title: `Track ${i}`,
                        duration: 200,
                        performed_by_groups: [{ group_id: `grp_${i}`, name: `Band ${i}` }]
                    }],
                    tracklist: [{
                        track_id: `trk_${i}_1`,
                        position: '1',
                        track_title: `Track ${i}`
                    }]
                });
            }

            const start = performance.now();
            let totalRels = 0;
            for (const bundle of bundles) {
                const normalized = normalizeReleaseBundle(bundle);
                totalRels += normalized.relationships.length;
            }
            const elapsed = performance.now() - start;

            // 100 bundles with 2 MEMBER_OF + 1 PERFORMED_ON each = 300 relationships
            expect(totalRels).toBeGreaterThanOrEqual(300);
            expect(elapsed).toBeLessThan(5000); // <5 seconds
        });
    });
});
