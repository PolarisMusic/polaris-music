/**
 * @fileoverview What counts as a genre, and when two spellings are one genre.
 *
 * Genre tags arrive from three places that agree about nothing: MusicBrainz's
 * controlled list (lowercase, hyphenated — "psychedelic rock", "hip-hop"),
 * Discogs styles (title case — "Psychedelic Rock"), and whatever a submitter
 * types. Left alone, "hip-hop", "Hip Hop" and "hiphop" are three nodes, and the
 * set arithmetic the whole feature exists for — which artists sit in the
 * overlap between two genres — silently reports three disjoint sets.
 *
 * So each tag reduces to an identity key. Two rules, kept apart deliberately:
 *
 *   MECHANICAL — case, accents, punctuation, "&", whitespace. Not judgements:
 *   nobody disputes that "Hip-Hop" and "hip hop" are the same word.
 *
 *   ORTHOGRAPHIC — a short table of spellings of one word ("prog rock" /
 *   "progressive rock"). Also not judgements, and the table stays small on
 *   purpose. "R&B" is NOT in it: collapsing it onto "rhythm and blues" merges
 *   1950s jump blues with 1990s contemporary R&B, which is a claim about music
 *   rather than about spelling. Claims about music belong in a submission
 *   somebody signs and others can vote on, not in a lookup table nobody sees.
 *
 * The display name is whatever the first source called it, trimmed. Nothing
 * here invents a capitalisation: MusicBrainz writes genres in lower case by
 * convention and that is its own editorial choice, not a mistake to correct.
 *
 * @module graph/genreVocabulary
 */

/**
 * Spellings of one word, never statements that two genres are the same.
 *
 * Keyed and valued in normalized form, so the mechanical pass runs first and
 * this only has to know about word-joining and common abbreviation. Anything
 * arguable is left out: see the module note on R&B.
 */
const ORTHOGRAPHIC = Object.freeze({
    'hiphop': 'hip hop',
    'prog rock': 'progressive rock',
    'psych rock': 'psychedelic rock',
    'synth pop': 'synthpop',
    'dnb': 'drum and bass',
    'd n b': 'drum and bass',
    'lo fi': 'lofi',
});

/**
 * Tags that describe the listener rather than the music.
 *
 * Last.fm's folksonomy is full of these and they are the single biggest reason
 * a crowd tag set reads as noise: "seen live" is the second most used tag on
 * the service and says nothing about any record.
 */
const ABOUT_THE_LISTENER = new Set([
    'seen live', 'favorites', 'favourites', 'favorite', 'favourite',
    'favorite songs', 'favourite songs', 'favorite albums', 'favourite albums',
    'albums i own', 'vinyl i own', 'owned', 'my gems', 'my music',
    'check out', 'to listen', 'to listen to', 'want to hear', 'wishlist',
    'awesome', 'amazing', 'beautiful', 'cool', 'love', 'loved', 'love it',
    'good', 'great', 'best', 'best of', 'masterpiece', 'classic albums',
    'under 2000 listeners', 'spotify', 'albums', 'music', 'song', 'songs',
    'all', 'other', 'misc', 'miscellaneous', 'unknown', 'none',
]);

/**
 * A decade or a year: real folksonomy, but not a genre.
 *
 * The registry already knows when a release came out, from the release date on
 * the node, so a "1970s" tag adds nothing a query cannot answer better — and it
 * would sit in the genre overlap view competing with things that describe
 * music.
 */
const PERIOD = /^((19|20)\d0s|\d0s|\d{4})$/;

/**
 * Long enough to be a sentence rather than a label.
 *
 * Words, not characters, because that is what separates the two: real genre
 * names are short in words however long they run in letters — "melodic death
 * metal", "progressive psychedelic rock", "drum and bass" are all three — while
 * a listener's note is a phrase ("music to listen to while driving"). A
 * character limit alone lets a 57-character sentence through, which is how this
 * was first written and what a test caught. The length cap stays as a backstop
 * against a single absurd token.
 */
const MAX_WORDS = 5;
const MAX_LENGTH = 60;

/**
 * Reduce a tag to the form two spellings of it share.
 *
 * @param {string} raw
 * @returns {string} '' when there is nothing usable
 */
export function normalizeGenre(raw) {
    const mechanical = String(raw ?? '')
        // Accents folded for identity only: "québécois folk" and "quebecois
        // folk" are one tag, and which one a source writes is a keyboard
        // question.
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s*&\s*/g, ' and ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');

    return ORTHOGRAPHIC[mechanical] ?? mechanical;
}

/**
 * Whether a tag says anything about the music.
 *
 * @param {string} raw
 * @returns {boolean}
 */
export function isDescriptive(raw) {
    const key = normalizeGenre(raw);
    if (!key) return false;
    if (key.length > MAX_LENGTH) return false;
    if (key.split(' ').length > MAX_WORDS) return false;
    // A single character is never a genre, and a bare number is a rating or a
    // year wearing a tag's clothes.
    if (key.length < 2) return false;
    if (/^\d+$/.test(key)) return false;
    if (PERIOD.test(key)) return false;
    return !ABOUT_THE_LISTENER.has(key);
}

/**
 * A tag as the registry should hold it, or null if it should not hold it.
 *
 * `key` is the identity two sources share; `name` is what the source called it,
 * tidied but not restyled. Storing the source's spelling rather than a
 * manufactured one is the same decision as alt_titles: the registry records
 * what somebody wrote, and a capitalisation nobody chose is not more canonical
 * for having been produced by a function.
 *
 * @param {string} raw
 * @returns {{key: string, name: string}|null}
 */
export function canonicalGenre(raw) {
    if (!isDescriptive(raw)) return null;

    return {
        key: normalizeGenre(raw),
        name: String(raw).trim().replace(/\s+/g, ' '),
    };
}

/**
 * Canonicalize a list, keeping the first spelling of each distinct genre.
 *
 * Deduplicated on the key rather than the text, which is the point: a release
 * tagged "Hip-Hop" by Discogs and "hip hop" by MusicBrainz is tagged once.
 *
 * @param {Array<string|{name?: string, count?: number}>} raw - Strings, or the
 *   objects MusicBrainz returns (`{name, count}`).
 * @returns {Array<{key: string, name: string, count: number}>} Most-used first,
 *   then alphabetical by key so the order is stable for a reader comparing runs.
 */
export function canonicalGenres(raw) {
    const byKey = new Map();

    for (const entry of Array.isArray(raw) ? raw : []) {
        const text = typeof entry === 'string' ? entry : entry?.name;
        const canonical = canonicalGenre(text);
        if (!canonical) continue;

        const count = Number(typeof entry === 'object' ? entry?.count : 0) || 0;
        const existing = byKey.get(canonical.key);
        if (existing) {
            // One genre, two spellings, two counts: the votes are for the same
            // thing, so they add rather than compete.
            existing.count += count;
            continue;
        }
        byKey.set(canonical.key, { ...canonical, count });
    }

    return [...byKey.values()].sort((a, b) =>
        (b.count - a.count) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export default { normalizeGenre, isDescriptive, canonicalGenre, canonicalGenres };
