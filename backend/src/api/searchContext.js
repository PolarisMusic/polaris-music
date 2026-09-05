/**
 * Disambiguating context for node-search results.
 *
 * The picker in the submit form previously showed a type badge, a name, a
 * one-field subtitle and a truncated id. That is not enough to tell two
 * musicians named "John Williams" apart, and picking the wrong one silently
 * attaches a credit to the wrong person — the kind of error a registry of
 * record cannot carry.
 *
 * So each hit is enriched with the facts that actually separate same-named
 * entities: for a Person the groups they played in, for a Group its roster and
 * active years, for a Release the pressing details. All of it already existed
 * as per-entity queries in the route layer; the only new work is fetching it
 * for a page of results at once instead of one entity at a time.
 *
 * Enrichment is batched with UNWIND — one round trip per label present in the
 * results, not one per result. A search returning eight people costs one
 * query, not eight.
 *
 * @module api/searchContext
 */

/** How many names to name before saying "and N more". */
const MAX_NAMES = 3;

/**
 * One Cypher statement per label, each taking $ids and returning a row per id.
 *
 * Every one is an OPTIONAL MATCH chain: a Person with no group, a Group with
 * no releases and a Release with no label all still return a row, just with
 * empty collections. A missing row would drop the result's context silently.
 */
export const CONTEXT_QUERIES = {
    Person: `
        UNWIND $ids AS id
        MATCH (p:Person {person_id: id})
        OPTIONAL MATCH (p)-[:MEMBER_OF]->(g:Group)
        WITH id, p, collect(DISTINCT g.name) AS groupNames
        OPTIONAL MATCH (p)-[:GUEST_ON]->(:Track)<-[:PERFORMED_ON]-(gg:Group)
        RETURN id,
               p.origin_city_name AS city,
               groupNames,
               collect(DISTINCT gg.name) AS guestGroupNames
    `,
    Group: `
        UNWIND $ids AS id
        MATCH (g:Group {group_id: id})
        OPTIONAL MATCH (p:Person)-[:MEMBER_OF]->(g)
        WITH id, g, collect(DISTINCT p.name) AS memberNames
        OPTIONAL MATCH (g)-[:PERFORMED_ON]->(:Track)-[:IN_RELEASE]->(r:Release)
        RETURN id,
               g.formed_date AS formedDate,
               g.origin_city_name AS city,
               memberNames,
               collect(DISTINCT r.release_date) AS releaseDates
    `,
    Release: `
        UNWIND $ids AS id
        MATCH (r:Release {release_id: id})
        OPTIONAL MATCH (r)<-[:RELEASED]-(l:Label)
        WITH id, r, collect(DISTINCT l.name) AS labelNames
        OPTIONAL MATCH (g:Group)-[:PERFORMED_ON]->(:Track)-[:IN_RELEASE]->(r)
        RETURN id,
               r.release_date AS date,
               r.format AS format,
               r.country AS country,
               r.catalog_number AS catalog,
               labelNames,
               collect(DISTINCT g.name) AS groupNames
    `,
    Label: `
        UNWIND $ids AS id
        MATCH (l:Label {label_id: id})
        OPTIONAL MATCH (l)-[:ORIGIN]->(c:City)
        WITH id, l, collect(DISTINCT c.name) AS cityNames
        OPTIONAL MATCH (l)-[:RELEASED]->(r:Release)
        RETURN id,
               cityNames,
               l.parent_label_name AS parent,
               count(DISTINCT r) AS releaseCount
    `,
    Track: `
        UNWIND $ids AS id
        MATCH (t:Track {track_id: id})
        OPTIONAL MATCH (t)-[:IN_RELEASE]->(r:Release)
        WITH id, t, collect(DISTINCT r.name) AS releaseNames
        OPTIONAL MATCH (g:Group)-[:PERFORMED_ON]->(t)
        RETURN id, releaseNames, collect(DISTINCT g.name) AS groupNames
    `,
    Song: `
        UNWIND $ids AS id
        MATCH (s:Song {song_id: id})
        OPTIONAL MATCH (p:Person)-[:WROTE]->(s)
        RETURN id, collect(DISTINCT p.name) AS writerNames
    `
};

/**
 * "A, B and 4 more" — names enough to recognise, then a count.
 *
 * @param {string[]} names
 * @param {number} [max=MAX_NAMES]
 * @returns {string|null}
 */
export function summarizeNames(names, max = MAX_NAMES) {
    const clean = (names || []).filter(Boolean);
    if (clean.length === 0) return null;
    if (clean.length <= max) return clean.join(', ');
    return `${clean.slice(0, max).join(', ')} +${clean.length - max} more`;
}

/**
 * Extract a 4-digit year from any of the date shapes the registry stores
 * (YYYY, YYYY/MM, YYYY/MM/DD, and dashed variants from imports).
 *
 * @param {string|null|undefined} date
 * @returns {number|null}
 */
export function yearOf(date) {
    if (!date) return null;
    const match = String(date).match(/\d{4}/);
    if (!match) return null;
    const year = parseInt(match[0], 10);
    // Guard against a catalogue number being mistaken for a year.
    return year >= 1000 && year <= 2999 ? year : null;
}

/**
 * "1996–2013", or "1996–" for a group with a single dated release.
 *
 * Derived from release dates rather than formed_date because most groups in
 * the registry have releases and few have a formed_date, and the span a
 * reader recognises is the one they released records in.
 *
 * @param {string[]} dates
 * @returns {string|null}
 */
export function activeYears(dates) {
    const years = (dates || []).map(yearOf).filter(y => y !== null);
    if (years.length === 0) return null;
    const first = Math.min(...years);
    const last = Math.max(...years);
    return first === last ? String(first) : `${first}–${last}`;
}

/**
 * Turn one enrichment row into the short chips shown under a result.
 *
 * Chips are ordered most-distinguishing first, because the dropdown is narrow
 * and the tail may be clipped. For a Person that is the groups they played in
 * — the disambiguator that motivated all of this.
 *
 * @param {string} label - Node label
 * @param {Object} row - Plain object from the label's context query
 * @returns {string[]}
 */
export function buildContext(label, row) {
    if (!row) return [];
    const chips = [];

    switch (label) {
        case 'Person': {
            const groups = summarizeNames(row.groupNames);
            if (groups) chips.push(groups);
            // Only fall back to guest credits when they are in no group at
            // all; otherwise a busy session player's row becomes unreadable.
            if (!groups) {
                const guest = summarizeNames(row.guestGroupNames, 2);
                if (guest) chips.push(`Guest: ${guest}`);
            }
            if (row.city) chips.push(row.city);
            break;
        }
        case 'Group': {
            const years = activeYears(row.releaseDates) ||
                (yearOf(row.formedDate) ? `Formed ${yearOf(row.formedDate)}` : null);
            if (years) chips.push(years);
            const members = summarizeNames(row.memberNames);
            if (members) chips.push(members);
            if (row.city) chips.push(row.city);
            break;
        }
        case 'Release': {
            const pressing = [row.date, normalizeFormatValue(row.format), row.country]
                .filter(Boolean).join(' · ');
            if (pressing) chips.push(pressing);
            const by = summarizeNames(row.groupNames, 2);
            if (by) chips.push(by);
            const labels = summarizeNames(row.labelNames, 2);
            if (labels) chips.push(labels);
            // Catalogue number last: it is the definitive discriminator but
            // means nothing to a reader until the softer fields have tied.
            if (row.catalog) chips.push(row.catalog);
            break;
        }
        case 'Label': {
            const city = summarizeNames(row.cityNames, 1);
            if (city) chips.push(city);
            if (row.parent) chips.push(`Part of ${row.parent}`);
            const count = toCount(row.releaseCount);
            if (count > 0) chips.push(`${count} release${count === 1 ? '' : 's'}`);
            break;
        }
        case 'Track': {
            const by = summarizeNames(row.groupNames, 2);
            if (by) chips.push(by);
            const on = summarizeNames(row.releaseNames, 2);
            if (on) chips.push(`On ${on}`);
            break;
        }
        case 'Song': {
            const writers = summarizeNames(row.writerNames);
            if (writers) chips.push(`Written by ${writers}`);
            break;
        }
        default:
            break;
    }

    return chips;
}

/** Release.format is stored as a string or an empty list. */
function normalizeFormatValue(format) {
    if (format == null) return null;
    if (Array.isArray(format)) {
        const joined = format.filter(Boolean).join(', ');
        return joined.length > 0 ? joined : null;
    }
    const s = String(format).trim();
    return s.length > 0 ? s : null;
}

/** Neo4j integers arrive as {low, high}. */
function toCount(value) {
    if (value == null) return 0;
    if (typeof value === 'number') return value;
    if (typeof value.toNumber === 'function') return value.toNumber();
    if (typeof value.low === 'number') return value.low;
    return 0;
}

/**
 * Attach `context` to each result, in place, and return the same array.
 *
 * Enrichment is decoration: if a context query fails the caller still gets
 * usable search results, just plainer ones. A search that 500s because the
 * subtitle could not be computed would be a worse outcome than a bare list.
 *
 * @param {Object} session - Neo4j session
 * @param {Object[]} results - Normalized search results
 * @param {Object} [log] - console-like, for the warn path
 * @returns {Promise<Object[]>} the same results, with `context` populated
 */
export async function enrichResults(session, results, log = console) {
    for (const r of results) r.context = [];
    if (results.length === 0) return results;

    const byLabel = new Map();
    for (const r of results) {
        if (!CONTEXT_QUERIES[r.type] || !r.id) continue;
        if (!byLabel.has(r.type)) byLabel.set(r.type, []);
        byLabel.get(r.type).push(r.id);
    }
    if (byLabel.size === 0) return results;

    // One query per label, all in flight together.
    const fetches = [...byLabel.entries()].map(async ([label, ids]) => {
        try {
            const res = await session.run(CONTEXT_QUERIES[label], { ids });
            const rows = new Map();
            for (const rec of res.records) {
                rows.set(rec.get('id'), Object.fromEntries(
                    rec.keys.map(k => [k, rec.get(k)])
                ));
            }
            return { label, rows };
        } catch (error) {
            log.warn(`Search context enrichment failed for ${label}:`, error.message);
            return { label, rows: new Map() };
        }
    });

    for (const { label, rows } of await Promise.all(fetches)) {
        for (const r of results) {
            if (r.type !== label) continue;
            r.context = buildContext(label, rows.get(r.id));
        }
    }

    return results;
}
