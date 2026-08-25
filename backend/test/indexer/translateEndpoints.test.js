/**
 * Unit tests for endpoint id translation in the release-bundle post-merge step.
 *
 * Background: extractRelationships works from the normalized bundle, so its
 * endpoints carry normalizer ids (prov:track:<sha of title+duration>).
 * processReleaseBundle creates the nodes under resolveEntityId fingerprints.
 * Untranslated, the two id schemes never meet — which is how mergeBundle came
 * to mint bare twin nodes holding only {id, name, status, track_id}.
 */

import { describe, test, expect } from '@jest/globals';
import { translateEndpoints } from '../../src/indexer/eventProcessor.js';

const resolvedIds = {
    person: new Map([['prov:person:aaa', 'prov:person:1111111111111111']]),
    group: new Map([['prov:group:bbb', 'prov:group:2222222222222222']]),
    track: new Map([['prov:track:ccc', 'prov:track:3333333333333333']]),
    song: new Map(),
    release: new Map(),
    label: new Map()
};

const rel = (from, to, type = 'PERFORMED_ON') => ({ type, from, to, props: { role: 'performer' } });

describe('translateEndpoints', () => {
    test('rewrites both endpoints to the ids the nodes were created under', () => {
        const out = translateEndpoints(rel(
            { label: 'Group', idProp: 'group_id', id: 'prov:group:bbb', name: 'A Band' },
            { label: 'Track', idProp: 'track_id', id: 'prov:track:ccc', name: 'A Song' }
        ), resolvedIds);

        expect(out.from.id).toBe('prov:group:2222222222222222');
        expect(out.to.id).toBe('prov:track:3333333333333333');
    });

    test('leaves everything else on the descriptor intact', () => {
        const input = rel(
            { label: 'Group', idProp: 'group_id', id: 'prov:group:bbb', name: 'A Band' },
            { label: 'Track', idProp: 'track_id', id: 'prov:track:ccc', name: 'A Song' }
        );
        const out = translateEndpoints(input, resolvedIds);

        expect(out.type).toBe('PERFORMED_ON');
        expect(out.props).toEqual({ role: 'performer' });
        expect(out.from.label).toBe('Group');
        expect(out.from.name).toBe('A Band');
        expect(out.to.idProp).toBe('track_id');
    });

    test('does not mutate the input descriptor', () => {
        const input = rel(
            { label: 'Group', idProp: 'group_id', id: 'prov:group:bbb', name: 'A Band' },
            { label: 'Track', idProp: 'track_id', id: 'prov:track:ccc', name: 'A Song' }
        );
        translateEndpoints(input, resolvedIds);

        expect(input.from.id).toBe('prov:group:bbb');
        expect(input.to.id).toBe('prov:track:ccc');
    });

    test('passes through an id with no mapping', () => {
        const out = translateEndpoints(rel(
            { label: 'Person', idProp: 'person_id', id: 'prov:person:unmapped', name: 'Nobody' },
            { label: 'Track', idProp: 'track_id', id: 'prov:track:ccc', name: 'A Song' }
        ), resolvedIds);

        expect(out.from.id).toBe('prov:person:unmapped');
        expect(out.to.id).toBe('prov:track:3333333333333333');
    });

    test('leaves name-matched endpoints (no id) alone', () => {
        const out = translateEndpoints(rel(
            { label: 'Person', idProp: 'person_id', id: null, name: 'Dave Grohl' },
            { label: 'Track', idProp: 'track_id', id: 'prov:track:ccc', name: 'A Song' }
        ), resolvedIds);

        expect(out.from.id).toBeNull();
        expect(out.from.name).toBe('Dave Grohl');
        expect(out.to.id).toBe('prov:track:3333333333333333');
    });

    test('is a no-op when the bundle returned no id maps', () => {
        const input = rel(
            { label: 'Group', idProp: 'group_id', id: 'prov:group:bbb', name: 'A Band' },
            { label: 'Track', idProp: 'track_id', id: 'prov:track:ccc', name: 'A Song' }
        );

        expect(translateEndpoints(input, undefined)).toBe(input);
        expect(translateEndpoints(input, null)).toBe(input);
    });

    test('ignores a label with no registry entry', () => {
        const out = translateEndpoints(rel(
            { label: 'Master', idProp: 'master_id', id: 'prov:master:zzz', name: 'A Master' },
            { label: 'Track', idProp: 'track_id', id: 'prov:track:ccc', name: 'A Song' }
        ), resolvedIds);

        expect(out.from.id).toBe('prov:master:zzz');
    });
});
