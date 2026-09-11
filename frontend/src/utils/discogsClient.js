/**
 * Discogs API Client for Frontend
 *
 * Fetches release data from Discogs API for auto-populating the submission form.
 * Uses unauthenticated API (60 requests per minute rate limit).
 */

export class DiscogsClient {
    constructor() {
        this.apiBase = 'https://api.discogs.com';
        this.userAgent = 'PolarisMusic/1.0';
        this.lastRequestTime = 0;
        this.minRequestInterval = 1000; // 1 second between requests (safe rate limit)
    }

    /**
     * Rate limiting helper
     * @private
     */
    async rateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;

        if (timeSinceLastRequest < this.minRequestInterval) {
            const waitTime = this.minRequestInterval - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        this.lastRequestTime = Date.now();
    }

    /**
     * Fetch release data by Discogs release ID
     * @param {number} releaseId - Discogs release ID
     * @returns {Promise<Object>} Release data
     */
    async fetchRelease(releaseId) {
        await this.rateLimit();

        console.log(`Fetching Discogs release ${releaseId}...`);

        const response = await fetch(`${this.apiBase}/releases/${releaseId}`, {
            headers: {
                'User-Agent': this.userAgent
            }
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error(`Release ${releaseId} not found on Discogs`);
            } else if (response.status === 429) {
                throw new Error('Rate limit exceeded. Please wait and try again.');
            }
            throw new Error(`Discogs API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        console.log('Discogs release data:', data);

        return data;
    }

    /**
     * Fetch artist data by Discogs artist ID
     * @param {number} artistId - Discogs artist ID
     * @returns {Promise<Object>} Artist data
     */
    async fetchArtist(artistId) {
        await this.rateLimit();

        console.log(`Fetching Discogs artist ${artistId}...`);

        const response = await fetch(`${this.apiBase}/artists/${artistId}`, {
            headers: {
                'User-Agent': this.userAgent
            }
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error(`Artist ${artistId} not found on Discogs`);
            } else if (response.status === 429) {
                throw new Error('Rate limit exceeded. Please wait and try again.');
            }
            throw new Error(`Discogs API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return data;
    }

    /**
     * Fetch master release data by Discogs master ID
     * Masters represent canonical album groupings - this method gets the main release
     * @param {number} masterId - Discogs master ID
     * @returns {Promise<Object>} Main release data from master
     */
    async fetchMaster(masterId) {
        await this.rateLimit();

        console.log(`Fetching Discogs master ${masterId}...`);

        const response = await fetch(`${this.apiBase}/masters/${masterId}`, {
            headers: {
                'User-Agent': this.userAgent
            }
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error(`Master ${masterId} not found on Discogs`);
            } else if (response.status === 429) {
                throw new Error('Rate limit exceeded. Please wait and try again.');
            }
            throw new Error(`Discogs API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        console.log('Discogs master data:', data);

        // Master returns main_release ID - fetch that actual release
        if (data.main_release) {
            console.log(`Fetching main release ${data.main_release} from master...`);
            return this.fetchRelease(data.main_release);
        }

        return data;
    }

    /**
     * Extract release ID or master ID from Discogs URL
     * @param {string} url - Discogs release or master URL
     * @returns {Object|null} {type: 'release'|'master', id: number} or null if invalid
     */
    extractReleaseId(url) {
        // Match patterns like:
        // https://www.discogs.com/release/123456
        // https://discogs.com/release/123456-Artist-Name-Album-Title
        // https://www.discogs.com/master/3239-Artist-Album
        // Just the number: 123456

        if (/^\d+$/.test(url)) {
            return { type: 'release', id: parseInt(url, 10) };
        }

        // Check for master URL
        const masterMatch = url.match(/\/master\/(\d+)/);
        if (masterMatch) {
            return { type: 'master', id: parseInt(masterMatch[1], 10) };
        }

        // Check for release URL
        const releaseMatch = url.match(/\/release\/(\d+)/);
        if (releaseMatch) {
            return { type: 'release', id: parseInt(releaseMatch[1], 10) };
        }

        return null;
    }

    /**
     * Determine if a Discogs artist is likely a group/band
     * Uses heuristics based on name and role
     * @param {Object} artist - Discogs artist object
     * @returns {boolean} True if likely a group
     */
    isGroup(artist) {
        const name = artist.name.toLowerCase();

        // Keywords that indicate a group
        const groupKeywords = [
            'band', 'orchestra', 'ensemble', 'quartet', 'trio',
            'quintet', 'sextet', 'the ', 'group', 'collective',
            'choir', 'chorus', 'symphony'
        ];

        if (groupKeywords.some(keyword => name.includes(keyword))) {
            return true;
        }

        // Names with "And" or "&" often indicate groups
        if (name.includes(' and ') || name.includes(' & ')) {
            return true;
        }

        // Role-based detection
        if (artist.role && artist.role.toLowerCase().includes('orchestra')) {
            return true;
        }

        return false;
    }

    /**
     * Roles that mean someone played on the record, rather than worked on it.
     *
     * The distinction drives MEMBER_OF versus GUEST_ON, which is the
     * relationship the registry cares most about getting right.
     */
    static PERFORMANCE_ROLES = [
        'performer', 'vocals', 'vocal', 'guitar', 'bass', 'drums', 'percussion',
        'keyboards', 'piano', 'organ', 'synthesizer', 'harmonica', 'saxophone',
        'trumpet', 'trombone', 'violin', 'viola', 'cello', 'flute', 'clarinet',
        'banjo', 'mandolin', 'sitar', 'accordion', 'strings', 'horns', 'backing'
    ];

    /**
     * Normalize a name for identity comparison.
     *
     * Strips Discogs' disambiguating "(2)" suffix, collapses whitespace and
     * folds case, so an ANV like "Chris Novoselic" and the canonical "Krist
     * Novoselic" at least compare consistently with themselves. It cannot
     * unify genuinely different spellings — that is what the id is for — but it
     * stops the same string being treated as two people.
     *
     * @param {string} name
     * @returns {string}
     */
    normalizeName(name) {
        return (name || '')
            .replace(/\s*\(\d+\)$/, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    /**
     * Build a lookup of the group's roster from Discogs' `members` array.
     *
     * Returns null when Discogs gave us nothing usable — an artist with no
     * `members` is either a solo act or a group Discogs has not filled in, and
     * the two are indistinguishable from the payload. Treating an absent roster
     * as an empty one would make every credited musician a guest, so absence
     * means "unknown" and the caller keeps its previous behaviour.
     *
     * @param {Array<{id?: number, name: string}>|null} rosterMembers
     * @returns {{ids: Set<number>, names: Set<string>}|null}
     */
    buildRoster(rosterMembers) {
        if (!Array.isArray(rosterMembers) || rosterMembers.length === 0) return null;

        const ids = new Set();
        const names = new Set();
        for (const member of rosterMembers) {
            if (!member) continue;
            if (member.id != null) ids.add(member.id);
            const name = String(member.name || '').replace(/\s*\(\d+\)$/, '').trim();
            if (name) names.add(this.normalizeName(name));
        }

        return (ids.size > 0 || names.size > 0) ? { ids, names } : null;
    }

    /**
     * Is this credited person on the roster?
     *
     * Discogs ids match exactly when both sides have one. Names are the
     * fallback, normalized the same way everywhere else in this class, because
     * a roster entry and a credit line can disagree on the "(2)" suffix or on
     * spacing while naming the same person.
     *
     * @param {{ids: Set<number>, names: Set<string>}} roster
     * @param {{id: ?number, name: string, altNames: Set<string>}} person
     * @returns {boolean}
     */
    isInRoster(roster, person) {
        if (person.id != null && roster.ids.has(person.id)) return true;
        if (roster.names.has(this.normalizeName(person.name))) return true;

        // The name printed on the sleeve can differ from the canonical one;
        // check the ANV aliases too before concluding they are not in the band.
        for (const alt of person.altNames) {
            if (roster.names.has(this.normalizeName(alt))) return true;
        }
        return false;
    }

    /**
     * Parse Discogs credits into members, and the production people who are not.
     *
     * Rewritten because the previous version misfiled a whole band as guests.
     * It had four defects that compounded:
     *
     *   1. Its "is a performer" set was built only from roles containing the
     *      literal word "performer". Discogs usually writes the instrument
     *      instead — "Bass, Vocals" — so the set was normally empty.
     *   2. The performer exclusion guarded only the guests bucket; the
     *      production buckets deliberately "include EVERYONE (even
     *      performers)", so a member who co-produced became a guest anyway.
     *   3. The buckets were independent `if`s, so one person credited
     *      "Producer, Engineer, Mixed By" produced three separate rows. That is
     *      how four credit lines became eleven guests.
     *   4. Identity was the numeric Discogs id with no name fallback, so an
     *      alias entry and the canonical entry were two different people.
     *
     * The fix is to accumulate every credit line per person FIRST, then
     * classify that person once. Anyone who played gets treated as a member of
     * the performing group; production-only people are guests. Someone who both
     * played and produced is a member — a production credit does not stop them
     * being in the band.
     *
     * @param {Array} extraArtists - Discogs extraartists array
     * @returns {{members: Array, producers: Array, engineers: Array,
     *            mixedBy: Array, masteredBy: Array, guests: Array}}
     */
    parseCredits(extraArtists, { rosterMembers = null } = {}) {
        // The band's actual roster, when Discogs knows it. `/artists/{id}`
        // returns `members` for a group, and it is the only authoritative
        // answer to "was this person in the band" that Discogs offers.
        const roster = this.buildRoster(rosterMembers);

        const credits = {
            members: [], producers: [], engineers: [],
            mixedBy: [], masteredBy: [], guests: []
        };

        if (!extraArtists || extraArtists.length === 0) return credits;

        // Accumulate every credit line for one human into a single entry.
        // Key on the Discogs id when present, else the normalized name, so two
        // lines for the same person converge however Discogs recorded them.
        const people = new Map();

        for (const artist of extraArtists) {
            const name = (artist.name || '').replace(/\s*\(\d+\)$/, '').trim();
            if (!name) continue;

            const key = artist.id != null ? `id:${artist.id}` : `name:${this.normalizeName(name)}`;

            if (!people.has(key)) {
                people.set(key, { name, id: artist.id ?? null, roles: [], altNames: new Set() });
            }
            const person = people.get(key);

            // Discogs' ANV is how the name was printed on this release. Keep it
            // as an alternative rather than discarding it, which is what the
            // previous code did.
            if (artist.anv && this.normalizeName(artist.anv) !== this.normalizeName(name)) {
                person.altNames.add(artist.anv.trim());
            }

            for (const role of String(artist.role || '').split(',')) {
                const trimmed = role.trim();
                if (trimmed) person.roles.push(trimmed);
            }
        }

        for (const person of people.values()) {
            const roles = [...new Set(person.roles)];
            const lowered = roles.map(r => r.toLowerCase());
            const has = (needle) => lowered.some(r => r.includes(needle));

            const entry = {
                name: person.name,
                id: person.id,
                roles,
                role: roles.join(', '),
                altNames: [...person.altNames]
            };

            const performanceRoles = roles.filter(r =>
                DiscogsClient.PERFORMANCE_ROLES.some(k => r.toLowerCase().includes(k)));

            // With a roster, membership is a fact rather than an inference.
            // Being in the band makes you a member whatever you were credited
            // for — a member who only produced this record is still in it.
            if (roster && this.isInRoster(roster, person)) {
                const memberRoles = performanceRoles.length > 0 ? performanceRoles : roles;
                credits.members.push({
                    ...entry, roles: memberRoles, role: memberRoles.join(', '), fromRoster: true
                });
                continue;
            }

            if (performanceRoles.length > 0) {
                // Played on the record. Whether that makes them a *member* is
                // the whole question, and an instrument credit does not answer
                // it: a session player and a founding member are credited
                // identically. So when the roster is known and does not list
                // them, they are a guest — which is what the domain model asks
                // for ("If unclear, default to guest").
                //
                // Without a roster there is nothing better to go on, so the
                // older behaviour stands: an instrument credit is taken as
                // membership. That is wrong for session players and right for
                // the whole-band-filed-as-guests case this replaced, and it
                // only applies when Discogs gave us no members list at all.
                const bucket = roster ? credits.guests : credits.members;
                bucket.push({
                    ...entry,
                    roles: performanceRoles,
                    role: performanceRoles.join(', '),
                    ...(roster ? { excludedByRoster: true } : {})
                });
                continue;
            }

            // Production and technical people. Each person lands in exactly one
            // bucket, most specific first, so nobody is listed three times.
            if (has('master')) credits.masteredBy.push(entry);
            else if (has('mix')) credits.mixedBy.push(entry);
            else if (has('producer')) credits.producers.push(entry);
            else if (has('engineer') || has('recording')) credits.engineers.push(entry);
            else credits.guests.push(entry);
        }

        return credits;
    }

    /**
     * Extract songwriters from Discogs track data
     * @param {Object} track - Discogs track object
     * @returns {Array} Songwriter names
     */
    extractSongwriters(track) {
        const writers = new Set();

        // Check extraartists for Written-By credits
        if (track.extraartists) {
            for (const artist of track.extraartists) {
                const role = artist.role ? artist.role.toLowerCase() : '';
                if (role.includes('written') || role.includes('composer') ||
                    role.includes('writer') || role.includes('lyrics')) {
                    const name = artist.name.replace(/\s*\(\d+\)$/, '');
                    writers.add(name);
                }
            }
        }

        return Array.from(writers);
    }
}

export const discogsClient = new DiscogsClient();
