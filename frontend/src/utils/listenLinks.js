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
    },
    {
        // Recognized because the backend now resolves Deezer links from a
        // track's ISRC, and an unrecognized link is only ever tracking-stripped
        // — which leaves two spellings of the same track comparing unequal, so
        // the same link gets stored twice.
        //
        // Deezer puts a bare two-letter locale in the path, as /en/track/123,
        // where Spotify writes /intl-de/. Handled per service rather than by
        // widening LOCALE_SEGMENT for everyone: a two-letter path segment is
        // only meaningless here because Deezer says so.
        service: 'deezer',
        // Not deezer.page.link: a dynamic short link's path is an opaque token
        // that only a redirect resolves, so claiming to parse it would mean
        // inventing an id. Those fall through to being tracking-stripped,
        // which is the honest answer for a link we cannot read.
        hosts: ['deezer.com'],
        types: ['track', 'album', 'playlist', 'artist'],
        locale: /^[a-z]{2}$/i,
        canonical: (type, id) => `https://www.deezer.com/${type}/${id}`
    },
    {
        // Apple names a track as a song *inside* an album: the path is the
        // album and `?i=` is the track, so a path-only parser reads every track
        // link as its album and two different songs from one record collapse
        // into one identity.
        //
        // The storefront stays in the URL and out of the identity. It is part
        // of a working link, but the same recording in two storefronts is one
        // recording, and dedup has to agree with that.
        service: 'apple',
        hosts: ['music.apple.com', 'geo.music.apple.com'],
        parse: (parsed) => {
            const segments = parsed.pathname.split('/').filter(Boolean);
            const storefront = /^[a-z]{2}$/i.test(segments[0] ?? '') ? segments[0] : null;
            const rest = storefront ? segments.slice(1) : segments;
            const [kind, ...tail] = rest;
            // The last path segment is the id; the slug before it is decoration
            // Apple ignores, and keeping it would fork the identity on a rename.
            const pathId = tail[tail.length - 1];
            if (!kind || !pathId) return null;

            const track = parsed.searchParams.get('i');
            if (kind === 'album' && track) {
                return { type: 'track', id: track, extra: { storefront, album: pathId } };
            }
            if (['album', 'artist', 'playlist', 'song'].includes(kind)) {
                return { type: kind === 'song' ? 'track' : kind, id: pathId, extra: { storefront } };
            }
            return null;
        },
        canonical: (type, id, extra = {}) => {
            const store = extra.storefront ?? 'us';
            if (type === 'track' && extra.album) {
                return `https://music.apple.com/${store}/album/${extra.album}?i=${id}`;
            }
            return `https://music.apple.com/${store}/${type}/${id}`;
        }
    },
    {
        service: 'tidal',
        hosts: ['tidal.com', 'listen.tidal.com'],
        types: ['track', 'album', 'playlist', 'artist', 'video', 'mix'],
        // Their share links carry /browse/ and their player does not; both name
        // the same thing.
        locale: /^browse$/i,
        canonical: (type, id) => `https://tidal.com/browse/${type}/${id}`
    },
    {
        // Both YouTubes put the id in `?v=`, so neither can be read from a path.
        service: 'youtubeMusic',
        hosts: ['music.youtube.com'],
        parse: (parsed) => fromYouTube(parsed),
        canonical: (type, id) => (type === 'playlist'
            ? `https://music.youtube.com/playlist?list=${id}`
            : `https://music.youtube.com/watch?v=${id}`)
    },
    {
        service: 'youtube',
        hosts: ['youtube.com', 'm.youtube.com', 'youtu.be'],
        parse: (parsed) => fromYouTube(parsed),
        canonical: (type, id) => (type === 'playlist'
            ? `https://www.youtube.com/playlist?list=${id}`
            : `https://www.youtube.com/watch?v=${id}`)
    },
    {
        // Amazon files a track as an album plus `?trackAsin=`, the same shape
        // as Apple and for the same reason.
        service: 'amazonMusic',
        hosts: ['music.amazon.com', 'music.amazon.co.uk', 'music.amazon.de'],
        parse: (parsed) => {
            const segments = parsed.pathname.split('/').filter(Boolean);
            const [kind, id] = segments;
            const track = parsed.searchParams.get('trackAsin');
            if (kind === 'albums' && id && track) {
                return { type: 'track', id: track, extra: { album: id } };
            }
            if (kind === 'albums' && id) return { type: 'album', id };
            if (kind === 'tracks' && id) return { type: 'track', id };
            if (kind === 'artists' && id) return { type: 'artist', id };
            return null;
        },
        canonical: (type, id, extra = {}) => (type === 'track' && extra.album
            ? `https://music.amazon.com/albums/${extra.album}?trackAsin=${id}`
            : `https://music.amazon.com/${type === 'track' ? 'tracks' : `${type}s`}/${id}`)
    },
    {
        // SoundCloud's path *is* the identity: /artist/track, with /sets/ for a
        // playlist. Nothing here is a numeric id, which is why it is kept whole.
        service: 'soundcloud',
        hosts: ['soundcloud.com', 'm.soundcloud.com'],
        parse: (parsed) => {
            const segments = parsed.pathname.split('/').filter(Boolean);
            if (segments.length === 1) return { type: 'artist', id: segments[0] };
            if (segments[1] === 'sets' && segments[2]) {
                return { type: 'playlist', id: `${segments[0]}/sets/${segments[2]}` };
            }
            if (segments.length >= 2) return { type: 'track', id: `${segments[0]}/${segments[1]}` };
            return null;
        },
        canonical: (type, id) => `https://soundcloud.com/${id}`
    },
    {
        // Pandora writes an entity as a prefixed id — TR: a track, AL: an
        // album, AR: an artist — and that is what their API hands out:
        // `https://www.pandora.com/TR:5661544` came back from Odesli for a
        // Spotify track on 2026-10-22. This table previously left Pandora out
        // on the grounds that its links were slug soup with nothing to key on,
        // which the live answer disproves.
        //
        // The human-readable /artist/<artist>/<album>/<track> path is a second
        // spelling, and no rule here maps it onto the first: that would need
        // Pandora to answer which id a slug names. It keeps its own identity
        // instead, the way SoundCloud's path does — two spellings of one track
        // comparing unequal is a duplicate link, while guessing they are the
        // same recording is a wrong one.
        service: 'pandora',
        // Not pandora.app.link: a dynamic short link's path is an opaque token
        // only a redirect resolves, so parsing it would mean inventing an id.
        hosts: ['pandora.com'],
        parse: (parsed) => {
            const segments = parsed.pathname.split('/').filter(Boolean)
                .map((segment) => decodeURIComponent(segment));
            if (segments.length === 0) return null;

            const prefixed = /^(TR|AL|AR|PL|ST):(.+)$/i.exec(segments[0]);
            if (prefixed) {
                const kind = { TR: 'track', AL: 'album', AR: 'artist',
                    PL: 'playlist', ST: 'station' }[prefixed[1].toUpperCase()];
                return kind
                    ? { type: kind, id: `${prefixed[1].toUpperCase()}:${prefixed[2]}` }
                    : null;
            }

            // /artist/<artist>[/<album>[/<track>]], deepest segment first:
            // four segments name a track, three an album, two an artist.
            if (segments[0].toLowerCase() === 'artist' && segments.length >= 2) {
                const depth = { 2: 'artist', 3: 'album' };
                return { type: depth[segments.length] ?? 'track', id: segments.join('/') };
            }
            return null;
        },
        canonical: (type, id) => `https://www.pandora.com/${id}`
    }
];

/**
 * Both YouTube hosts, which agree about everything except the domain.
 *
 * A youtu.be link carries the id as its whole path; everywhere else it is `?v=`,
 * and a playlist is `?list=`. Checked in that order because a link can carry
 * both — a track *within* a playlist — and the track is what it points at.
 *
 * @param {URL} parsed
 * @returns {{type: string, id: string}|null}
 * @private
 */
function fromYouTube(parsed) {
    if (parsed.hostname.toLowerCase().replace(/^www\./, '') === 'youtu.be') {
        const id = parsed.pathname.split('/').filter(Boolean)[0];
        return id ? { type: 'track', id } : null;
    }

    const video = parsed.searchParams.get('v');
    if (video) return { type: 'track', id: video };

    const list = parsed.searchParams.get('list');
    if (list) return { type: 'playlist', id: list };

    return null;
}

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

    // A service that cannot be read from its path brings its own parser. Apple,
    // Amazon and both YouTubes keep the thing being linked to in a query
    // parameter, so the shared path walk below would read an Apple track link
    // as its album — collapsing every song on a record into one identity.
    if (definition.parse) {
        const read = definition.parse(parsed);
        if (!read?.id) return null;
        return {
            service: definition.service,
            type: read.type,
            id: read.id,
            url: definition.canonical(read.type, read.id, read.extra),
        };
    }

    // Drop the locale prefix and the /embed/ marker, then expect type/id.
    // A service's own `locale` pattern is consulted too, and only for that
    // service — Deezer's bare /en/ would otherwise have to be allowed
    // everywhere, which would make /us/album/... parse as type "album" on a
    // host that means something else by it.
    const segments = parsed.pathname.split('/')
        .filter(Boolean)
        .filter(seg => !LOCALE_SEGMENT.test(seg) && seg.toLowerCase() !== 'embed')
        .filter(seg => !(definition.locale?.test(seg) && !definition.types.includes(seg.toLowerCase())));

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
