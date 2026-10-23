/**
 * Who performed what, on a Discogs release that credits more than one act.
 *
 * A compilation is credited to "Various" at the release level and names the
 * real performer on each track. Polaris has somewhere to put both — a Release
 * carries Groups, and every Track carries its own — but the import read only
 * the release-level credit, so a compilation arrived as a band called Various
 * that played every track, and the dozen acts that actually did were dropped
 * on the floor.
 *
 * "Various" is not a band. Writing it into the registry as one puts a node in
 * the graph that nobody can ever be a member of, and attaches a stranger's
 * recording to it on every compilation anyone imports.
 *
 * Pure and standalone so it can be unit-tested without a browser — the
 * frontend has no unit-test runner, so its tests live under
 * backend/test/frontend/, the same arrangement as listenLinks.js.
 *
 * @module utils/discogsArtists
 */

/**
 * Discogs' own id for the "Various" placeholder.
 *
 * The id is the reliable half: the display name is edited per release and
 * comes through as "Various", "Various Artists" and a few other spellings,
 * while the id is the same row in their database every time.
 */
export const VARIOUS_ARTISTS_ID = 194;

/** The spellings seen without the id, normalized. */
const VARIOUS_NAMES = new Set(['various', 'various artists', 'v/a', 'va']);

/**
 * A Discogs artist name with its disambiguating suffix removed.
 *
 * Discogs appends "(2)", "(3)" to tell apart acts of the same name, which is
 * their database's business and not part of what the band is called.
 *
 * @param {string} name
 * @returns {string}
 */
export function cleanArtistName(name) {
    return String(name ?? '').replace(/\s*\(\d+\)$/, '').trim();
}

/**
 * Whether this credit is the compilation placeholder rather than an act.
 *
 * @param {{id?: number, name?: string}} artist
 * @returns {boolean}
 */
export function isVariousArtists(artist) {
    if (!artist) return false;
    if (Number(artist.id) === VARIOUS_ARTISTS_ID) return true;

    return VARIOUS_NAMES.has(cleanArtistName(artist.name).toLowerCase());
}

/**
 * The acts a release is credited to, with the placeholder removed.
 *
 * @param {Object} discogsRelease
 * @returns {Array<Object>} Possibly empty — a compilation credits nobody at
 *   the release level, and that is the honest answer rather than a band.
 */
export function releaseArtists(discogsRelease) {
    const artists = Array.isArray(discogsRelease?.artists) ? discogsRelease.artists : [];
    return artists.filter((artist) => artist?.name && !isVariousArtists(artist));
}

/**
 * Whether this release is a compilation of other people's recordings.
 *
 * Two independent signals, because either can be absent: the "Various" credit,
 * and Discogs' own format description. A release credited to one act with
 * "Compilation" in its formats is a best-of, not this — it stays credited to
 * that act, and its tracks inherit from the release as they always have.
 *
 * @param {Object} discogsRelease
 * @returns {boolean}
 */
export function isCompilation(discogsRelease) {
    const artists = Array.isArray(discogsRelease?.artists) ? discogsRelease.artists : [];
    if (artists.some(isVariousArtists)) return true;

    const described = (discogsRelease?.formats ?? []).some((format) =>
        (format?.descriptions ?? []).some((d) => String(d).toLowerCase() === 'compilation'));

    // A format description alone only counts when the tracks disagree with
    // each other about who played them; otherwise it is one act's own
    // retrospective.
    return described && trackArtistNames(discogsRelease).size > 1;
}

/**
 * Every distinct performer named on a track, across the tracklist.
 *
 * @param {Object} discogsRelease
 * @returns {Set<string>} Cleaned names, lowercased.
 * @private
 */
function trackArtistNames(discogsRelease) {
    const names = new Set();
    for (const track of discogsRelease?.tracklist ?? []) {
        for (const artist of track?.artists ?? []) {
            const name = cleanArtistName(artist?.name).toLowerCase();
            if (name) names.add(name);
        }
    }
    return names;
}

/**
 * The acts that performed one track.
 *
 * A track's own credit wins where Discogs gives one, which on a compilation is
 * everywhere. Where it does not, the release's acts are the answer — and on a
 * compilation that is an empty list rather than "Various", because nothing
 * here knows who played it and saying so is better than naming a placeholder.
 *
 * `anv` is the name as printed on this particular release — "Bob Dylan" billed
 * as "Blind Boy Grunt" — so it is kept as an alternate name rather than
 * replacing what the act is called or being discarded.
 *
 * @param {Object} discogsTrack
 * @param {Object} discogsRelease
 * @returns {Array<{name: string, id: number|null, alt_names: string[]}>}
 */
export function trackPerformers(discogsTrack, discogsRelease) {
    const credited = Array.isArray(discogsTrack?.artists) && discogsTrack.artists.length > 0
        ? discogsTrack.artists
        : releaseArtists(discogsRelease);

    const performers = [];
    const seen = new Set();

    for (const artist of credited) {
        if (isVariousArtists(artist)) continue;

        const name = cleanArtistName(artist?.name);
        if (!name) continue;

        // Two credits for one act on a track — Discogs does this with `join`
        // strings — are one performer.
        const key = artist?.id != null ? `id:${artist.id}` : `name:${name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const billed = cleanArtistName(artist?.anv);
        performers.push({
            name,
            id: artist?.id ?? null,
            alt_names: billed && billed !== name ? [billed] : [],
        });
    }

    return performers;
}

/**
 * Whether this track's credit says something the release's does not.
 *
 * The form inherits performing groups from the release by default, and that is
 * the right default: it keeps a track's payload pointing at the same Group
 * node the submitter bound at the top, rather than at a new provisional one
 * minted from a re-typed name. So the inheritance is only broken where
 * breaking it says something true.
 *
 * On a compilation it always says something true — the release names nobody,
 * and every track names its act. Elsewhere it only does when the track credits
 * an act the release does not, which is how Discogs writes a guest spot or one
 * outside contribution on an otherwise single-artist record.
 *
 * @param {Object} discogsTrack
 * @param {Object} discogsRelease
 * @returns {boolean}
 */
export function overridesReleaseCredit(discogsTrack, discogsRelease) {
    if (isCompilation(discogsRelease)) return true;
    if (!Array.isArray(discogsTrack?.artists) || discogsTrack.artists.length === 0) return false;

    const key = (artist) => (artist?.id != null
        ? `id:${artist.id}`
        : `name:${cleanArtistName(artist?.name).toLowerCase()}`);

    const theirs = new Set(releaseArtists(discogsRelease).map(key));
    return trackPerformers(discogsTrack, discogsRelease).some((p) =>
        !theirs.has(p.id != null ? `id:${p.id}` : `name:${p.name.toLowerCase()}`));
}

/**
 * Put each of a track's performance credits with the act it belongs to.
 *
 * A compilation names the act on the track and its line-up underneath it —
 * "Tan Sister Radio — Leap Year / Drums – Andrew Ware / Guitar – Aaron Dennis
 * / Vocals, Bass – Max Greenhalgh" — so the people are there to be read, and
 * the import was leaving every group empty.
 *
 * Where a credited performer *is* one of the acts, they go with their own
 * group rather than into somebody else's. Track 6 of that release is "The
 * Paragraphs, Tori Rogg", with Tori Rogg credited on organ: she is a group of
 * one beside The Paragraphs, not a member of it. Matched on the Discogs id
 * first and the name second, because the id survives a reprint and a typo.
 *
 * Everyone else goes with the first act. That is a guess, and it is the same
 * guess the release-level import makes for the same reason: with two acts on
 * one track nothing in the payload says who played in which, and splitting
 * them by anything other than evidence would put people in bands they were
 * never in. With one act — every normal compilation track — there is no guess.
 *
 * @param {Array<{name: string, id: number|null}>} performers - From trackPerformers.
 * @param {Array<{name: string, id?: number|null, roles?: string[], role?: string}>} credits
 *   Performance credits, as discogsClient.parseCredits classifies them.
 * @returns {Array<Array<Object>>} One list per performer, in the same order.
 */
export function creditsByAct(performers, credits) {
    const acts = Array.isArray(performers) ? performers : [];
    const byAct = acts.map(() => []);
    if (acts.length === 0) return byAct;

    const keysFor = (person) => [
        person?.id != null ? `id:${person.id}` : null,
        `name:${cleanArtistName(person?.name).toLowerCase()}`,
    ].filter(Boolean);

    for (const credit of Array.isArray(credits) ? credits : []) {
        const keys = new Set(keysFor(credit));
        const own = acts.findIndex((act) => keysFor(act).some((key) => keys.has(key)));
        byAct[own >= 0 ? own : 0].push(credit);
    }

    return byAct;
}

export default {
    isVariousArtists, releaseArtists, isCompilation, trackPerformers,
    overridesReleaseCredit, creditsByAct, cleanArtistName,
};
