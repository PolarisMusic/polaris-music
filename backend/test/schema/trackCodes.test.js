/**
 * The validator must accept the two things the Spotify cross-check resolves:
 * a track's ISRC and the other spelling of its title.
 *
 * Both are written into hidden fields on the submission form, so nothing on
 * screen shows them and nothing in the form will complain if they are rejected.
 * `additionalProperties: false` on Track would reject the whole submission with
 * "Unknown field" — on the submit path and again inside processReleaseBundle —
 * and the first visible symptom would be a release that will not submit at all.
 *
 * The same trap caught per-label catalogue numbers (see labelCatalogNumber.test.js):
 * the repo holds two copies of this schema and the validator reads only one.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { validateReleaseBundle } from '../../src/schema/validateReleaseBundle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readSchema = (p) => JSON.parse(readFileSync(resolve(__dirname, p), 'utf8'));

const bundleWith = (track) => ({
    release: { name: 'Fire of Unknown Origin', release_date: '1981', format: 'LP' },
    tracks: [track],
    tracklist: [{ position: '1', track_title: track.title }]
});

describe('a track may carry its ISRC and its other titles', () => {
    it('accepts an ISRC', () => {
        const result = validateReleaseBundle(bundleWith({
            title: 'Burnin’ For You', isrc: 'USSM17900123'
        }));
        expect(result.errors).toBeUndefined();
        expect(result.valid).toBe(true);
    });

    it('accepts alternate titles', () => {
        const result = validateReleaseBundle(bundleWith({
            title: 'Burnin’ For You', alt_titles: ['Burning For You']
        }));
        expect(result.errors).toBeUndefined();
        expect(result.valid).toBe(true);
    });

    it('accepts both at once, which is how they arrive', () => {
        expect(validateReleaseBundle(bundleWith({
            title: 'Veteran Of The Psychic Wars',
            isrc: 'USSM17900124',
            alt_titles: ['Veteran of the Psychic War'],
            listen_links: ['https://open.spotify.com/track/abc'],
        })).valid).toBe(true);
    });

    it('rejects the singular spelling', () => {
        // `track-alt-title-N` is the form field; `alt_titles` is the bundle
        // key. Confusing the two is the likely mistake, and the guard that
        // catches it must stay switched on.
        expect(validateReleaseBundle(bundleWith({
            title: 'Joan Crawford', alt_title: 'Joan Crawford Has Risen'
        })).valid).toBe(false);
    });

    it('rejects alternate titles that are not strings', () => {
        expect(validateReleaseBundle(bundleWith({
            title: 'Vengeance', alt_titles: [{ title: 'Vengeance (The Pact)' }]
        })).valid).toBe(false);
    });
});

describe('the two copies of the bundle schema agree about Track', () => {
    // They have drifted before, in both directions, and the validator reads
    // only the backend copy — so adding a field to the shared one alone changes
    // nothing while looking as though it changed everything.
    const backend = readSchema('../../src/schema/releaseBundle.schema.json');
    const shared = readSchema('../../../shared/schemas/releaseBundle.schema.json');

    it('exposes alt_titles and isrc in both copies', () => {
        for (const schema of [backend, shared]) {
            expect(Object.keys(schema.definitions.Track.properties))
                .toEqual(expect.arrayContaining(['isrc', 'alt_titles']));
        }
    });

    it('keeps Track closed to unknown fields in both copies', () => {
        expect(backend.definitions.Track.additionalProperties).toBe(false);
        expect(shared.definitions.Track.additionalProperties).toBe(false);
    });

    it('describes alt_titles the same way in both copies', () => {
        expect(backend.definitions.Track.properties.alt_titles)
            .toEqual(shared.definitions.Track.properties.alt_titles);
    });
});
