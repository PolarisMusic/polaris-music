/**
 * @fileoverview The canonical event-type table.
 *
 * These codes are the contract's: put() writes `type` as a uint8 and anchors
 * everything in [MIN_CONTENT_TYPE, MAX_CONTENT_TYPE] (polaris.music.cpp:1395).
 * Off-chain, the same event is stored with its *name* — a body reads
 * `"type":"CREATE_RELEASE_BUNDLE"`, not `"type":21` — so both representations
 * are in circulation and code that reads events must handle either.
 *
 * That divergence is what `toTypeCode()` is for. The curate detail route used
 * to compare a stored event's `type` against numeric literals, which a string
 * can never equal, so every release bundle rendered as "Unsupported operation
 * type for detailed view" while its anchor sat there perfectly intact.
 *
 * This module exists because there were four partial copies of the mapping —
 * two of them missing MINT_ENTITY and RESOLVE_ID, which is why those rows
 * showed up in the curation feed labelled "TYPE 22".
 *
 * @module constants/eventTypes
 */

/**
 * Event type name -> numeric code.
 *
 * @type {Readonly<Object<string, number>>}
 */
export const EVENT_TYPES = Object.freeze({
    CREATE_RELEASE_BUNDLE: 21,
    MINT_ENTITY: 22,           // Create canonical entity
    RESOLVE_ID: 23,            // Map provisional/external ID to canonical
    ADD_CLAIM: 30,
    EDIT_CLAIM: 31,
    VOTE: 40,
    LIKE: 41,
    FINALIZE: 50,
    MERGE_ENTITY: 60           // Merge duplicate entities (renamed from MERGE_NODE)
});

/**
 * Numeric code -> event type name.
 *
 * @type {Readonly<Object<number, string>>}
 */
export const TYPE_CODE_TO_EVENT_TYPE = Object.freeze(
    Object.fromEntries(Object.entries(EVENT_TYPES).map(([name, code]) => [code, name]))
);

/**
 * Lowest and highest type codes put() anchors on chain.
 *
 * Mirrors MIN_CONTENT_TYPE / MAX_CONTENT_TYPE in polaris.music.cpp:1395. Only
 * these get an anchor row, a vote tally and a place in the curation feed.
 */
export const MIN_CONTENT_TYPE = 20;
export const MAX_CONTENT_TYPE = 39;

/**
 * Resolve either representation of an event type to its numeric code.
 *
 * Accepts the number itself, a numeric string (JSON from the chain API
 * sometimes stringifies), or a type name as stored in an event body. Returns
 * null for anything unrecognized rather than a plausible-looking wrong code —
 * a caller that cannot identify a type should say so, not guess at 21.
 *
 * @param {number|string|null|undefined} value
 * @returns {number|null}
 */
export function toTypeCode(value) {
    if (value == null || value === '') return null;

    if (typeof value === 'number') return Number.isFinite(value) ? value : null;

    const raw = String(value);
    if (/^\d+$/.test(raw)) return Number(raw);

    return EVENT_TYPES[raw] ?? null;
}

/**
 * Whether a type code is one put() anchors, and so one the curation feed lists.
 *
 * @param {number|string|null|undefined} value - Either representation.
 * @returns {boolean}
 */
export function isContentType(value) {
    const code = toTypeCode(value);
    return code != null && code >= MIN_CONTENT_TYPE && code <= MAX_CONTENT_TYPE;
}
