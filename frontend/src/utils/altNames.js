/**
 * Saying why a search result is in the list.
 *
 * The search index covers alternate names — `entitySearch` includes
 * `alt_names` and `alt_titles`, and the substring fallback checks both — so a
 * query can match a node through a name the row does not show. Typing "Avey
 * Tare" returns somebody filed as Dave Portner, and with nothing to explain it
 * the row reads as a mistake rather than an answer.
 *
 * Its own module, free of Vite imports, so it can be unit-tested: the frontend
 * has no test runner of its own and EntityLookupField reaches the network.
 *
 * @module utils/altNames
 */

/**
 * The alternate name a query matched, if that is why this result is here.
 *
 * Prefers the alias the person actually typed over listing everything: a node
 * with six aliases shows the relevant one, and a node whose visible name
 * already matches shows none, because then the alias explains nothing.
 *
 * @param {{display_name?: string, alt_names?: string[]}} result
 * @param {string} query - What is currently in the input.
 * @returns {string|null}
 */
export function matchingAltName(result, query) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (!needle) return null;

    const shown = String(result?.display_name ?? '').toLowerCase();
    if (shown.includes(needle)) return null;

    const aliases = Array.isArray(result?.alt_names) ? result.alt_names : [];
    return aliases.find((alias) => String(alias).toLowerCase().includes(needle)) ?? null;
}

