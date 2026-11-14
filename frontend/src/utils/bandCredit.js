/**
 * Credit rows that name a band rather than a person.
 *
 * Catalogues do not keep the two apart. Discogs files "The Budos Band" among a
 * release's extraartists beside its mixing engineer, and an act's own member
 * list can name a horn section as readily as a trumpeter — so a band arrives
 * in the form looking exactly like a person, at any of four places: a member
 * or a guest, on a track or on the release.
 *
 * Rather than a second "Guest Bands" section the submitter has to sort credits
 * into, the row itself carries the answer. These helpers put it there and read
 * it back. The backend's hoistGroupCredits does the rest, recasting the row as
 * a group that performed on the recording — on the way in, not at display
 * time, because a band stored as a Person is returned by the entity search as
 * a Person and the only way back is a MERGE_NODE event against anchored data.
 */

/**
 * Entity types a name may be auto-matched against after an import.
 *
 * Deliberately narrower than what the dropdown searches. This registry models
 * a solo artist as a group of one, so "Charles Bradley" is legitimately both a
 * Person and a Group — and an importer filling an engineer's name cannot tell
 * which a lone exact match is. Reconciliation sticks to Persons; binding a
 * band is left to the submitter, who can see the type badge on each result.
 *
 * @param {string} lookupType - The data-lookup-type value.
 * @param {Object<string,string[]>} map - Lookup-type to searched types.
 * @returns {string[]}
 */
export function reconcilableTypes(lookupType, map = {}) {
    if (lookupType === 'PersonOrGroup') return ['Person'];
    return map[lookupType] || [lookupType];
}

/**
 * The field names a credit row's band marker lives under.
 *
 * Derived from the visible name field, the way the alias box is: a row's
 * inputs share one suffix, and release-level guests carry no parentIndex, so
 * deriving beats passing the shape around.
 *
 * @param {string} nameField - Name of the visible name input.
 * @returns {{entityType: string, checkbox: string}|null}
 */
export function markerFields(nameField) {
    const name = String(nameField ?? '');
    const entityType = name.replace(/-name-/, '-entity-type-');
    if (entityType === name) return null;
    return { entityType, checkbox: name.replace(/-name-/, '-is-band-') };
}

/**
 * Record whether the entity bound to a credit row is a band.
 *
 * The row stays person-shaped in the form; this is the marker the serializer
 * reads to emit it as a group instead. The checkbox beside it is kept in step
 * so the answer is visible rather than hidden in an input nobody can see — and
 * so clearing a binding does not leave the row silently marked as a band.
 *
 * @param {HTMLInputElement} nameInput - The visible name field.
 * @param {{type?: string}|null} result - The bound entity, or null on unbind.
 */
export function recordBoundEntityType(nameInput, result) {
    const fields = markerFields(nameInput?.name);
    if (!fields) return;

    const scope = nameInput.closest('form, body');
    const marker = scope?.querySelector(`[name="${fields.entityType}"]`);
    if (!marker) return;

    const isGroup = String(result?.type || '').toLowerCase() === 'group';
    marker.value = isGroup ? 'Group' : '';

    const box = scope?.querySelector(`[name="${fields.checkbox}"]`);
    if (box) box.checked = isGroup;
}

/**
 * Whether a credit row has been marked as naming a band.
 *
 * Two ways to say so, because they answer for different cases: the search box
 * writes the hidden marker when it binds the row to a Group already in the
 * registry, and the checkbox is how a submitter names a band that is not.
 *
 * @param {Element} item - The row.
 * @param {string} markerName - Name of the hidden entity-type input.
 * @param {string} boxName - Name of the "this is a band" checkbox.
 * @returns {boolean}
 */
export function marksABand(item, markerName, boxName) {
    if (!item) return false;
    const marker = item.querySelector(`[name="${markerName}"]`);
    if (String(marker?.value || '').toLowerCase() === 'group') return true;
    return item.querySelector(`[name="${boxName}"]`)?.checked === true;
}

/**
 * Put a credit row's bound id on the field that matches what it names.
 *
 * A band's id is a group_id; a person's is a person_id. Where the row is
 * marked as a band but the id came from binding a Person — ticking the box
 * after binding somebody — the id is dropped and the band resolves by name.
 * Writing a person_id as a group_id would point the performance edge at a
 * Person node, which is the thing this whole path exists to avoid.
 *
 * Mutates and returns the credit, so it can be used inline.
 *
 * @param {Object} credit - The credit being emitted.
 * @param {string} boundId - The id the search box bound, if any.
 * @param {boolean} isBand - Whether the row names a band.
 * @param {boolean} boundIsGroup - Whether that id belongs to a Group.
 * @returns {Object} The credit.
 */
export function assignCreditId(credit, boundId, isBand, boundIsGroup) {
    if (!boundId) return credit;
    if (!isBand) credit.person_id = boundId;
    else if (boundIsGroup) credit.group_id = boundId;
    return credit;
}

export default {
    reconcilableTypes,
    markerFields,
    recordBoundEntityType,
    marksABand,
    assignCreditId,
};
