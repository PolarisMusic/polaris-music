/**
 * Ordering and shaping for the sibling editions of a Master release.
 *
 * A Master groups every edition of one work — the original pressing, a CD
 * remaster, a deluxe reissue — each a separate Release node with its own
 * tracklist. The info viewer steps through them with left/right arrows, so
 * the order has to be stable and meaningful rather than whatever order the
 * graph happened to return: the same release must always sit at the same
 * index, or the arrows jump around between renders.
 *
 * @module api/editionOrder
 */

/**
 * Collapse a release date into a sortable key.
 *
 * Dates arrive as YYYY, YYYY/MM or YYYY/MM/DD (the submit form's three
 * accepted shapes), and older imported rows sometimes use dashes. Comparing
 * those as raw strings puts "2002-08" and "2002/08" on opposite sides of
 * "2002.5", so the separators are stripped and the digits right-padded to a
 * full YYYYMMDD. A year-only date therefore sorts before any fuller date in
 * the same year, which is what you want: the vaguer record is the older
 * catalogue entry.
 *
 * @param {string|null|undefined} date
 * @returns {string} 8-digit sort key, or '' when there is no date
 */
export function dateSortKey(date) {
    if (!date) return '';
    const digits = String(date).replace(/\D/g, '');
    if (digits.length === 0) return '';
    return digits.slice(0, 8).padEnd(8, '0');
}

/**
 * Neo4j returns integers as {low, high} objects. Unwrap to a JS number.
 *
 * @param {*} value
 * @returns {number}
 */
export function toInt(value) {
    if (value == null) return 0;
    if (typeof value === 'number') return value;
    if (typeof value.toNumber === 'function') return value.toNumber();
    if (typeof value.low === 'number') return value.low;
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Release.format is written as `format || []`, so a release submitted without
 * one holds an empty list while a submitted one holds a string. Callers want
 * a display string or nothing.
 *
 * @param {string|string[]|null|undefined} format
 * @returns {string|null}
 */
export function normalizeFormat(format) {
    if (format == null) return null;
    if (Array.isArray(format)) {
        const joined = format.filter(Boolean).join(', ');
        return joined.length > 0 ? joined : null;
    }
    const s = String(format).trim();
    return s.length > 0 ? s : null;
}

/**
 * Order editions oldest first.
 *
 * Undated editions go last rather than first — an empty date sorts before
 * everything as a string, and a release nobody dated is not evidence that it
 * came first. Ties break toward the master release, then catalogue number,
 * then release_id so the sequence is total and deterministic.
 *
 * @param {Object[]} editions
 * @returns {Object[]} new array, ordered
 */
export function orderEditions(editions) {
    return [...(editions || [])].sort((a, b) => {
        const ka = dateSortKey(a.release_date);
        const kb = dateSortKey(b.release_date);
        if (ka !== kb) {
            if (ka === '') return 1;
            if (kb === '') return -1;
            return ka < kb ? -1 : 1;
        }
        if (a.is_master_release !== b.is_master_release) {
            return a.is_master_release ? -1 : 1;
        }
        const ca = a.catalog_number || '';
        const cb = b.catalog_number || '';
        if (ca !== cb) return ca < cb ? -1 : 1;
        return String(a.release_id || '') < String(b.release_id || '') ? -1 : 1;
    });
}

/**
 * A short human label distinguishing one edition from its siblings.
 *
 * Only the fields that actually differ across the set are used: labelling
 * three CDs "CD" tells the reader nothing, and the point of the switcher is
 * to say what makes this one different. Falls back to the release name when
 * nothing distinguishes it.
 *
 * @param {Object} edition
 * @param {Object[]} allEditions
 * @returns {string}
 */
export function editionLabel(edition, allEditions) {
    const set = allEditions || [];
    const varies = (field) => new Set(set.map(e => e[field] || '')).size > 1;
    const parts = [];

    if (varies('release_date') && edition.release_date) parts.push(edition.release_date);
    if (varies('format') && edition.format) parts.push(edition.format);
    if (varies('country') && edition.country) parts.push(edition.country);
    if (parts.length === 0 && varies('catalog_number') && edition.catalog_number) {
        parts.push(edition.catalog_number);
    }
    if (parts.length === 0) return edition.name || 'Edition';
    return parts.join(' · ');
}
