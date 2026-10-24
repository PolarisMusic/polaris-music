/**
 * @fileoverview Reading a release off a Bandcamp page.
 *
 * Bandcamp has no catalogue API. Their developer programme covers an artist's
 * own sales and orders; there is no endpoint that answers "what is on this
 * album", and the requests for one have gone unanswered for years. So a
 * Bandcamp import reads the page, which is the only thing there is to read.
 *
 * That matters more than it sounds, because Bandcamp is the only source for
 * the music this registry most wants and the other two do not have:
 * self-released records, small-label records, anything never distributed to a
 * shop or a streaming service. Discogs has the pressings; Spotify has the
 * digital catalogue; Bandcamp has what an artist put up themselves.
 *
 * Two structures are read, in order:
 *
 *   1. `<script type="application/ld+json">` — schema.org MusicAlbum. Standard
 *      vocabulary, so it is the one to prefer: `name`, `byArtist`,
 *      `datePublished`, `creditText`, `keywords`, `track.itemListElement[]`.
 *   2. The page's embedded player data (`data-tralbum`, historically
 *      `TralbumData`). Bandcamp's own JSON, with per-track durations in
 *      seconds rather than the ISO strings JSON-LD carries.
 *
 * Neither is a published interface. Bandcamp can change both without notice,
 * which is why every field here is optional, nothing throws on a missing one,
 * and `scripts/checkBandcamp.js` exists to show what a real page yields today.
 *
 * Deliberately not a crawler: one page, fetched because somebody pasted its
 * link, with a User-Agent that says who is asking. Nothing here follows a
 * link, enumerates a discography or runs on a schedule.
 *
 * @module api/bandcampClient
 */

/** Node's fetch has no default timeout; an unreachable host would hang. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Who is asking, and where to complain.
 *
 * The same courtesy MusicBrainz asks for in writing. Bandcamp does not ask,
 * but an operator who wants to block a misbehaving client should be able to
 * tell which one it is.
 */
const USER_AGENT =
    'PolarisMusicRegistry/1.0 ( https://polaris.mu ) release-import-on-paste';

/**
 * Whether this is a Bandcamp release page worth fetching.
 *
 * Album and track pages only. A custom domain — Bandcamp lets a label point
 * its own — cannot be told from any other website by its URL, so those are not
 * accepted: guessing wrong means fetching a stranger's site on a submitter's
 * behalf.
 *
 * @param {string} url
 * @returns {{url: string, kind: 'album'|'track'}|null}
 */
export function parseBandcampUrl(url) {
    let parsed;
    try {
        parsed = new URL(String(url ?? '').trim());
    } catch {
        return null;
    }

    if (!/^https?:$/.test(parsed.protocol)) return null;
    if (!/(^|\.)bandcamp\.com$/i.test(parsed.hostname)) return null;

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    if (segments[0] !== 'album' && segments[0] !== 'track') return null;

    // Query and fragment are tracking and playback state, never identity.
    return {
        url: `${parsed.origin}/${segments[0]}/${segments[1]}`,
        kind: segments[0],
    };
}

/**
 * Undo the escaping an HTML attribute value carries.
 *
 * The player data arrives inside `data-tralbum="…"`, so every quote in that
 * JSON is `&quot;` by the time it reaches us. There is no DOM here to do it
 * properly; this covers the five entities an attribute can contain plus
 * numeric escapes.
 *
 * @param {string} value
 * @returns {string}
 */
export function decodeHtmlAttribute(value) {
    return String(value ?? '')
        .replace(/&(?:#(\d+)|#x([0-9a-f]+)|(quot|amp|lt|gt|apos|#39));/gi,
            (whole, dec, hex, named) => {
                if (dec) return String.fromCodePoint(Number(dec));
                if (hex) return String.fromCodePoint(parseInt(hex, 16));
                return { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", '#39': "'" }[
                    String(named).toLowerCase()] ?? whole;
            })
        // &amp; last would double-decode; doing it first turns &amp;quot; into
        // a quote. Handled above in one pass for that reason.
        .replace(/&nbsp;/gi, ' ');
}

/**
 * Every JSON-LD object on the page, parsed.
 *
 * A page carries several — a breadcrumb list, the album, sometimes an
 * organisation — so this returns all of them and the caller picks.
 *
 * @param {string} html
 * @returns {Object[]}
 */
export function extractJsonLd(html) {
    const blocks = [];
    const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

    for (const match of String(html ?? '').matchAll(pattern)) {
        try {
            const parsed = JSON.parse(match[1].trim());
            // A @graph is a list of objects sharing one block.
            if (Array.isArray(parsed)) blocks.push(...parsed);
            else if (Array.isArray(parsed?.['@graph'])) blocks.push(...parsed['@graph']);
            else if (parsed) blocks.push(parsed);
        } catch {
            // A malformed block is not a reason to abandon the page: the
            // player data below may still answer.
        }
    }
    return blocks;
}

/**
 * The album object out of a page's JSON-LD, if there is one.
 *
 * @param {Object[]} blocks
 * @returns {Object|null}
 */
export function musicAlbumFrom(blocks) {
    const types = (block) => [block?.['@type']].flat().filter(Boolean).map(String);
    return (blocks ?? []).find((block) =>
        types(block).some((t) => t === 'MusicAlbum' || t === 'MusicRecording')) ?? null;
}

/**
 * Bandcamp's own player data, which carries durations as numbers.
 *
 * Two spellings have been in use: the `data-tralbum` attribute, and a
 * `TralbumData` assignment in a script. Both are read, attribute first.
 *
 * @param {string} html
 * @returns {Object|null}
 */
export function extractTralbum(html) {
    const text = String(html ?? '');

    const attribute = /data-tralbum=(["'])([\s\S]*?)\1/i.exec(text);
    if (attribute) {
        try {
            return JSON.parse(decodeHtmlAttribute(attribute[2]));
        } catch {
            // Fall through to the script form.
        }
    }

    const assigned = /(?:var|let|const)\s+TralbumData\s*=\s*(\{[\s\S]*?\})\s*;/i.exec(text);
    if (assigned) {
        try {
            return JSON.parse(assigned[1]);
        } catch {
            // Historically this was JavaScript rather than JSON — trailing
            // commas, single quotes — and parsing it as code is not something
            // a server does with a stranger's page.
            return null;
        }
    }

    return null;
}

/**
 * Seconds, from however this page spells a duration.
 *
 * JSON-LD carries Bandcamp's own ISO-8601 variant, `P00H03M17S`, and the
 * player data carries a float. Anything unrecognised is null rather than a
 * guess: a wrong duration is a claim about the recording.
 *
 * @param {string|number} value
 * @returns {number|null}
 */
export function durationSeconds(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.round(value);
    }

    const iso = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i
        .exec(String(value ?? '').trim());
    if (!iso) return null;

    // Bandcamp writes P00H03M17S — hours and minutes with no T separator, so
    // the minutes land in the date half of the pattern. Both halves are summed,
    // which is right for a duration that never carries years or days.
    const [, , months, days, hours, minutes, seconds] = iso;
    const total = (Number(months) || 0) * 60          // "M" before any T is minutes here
        + (Number(days) || 0) * 86_400
        + (Number(hours) || 0) * 3_600
        + (Number(minutes) || 0) * 60
        + (Number(seconds) || 0);

    return total > 0 ? Math.round(total) : null;
}

/**
 * A date the form can take, from however the page spells one.
 *
 * Bandcamp's JSON-LD writes "11 Nov 2014 00:00:00 GMT". The form takes
 * YYYY/MM/DD, YYYY/MM or YYYY.
 *
 * @param {string} value
 * @returns {string} '' when nothing usable is there.
 */
export function releaseDate(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';

    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (iso) return `${iso[1]}/${iso[2]}/${iso[3]}`;

    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return '';

    // UTC throughout: Bandcamp states these in GMT, and reading them in the
    // server's zone would move a midnight release to the day before.
    const date = new Date(parsed);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`;
}

/**
 * The tags an artist filed the release under.
 *
 * `keywords` is a comma-separated string in some pages and an array in others.
 * These are the artist's own genre statement, which is the best provenance a
 * genre tag can have — see docs/02, "Genre tags".
 *
 * @param {Object} album - JSON-LD album.
 * @returns {string[]}
 */
export function tagsFrom(album) {
    const keywords = album?.keywords;
    const list = Array.isArray(keywords) ? keywords : String(keywords ?? '').split(',');

    const seen = new Set();
    const tags = [];
    for (const entry of list) {
        const tag = String(entry ?? '').trim();
        const key = tag.toLowerCase();
        if (!tag || seen.has(key)) continue;
        seen.add(key);
        tags.push(tag);
    }
    return tags;
}

/**
 * The record label, or null for a record the act put out itself.
 *
 * `publisher` is not the label. It is the band whose Bandcamp page this is,
 * and on an act's own page that is the act: reading it as the label minted a
 * Label node called "Howlin Rain" for a record Silver Current Records
 * released. A label, when there is one, is stated outright — `recordLabel` on
 * a release in the JSON-LD, `label` on a package in the player data — and
 * both appear only when the selling band differs from the page's own.
 *
 * `publisher` is the label in exactly one shape: an album hosted on a label's
 * page, where the page owner is the label and `byArtist` is somebody else.
 * That is the only reading it gets, and a publisher equal to the act is
 * discarded as the band naming itself.
 *
 * @param {Object|null} album - The JSON-LD MusicAlbum.
 * @param {Object|null} tralbum - The embedded player data.
 * @param {string|null} byArtist - The performing act, already resolved.
 * @returns {string|null}
 */
export function labelFrom(album, tralbum, byArtist) {
    const releases = Array.isArray(album?.albumRelease) ? album.albumRelease : [];
    for (const release of releases) {
        const stated = release?.recordLabel?.name;
        if (stated) return String(stated).trim();
    }

    const packages = Array.isArray(tralbum?.packages) ? tralbum.packages : [];
    for (const pkg of packages) {
        if (pkg?.label) return String(pkg.label).trim();
    }

    const publisher = album?.publisher?.name ? String(album.publisher.name).trim() : null;
    if (!publisher) return null;
    const act = byArtist ? String(byArtist).trim() : null;
    return act && publisher.toLowerCase() === act.toLowerCase() ? null : publisher;
}

/**
 * The track's own page, or null when it has none.
 *
 * Only some tracks of an album get a page to themselves. The rest are listed
 * with an `@id` of the album URL plus a `#t4` fragment, which is the album
 * page — handing that over as a track's listen link pointed six of one
 * album's nine tracks at the same address. A track that really has a page
 * says so twice, in `mainEntityOfPage` and in the player's `title_link`, and
 * both are absent for the fragment-only ones.
 *
 * @param {Object} item - The JSON-LD MusicRecording.
 * @param {Object} player - The matching trackinfo entry.
 * @param {string} url - The album page URL, for resolving a relative link.
 * @returns {string|null}
 */
export function trackUrl(item, player, url) {
    const page = item?.mainEntityOfPage;
    if (typeof page === 'string' && page && !page.includes('#')) return page;

    if (player?.title_link) {
        try {
            return new URL(String(player.title_link), url).toString();
        } catch {
            return null;
        }
    }

    const id = item?.['@id'];
    return typeof id === 'string' && id && !id.includes('#') ? id : null;
}

/** Bandcamp's `musicReleaseFormat` for the physical editions we have a name for. */
const PHYSICAL_FORMAT = new Map([
    ['vinylformat', 'LP'],
    ['cdformat', 'CD'],
    ['cassetteformat', 'Cassette'],
]);

/**
 * The format of the release this page *is*, which is not the formats it sells.
 *
 * A Bandcamp album page is one digital release that may also offer vinyl, a
 * CD and a test pressing. In this registry those are separate Releases:
 * format is part of the release fingerprint precisely so a CD does not MERGE
 * onto the LP it was remastered from. So the page maps to its digital album,
 * and the editions it sells alongside are reported to the submitter rather
 * than folded in.
 *
 * A track page is a Single. A page with no digital release at all — physical
 * only — takes the format of the first edition it does offer.
 *
 * @param {Object|null} album - The JSON-LD MusicAlbum.
 * @param {Object|null} tralbum - The embedded player data.
 * @returns {string|null}
 */
export function formatFrom(album, tralbum) {
    const itemType = String(tralbum?.item_type ?? tralbum?.current?.type ?? '').toLowerCase();
    if (itemType === 'track') return 'Single';

    const releases = Array.isArray(album?.albumRelease) ? album.albumRelease : [];
    const formats = releases
        .map((release) => String(release?.musicReleaseFormat ?? '').toLowerCase())
        .filter(Boolean);

    if (formats.includes('digitalformat')) return 'Digital';
    // The digital album carries no musicReleaseFormat on some pages; the
    // player data still announces it, and a page with audio always has one.
    if (!formats.length) return tralbum?.hasAudio || itemType === 'album' ? 'Digital' : null;

    for (const format of formats) {
        const known = PHYSICAL_FORMAT.get(format);
        if (known) return known;
    }
    return 'Other';
}

/**
 * The physical editions sold beside the digital release, by Bandcamp's own
 * name for each. Informational: each is a Release of its own to submit, and
 * saying so is more use to a submitter than silently dropping them.
 *
 * @param {Object|null} tralbum - The embedded player data.
 * @returns {string[]}
 */
export function otherEditions(tralbum) {
    const packages = Array.isArray(tralbum?.packages) ? tralbum.packages : [];
    const seen = new Set();
    const editions = [];
    for (const pkg of packages) {
        const name = String(pkg?.type_name ?? '').trim();
        const key = name.toLowerCase();
        if (!name || seen.has(key)) continue;
        seen.add(key);
        editions.push(name);
    }
    return editions;
}

/**
 * One release, as this page describes it.
 *
 * JSON-LD first for everything it carries, because it is standard vocabulary;
 * the player data fills in what it does not, which is mainly exact durations.
 * Nothing is invented: a field neither structure carries comes back null, and
 * the form shows a submitter an empty box rather than a guess.
 *
 * @param {string} html
 * @param {string} url - The canonical page URL.
 * @returns {{name: string, artist: string|null, release_date: string,
 *            label: string|null, format: string|null,
 *            other_editions: string[], upc: string|null,
 *            credits: string|null, about: string|null,
 *            tags: string[], art: string|null, url: string,
 *            tracks: Array<{title: string, position: number, duration: number|null,
 *                           url: string|null, artist: string|null}>}|null}
 */
export function albumFromPage(html, url) {
    const album = musicAlbumFrom(extractJsonLd(html));
    const tralbum = extractTralbum(html);
    if (!album && !tralbum) return null;

    const current = tralbum?.current ?? {};
    const name = String(album?.name ?? current.title ?? '').trim();
    if (!name) return null;

    const byArtist = album?.byArtist?.name ?? tralbum?.artist ?? current.artist ?? null;
    const label = labelFrom(album, tralbum, byArtist);

    // The player data's durations are seconds and exact; JSON-LD's are
    // Bandcamp's ISO variant. Matched up by position, which is the only key
    // both halves share.
    const playerTracks = Array.isArray(tralbum?.trackinfo) ? tralbum.trackinfo : [];
    const listed = Array.isArray(album?.track?.itemListElement)
        ? album.track.itemListElement
        : [];

    const tracks = [];
    const count = Math.max(listed.length, playerTracks.length);
    for (let index = 0; index < count; index++) {
        const item = listed[index]?.item ?? {};
        const player = playerTracks[index] ?? {};

        const title = String(item.name ?? player.title ?? '').trim();
        if (!title) continue;

        // Only a compilation states this, and then only sometimes: on a
        // single-act record every track is the page's act and both fields are
        // null. UNVERIFIED against a live compilation — see checkBandcamp.js,
        // which prints it so one paste settles whether these are the names.
        const act = item.byArtist?.name ?? player.artist ?? null;

        tracks.push({
            title,
            position: Number(listed[index]?.position ?? player.track_num ?? index + 1),
            duration: durationSeconds(player.duration) ?? durationSeconds(item.duration),
            url: trackUrl(item, player, url),
            artist: act ? String(act).trim() : null,
        });
    }

    return {
        name,
        artist: byArtist ? String(byArtist).trim() : null,
        release_date: releaseDate(album?.datePublished ?? current.release_date),
        label: label ? String(label).trim() : null,
        format: formatFrom(album, tralbum),
        // Separate Releases, not this one's formats. See formatFrom.
        other_editions: otherEditions(tralbum),
        // Usually null, and the key a credits lookup needs when it is not.
        upc: current.upc ? String(current.upc).trim() : null,
        // Free text, typed by whoever put the record up. Bandcamp has no
        // structured credits at all: no roles, no per-person fields, nothing a
        // parser can trust. It is liner notes, and that is where it goes.
        credits: album?.creditText ?? current.credits ?? null,
        about: album?.description ?? current.about ?? null,
        tags: tagsFrom(album),
        art: album?.image ?? null,
        url,
        tracks,
    };
}

export class BandcampClient {
    /**
     * @param {Object} [options]
     * @param {Function} [options.fetchImpl] - Injectable for tests; no network in CI.
     */
    constructor({ fetchImpl } = {}) {
        this.fetch = fetchImpl ?? fetch;
    }

    /** Always configured: there are no credentials to have. */
    isConfigured() {
        return true;
    }

    /**
     * Fetch one release page and read it.
     *
     * @param {string} url - A bandcamp.com album or track URL.
     * @returns {Promise<Object|null>} The release, or null when the page
     *   carries no structured data this understands.
     * @throws {Error} With `status` for an HTTP failure, so a caller can tell
     *   a release that is gone from a host that is unreachable.
     */
    async fetchRelease(url) {
        const target = parseBandcampUrl(url);
        if (!target) {
            const error = new Error('Not a Bandcamp album or track URL');
            error.reason = 'not_bandcamp';
            throw error;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let response;
        try {
            response = await this.fetch(target.url, {
                headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
                signal: controller.signal,
                redirect: 'follow',
            });
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            const error = new Error(`Bandcamp answered ${response.status}`);
            error.status = response.status;
            throw error;
        }

        return albumFromPage(await response.text(), target.url);
    }
}

export default BandcampClient;
