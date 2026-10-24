/**
 * Which credits travel with a recording, and which belong to the release.
 *
 * The test is a thought experiment: would a compilation carrying this track
 * have a different one? Different cover art, different liner notes, a
 * different person who laid it out or put up the money — those describe the
 * published object. The same producer, the same engineer, the same people
 * playing — those describe the recording, which is what a compilation
 * borrows.
 *
 * What prompted it: a release's cover artist, layout designer and
 * photographer were inherited onto all seven tracks of an album, credited
 * with "artwork [front drawing]" on recordings they had nothing to do with —
 * and sat in the same bucket as a vocalist featured on every track, because
 * the classifier's fallback bucket is called `guests` and means
 * "unclassified".
 */

import { describe, test, expect } from '@jest/globals';
import {
    roleDescribesRecording, creditForTrack, guestsForTracks,
} from '../../../frontend/src/utils/creditScope.js';

describe('whether a role travels with the recording', () => {
    test.each([
        ['a producer', 'Producer'],
        ['an engineer', 'Engineer'],
        ['a recording engineer', 'Recorded By'],
        ['a mix', 'Mixed By'],
        // Both, deliberately: the album master travels with the track and a
        // compilation masters it again, so the track carries two credits.
        ['a master', 'Mastered By'],
        ['a featured vocalist', 'Featuring'],
        ['an instrument', 'Double Bass'],
        ['an arrangement', 'Arranged By'],
        ['a composer', 'Written-By'],
    ])('%s does', (_label, role) => {
        expect(roleDescribesRecording(role)).toBe(true);
    });

    test.each([
        ['cover art', 'Artwork [Front Drawing]'],
        ['art direction', 'Art Direction'],
        ['a layout', 'Layout'],
        ['a design credit', 'Design, Layout'],
        ['a photograph', 'Photography By [Group Photo]'],
        ['an illustration', 'Illustration'],
        ['liner notes', 'Liner Notes'],
        ['sleeve notes', 'Sleeve Notes'],
        // The financier of a release, not an artistic hand on the recordings.
        ['an executive producer', 'Executive Producer'],
        ['a&r', 'A&R'],
        ['management', 'Management'],
        ['a lacquer cut', 'Lacquer Cut By'],
        ['a pressing plant', 'Pressed By'],
        ['distribution', 'Distributed By'],
        ['a compiler', 'Compiled By'],
    ])('%s does not', (_label, role) => {
        expect(roleDescribesRecording(role)).toBe(false);
    });

    test('"executive producer" is not read as "producer"', () => {
        // It contains the word, and is matched ahead of it.
        expect(roleDescribesRecording('Executive Producer')).toBe(false);
        expect(roleDescribesRecording('Producer')).toBe(true);
    });

    test.each([
        ['an empty role', ''],
        ['whitespace', '   '],
        ['not a string', null],
    ])('%s does not travel', (_label, role) => {
        expect(roleDescribesRecording(role)).toBe(false);
    });

    test('an unrecognised role travels, keeping the old behaviour', () => {
        // The failure mode has to be benign: this only sets a default, so
        // anything it does not know must behave as it did before.
        expect(roleDescribesRecording('Theremin Wrangler')).toBe(true);
        expect(roleDescribesRecording('Vibes')).toBe(true);
    });
});

describe('one person with facts of both kinds', () => {
    test('keeps the recording roles and loses the release ones', () => {
        // The case from the record that prompted this: one human, credited
        // "Mixed By, Mastered By, Photography By". All-or-nothing gets one of
        // the two facts wrong whichever way it goes.
        const credit = creditForTrack({
            name: 'Jonas Munk',
            roles: ['Mixed By', 'Mastered By', 'Photography By'],
            role: 'Mixed By',
        });

        expect(credit.roles).toEqual(['Mixed By', 'Mastered By']);
        expect(credit.name).toBe('Jonas Munk');
    });

    test('the singular role field is kept in step', () => {
        const credit = creditForTrack({
            name: 'Someone', roles: ['Photography By', 'Producer'], role: 'Photography By',
        });

        expect(credit.role).toBe('Producer');
    });

    test('a person with nothing but release roles is dropped', () => {
        expect(creditForTrack({
            name: 'Alan Forbes', roles: ['Artwork [Front Drawing]'], role: 'Artwork',
        })).toBeNull();
    });

    test('a person with nothing but recording roles comes through untouched', () => {
        const input = { name: 'Björk', roles: ['Featuring'], role: 'Featuring',
            person_id: 'prov:person:abc' };

        expect(creditForTrack(input)).toEqual(input);
    });

    test('a credit with no roles travels, as an unrecognised one does', () => {
        expect(creditForTrack({ name: 'Someone' })).toEqual({ name: 'Someone' });
    });

    test('the original is not mutated', () => {
        const input = { name: 'Jonas Munk', roles: ['Mixed By', 'Layout'], role: 'Mixed By' };
        creditForTrack(input);

        expect(input.roles).toEqual(['Mixed By', 'Layout']);
    });

    test.each([
        ['null', null],
        ['a string', 'not a credit'],
    ])('%s is survivable', (_label, input) => {
        expect(creditForTrack(input)).toBeNull();
    });
});

describe('a release’s guests as its tracks inherit them', () => {
    const GUESTS = [
        { name: 'Björk', roles: ['Featuring'] },
        { name: 'Alan Forbes', roles: ['Artwork [Front Drawing]'] },
        { name: 'Jakob Skøtt', roles: ['Layout'] },
        { name: 'Evan Wenskay', roles: ['Photography By [Group Photo]'] },
        { name: 'Jonas Munk', roles: ['Mixed By', 'Photography By'] },
        { name: 'A Mastering House', roles: ['Mastered By'] },
    ];

    test('the people who made the object do not reach the tracks', () => {
        expect(guestsForTracks(GUESTS).map((g) => g.name))
            .toEqual(['Björk', 'Jonas Munk', 'A Mastering House']);
    });

    test('the featured vocalist does', () => {
        // She was in the same bucket as the cover artist, which is the whole
        // reason none of this could be told apart.
        expect(guestsForTracks(GUESTS).find((g) => g.name === 'Björk')).toBeDefined();
    });

    test('mastering reaches the track and stays on the release', () => {
        // The release keeps every guest; only what a track inherits is
        // filtered. So a track carries the album's mastering credit, and a
        // compilation adds its own on top rather than replacing it.
        expect(guestsForTracks(GUESTS).some((g) => g.roles.includes('Mastered By'))).toBe(true);
        expect(GUESTS.some((g) => g.roles.includes('Mastered By'))).toBe(true);
    });

    test('a mixed credit arrives with only its recording half', () => {
        expect(guestsForTracks(GUESTS).find((g) => g.name === 'Jonas Munk').roles)
            .toEqual(['Mixed By']);
    });

    test.each([
        ['nothing', []],
        ['not a list', null],
    ])('%s gives an empty list', (_label, input) => {
        expect(guestsForTracks(input)).toEqual([]);
    });
});
