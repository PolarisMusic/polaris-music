/**
 * @fileoverview Reading a setting that may have arrived blank.
 *
 * @module utils/envSetting
 */

/**
 * The first of these values that was actually configured.
 *
 * `??` is not enough for anything that reaches the process through
 * docker-compose. Every optional setting in docker-compose.yml is written
 * `- FOO=${FOO:-}`, so that compose does not refuse to start over one nobody
 * set — and that puts FOO in the container as an **empty string**. Nullish
 * coalescing then sees a value, the default never applies, and the result is a
 * client configured with nothing:
 *
 *   ODESLI_API_BASE        → `fetch('/links?…')`, which throws
 *                            "Failed to parse URL" on every lookup
 *   MUSICBRAINZ_USER_AGENT → a blank User-Agent, the one header MusicBrainz
 *                            refuses outright
 *
 * Both read as an outage rather than as a default that did not apply, and both
 * only happen in a container — a developer running `npm run dev` with the same
 * line commented out in .env gets the default and sees nothing wrong.
 *
 * Whitespace counts as blank, and a configured value comes back trimmed: an
 * API key pasted with a trailing newline is the same key, and a credential
 * that silently differs by one invisible character is a bad afternoon.
 *
 * @param {...(string|undefined|null)} values - Candidates, most specific
 *   first; the last is normally a literal default.
 * @returns {string} The first non-blank value, trimmed, or '' if there is none.
 */
export function envSetting(...values) {
    for (const value of values) {
        if (value == null) continue;

        const trimmed = String(value).trim();
        if (trimmed) return trimmed;
    }
    return '';
}

export default envSetting;
