/**
 * Telling a credit for playing on a record from a credit for working on it.
 *
 * `GUEST_ON` is a fallback bucket: everyone who is not a member of the
 * performing group lands in it, so Björk and the person who laid out the
 * booklet are indistinguishable. Because the whole bucket was hidden by
 * default, a submitter with an interesting session player to show had to file
 * them as a *member* to make the connection visible — a display default
 * corrupting the data. Splitting the bucket is what lets the musical half be
 * drawn and the technical half wait to be asked for.
 *
 * The table at the bottom is the contract. It runs printed Discogs role text
 * through the registry's own normalizer first, so it pins what actually lands
 * on an edge rather than what a role looks like before storage.
 */

import { describe, test, expect } from '@jest/globals';
import { isPerformanceRole, partitionRoles, creditIsMusical } from '../../src/graph/creditKind.js';
import { normalizeRoleInput } from '../../src/graph/roleNormalization.js';
import { roleDescribesRecording } from '../../../frontend/src/utils/creditScope.js';

describe('a single role', () => {
    test('an instrument is a performance', () => {
        expect(isPerformanceRole('guitar')).toBe(true);
        expect(isPerformanceRole('bass guitar')).toBe(true);
        expect(isPerformanceRole('backing vocals')).toBe(true);
    });

    test('an instrument nobody listed is still a performance', () => {
        // The whole reason the list names what to HIDE. Discogs credits
        // several hundred instruments and an allowlist cannot be finished —
        // and a missing one would make its player vanish, which is the exact
        // failure this split exists to end.
        expect(isPerformanceRole('ondes martenot')).toBe(true);
        expect(isPerformanceRole('bağlama')).toBe(true);
        expect(isPerformanceRole('theremin')).toBe(true);
        expect(isPerformanceRole('cuatro')).toBe(true);
    });

    test('capturing the sound is not playing it', () => {
        expect(isPerformanceRole('engineer')).toBe(false);
        expect(isPerformanceRole('mixing')).toBe(false);
        expect(isPerformanceRole('mastering')).toBe(false);
        expect(isPerformanceRole('recorded by')).toBe(false);
    });

    test('nor is making the object it came in', () => {
        expect(isPerformanceRole('artwork')).toBe(false);
        expect(isPerformanceRole('photography by')).toBe(false);
        expect(isPerformanceRole('liner notes')).toBe(false);
        expect(isPerformanceRole('lacquer cut by')).toBe(false);
    });

    test('a producer is a performance credit and an executive producer is not', () => {
        // Producing is an artistic hand on the recording. An executive
        // producer is its financier. "executive producer" is matched before
        // "producer", which it contains.
        expect(isPerformanceRole('producer')).toBe(true);
        expect(isPerformanceRole('co-producer')).toBe(true);
        expect(isPerformanceRole('executive producer')).toBe(false);
    });

    test('programming is playing; editing is not', () => {
        // In hip-hop and electronic music the programming IS the drum part,
        // so hiding it would hide the performance. Editing is work done to a
        // performance rather than a performance.
        expect(isPerformanceRole('programmed by')).toBe(true);
        expect(isPerformanceRole('programming')).toBe(true);
        expect(isPerformanceRole('edited by')).toBe(false);
    });

    test('a qualifier in brackets does not smuggle a role past the list', () => {
        // Catalogues qualify freely: "Engineer [Assistant]", "Photography By
        // [Group Photo]". Matching is on substrings for exactly this.
        expect(isPerformanceRole('engineer [assistant]')).toBe(false);
        expect(isPerformanceRole('photography by [group photo]')).toBe(false);
    });

    test('an empty role is not a performance, and says nothing either way', () => {
        expect(isPerformanceRole('')).toBe(false);
        expect(isPerformanceRole(null)).toBe(false);
        expect(isPerformanceRole(undefined)).toBe(false);
    });
});

describe('a credit with roles of both kinds', () => {
    test('is split, not sorted', () => {
        // "Mixed By, Guitar" is one human. Judging the person would lose one
        // of the two facts whichever way it went.
        expect(partitionRoles(['mixed by', 'guitar'])).toEqual({
            musical: ['guitar'],
            technical: ['mixed by'],
        });
    });

    test('and counts as musical, so the guitarist stays on the graph', () => {
        expect(creditIsMusical(['mixed by', 'guitar'])).toBe(true);
        expect(creditIsMusical(['engineer', 'backing vocals'])).toBe(true);
    });

    test('a credit that is only technical does not', () => {
        expect(creditIsMusical(['engineer'])).toBe(false);
        expect(creditIsMusical(['artwork', 'photography by'])).toBe(false);
    });

    test('blank entries are dropped rather than counted', () => {
        expect(partitionRoles(['guitar', '', null, '  '])).toEqual({
            musical: ['guitar'],
            technical: [],
        });
    });
});

describe('a credit with no roles at all', () => {
    test('counts as musical, because absence is not evidence of a sleeve designer', () => {
        // A credit nobody described is still a connection somebody recorded.
        // Same posture as creditScope.creditForTrack, which lets an
        // undescribed credit travel.
        expect(creditIsMusical([])).toBe(true);
        expect(creditIsMusical(null)).toBe(true);
        expect(creditIsMusical(undefined)).toBe(true);
    });

    test('and partitions to nothing on either side', () => {
        expect(partitionRoles(null)).toEqual({ musical: [], technical: [] });
    });
});

describe('this is not the same question as credit scope', () => {
    test('an engineer travels with the recording and is still not a performance', () => {
        // The two lists overlap without being the same, and this is where they
        // cross: creditScope asks whether a compilation carrying the track
        // would have a different credit — it would not, the recording was
        // engineered once — while this asks whether somebody played.
        expect(roleDescribesRecording('engineer')).toBe(true);
        expect(isPerformanceRole('engineer')).toBe(false);

        expect(roleDescribesRecording('mixing')).toBe(true);
        expect(isPerformanceRole('mixing')).toBe(false);
    });

    test('and they agree about the sleeve', () => {
        expect(roleDescribesRecording('artwork')).toBe(false);
        expect(isPerformanceRole('artwork')).toBe(false);
    });

    test('and about the band', () => {
        expect(roleDescribesRecording('guitar')).toBe(true);
        expect(isPerformanceRole('guitar')).toBe(true);
    });
});

describe('the contract, from printed credit to what is drawn', () => {
    /** [what Discogs prints, what is visible, what is hidden] */
    const TABLE = [
        ['Bass', 'bass guitar', ''],
        ['Drums', 'drums', ''],
        ['Guitar', 'guitar', ''],
        ['Backing Vocals', 'backing vocals', ''],
        ['Horns', 'horns', ''],
        ['Saxophone', 'saxophone', ''],
        ['Ondes Martenot', 'ondes martenot', ''],
        ['Tabla', 'tabla', ''],
        ['Theremin', 'theremin', ''],
        ['Bağlama', 'bağlama', ''],
        ['Performer', 'performer', ''],
        ['Featuring', 'featuring', ''],
        ['Producer', 'producer', ''],
        ['Co-producer', 'co-producer', ''],
        ['Arranged By', 'arranged by', ''],
        ['Programmed By', 'programmed by', ''],
        ['Engineer', '', 'engineer'],
        ['Engineer [Assistant]', '', 'engineer [assistant]'],
        ['Mixed By', '', 'mixed by'],
        ['Mastered By', '', 'mastered by'],
        ['Mastering Engineer', '', 'mastering'],
        ['Recorded By', '', 'recorded by'],
        ['Edited By', '', 'edited by'],
        ['Executive Producer', '', 'executive producer'],
        ['Artwork', '', 'artwork'],
        ['Photography By', '', 'photography by'],
        ['Design', '', 'design'],
        ['Liner Notes', '', 'liner notes'],
        ['A&R', '', 'a&r'],
        ['Lacquer Cut By', '', 'lacquer cut by'],
        ['Management', '', 'management'],
        // One human, two kinds of work.
        ['Mixed By, Guitar', 'guitar', 'mixed by'],
        ['Engineer, Backing Vocals', 'backing vocals', 'engineer'],
    ];

    for (const [printed, visible, hidden] of TABLE) {
        test(`"${printed}" → ${visible || '(nothing)'}`, () => {
            const { musical, technical } = partitionRoles(normalizeRoleInput(printed));
            expect(musical.join(', ')).toBe(visible);
            expect(technical.join(', ')).toBe(hidden);
        });
    }
});
