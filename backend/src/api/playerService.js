/**
 * @fileoverview Player queue service for Polaris Music Registry
 *
 * Builds playback queues from Neo4j for release, group, and person contexts.
 * Normalizes track metadata and listen links, determining inline playability.
 *
 * @module api/playerService
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('playerService');

/**
 * Audio file extensions that can be played directly in an HTML <audio> element.
 */
const INLINE_PLAYABLE_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.wav', '.flac', '.webm']);

/**
 * Known streaming/external service hostnames.
 */
const EXTERNAL_SERVICE_HOSTS = new Set([
    'open.spotify.com', 'spotify.com',
    'music.apple.com', 'itunes.apple.com',
    'bandcamp.com',
    'soundcloud.com',
    'youtube.com', 'www.youtube.com', 'music.youtube.com', 'youtu.be',
    'tidal.com', 'listen.tidal.com',
    'deezer.com', 'www.deezer.com',
    'amazon.com', 'music.amazon.com'
]);

/**
 * Determine the service type from a URL hostname.
 */
function classifyLinkType(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, '');
        if (host.includes('spotify')) return 'spotify';
        if (host.includes('apple')) return 'apple_music';
        if (host.includes('bandcamp')) return 'bandcamp';
        if (host.includes('soundcloud')) return 'soundcloud';
        if (host.includes('youtube') || host === 'youtu.be') return 'youtube';
        if (host.includes('tidal')) return 'tidal';
        if (host.includes('deezer')) return 'deezer';
        if (host.includes('amazon')) return 'amazon_music';
        return 'other';
    } catch {
        return 'other';
    }
}

/**
 * Determine if a URL points to a directly playable audio resource.
 */
function isInlinePlayable(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, '');

        // If it's a known streaming service, it's not inline-playable
        if (EXTERNAL_SERVICE_HOSTS.has(host)) return false;

        // Check file extension in pathname
        const pathname = parsed.pathname.toLowerCase();
        for (const ext of INLINE_PLAYABLE_EXTENSIONS) {
            if (pathname.endsWith(ext)) return true;
        }

        // Check content-type hints in URL params (some CDNs use this)
        const contentType = parsed.searchParams.get('content-type') || '';
        if (contentType.startsWith('audio/')) return true;

        return false;
    } catch {
        return false;
    }
}

/**
 * Normalize listen links for a track, classifying each and identifying playable URLs.
 */
function normalizeListenLinks(listenLinks) {
    if (!Array.isArray(listenLinks) || listenLinks.length === 0) {
        return {
            playable_url: null,
            preferred_link: null,
            all_links: [],
            can_inline_play: false
        };
    }

    const allLinks = [];
    let playableUrl = null;
    let preferredLink = null;

    // Priority order for preferred external link
    const priorityOrder = ['spotify', 'apple_music', 'bandcamp', 'youtube', 'soundcloud', 'tidal', 'deezer', 'amazon_music', 'other'];

    for (const url of listenLinks) {
        if (typeof url !== 'string' || !url.trim()) continue;

        const type = classifyLinkType(url);
        const playable = isInlinePlayable(url);

        allLinks.push({ type, url });

        if (playable && !playableUrl) {
            playableUrl = url;
        }
    }

    // Pick preferred external link by priority
    for (const pType of priorityOrder) {
        const found = allLinks.find(l => l.type === pType);
        if (found) {
            preferredLink = found.url;
            break;
        }
    }

    // If no preferred link was found by type, use first link
    if (!preferredLink && allLinks.length > 0) {
        preferredLink = allLinks[0].url;
    }

    return {
        playable_url: playableUrl,
        preferred_link: preferredLink,
        all_links: allLinks,
        can_inline_play: !!playableUrl
    };
}

export class PlayerService {
    /**
     * @param {import('neo4j-driver').Driver} driver - Neo4j driver instance
     */
    constructor(driver) {
        this.driver = driver;
    }

    /**
     * Build a playback queue for the given context.
     *
     * @param {'release'|'group'|'person'} contextType
     * @param {string} contextId
     * @returns {Promise<{context: Object, queue: Array}>}
     */
    async buildQueue(contextType, contextId) {
        switch (contextType) {
            case 'release':
                return this._buildReleaseQueue(contextId);
            case 'group':
                return this._buildGroupQueue(contextId);
            case 'person':
                return this._buildPersonQueue(contextId);
            default:
                throw new Error(`Invalid context type: ${contextType}`);
        }
    }

    /**
     * Build queue for a release: tracks ordered by disc_number, track_number.
     */
    async _buildReleaseQueue(releaseId) {
        const session = this.driver.session();
        try {
            const result = await session.run(`
                MATCH (r:Release {release_id: $releaseId})
                WHERE r.status = 'ACTIVE'
                MATCH (t:Track)-[ir:IN_RELEASE]->(r)
                WHERE t.status = 'ACTIVE'
                OPTIONAL MATCH (g:Group)-[:PERFORMED_ON]->(t)
                WHERE g.status = 'ACTIVE'
                RETURN r, t, ir,
                       collect(DISTINCT g.name) as groupNames
                ORDER BY ir.disc_number, ir.track_number, t.title
            `, { releaseId });

            if (result.records.length === 0) {
                return { context: null, queue: [] };
            }

            const release = result.records[0].get('r').properties;
            const context = {
                type: 'release',
                id: release.release_id,
                name: release.name
            };

            const queue = result.records.map(rec => {
                const t = rec.get('t').properties;
                const ir = rec.get('ir').properties;
                return this._buildQueueEntry(t, ir, release);
            });

            return { context, queue };
        } finally {
            await session.close();
        }
    }

    /**
     * Build queue for a group: tracks from all releases performed by this group,
     * ordered by release_date, release_name, disc_number, track_number.
     */
    async _buildGroupQueue(groupId) {
        const session = this.driver.session();
        try {
            const result = await session.run(`
                MATCH (g:Group {group_id: $groupId})
                WHERE g.status = 'ACTIVE'
                MATCH (g)-[:PERFORMED_ON]->(t:Track)
                WHERE t.status = 'ACTIVE'
                MATCH (t)-[ir:IN_RELEASE]->(r:Release)
                WHERE r.status = 'ACTIVE'
                RETURN g, t, ir, r
                ORDER BY r.release_date, r.name, ir.disc_number, ir.track_number, t.title
            `, { groupId });

            if (result.records.length === 0) {
                // Try to at least get the group name
                const gResult = await session.run(
                    `MATCH (g:Group {group_id: $groupId}) RETURN g LIMIT 1`,
                    { groupId }
                );
                const gName = gResult.records[0]?.get('g')?.properties?.name || groupId;
                return {
                    context: { type: 'group', id: groupId, name: gName },
                    queue: []
                };
            }

            const group = result.records[0].get('g').properties;
            const context = {
                type: 'group',
                id: group.group_id,
                name: group.name
            };

            const queue = result.records.map(rec => {
                const t = rec.get('t').properties;
                const ir = rec.get('ir').properties;
                const r = rec.get('r').properties;
                return this._buildQueueEntry(t, ir, r);
            });

            return { context, queue };
        } finally {
            await session.close();
        }
    }

    /**
     * Build queue for a person: tracks from releases they contributed to
     * (via MEMBER_OF->Group->PERFORMED_ON or GUEST_ON or WROTE->Song->RECORDING_OF),
     * ordered by release_date, release_name, disc_number, track_number.
     */
    async _buildPersonQueue(personId) {
        const session = this.driver.session();
        try {
            const result = await session.run(`
                MATCH (p:Person {person_id: $personId})
                WHERE p.status = 'ACTIVE'
                CALL {
                    WITH p
                    MATCH (p)-[:PERFORMED_ON]->(t:Track)
                    WHERE t.status = 'ACTIVE'
                    RETURN t
                    UNION
                    WITH p
                    MATCH (p)-[:GUEST_ON]->(t:Track)
                    WHERE t.status = 'ACTIVE'
                    RETURN t
                    UNION
                    WITH p
                    MATCH (p)-[:WROTE]->(:Song)<-[:RECORDING_OF]-(t:Track)
                    WHERE t.status = 'ACTIVE'
                    RETURN t
                }
                WITH p, t
                MATCH (t)-[ir:IN_RELEASE]->(r:Release)
                WHERE r.status = 'ACTIVE'
                RETURN p, t, ir, r
                ORDER BY r.release_date, r.name, ir.disc_number, ir.track_number, t.title
            `, { personId });

            if (result.records.length === 0) {
                const pResult = await session.run(
                    `MATCH (p:Person {person_id: $personId}) RETURN p LIMIT 1`,
                    { personId }
                );
                const pName = pResult.records[0]?.get('p')?.properties?.name || personId;
                return {
                    context: { type: 'person', id: personId, name: pName },
                    queue: []
                };
            }

            const person = result.records[0].get('p').properties;
            const context = {
                type: 'person',
                id: person.person_id,
                name: person.name
            };

            const queue = result.records.map(rec => {
                const t = rec.get('t').properties;
                const ir = rec.get('ir').properties;
                const r = rec.get('r').properties;
                return this._buildQueueEntry(t, ir, r);
            });

            return { context, queue };
        } finally {
            await session.close();
        }
    }

    /**
     * Build a single queue entry from track, IN_RELEASE relationship, and release data.
     */
    _buildQueueEntry(track, inRelease, release) {
        const listen = normalizeListenLinks(track.listen_links);

        return {
            track_id: track.track_id,
            track_name: track.title,
            track_number: this._toInt(inRelease.track_number),
            disc_number: this._toInt(inRelease.disc_number) || 1,
            duration_ms: this._toInt(track.duration) || null,
            release_id: release.release_id,
            release_name: release.name,
            release_date: release.release_date || null,
            album_art: release.album_art || null,
            listen
        };
    }

    /**
     * Safely convert a Neo4j Integer or JS value to a plain number.
     */
    _toInt(val) {
        if (val == null) return null;
        if (typeof val === 'number') return val;
        if (typeof val.toNumber === 'function') return val.toNumber();
        return parseInt(val) || null;
    }
}
