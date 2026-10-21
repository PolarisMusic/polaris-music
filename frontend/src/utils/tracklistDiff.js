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

/**
 * Parenthetical additions that likewise do not change the recording.
 *
 * Kept in step with EDITION_SUFFIX above, which already discounted "- Album
 * Version" and "- 2011 Remaster" while the bracketed forms of the same words
 * went through as differences. A catalogue writes both.
 *
 * Deliberately not "any trailing bracket": "(Live)", "(Demo)", "(Acoustic)"
 * and "(Remix)" name *different recordings*, and pairing one of those with the
 * studio take would be the confidently-wrong match this module exists to avoid.
 */
const PARENTHETICAL = /\s*[([](feat\.?|featuring|with|remaster(ed)?|mono|stereo|bonus|explicit|deluxe|lp version|album version|single version|original mix|\d{4} (remaster|mix|version))[^)\]]*[)\]]/gi;

/**
 * A title with edition decoration removed but its spelling left alone.
 *
 * This is what gets recorded when the two services spell a title differently:
 * normalizeTitle's output is lowercased and stripped of punctuation, which is
 * fine for comparing and wrong for storing, while the raw catalogue string
 * drags "- Remastered 2011" along with it.
 *
 * @param {string} title
 * @returns {string}
 */
export function displayTitle(title) {
    return String(title ?? '')
        .replace(PARENTHETICAL, '')
        .replace(EDITION_SUFFIX, '')
        .trim();
}

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
    return displayTitle(title)
        .replace(/['’`]/g, '')
        // Before punctuation goes, because losing the ampersand outright makes
        // "Rock & Roll" and "Rock and Roll" four characters apart instead of
        // identical — far enough apart to defeat the tolerance below.
        .replace(/\s*&\s*/g, ' and ')
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
 * How much disagreement a title of a given length is allowed.
 *
 * Roughly one edit per ten characters, measured on the shorter of the two. A
 * fixed budget cannot work: one edit is a plural on "Mystic Lover" and a
 * different song entirely on "Intro" — which is two edits from "Outro" and
 * must stay that way.
 */
const FUZZY_CHARS_PER_EDIT = 10;

/**
 * Levenshtein distance, two rows at a time.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        previous = current;
    }
    return previous[b.length];
}

/**
 * Whether two titles are the same recording spelled differently.
 *
 * Discogs is typed by hand and a streaming catalogue is typed by somebody else:
 * "Mystic Lover" against "Mystic Lovers", a dropped article, a transliterated
 * accent. Demanding an exact match after normalising discards that pairing
 * entirely — no link gets filled, and the better of the two spellings is thrown
 * away rather than recorded.
 *
 * The tolerance scales with length, and short titles get none, because the
 * cost of being wrong is not symmetric: an unfilled field is visible and costs
 * a moment, while a link written against the wrong recording is invisible and
 * anchored.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function nearlySameTitle(a, b) {
    const left = normalizeTitle(a);
    const right = normalizeTitle(b);
    if (!left || !right) return false;
    if (left === right) return true;

    const budget = Math.floor(Math.min(left.length, right.length) / FUZZY_CHARS_PER_EDIT);
    return budget > 0 && editDistance(left, right) <= budget;
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

        // A transposition outranks a misspelling, deliberately: an exact match
        // somewhere else in the list is stronger evidence about what happened
        // than a near match here, and an offset tracklist of near-identical
        // titles would otherwise be reported as a page of misspellings.
        const kind = elsewhere >= 0
            ? 'order'
            : (nearlySameTitle(mine.title, other.name) ? 'spelling' : 'title');

        differences.push({
            kind,
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
        case 'spelling':
            return `${where}"${difference.discogs}" is spelled "${difference.spotify}" on Spotify — close enough to be the same recording, so both spellings are kept.`;
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

/**
 * Pair the form's tracks with Spotify's, for filling in per-track listen links.
 *
 * Matching is by normalized title, never by list position. Position is the least
 * trustworthy signal available here — this module exists because Discogs and
 * Spotify tracklists routinely disagree by an offset — and a link written
 * against the wrong track is bad data of precisely the kind the registry is
 * meant to prevent. An unfilled field is visible and costs a moment; a
 * confidently wrong one is invisible and permanent.
 *
 * Duplicate titles (a reprise, two "Untitled") are the one place ordering is
 * consulted, and only to choose between candidates already known to share a
 * title: equal counts on both sides pair in order, otherwise a track number
 * matching the row's ordinal decides. Getting that wrong swaps two identically
 * named tracks, which is a far smaller error than mismatching a title.
 *
 * A second pass then pairs what is left by near-identical title, so a row the
 * two services spell differently still gets its link — see below.
 *
 * @param {{position?: string, title: string}[]} formTracks - In form order.
 * @param {{id: string, name: string, track_number?: number}[]} spotifyTracks
 * @returns {{index: number, spotify: Object|null, alt_title: string|null,
 *            reason: string}[]}
 *   One entry per form track. `reason` is 'matched', 'near_match' when the
 *   titles differ only in spelling, 'ambiguous' when several candidates were
 *   plausible and none could be chosen, or 'no_match'. `alt_title` is Spotify's
 *   spelling, present only on a near match and only when it really differs.
 */
export function matchSpotifyTracks(formTracks = [], spotifyTracks = []) {
    const ours = Array.isArray(formTracks) ? formTracks : [];
    const theirs = Array.isArray(spotifyTracks) ? spotifyTracks : [];

    /** @type {Map<string, {rows: number[], tracks: Object[]}>} */
    const groups = new Map();
    const group = (key) => {
        if (!groups.has(key)) groups.set(key, { rows: [], tracks: [] });
        return groups.get(key);
    };

    ours.forEach((track, index) => {
        const key = normalizeTitle(track?.title);
        // An untitled row cannot be matched on title, and normalizeTitle
        // collapses every such row to the same empty key — so they are skipped
        // rather than grouped together.
        if (key) group(key).rows.push(index);
    });
    for (const track of theirs) {
        const key = normalizeTitle(track?.name);
        if (key) group(key).tracks.push(track);
    }

    const results = ours.map((_, index) => (
        { index, spotify: null, alt_title: null, reason: 'no_match' }));

    for (const { rows, tracks } of groups.values()) {
        if (rows.length === 0 || tracks.length === 0) continue;

        if (rows.length === 1 && tracks.length === 1) {
            results[rows[0]] = {
                index: rows[0], spotify: tracks[0], alt_title: null, reason: 'matched',
            };
            continue;
        }

        if (rows.length === tracks.length) {
            rows.forEach((row, i) => {
                results[row] = {
                    index: row, spotify: tracks[i], alt_title: null, reason: 'matched',
                };
            });
            continue;
        }

        if (rows.length > tracks.length) {
            // More rows carry this title than Spotify has recordings of it, so
            // at least one row has no counterpart and nothing says which. An
            // ordinal here would be a coin toss dressed up as a match.
            for (const row of rows) {
                results[row] = {
                    index: row, spotify: null, alt_title: null, reason: 'ambiguous',
                };
            }
            continue;
        }

        // Spotify lists more than the form does — an extra version, say. Every
        // row does have a counterpart; a track number landing exactly on the
        // row's ordinal picks it, and anything less certain stays unmatched.
        for (const row of rows) {
            const byNumber = tracks.find(t => Number(t?.track_number) === row + 1);
            results[row] = byNumber
                ? { index: row, spotify: byNumber, alt_title: null, reason: 'matched' }
                : { index: row, spotify: null, alt_title: null, reason: 'ambiguous' };
        }
    }

    // ===== Second pass: the same recording, spelled differently =====
    //
    // Discogs is typed by hand; a streaming catalogue is typed by somebody
    // else. "Mystic Lover" against "Mystic Lovers" is one character and two
    // sources that agree about everything else, and stopping at the exact
    // comparison throws away both the link and the other spelling.
    //
    // Only a *mutually* unique pairing is accepted: one candidate for the row,
    // and that candidate reached by no other row. Taking the first plausible
    // pair instead would make the answer depend on tracklist order, which is
    // the one signal this module refuses to trust.
    const claimed = new Set(results.map(r => r.spotify).filter(Boolean));
    const openTracks = theirs.filter(t => !claimed.has(t) && normalizeTitle(t?.name));

    /** @type {Map<number, Object[]>} form row -> its near candidates */
    const candidates = new Map();
    /** @type {Map<Object, number>} spotify track -> how many rows reached it */
    const reachedBy = new Map();

    for (const result of results) {
        // Only rows nothing was decided about. A row left 'ambiguous' had an
        // exact title group that was rejected as unresolvable, and a weaker
        // match is no way to resolve it.
        if (result.reason !== 'no_match') continue;
        const title = ours[result.index]?.title;
        if (!normalizeTitle(title)) continue;

        const near = openTracks.filter(t => nearlySameTitle(title, t.name));
        if (near.length === 0) continue;

        candidates.set(result.index, near);
        for (const track of near) reachedBy.set(track, (reachedBy.get(track) ?? 0) + 1);
    }

    for (const [row, near] of candidates) {
        if (near.length > 1 || reachedBy.get(near[0]) > 1) {
            results[row] = { index: row, spotify: null, alt_title: null, reason: 'ambiguous' };
            continue;
        }

        // Spotify's spelling, with edition decoration removed: it is the one
        // that differs from what the form holds, and the form's title is the
        // one about to be submitted as canonical.
        const theirSpelling = displayTitle(near[0].name);
        const ourSpelling = String(ours[row]?.title ?? '').trim();

        results[row] = {
            index: row,
            spotify: near[0],
            alt_title: theirSpelling && theirSpelling !== ourSpelling
                ? theirSpelling
                : null,
            reason: 'near_match',
        };
    }

    return results;
}

/**
 * Share of the form's tracks a candidate album must account for.
 *
 * Three quarters, not all of them: a Discogs LP tracklist and a streaming
 * release of the same record routinely differ by a bonus track or an
 * untitled run-out groove, and demanding a clean sweep would reject the right
 * album for the same reasons the diff below exists to report.
 */
const NAME_MATCH_MIN_SHARE = 0.75;

/**
 * Floor under that share, so a short form cannot be matched on one title.
 *
 * A single-track form against a greatest-hits package containing that track
 * clears any percentage, which is why the share alone is not the whole test.
 */
const NAME_MATCH_MIN_TRACKS = 3;

/**
 * How many of a candidate's tracks a form must account for to claim it.
 *
 * @param {number} rows - Tracks on the form.
 * @returns {number}
 */
function requiredMatches(rows) {
    return Math.max(Math.ceil(rows * NAME_MATCH_MIN_SHARE),
        Math.min(rows, NAME_MATCH_MIN_TRACKS));
}

/**
 * Whether two tracklists are the same list of recordings.
 *
 * Used only to tell "two editions of the one album" from "two different
 * albums that scored alike": the first is a choice worth making and the
 * second is a coin toss worth refusing.
 *
 * @param {{name: string}[]} a
 * @param {{name: string}[]} b
 * @returns {boolean}
 */
function sameTracklist(a = [], b = []) {
    if (a.length !== b.length || a.length === 0) return false;
    return a.every((track, i) => sameTitle(track?.name, b[i]?.name));
}

/**
 * Pick the album a form's tracklist proves it is about, out of candidates
 * found by name.
 *
 * Artist-and-title search is guesswork — that is why it is the last resort,
 * behind a submitter's own link and behind a barcode, both of which name one
 * release. What makes it usable anyway is that the guess does not have to be
 * trusted: the search only *proposes* an album, and the tracklist in the form
 * is independent evidence about whether the proposal is right. Twelve titles
 * agreeing in order is not something two unrelated releases do.
 *
 * So this accepts a candidate only when the form accounts for most of it and
 * for most of the form, and refuses when two candidates explain the tracklist
 * equally well without being the same record. The rejected front-runner comes
 * back regardless, because "this is the closest thing Spotify has and here is
 * why it was not used" is the message a submitter can act on.
 *
 * @param {{position?: string, title: string}[]} formTracks
 * @param {{id: string, name: string, tracks: {name: string}[]}[]} candidates
 * @returns {{album: Object|null, best: Object|null, reason: string,
 *            accounted: number, required: number, rows: number,
 *            considered: number}}
 *   `reason` is 'matched', 'ambiguous' when two candidates tie, 'weak' when
 *   the closest one fell short of the bar, or 'none' when there was nothing to
 *   choose between or no tracklist to judge with.
 */
export function chooseAlbumByTracklist(formTracks = [], candidates = []) {
    const rows = (Array.isArray(formTracks) ? formTracks : [])
        .filter(track => normalizeTitle(track?.title));
    const albums = (Array.isArray(candidates) ? candidates : [])
        .filter(album => Array.isArray(album?.tracks) && album.tracks.length > 0);

    const required = requiredMatches(rows.length);
    const empty = {
        album: null,
        best: null,
        reason: 'none',
        accounted: 0,
        required,
        rows: rows.length,
        considered: albums.length,
    };
    if (rows.length === 0 || albums.length === 0) return empty;

    const scored = albums.map(album => {
        const accounted = matchSpotifyTracks(rows, album.tracks)
            .filter(match => match.spotify).length;
        return {
            album,
            accounted,
            // Tracks the form says nothing about. A compilation that happens to
            // carry this album's singles accounts for a few rows and leaves
            // thirty unexplained, and is not this album.
            unexplained: album.tracks.length - accounted,
        };
    });

    // Most of the form accounted for first; then the tightest fit, which is how
    // a standard edition wins over the deluxe reissue that contains it.
    scored.sort((a, b) => b.accounted - a.accounted || a.unexplained - b.unexplained);

    const [best, runnerUp] = scored;
    const result = {
        album: null,
        best: best.album,
        reason: 'weak',
        accounted: best.accounted,
        required,
        rows: rows.length,
        considered: albums.length,
    };

    if (best.accounted < required || best.accounted < best.unexplained) return result;

    // A tie on both counts between genuinely different records is exactly the
    // coin toss this module refuses elsewhere. Between two editions of the one
    // record it is not a choice at all, and Spotify's own ordering can have it.
    if (runnerUp
        && runnerUp.accounted === best.accounted
        && runnerUp.unexplained === best.unexplained
        && !sameTracklist(best.album.tracks, runnerUp.album.tracks)) {
        return { ...result, reason: 'ambiguous' };
    }

    return { ...result, album: best.album, reason: 'matched' };
}

/**
 * Say what a name search came back with, and why it was or was not used.
 *
 * The rejected front-runner is named and linked deliberately. "No match" on
 * its own leaves a submitter with nothing to do; "this is the closest thing
 * Spotify has, it only accounts for four of your eleven tracks, here it is"
 * lets them look and decide, which is the division of labour this whole
 * cross-check is built on.
 *
 * @param {{album: Object|null, best: Object|null, reason: string,
 *          accounted: number, rows: number, considered: number}} choice
 * @returns {string}
 */
export function describeAlbumChoice(choice) {
    const best = choice?.best;
    const link = best?.id ? ` — https://open.spotify.com/album/${best.id}` : '';

    switch (choice?.reason) {
        case 'matched':
            return `Found "${best.name}" by name, and the tracklists agree.`;
        case 'ambiguous':
            return `Spotify has ${choice.considered} releases under this name that fit this `
                + 'tracklist equally well, and they are not the same record, so none was used. '
                + 'Paste a Spotify album link to say which.';
        case 'weak':
            return `Spotify's closest release by name is "${best.name}", which accounts for `
                + `${choice.accounted} of this form's ${choice.rows} track(s) — too few to be sure `
                + `it is the same record, so nothing was filled in${link}. Paste a Spotify album `
                + 'link if it is the right release.';
        default:
            return 'Spotify has nothing under that name to compare against.';
    }
}
