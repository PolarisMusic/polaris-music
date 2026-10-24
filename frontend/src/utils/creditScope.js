/**
 * Which credits travel with a recording, and which belong to the release.
 *
 * The test, and it is a thought experiment anyone can run: **would a
 * compilation carrying this track have a different one?**
 *
 * - The cover art would be different. The liner notes would be different. The
 *   person who laid it out, photographed the band, cut the lacquer or put up
 *   the money for the pressing would all be different, or absent. Those
 *   describe the published object.
 * - The producer would not be different. Nor the engineer who recorded it, nor
 *   whoever mixed it, nor anybody who played on it. Those describe the
 *   recording, and the recording is what a compilation borrows.
 *
 * Mastering is both, which is why it is not in either list. The album master
 * travels with the track, and a compilation masters it again against its own
 * running order — so a track genuinely carries two mastering credits, and
 * neither cancels the other. Leaving it out of the release-only set gives that
 * for free: it inherits to the track, and the release keeps it too.
 *
 * "Executive producer" is the one that looks like a counter-example and is
 * not: it is the financier of a release, not an artistic hand on the
 * recordings, so it stays with the release. Matched before "producer", which
 * it contains.
 *
 * Filtering is per ROLE, not per person. One credit line routinely mixes the
 * two — "Mixed By, Mastered By, Photography By" is one human — and dropping or
 * keeping them as a unit gets one of the two facts wrong either way.
 *
 * Nothing here is a submission invariant. The form lets a submitter override
 * inheritance per track, and the backend accepts whatever the bundle says;
 * this only decides a default, so an unrecognised role keeps the old
 * behaviour and travels.
 *
 * @module utils/creditScope
 */

/**
 * Roles that describe the published object rather than the recording.
 *
 * Substrings, matched against a lowercased role, because catalogues qualify
 * them freely: "Artwork [Front Drawing]", "Photography By [Group Photo]".
 */
const RELEASE_ONLY = [
    // The object people hold
    'artwork', 'art direction', 'artist [cover', 'cover art', 'sleeve', 'design',
    'illustration', 'illustrator', 'layout', 'photography', 'photographer', 'painting',
    // The words printed on it
    'liner notes', 'sleeve notes', 'booklet',
    // Whose release it is, rather than whose recording
    'executive producer', 'executive-producer', 'a&r', 'management', 'manager',
    'compiled by', 'curated by', 'sequenced by',
    // Manufacture and trade
    'lacquer cut', 'lacquer-cut', 'pressed by', 'distributed by', 'phonographic copyright',
    'copyright', 'licensed', 'marketing', 'legal',
];

/**
 * Whether a single role describes the recording, and so travels with it.
 *
 * @param {string} role
 * @returns {boolean}
 */
export function roleDescribesRecording(role) {
    const text = String(role ?? '').trim().toLowerCase();
    if (!text) return false;
    return !RELEASE_ONLY.some((keyword) => text.includes(keyword));
}

/**
 * A credit as a track should inherit it, or null if none of it applies.
 *
 * @param {{roles?: string[], role?: string}} credit
 * @returns {Object|null} The credit with only its recording roles, or null.
 */
export function creditForTrack(credit) {
    if (!credit || typeof credit !== 'object') return null;

    const roles = Array.isArray(credit.roles) ? credit.roles : [];
    // A credit with no roles at all says nothing about scope, so it travels —
    // the same way an unrecognised role does.
    if (roles.length === 0) return { ...credit };

    const kept = roles.filter(roleDescribesRecording);
    if (kept.length === 0) return null;
    if (kept.length === roles.length) return { ...credit };

    const trimmed = { ...credit, roles: kept };
    // `role` is the singular backward-compatible field and has to agree.
    if (credit.role) trimmed.role = kept[0];
    return trimmed;
}

/**
 * The release's guest credits, as its tracks should inherit them.
 *
 * @param {Object[]} guests
 * @returns {Object[]}
 */
export function guestsForTracks(guests) {
    if (!Array.isArray(guests)) return [];
    return guests.map(creditForTrack).filter(Boolean);
}
