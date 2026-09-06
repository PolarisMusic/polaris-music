/**
 * The validator must accept a catalogue number on a label.
 *
 * There are two copies of the release-bundle JSON schema in this repo —
 * `shared/schemas/releaseBundle.schema.json` and
 * `backend/src/schema/releaseBundle.schema.json` — and the validator reads the
 * backend one. Adding a field to the shared copy alone therefore changes
 * nothing: `additionalProperties: false` on Label rejects the submission with
 * "Unknown field", on the submit path *and* again inside processReleaseBundle.
 *
 * That is exactly what happened when per-label catalogue numbers were added,
 * and nothing caught it until the bundle was run through the real validator.
 * These tests do that.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { validateReleaseBundle } from '../../src/schema/validateReleaseBundle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readSchema = (p) => JSON.parse(readFileSync(resolve(__dirname, p), 'utf8'));

const bundleWith = (labels) => ({
    release: { name: 'Bleach', release_date: '1989', format: 'LP', labels },
    tracks: [{ title: 'Blew' }],
    tracklist: [{ position: '1', track_title: 'Blew' }]
});

describe('per-label catalogue numbers pass validation', () => {
    it('accepts a single label carrying its catalogue number', () => {
        const result = validateReleaseBundle(bundleWith([
            { name: 'Sub Pop', catalog_number: 'SP 34' }
        ]));
        expect(result.errors).toBeUndefined();
        expect(result.valid).toBe(true);
    });

    it('accepts a co-issue where each label carries its own number', () => {
        const result = validateReleaseBundle(bundleWith([
            { name: 'Sub Pop', catalog_number: 'SP 34' },
            { name: 'Tupelo', catalog_number: 'TUP 8' }
        ]));
        expect(result.valid).toBe(true);
    });

    it('still accepts a label with no catalogue number', () => {
        expect(validateReleaseBundle(bundleWith([{ name: 'Sub Pop' }])).valid).toBe(true);
    });

    it('still rejects a genuinely unknown field on a label', () => {
        // The guard that caught this must stay switched on.
        const result = validateReleaseBundle(bundleWith([
            { name: 'Sub Pop', cataloge_numbr: 'typo' }
        ]));
        expect(result.valid).toBe(false);
    });
});

describe('the two copies of the bundle schema agree about Label', () => {
    // They have drifted before, in both directions. This does not demand the
    // whole files match — they already differ elsewhere — only that the shape
    // a submitter is validated against matches the shape the shared contract
    // advertises for the object being changed here.
    const backend = readSchema('../../src/schema/releaseBundle.schema.json');
    const shared = readSchema('../../../shared/schemas/releaseBundle.schema.json');

    it('exposes the same Label properties in both copies', () => {
        expect(Object.keys(backend.definitions.Label.properties).sort())
            .toEqual(Object.keys(shared.definitions.Label.properties).sort());
    });

    it('keeps Label closed to unknown fields in both copies', () => {
        expect(backend.definitions.Label.additionalProperties).toBe(false);
        expect(shared.definitions.Label.additionalProperties).toBe(false);
    });
});
