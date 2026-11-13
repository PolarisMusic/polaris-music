/**
 * Whether a credit describes playing on a record, or working on it.
 *
 * `GUEST_ON` is a fallback bucket. Everyone who is not a member of the
 * performing group lands in it — a featured vocalist, a horn section, the
 * mixing engineer, whoever shot the sleeve — so the registry cannot tell Björk
 * from the person who laid out the booklet. That conflation had a cost beyond
 * tidiness: because the whole bucket was hidden by default, a submitter with
 * an interesting session player to show had to file them as a *member* to make
 * the connection visible at all. A display default was corrupting the data.
 *
 * So the bucket is split at read time, per ROLE rather than per person, and
 * the two halves get different defaults: musical credits are drawn, technical
 * ones are behind a toggle.
 *
 * **Per role, not per person.** One credit line routinely mixes the two —
 * "Mixed By, Guitar" is one human — and judging the person would get one of
 * the two facts wrong whichever way it went. Partitioning the roles keeps the
 * guitarist visible as a guitarist and leaves the engineering credit for
 * whoever asked to see engineering credits. This is the same discipline
 * `creditScope.js` applies to track inheritance, for the same reason.
 *
 * **A closed list of what to hide, and everything else is music.** The
 * opposite arrangement — an allowlist of instruments, which is what
 * `DiscogsClient.PERFORMANCE_ROLES` is — cannot be completed: Discogs credits
 * ondes martenot, bağlama, tabla, theremin and several hundred more, and an
 * instrument missing from the list would make its player vanish. That is
 * precisely the failure this split exists to end, so the default direction is
 * visible. An unrecognised technical credit shows up instead, which is mild
 * noise and is fixed by adding a word here.
 *
 * **Credit-derived edges only.** This decides how `GUEST_ON` and the
 * `PERFORMED_WITH` view-edge are drawn. It is never applied to `MEMBER_OF`:
 * membership is a roster fact, and the importer's rule governs it — "being in
 * the band makes you a member whatever you were credited for". A band's own
 * producer stays visible as a member.
 *
 * @module graph/creditKind
 */

/**
 * Roles that are not performances.
 *
 * Substrings, matched against an already-normalized (lowercased, synonym-
 * folded) role, because catalogues qualify them freely: "Engineer
 * [Assistant]", "Photography By [Group Photo]".
 *
 * Overlaps `creditScope.RELEASE_ONLY` without being it, and the two are
 * deliberately separate lists answering separate questions. That one asks
 * whether a credit travels with the recording to a compilation; this one asks
 * whether somebody played. The answers cross: an engineer's credit *does*
 * travel with the recording and is *not* a performance, so it is here and not
 * there. See the divergence test in creditKind.test.js.
 */
const NOT_A_PERFORMANCE = [
    // Captured the sound rather than made it
    'engineer', 'engineering', 'mix', 'mixed', 'mixing', 'master', 'mastered', 'mastering',
    'recorded by', 'recording by', 'technician', 'assistant', 'studio',
    'transfer', 'restoration', 'tape op',
    // Assembled the recording after the fact. "Programmed By" is deliberately
    // absent: in hip-hop and electronic music the programming IS the drum
    // part, and hiding it would hide the performance. Editing is work done to
    // a performance rather than a performance, so it stays.
    'edited', 'editing',

    // The object people hold
    'artwork', 'art direction', 'artist [cover', 'cover art', 'sleeve', 'design',
    'illustration', 'illustrator', 'layout', 'photography', 'photographer', 'painting',
    // The words printed on it
    'liner notes', 'sleeve notes', 'booklet',
    // Whose release it is, rather than whose recording. "Executive producer"
    // is matched before "producer", which it contains — and plain "producer"
    // is absent on purpose: producing is an artistic hand on the recording,
    // where an executive producer is its financier.
    'executive producer', 'executive-producer', 'a&r', 'management', 'manager',
    'compiled by', 'curated by', 'sequenced by',
    // Manufacture and trade
    'lacquer cut', 'lacquer-cut', 'pressed by', 'distributed by', 'phonographic copyright',
    'copyright', 'licensed', 'marketing', 'legal',
];

/**
 * Whether a single role describes somebody playing.
 *
 * @param {string} role
 * @returns {boolean}
 */
export function isPerformanceRole(role) {
    const text = String(role ?? '').trim().toLowerCase();
    if (!text) return false;
    return !NOT_A_PERFORMANCE.some((keyword) => text.includes(keyword));
}

/**
 * Split a credit's roles into the ones that are performances and the ones that
 * are not.
 *
 * @param {Array<string>|null|undefined} roles
 * @returns {{musical: string[], technical: string[]}}
 */
export function partitionRoles(roles) {
    const list = (Array.isArray(roles) ? roles : [])
        .filter((role) => String(role ?? '').trim() !== '');

    const musical = [];
    const technical = [];
    for (const role of list) {
        (isPerformanceRole(role) ? musical : technical).push(role);
    }
    return { musical, technical };
}

/**
 * Whether a credit should be drawn for somebody looking at musical
 * connections.
 *
 * A credit carrying no roles at all says nothing about what its person did, so
 * it counts as musical and is drawn. Same posture as the rest of this module
 * and as `creditScope.creditForTrack`: absence of evidence is not evidence of
 * a sleeve designer, and a credit nobody described is still a connection
 * somebody recorded.
 *
 * @param {Array<string>|null|undefined} roles
 * @returns {boolean}
 */
export function creditIsMusical(roles) {
    const { musical, technical } = partitionRoles(roles);
    if (musical.length > 0) return true;
    // Roles were given and every one of them was technical.
    return technical.length === 0;
}

export default { isPerformanceRole, partitionRoles, creditIsMusical };
