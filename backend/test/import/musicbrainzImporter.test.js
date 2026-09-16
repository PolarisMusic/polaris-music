/**
 * The MusicBrainz importer's transform, pinned against a recorded-shape fixture.
 *
 * The point of these tests is the first one: whatever the transform produces has
 * to survive `validateReleaseBundle`, because every object in the bundle schema
 * sets `additionalProperties: false` and a single stray key fails the whole
 * submission — on the submit path and again inside `processReleaseBundle`.
 *
 * This is not hypothetical. None of the 29 bundles in `smoke-tests/releases/`
 * passes that validator: they carry `track.groups` and a top-level `labels`
 * array, neither of which is in the canonical schema. They load anyway because
 * `scripts/loadSmokeTests.js` writes to Neo4j directly without validating. An
 * importer that copied their dialect would produce data that can never be
 * submitted through the real path.
 *
 * No network: the transform is pure and takes recorded JSON.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { MusicBrainzImporter } from '../../../tools/import/musicbrainzImporter.js';
import { validateReleaseBundle } from '../../src/schema/validateReleaseBundle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = () => JSON.parse(
    readFileSync(resolve(__dirname, 'fixtures/musicbrainz-release.fixture.json'), 'utf8')
);

const build = (config = {}, context = {}) =>
    new MusicBrainzImporter({ contact: 'test@example.com', ...config })
        .buildBundle(fixture(), context);

describe('the emitted bundle is accepted by the canonical validator', () => {
    it('validates with external ids', () => {
        const result = validateReleaseBundle(build());
        expect(result.errors || []).toEqual([]);
        expect(result.valid).toBe(true);
    });

    it('validates with ids omitted, for prov: minting downstream', () => {
        const result = validateReleaseBundle(build({ externalIds: false }));
        expect(result.errors || []).toEqual([]);
        expect(result.valid).toBe(true);
    });

    it('validates with resolved band membership attached', () => {
        const membersByArtist = new Map([[
            '00000000-0000-4000-8000-0000000000b1',
            [{ name: 'Brant Bjork', roles: ['drums'], from_date: '1987', to_date: '1993' }]
        ]]);
        const result = validateReleaseBundle(build({}, { membersByArtist }));
        expect(result.errors || []).toEqual([]);
        expect(result.valid).toBe(true);
    });
});

describe('release and label mapping', () => {
    it('carries the catalogue number on the label, inside release.labels', () => {
        const { release } = build();
        expect(release.labels).toEqual([{
            label_id: 'mb:label:00000000-0000-4000-8000-0000000000d1',
            name: 'Dali Records',
            catalog_number: 'CD 61340'
        }]);
    });

    it('maps the release group to master_id, not to the release id', () => {
        const { release } = build();
        expect(release.release_id).toBe('mb:release:00000000-0000-4000-8000-0000000000aa');
        expect(release.master_id).toBe('mb:release-group:00000000-0000-4000-8000-0000000000c1');
    });

    it('attaches release-level credits as release guests', () => {
        const { release } = build();
        expect(release.guests).toEqual([
            { person_id: 'mb:artist:00000000-0000-4000-8000-0000000000e9', name: 'Eddy Schreyer', roles: ['mastering'] }
        ]);
    });
});

describe('performance credits — the authorship/performance split', () => {
    const track = () => build().tracks[0];

    it('converts milliseconds to seconds', () => {
        expect(track().duration).toBe(296);
    });

    it('keeps the ISRC, which normalizeReleaseBundle uses to key prov: track ids', () => {
        expect(track().isrc).toBe('USDA19200001');
    });

    it('records each performer with the instrument named', () => {
        const garcia = track().guests.find(g => g.name === 'John Garcia');
        expect(garcia.roles).toEqual(['lead vocals']);
    });

    it('merges a multi-instrumentalist into one credit with several roles', () => {
        const bjork = track().guests.filter(g => g.name === 'Brant Bjork');
        expect(bjork).toHaveLength(1);
        expect(bjork[0].roles.sort()).toEqual(['drums (drum set)', 'percussion']);
        expect(bjork[0].instruments.sort()).toEqual(['drums (drum set)', 'percussion']);
    });

    it('does not file producers or arrangers as performers', () => {
        const t = track();
        expect(t.guests.map(g => g.name)).not.toContain('Chris Goss');
        expect(t.producers).toEqual([
            { person_id: 'mb:artist:00000000-0000-4000-8000-0000000000b6', name: 'Chris Goss', roles: ['producer'] }
        ]);
        expect(t.arrangers[0].name).toBe('Josh Homme');
    });

    it('emits performers as guests even when they are band members, because '
        + 'dropGuestsWhoAreMembers resolves the overlap downstream', () => {
        // Homme is a member and also has a per-track instrument credit. Losing
        // the track credit here would lose which instrument he played on which
        // recording, which is the whole point of the import.
        expect(track().guests.map(g => g.name)).toContain('Josh Homme');
    });
});

describe('compositions', () => {
    it('takes the song from the linked Work, with its ISWC', () => {
        const song = build().songs.find(s => s.title === 'Thumb');
        expect(song.song_id).toBe('mb:work:00000000-0000-4000-8000-000000000201');
        expect(song.iswc).toBe('T-123.456.789-0');
    });

    it('distinguishes composer from lyricist rather than flattening to "writer"', () => {
        const song = build().songs.find(s => s.title === 'Thumb');
        expect(song.writers).toEqual([
            { person_id: 'mb:artist:00000000-0000-4000-8000-0000000000b2', name: 'Josh Homme', role: 'composer' },
            {
                person_id: 'mb:artist:00000000-0000-4000-8000-0000000000b5',
                name: 'John Garcia',
                role: 'lyricist',
                credited_as: 'J. Garcia'
            }
        ]);
    });

    it('links the track to its song through recording_of', () => {
        const bundle = build();
        expect(bundle.tracks[0].recording_of)
            .toBe('mb:work:00000000-0000-4000-8000-000000000201');
    });

    it('still emits a song when the recording has no linked Work, so the '
        + 'one-track-one-song invariant holds', () => {
        const bundle = build();
        expect(bundle.songs.map(s => s.title)).toContain('Green Machine');
        const song = bundle.songs.find(s => s.title === 'Green Machine');
        expect(song.song_id).toBeUndefined();
        expect(song.iswc).toBeUndefined();
    });
});

describe('tracklist', () => {
    it('prefixes positions with the disc number on multi-disc releases', () => {
        const positions = build().tracklist.map(t => t.position);
        expect(positions).toEqual(['1-1', '1-2', '2-1']);
    });

    it('preserves MusicBrainz track numbers rather than renumbering, so vinyl '
        + 'side labels survive', () => {
        const single = { ...fixture(), media: [fixture().media[0]] };
        const bundle = new MusicBrainzImporter({ contact: 'test@example.com' }).buildBundle(single);
        expect(bundle.tracklist.map(t => t.position)).toEqual(['1', '2']);
    });
});

describe('rate limiting', () => {
    it('spaces requests at least rateLimitMs apart', async () => {
        const times = [];
        const fetchImpl = async () => {
            times.push(Date.now());
            return { ok: true, status: 200, json: async () => ({ id: 'x', relations: [] }) };
        };
        const importer = new MusicBrainzImporter({
            contact: 'test@example.com', rateLimitMs: 50, fetchImpl
        });
        await importer.fetchArtist('a');
        await importer.fetchArtist('b');
        expect(times[1] - times[0]).toBeGreaterThanOrEqual(45);
    });

    it('names the rate limit when MusicBrainz returns 503', async () => {
        const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
        const importer = new MusicBrainzImporter({
            contact: 'test@example.com', rateLimitMs: 0, fetchImpl
        });
        await expect(importer.fetchRelease('x')).rejects.toThrow(/rate limit/i);
    });
});
