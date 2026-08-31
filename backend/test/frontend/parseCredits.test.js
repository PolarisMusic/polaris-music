/**
 * Unit tests for the Discogs credit classifier.
 *
 * These exist because importing Nirvana's Nevermind filed the entire band as
 * release guests — eleven of them, from four humans — while the group's member
 * list came back empty. Four defects compounded:
 *
 *   1. The "is a performer" set was built only from roles containing the
 *      literal word "performer". Discogs writes the instrument instead
 *      ("Bass, Vocals"), so the set was normally empty.
 *   2. The exclusion guarded only the guests bucket; the production buckets
 *      deliberately included everyone, performers among them.
 *   3. The buckets were independent `if`s, so one person credited three ways
 *      produced three rows.
 *   4. Identity was the numeric Discogs id with no name fallback, so an ANV
 *      alias and the canonical entry were two different people.
 *
 * The classifier now accumulates every credit line per person before deciding
 * what they are. The cases below are the shapes Discogs actually returns.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { DiscogsClient } from '../../../frontend/src/utils/discogsClient.js';

let client;
beforeEach(() => { client = new DiscogsClient(); });

/** How Discogs credits a rock band: instruments, not the word "performer". */
const NEVERMIND_CREDITS = [
    { id: 1, name: 'Kurt Cobain', role: 'Guitar, Vocals' },
    { id: 2, name: 'Krist Novoselic', role: 'Bass' },
    { id: 3, name: 'Dave Grohl', role: 'Drums' },
    { id: 4, name: 'Butch Vig', role: 'Producer' },
    { id: 5, name: 'Andy Wallace', role: 'Mixed By' },
    { id: 6, name: 'Howie Weinberg', role: 'Mastered By' },
];

describe('members versus guests', () => {
    test('instrument credits make someone a member, not a guest', () => {
        const { members, guests } = client.parseCredits(NEVERMIND_CREDITS);
        const names = members.map(m => m.name);

        expect(names).toEqual(
            expect.arrayContaining(['Kurt Cobain', 'Krist Novoselic', 'Dave Grohl']));
        // The bug: all three landed here instead.
        expect(guests.map(g => g.name)).not.toEqual(
            expect.arrayContaining(['Kurt Cobain', 'Krist Novoselic', 'Dave Grohl']));
    });

    test('production people are not members', () => {
        const { members, producers, mixedBy, masteredBy } = client.parseCredits(NEVERMIND_CREDITS);

        expect(members.map(m => m.name)).not.toContain('Butch Vig');
        expect(producers.map(p => p.name)).toEqual(['Butch Vig']);
        expect(mixedBy.map(p => p.name)).toEqual(['Andy Wallace']);
        expect(masteredBy.map(p => p.name)).toEqual(['Howie Weinberg']);
    });

    test('a member who also produced stays a member', () => {
        // A production credit does not stop someone being in the band. The old
        // code moved them to guests, because the production buckets included
        // performers by design.
        const { members, producers } = client.parseCredits([
            { id: 1, name: 'Kurt Cobain', role: 'Guitar, Vocals' },
            { id: 1, name: 'Kurt Cobain', role: 'Producer' },
        ]);

        expect(members.map(m => m.name)).toEqual(['Kurt Cobain']);
        expect(producers).toEqual([]);
    });

    test('a member row carries only the instruments, not the production role', () => {
        const { members } = client.parseCredits([
            { id: 1, name: 'Kurt Cobain', role: 'Guitar, Vocals' },
            { id: 1, name: 'Kurt Cobain', role: 'Producer' },
        ]);
        // A MEMBER_OF edge should not claim they played "Producer".
        expect(members[0].roles).toEqual(['Guitar', 'Vocals']);
    });
});

describe('one person, one row', () => {
    test('three credits for one person do not become three guests', () => {
        // This is how four credit lines inflated to eleven guest rows.
        const credits = client.parseCredits([
            { id: 9, name: 'Andy Wallace', role: 'Producer' },
            { id: 9, name: 'Andy Wallace', role: 'Engineer' },
            { id: 9, name: 'Andy Wallace', role: 'Mixed By' },
        ]);

        const everyone = [
            ...credits.producers, ...credits.engineers, ...credits.mixedBy,
            ...credits.masteredBy, ...credits.guests,
        ];
        expect(everyone).toHaveLength(1);
        expect(everyone[0].roles.sort()).toEqual(['Engineer', 'Mixed By', 'Producer']);
    });

    test('a combined role string is split into separate roles', () => {
        const { members } = client.parseCredits([
            { id: 1, name: 'Kurt Cobain', role: 'Guitar, Vocals, Lyrics By' },
        ]);
        expect(members[0].roles).toEqual(expect.arrayContaining(['Guitar', 'Vocals']));
    });
});

describe('identity', () => {
    test('an ANV alias and the canonical name are one person', () => {
        // Discogs returned "Chris Novoselic" on one line and "Krist Novoselic"
        // on another. Matching on id alone produced two people with different
        // spellings, which is what surfaced in the form.
        const { members } = client.parseCredits([
            { id: 2, name: 'Krist Novoselic', anv: 'Chris Novoselic', role: 'Bass' },
            { id: 2, name: 'Krist Novoselic', role: 'Vocals' },
        ]);

        expect(members).toHaveLength(1);
        expect(members[0].name).toBe('Krist Novoselic');
        expect(members[0].altNames).toContain('Chris Novoselic');
        expect(members[0].roles.sort()).toEqual(['Bass', 'Vocals']);
    });

    test('people with no id fall back to matching on name', () => {
        const { members } = client.parseCredits([
            { name: 'Kurt Cobain', role: 'Guitar' },
            { name: 'Kurt Cobain (2)', role: 'Vocals' },
        ]);
        // The "(2)" is Discogs disambiguation, not part of the name.
        expect(members).toHaveLength(1);
        expect(members[0].roles.sort()).toEqual(['Guitar', 'Vocals']);
    });

    test('genuinely different people stay separate', () => {
        const { members } = client.parseCredits([
            { id: 1, name: 'Kurt Cobain', role: 'Guitar' },
            { id: 3, name: 'Dave Grohl', role: 'Drums' },
        ]);
        expect(members).toHaveLength(2);
    });
});

describe('edge cases', () => {
    test('no credits yields empty buckets rather than throwing', () => {
        for (const input of [undefined, null, []]) {
            const credits = client.parseCredits(input);
            expect(credits.members).toEqual([]);
            expect(credits.guests).toEqual([]);
        }
    });

    test('an unrecognized role is kept as a guest rather than dropped', () => {
        // Better to surface someone for review than to lose the credit.
        const { guests } = client.parseCredits([
            { id: 7, name: 'Robert Fisher', role: 'Artwork' },
        ]);
        expect(guests.map(g => g.name)).toEqual(['Robert Fisher']);
    });

    test('a nameless credit is skipped', () => {
        const credits = client.parseCredits([{ id: 8, name: '', role: 'Guitar' }]);
        expect(credits.members).toEqual([]);
    });
});
