/**
 * Listen-link normalization.
 *
 * Submitted links are stored stripped to the part that identifies the
 * recording: service, type and id. Everything else a share button attaches —
 * `?si=` session tokens, `utm_*` campaign tags, the `/intl-de/` locale segment
 * Spotify inserts for non-English users — describes the person who copied the
 * link, not the music, and makes two links to the same track compare unequal.
 *
 * backend/src/api/playerService.js has extractSpotifyUri(), which parses the
 * same forms. It is deliberately not shared: importing it here would pull the
 * API module graph into the browser bundle. The accepted forms are kept in
 * step by hand, and the table below is the place to add a service.
 *
 * @module utils/listenLinks
 */

/**
 * Recognized services, keyed by the hostnames they use.
 *
 * `types` lists the path segments that introduce an id, so a URL is only
 * accepted when it names something we can point a player at.
 */
const SERVICES = [
    {
        service: 'spotify',
        hosts: ['open.spotify.com', 'play.spotify.com'],
        types: ['track', 'album', 'playlist', 'artist', 'episode', 'show'],
        canonical: (type, id) => `https://open.spotify.com/${type}/${id}`
    }
];

/** Query params that describe the sharer rather than the music. */
const TRACKING_PARAMS = /^(si|utm_[a-z_]+|nd|_branch_match_id|context|go|sp_cid|referrer)$/i;

/** Two-letter locale segments Spotify injects: /intl-de/track/... */
const LOCALE_SEGMENT = /^intl-[a-z]{2,3}$/i;

/**
 * Reduce a listen link to its essential identity.
 *
 * Accepts full URLs, locale-prefixed URLs, /embed/ URLs and bare `spotify:`
 * URIs. Anything unrecognized returns null rather than a guess — storing a URL
 * we cannot parse as though we understood it is worse than storing nothing.
 *
 * @param {string} url - A pasted link or URI.
 * @returns {{service: string, type: string, id: string, url: string}|null}
 */
export function normalizeListenLink(url) {
    if (typeof url !== 'string') return null;
    const raw = url.trim();
    if (!raw) return null;

    const fromUri = parseUri(raw);
    if (fromUri) return fromUri;

    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        return null;
    }

    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const definition = SERVICES.find(s => s.hosts.includes(host));
    if (!definition) return null;

    // Drop the locale prefix and the /embed/ marker, then expect type/id.
    const segments = parsed.pathname.split('/')
        .filter(Boolean)
        .filter(seg => !LOCALE_SEGMENT.test(seg) && seg.toLowerCase() !== 'embed');

    const [type, id] = segments;
    if (!type || !id) return null;
    if (!definition.types.includes(type.toLowerCase())) return null;

    return {
        service: definition.service,
        type: type.toLowerCase(),
        id,
        url: definition.canonical(type.toLowerCase(), id)
    };
}

/**
 * Parse a bare `spotify:track:ID` style URI.
 *
 * @param {string} raw
 * @returns {{service: string, type: string, id: string, url: string}|null}
 * @private
 */
function parseUri(raw) {
    const match = /^([a-z]+):([a-z]+):([A-Za-z0-9]+)$/.exec(raw);
    if (!match) return null;

    const [, scheme, type, id] = match;
    const definition = SERVICES.find(s => s.service === scheme);
    if (!definition || !definition.types.includes(type)) return null;

    return { service: definition.service, type, id, url: definition.canonical(type, id) };
}

/**
 * Strip tracking parameters from a URL without otherwise rewriting it.
 *
 * Used for links to services we do not recognize: we cannot canonicalize them,
 * but we can still avoid storing someone's share token.
 *
 * @param {string} url
 * @returns {string} The cleaned URL, or the input unchanged if it will not parse.
 */
export function stripTrackingParams(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return url;
    }
    for (const key of [...parsed.searchParams.keys()]) {
        if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
}

/**
 * Normalize for storage, falling back to a cleaned original.
 *
 * A link to a service we do not model yet should still be kept — the submitter
 * took the trouble to add it — just without the tracking cruft.
 *
 * @param {string} url
 * @returns {string|null} null only for input that is not a URL at all.
 */
export function canonicalizeListenLink(url) {
    const normalized = normalizeListenLink(url);
    if (normalized) return normalized.url;

    const raw = typeof url === 'string' ? url.trim() : '';
    if (!raw) return null;
    try {
        new URL(raw);
    } catch {
        return null;
    }
    return stripTrackingParams(raw);
}

/**
 * Whether two links point at the same thing.
 *
 * Comparison is on the normalized identity, so a locale-prefixed link with a
 * share token matches the plain one. Unrecognized links compare on their
 * cleaned URL text, which is the best available answer.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameTarget(a, b) {
    const left = normalizeListenLink(a);
    const right = normalizeListenLink(b);

    if (left && right) {
        return left.service === right.service
            && left.type === right.type
            && left.id === right.id;
    }
    if (left || right) return false;

    const cleanedA = canonicalizeListenLink(a);
    const cleanedB = canonicalizeListenLink(b);
    return cleanedA !== null && cleanedA === cleanedB;
}
