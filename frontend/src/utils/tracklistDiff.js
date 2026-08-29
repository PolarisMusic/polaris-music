/**
 * Compare an imported Discogs tracklist against what Spotify says the album
 * contains.
 *
 * The point is to catch a bad import before it is signed and anchored: a
 * missing pre-roll track, a tracklist taken from the wrong edition, two tracks
 * transposed. Discogs is community-edited and frequently disagrees with the
 * streaming release; neither source is authoritative, so this reports
 * differences and leaves the judgement to the submitter.
 *
 * Pure and standalone so it can be unit-tested without a browser — the frontend
 * has no unit-test runner, so its tests live under backend/test/frontend/,
 * the same arrangement as listenLinks.js.
 *
 * @module utils/tracklistDiff
 */

/**
 * Suffixes streaming services append that do not change which recording it is.
 *
 * Without stripping these, nearly every album reports a difference on nearly
 * every track — Spotify's catalogue is full of "- Remastered 2011" — and a
 * report that always cries wolf is worse than no report.
 */
const EDITION_SUFFIX = /\s*[-–—]\s*(remaster(ed)?|mono|stereo|live|radio edit|single version|album version|deluxe|bonus track|\d{4} (remaster|mix|version))\b.*$/i;

/** Parenthetical additions that likewise do not change the recording. */
const PARENTHETICAL = /\s*[([](feat\.?|featuring|with|remaster(ed)?|mono|stereo|bonus|explicit|deluxe)[^)\]]*[)\]]/gi;

/**
 * Reduce a title to what is being compared.
 *
 * Case, punctuation, edition suffixes and featured-artist parentheticals all
 * go; word order and spelling do not.
 *
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitle(title) {
    return String(title ?? '')
        .replace(PARENTHETICAL, '')
        .replace(EDITION_SUFFIX, '')
        .replace(/['’`]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .toLowerCase();
}

/**
 * Whether two titles name the same recording, for reporting purposes.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameTitle(a, b) {
    const left = normalizeTitle(a);
    return left.length > 0 && left === normalizeTitle(b);
}

/**
 * Diff an imported tracklist against Spotify's.
 *
 * Comparison is by sequence position rather than by the printed position
 * string: a vinyl release numbers tracks per side ("A1", "B1") while Spotify
 * numbers them straight through, so the two position strings never line up even
 * when the records agree.
 *
 * @param {{position?: string, title: string}[]} discogsTracks - In form order.
 * @param {{name: string, track_number?: number}[]} spotifyTracks - In Spotify order.
 * @returns {{kind: string, index: number, position: string|null,
 *            discogs: string|null, spotify: string|null}[]} Differences, in order.
 */
export function diffTracklists(discogsTracks = [], spotifyTracks = []) {
    const differences = [];
    const ours = Array.isArray(discogsTracks) ? discogsTracks : [];
    const theirs = Array.isArray(spotifyTracks) ? spotifyTracks : [];

    if (ours.length !== theirs.length) {
        differences.push({
            kind: 'count',
            index: -1,
            position: null,
            discogs: String(ours.length),
            spotify: String(theirs.length),
        });
    }

    const overlap = Math.min(ours.length, theirs.length);
    for (let i = 0; i < overlap; i++) {
        const mine = ours[i];
        const other = theirs[i];
        if (sameTitle(mine.title, other.name)) continue;

        // A title that appears somewhere else in Spotify's order is a
        // transposition, which is a different problem from a wrong title and
        // is worth naming separately — it usually means one track is missing
        // earlier in the list and everything after it has shifted.
        const elsewhere = theirs.findIndex(t => sameTitle(mine.title, t.name));

        differences.push({
            kind: elsewhere >= 0 ? 'order' : 'title',
            index: i,
            position: mine.position ?? null,
            discogs: mine.title ?? null,
            spotify: other.name ?? null,
        });
    }

    // Anything past the shorter list is present on one side only.
    for (let i = overlap; i < ours.length; i++) {
        differences.push({
            kind: 'missing_on_spotify',
            index: i,
            position: ours[i].position ?? null,
            discogs: ours[i].title ?? null,
            spotify: null,
        });
    }
    for (let i = overlap; i < theirs.length; i++) {
        differences.push({
            kind: 'missing_locally',
            index: i,
            position: null,
            discogs: null,
            spotify: theirs[i].name ?? null,
        });
    }

    return differences;
}

/**
 * A one-line, human-readable form of a difference.
 *
 * @param {{kind: string, position: string|null, discogs: string|null, spotify: string|null}} difference
 * @returns {string}
 */
export function describeDifference(difference) {
    const where = difference.position ? `${difference.position}: ` : '';
    switch (difference.kind) {
        case 'count':
            return `Track count differs — this form has ${difference.discogs}, Spotify has ${difference.spotify}.`;
        case 'order':
            return `${where}"${difference.discogs}" appears here, but Spotify has "${difference.spotify}" at this position — the order may have shifted.`;
        case 'title':
            return `${where}"${difference.discogs}" does not match Spotify's "${difference.spotify}".`;
        case 'missing_on_spotify':
            return `${where}"${difference.discogs}" is not on the Spotify release.`;
        case 'missing_locally':
            return `Spotify has "${difference.spotify}", which is not in this form.`;
        default:
            return `${where}${difference.discogs ?? ''}`;
    }
}
