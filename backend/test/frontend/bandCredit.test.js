/**
 * @jest-environment jsdom
 */
/**
 * Marking a credit row as a band, and reading the mark back.
 *
 * The form asks on the row rather than in a separate "Guest Bands" section,
 * because no catalogue sorts them for you: Discogs files "The Budos Band"
 * among a release's extraartists beside its mixing engineer, and an act's own
 * member list can name a horn section as readily as a trumpeter. So the row
 * looks like a person at all four places a band can appear — member or guest,
 * track or release — and the mark is what tells them apart.
 *
 * Lives under backend/test for the usual reason: the frontend has no unit-test
 * runner, and these modules are plain ESM.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { FormBuilder } from '../../../frontend/src/components/FormBuilder.js';
import {
    reconcilableTypes,
    markerFields,
    recordBoundEntityType,
    marksABand,
    assignCreditId,
} from '../../../frontend/src/utils/bandCredit.js';

const LOOKUP_MAP = {
    'Person': ['Person'],
    'Group': ['Group'],
    'City': ['City'],
    'PersonOrGroup': ['Person', 'Group'],
};

/** A guest row as createPersonForm builds one. */
function guestRow({ name = 'The Budos Band', ticked = false, marker = '' } = {}) {
    document.body.innerHTML = `
        <form id="release-form">
          <div class="nested-item" data-type="guest" data-index="0">
            <input type="text" name="guest-name-0-0" value="${name}">
            <input type="hidden" name="guest-person-id-0-0">
            <input type="hidden" name="guest-entity-type-0-0" value="${marker}">
            <input type="checkbox" name="guest-is-band-0-0" ${ticked ? 'checked' : ''}>
          </div>
        </form>`;
    return document.querySelector('.nested-item');
}

describe('what a name is auto-matched against after an import', () => {
    test('a Person row searches Persons', () => {
        expect(reconcilableTypes('Person', LOOKUP_MAP)).toEqual(['Person']);
    });

    test('a row that may be either still only matches Persons', () => {
        // This registry models a solo artist as a group of one, so "Charles
        // Bradley" is legitimately both a Person and a Group. An importer
        // filling an engineer's name cannot tell which a lone exact match is,
        // and binding the wrong one turns a human credit into a band.
        expect(reconcilableTypes('PersonOrGroup', LOOKUP_MAP)).toEqual(['Person']);
    });

    test('an unmapped type falls back to itself', () => {
        expect(reconcilableTypes('Mystery', LOOKUP_MAP)).toEqual(['Mystery']);
    });
});

describe('where a row keeps its mark', () => {
    test('derived from the name field, for a track-level row', () => {
        expect(markerFields('guest-name-0-3')).toEqual({
            entityType: 'guest-entity-type-0-3',
            checkbox: 'guest-is-band-0-3',
        });
    });

    test('and for a release-level row, which carries no parent index', () => {
        expect(markerFields('release-guest-name-2')).toEqual({
            entityType: 'release-guest-entity-type-2',
            checkbox: 'release-guest-is-band-2',
        });
    });

    test('nothing for a field that is not a name', () => {
        expect(markerFields('track-title-0')).toBeNull();
        expect(markerFields(undefined)).toBeNull();
    });
});

describe('binding a row to something in the registry', () => {
    let row;
    beforeEach(() => { row = guestRow(); });

    const nameInput = () => document.querySelector('[name="guest-name-0-0"]');
    const marker = () => document.querySelector('[name="guest-entity-type-0-0"]');
    const box = () => document.querySelector('[name="guest-is-band-0-0"]');

    test('a Group marks the row as a band', () => {
        recordBoundEntityType(nameInput(), { type: 'Group', id: 'grp:budos' });

        expect(marker().value).toBe('Group');
        expect(marksABand(row, 'guest-entity-type-0-0', 'guest-is-band-0-0')).toBe(true);
    });

    test('and ticks the box, so the answer is visible rather than hidden', () => {
        recordBoundEntityType(nameInput(), { type: 'Group', id: 'grp:budos' });

        expect(box().checked).toBe(true);
    });

    test('a Person does not', () => {
        recordBoundEntityType(nameInput(), { type: 'Person', id: 'psn:brenneck' });

        expect(marker().value).toBe('');
        expect(marksABand(row, 'guest-entity-type-0-0', 'guest-is-band-0-0')).toBe(false);
    });

    test('clearing the binding clears the mark', () => {
        // Otherwise a row bound to a band and then cleared stays marked, and
        // the typed name is submitted as a band nobody chose.
        recordBoundEntityType(nameInput(), { type: 'Group', id: 'grp:budos' });
        recordBoundEntityType(nameInput(), null);

        expect(marker().value).toBe('');
        expect(box().checked).toBe(false);
    });

    test('a row with no marker fields is left alone', () => {
        // Songwriter and producer rows have none: WROTE and the producer
        // credit run from a Person in this model.
        document.body.innerHTML = `
            <form><input type="text" name="songwriter-name-0-0" value="Paul McCartney"></form>`;
        expect(() => recordBoundEntityType(
            document.querySelector('input'), { type: 'Group' })).not.toThrow();
    });
});

describe('ticking the box by hand', () => {
    test('marks the row, which is the only answer for a band not yet in the registry', () => {
        const row = guestRow({ ticked: true });

        expect(marksABand(row, 'guest-entity-type-0-0', 'guest-is-band-0-0')).toBe(true);
    });

    test('an untouched row is not marked', () => {
        const row = guestRow();

        expect(marksABand(row, 'guest-entity-type-0-0', 'guest-is-band-0-0')).toBe(false);
    });

    test('a row missing both inputs is not marked', () => {
        document.body.innerHTML = '<div class="nested-item"></div>';
        const row = document.querySelector('.nested-item');

        expect(marksABand(row, 'guest-entity-type-0-0', 'guest-is-band-0-0')).toBe(false);
        expect(marksABand(null, 'a', 'b')).toBe(false);
    });
});

describe('which field the bound id goes on', () => {
    test('a person id for a person', () => {
        expect(assignCreditId({ name: 'Thomas Brenneck' }, 'psn:x', false, false))
            .toEqual({ name: 'Thomas Brenneck', person_id: 'psn:x' });
    });

    test('a group id for a band picked from the registry', () => {
        expect(assignCreditId({ name: 'The Budos Band' }, 'grp:budos', true, true))
            .toEqual({ name: 'The Budos Band', group_id: 'grp:budos' });
    });

    test('no id at all when a bound person is then marked a band', () => {
        // Writing a person_id as a group_id would point the performance edge
        // at a Person node, which is the thing this whole path avoids.
        // Resolving the band by name is the lesser wrong.
        expect(assignCreditId({ name: 'The Budos Band' }, 'psn:x', true, false))
            .toEqual({ name: 'The Budos Band' });
    });

    test('nothing to do when nothing was bound', () => {
        expect(assignCreditId({ name: 'Nobody' }, '', false, false))
            .toEqual({ name: 'Nobody' });
    });
});

describe('which rows the form asks the question on', () => {
    const builder = () => new FormBuilder();

    test('a track guest', () => {
        const row = builder().createPersonForm(0, 'guest', 3);

        expect(row.querySelector('[name="guest-is-band-3-0"]')).not.toBeNull();
        expect(row.querySelector('[name="guest-entity-type-3-0"]')).not.toBeNull();
    });

    test("a track group's member, which is where a horn section turns up", () => {
        const row = builder().createPersonForm(1, 'member', '3-0');

        expect(row.querySelector('[name="member-is-band-3-0-1"]')).not.toBeNull();
    });

    test("a release act's member", () => {
        const row = builder().createPersonForm(0, 'release-member', 2);

        expect(row.querySelector('[name="release-member-is-band-2-0"]')).not.toBeNull();
    });

    test('a release guest, which has its own builder', () => {
        const row = builder().createReleaseGuestForm(4);

        expect(row.querySelector('[name="release-guest-is-band-4"]')).not.toBeNull();
        expect(row.querySelector('[name="release-guest-entity-type-4"]')).not.toBeNull();
    });

    test('not a songwriter: WROTE runs from a Person in this model', () => {
        const row = builder().createPersonForm(0, 'songwriter', 3);

        expect(row.querySelector('[name="songwriter-is-band-3-0"]')).toBeNull();
    });

    test('not a producer either', () => {
        const row = builder().createPersonForm(0, 'producer', 3);

        expect(row.querySelector('[name="producer-is-band-3-0"]')).toBeNull();
    });
});

describe('what the search box on each row offers', () => {
    test('Persons and Groups where the row may be a band', () => {
        const row = new FormBuilder().createPersonForm(0, 'guest', 3);

        expect(row.querySelector('[name="guest-person-id-3-0"]').dataset.lookupType)
            .toBe('PersonOrGroup');
    });

    test('Persons only where it may not', () => {
        const row = new FormBuilder().createPersonForm(0, 'songwriter', 3);

        expect(row.querySelector('[name="songwriter-person-id-3-0"]').dataset.lookupType)
            .toBe('Person');
    });

    test('and the release guest row agrees', () => {
        const row = new FormBuilder().createReleaseGuestForm(4);

        expect(row.querySelector('[name="release-guest-person-id-4"]').dataset.lookupType)
            .toBe('PersonOrGroup');
    });
});

describe('ticking the box on a real row', () => {
    test('writes the mark the serializer reads', () => {
        // The checkbox and the hidden marker are two inputs; the row wires
        // them together. Without that, ticking by hand said nothing to
        // anything reading the entity-type field.
        const row = new FormBuilder().createPersonForm(0, 'guest', 3);
        document.body.innerHTML = '';
        document.body.appendChild(row);

        const box = row.querySelector('[name="guest-is-band-3-0"]');
        box.checked = true;
        box.dispatchEvent(new Event('change'));

        expect(row.querySelector('[name="guest-entity-type-3-0"]').value).toBe('Group');
        expect(marksABand(row, 'guest-entity-type-3-0', 'guest-is-band-3-0')).toBe(true);
    });

    test('and un-ticking clears it', () => {
        const row = new FormBuilder().createReleaseGuestForm(4);
        document.body.innerHTML = '';
        document.body.appendChild(row);

        const box = row.querySelector('[name="release-guest-is-band-4"]');
        box.checked = true;
        box.dispatchEvent(new Event('change'));
        box.checked = false;
        box.dispatchEvent(new Event('change'));

        expect(row.querySelector('[name="release-guest-entity-type-4"]').value).toBe('');
    });
});
