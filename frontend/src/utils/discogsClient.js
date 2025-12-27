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
     * Parse Discogs credits to identify roles
     * @param {Array} extraArtists - Discogs extraartists array
     * @returns {Object} Categorized credits
     */
    parseCredits(extraArtists) {
        const credits = {
            producers: [],
            engineers: [],
            mixedBy: [],
            masteredBy: [],
            guests: []
        };

        if (!extraArtists) return credits;

        for (const artist of extraArtists) {
            const role = artist.role ? artist.role.toLowerCase() : '';
            const name = artist.name.replace(/\s*\(\d+\)$/, ''); // Remove Discogs numbering

            if (role.includes('producer')) {
                credits.producers.push({ name, id: artist.id });
            } else if (role.includes('engineer') || role.includes('recording')) {
                credits.engineers.push({ name, id: artist.id, role: artist.role });
            } else if (role.includes('mix')) {
                credits.mixedBy.push({ name, id: artist.id });
            } else if (role.includes('master')) {
                credits.masteredBy.push({ name, id: artist.id });
            } else if (role.includes('vocals') || role.includes('guitar') ||
                       role.includes('bass') || role.includes('drums') ||
                       role.includes('keyboards') || role.includes('piano')) {
                // Instrument roles indicate guest musicians
                credits.guests.push({ name, id: artist.id, role: artist.role });
            }
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
