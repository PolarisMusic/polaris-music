/**
 * The curate detail parser, which had no tests at all.
 *
 * That absence is the whole story here. Stored events carry their type as a
 * *name* — a body reads `"type":"CREATE_RELEASE_BUNDLE"`, not `"type":21` — and
 * the parser compared it against numeric literals. A string never equals a
 * number, so every release bundle fell through to the unrecognized-type
 * fallback and the UI reported "Unsupported operation type for detailed view"
 * for operations whose anchors were sitting there perfectly intact.
 *
 * The snapshot tests did not catch it because they hand the frontend a
 * ready-made `detail` object with `type: 'release_bundle'`, jumping straight
 * over the parser that produces it. So these go at the parser directly, and
 * every case runs against both representations of the type.
 */

import { describe, test, expect } from '@jest/globals';
import { parseOperationDetail } from '../../src/api/routes/curate.js';
import { EVENT_TYPES } from '../../src/constants/eventTypes.js';

/**
 * Build a stored event both ways round: as the event store holds it (type name)
 * and as the chain reports it (type code).
 *
 * @param {string} name - Event type name.
 * @param {Object} body
 * @returns {Array<[string, Object]>} [label, event] pairs for test.each.
 */
function bothShapes(name, body) {
    return [
        [`${name} as a type name`, { type: name, body }],
        [`${name} as a type code`, { type: EVENT_TYPES[name], body }],
    ];
}

const RELEASE_BODY = {
    release: {
        name: 'Songs For The Deaf', release_date: '2002', format: 'CD',
        labels: [{ name: 'Interscope Records' }],
        guests: [{ name: 'Eric Valentine', roles: ['producer'] }],
    },
    groups: [{ name: 'Queens of the Stone Age', members: [{ name: 'Josh Homme' }] }],
    tracks: [{ title: 'No One Knows', performed_by_groups: [{ name: 'Queens of the Stone Age' }] }],
    songs: [{ title: 'No One Knows', writers: [{ name: 'Josh Homme' }] }],
    sources: [{ url: 'https://example.org/liner-notes' }],
};

describe('a release bundle parses from either type representation', () => {
    test.each(bothShapes('CREATE_RELEASE_BUNDLE', RELEASE_BODY))('%s', (_label, event) => {
        const detail = parseOperationDetail(event);

        // 'release_bundle' is what renderCurateDetail dispatches on. Anything
        // else lands in "Unsupported operation type for detailed view".
        expect(detail.type).toBe('release_bundle');
        expect(detail.release.name).toBe('Songs For The Deaf');
        expect(detail.groups[0].members[0].name).toBe('Josh Homme');
        expect(detail.tracks[0].title).toBe('No One Knows');
        expect(detail.songs[0].writers[0].name).toBe('Josh Homme');
    });
});

describe('claims parse from either type representation', () => {
    const body = { target_type: 'person', target_id: 'person:lennon', field: 'bio', value: 'Songwriter' };

    test.each(bothShapes('ADD_CLAIM', body))('%s', (_label, event) => {
        expect(parseOperationDetail(event)).toMatchObject({
            type: 'add_claim', target_type: 'person', field: 'bio',
        });
    });

    test.each(bothShapes('EDIT_CLAIM', body))('%s', (_label, event) => {
        expect(parseOperationDetail(event).type).toBe('edit_claim');
    });
});

describe('mint_entity and resolve_id are recognized rather than unsupported', () => {
    // These are anchored by put() and so appear in the feed, but had no case in
    // the parser and no label in the UI — the "TYPE 22" rows.
    const mintBody = {
        entity_type: 'person', canonical_id: 'person:mbid:abc',
        initial_claims: [{ field: 'name', value: 'Mark Lanegan' }],
        provenance: { source: 'musicbrainz' },
    };

    test.each(bothShapes('MINT_ENTITY', mintBody))('%s', (_label, event) => {
        expect(parseOperationDetail(event)).toMatchObject({
            type: 'mint_entity', entity_type: 'person', canonical_id: 'person:mbid:abc',
        });
    });

    test('mint_entity keeps its initial claims', () => {
        const detail = parseOperationDetail({ type: 'MINT_ENTITY', body: mintBody });
        expect(detail.initial_claims).toEqual([{ field: 'name', value: 'Mark Lanegan' }]);
    });

    const resolveBody = {
        subject_id: 'prov:person:913eff5c', canonical_id: 'person:mbid:abc',
        method: 'manual', confidence: 0.9, evidence: 'liner notes',
    };

    test.each(bothShapes('RESOLVE_ID', resolveBody))('%s', (_label, event) => {
        expect(parseOperationDetail(event)).toMatchObject({
            type: 'resolve_id', subject_id: 'prov:person:913eff5c', method: 'manual', confidence: 0.9,
        });
    });

    test('a confidence of zero survives as zero', () => {
        // A truthiness fallback would render "no confidence stated" for what is
        // actually a strong statement that the mapping is not trusted.
        const detail = parseOperationDetail({
            type: 'RESOLVE_ID', body: { ...resolveBody, confidence: 0 },
        });
        expect(detail.confidence).toBe(0);
    });
});

describe('inputs the parser cannot make sense of', () => {
    test.each([
        ['null', null],
        ['undefined', undefined],
        ['an event with no body', { type: 'ADD_CLAIM' }],
    ])('%s yields null', (_label, event) => {
        expect(parseOperationDetail(event)).toBeNull();
    });

    test('an unrecognized type falls back rather than throwing', () => {
        const detail = parseOperationDetail({ type: 'SOMETHING_NEW', body: { a: 1 } });

        // Unresolvable, so the fallback says so instead of naming a code it
        // guessed at.
        expect(detail.type).toBe('type_unknown');
        expect(detail.raw).toEqual({ a: 1 });
    });

    test('a known-but-unrendered type keeps its code in the fallback', () => {
        // VOTE resolves fine; there is simply no detail view for it. Keeping the
        // code distinguishes that from a type we could not identify at all.
        expect(parseOperationDetail({ type: 'VOTE', body: {} }).type).toBe('type_40');
    });
});
