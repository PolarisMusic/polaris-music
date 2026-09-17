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

describe('the two copies of the bundle schema agree', () => {
    // They have drifted before, in both directions, and always silently: the
    // validator reads only the backend copy, so a field added to the shared one
    // alone changes nothing, and a field added to the backend one alone leaves
    // the published contract understating what a submitter may send.
    //
    // This used to check Label alone, which let the rest drift. By the time it
    // was widened the shared copy was six fields behind — `schema_version`,
    // `release.listen_links`, and `Track.song_id` / `lyrics` / `trivia` — none
    // of it caught by anything. Compare the whole shape instead: it costs one
    // assertion and there is no case where the two copies should disagree.
    const backend = readSchema('../../src/schema/releaseBundle.schema.json');
    const shared = readSchema('../../../shared/schemas/releaseBundle.schema.json');

    /** Every property path in the schema, so a diff names the field that moved. */
    const propertyPaths = (node, prefix = '') => {
        const paths = [];
        for (const [name, value] of Object.entries(node.properties || {})) {
            paths.push(prefix + name);
            if (value && typeof value === 'object') {
                paths.push(...propertyPaths(value, `${prefix}${name}.`));
                if (value.items && typeof value.items === 'object') {
                    paths.push(...propertyPaths(value.items, `${prefix}${name}[].`));
                }
            }
        }
        return paths.sort();
    };

    it('declares the same top-level and release properties', () => {
        expect(propertyPaths(shared)).toEqual(propertyPaths(backend));
    });

    it('declares the same definitions', () => {
        expect(Object.keys(shared.definitions || {}).sort())
            .toEqual(Object.keys(backend.definitions || {}).sort());
    });

    it.each(Object.keys(backend.definitions || {}))('declares the same %s shape', (name) => {
        expect(propertyPaths(shared.definitions[name]))
            .toEqual(propertyPaths(backend.definitions[name]));
        expect(shared.definitions[name].required || [])
            .toEqual(backend.definitions[name].required || []);
    });

    it('keeps every definition closed to unknown fields in both copies', () => {
        // A definition that quietly opens up stops rejecting typos, and the
        // bundle reaches processReleaseBundle carrying fields nothing reads.
        for (const [name, definition] of Object.entries(backend.definitions || {})) {
            expect([name, definition.additionalProperties]).toEqual([name, false]);
            expect([name, shared.definitions[name].additionalProperties]).toEqual([name, false]);
        }
    });
});
