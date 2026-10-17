/**
 * Read the barcode off a Discogs release.
 *
 * This is the bridge between the two catalogues. Discogs carries no streaming
 * ids at all, so matching a pressing to its streaming release otherwise means
 * matching on artist and title — the comparison this module's neighbour
 * tracklistDiff.js exists because it cannot be trusted. A barcode is the one
 * identifier both sides print: the UPC on the sleeve is the UPC in Spotify's
 * `external_ids`, and it names the edition rather than the music, which is
 * exactly the precision wanted here.
 *
 * Pure and standalone so it can be unit-tested without a browser — the frontend
 * has no unit-test runner, so its tests live under backend/test/frontend/, the
 * same arrangement as listenLinks.js and tracklistDiff.js.
 *
 * @module utils/discogsBarcode
 */

/**
 * The shortest and longest digit runs that could be a real article number.
 *
 * EAN-8 at the bottom, ITF-14 at the top. Below that the field is holding a
 * label's catalogue number, a price code or the word "none" — Discogs
 * identifiers are free text and submitters put all three in there.
 */
const MIN_DIGITS = 8;
const MAX_DIGITS = 14;

/**
 * Reduce a printed barcode to digits.
 *
 * Sleeve barcodes are transcribed as they are printed — "0 7599-27336-2" — and
 * the grouping is typography, not data.
 *
 * @param {string} value
 * @returns {string} Digits only; '' when there is nothing usable.
 */
export function normalizeBarcode(value) {
    const digits = String(value ?? '').replace(/\D/g, '');
    return digits.length >= MIN_DIGITS && digits.length <= MAX_DIGITS ? digits : '';
}

/**
 * Whether two barcodes name the same article.
 *
 * Compared with leading zeros dropped, because a 12-digit UPC-A and its
 * 13-digit EAN form are the same number written for different scanners, and
 * which one a catalogue stores is a coin toss.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameBarcode(a, b) {
    const left = normalizeBarcode(a).replace(/^0+/, '');
    const right = normalizeBarcode(b).replace(/^0+/, '');
    return left.length > 0 && left === right;
}

/**
 * Every barcode a Discogs release carries, best candidate first.
 *
 * A pressing often lists more than one — the sleeve and the disc, or a reissue
 * printing both its own and the original's. Longer first: a 13-digit EAN is
 * what a streaming catalogue is most likely to hold, and the 12-digit form of
 * the same number still matches it through sameBarcode.
 *
 * @param {{identifiers?: {type?: string, value?: string}[]}} release - A
 *   Discogs release as its API returns it.
 * @returns {string[]} Normalized digit strings, deduplicated.
 */
export function barcodesFrom(release) {
    const identifiers = Array.isArray(release?.identifiers) ? release.identifiers : [];

    const found = identifiers
        .filter(id => String(id?.type ?? '').toLowerCase() === 'barcode')
        .map(id => normalizeBarcode(id?.value))
        .filter(Boolean);

    // Sorted before deduplication, so the kept copy is the longest spelling.
    const ordered = [...found].sort((a, b) => b.length - a.length);

    const seen = new Set();
    return ordered.filter(code => {
        const key = code.replace(/^0+/, '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * The forms of a barcode worth asking a catalogue about.
 *
 * Spotify's `upc:` search filter matches the string it is given, so a UPC-A
 * stored as a zero-padded EAN-13 is a miss unless both are tried. Two queries
 * at most, and the second only when it differs.
 *
 * @param {string} barcode
 * @returns {string[]}
 */
export function barcodeVariants(barcode) {
    const digits = normalizeBarcode(barcode);
    if (!digits) return [];

    const variants = [digits];
    const padded = digits.replace(/^0+/, '').padStart(13, '0');
    if (padded !== digits) variants.push(padded);
    return variants;
}
