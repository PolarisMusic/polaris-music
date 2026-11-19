/**
 * Links to a particular thing in the graph.
 *
 * The registry is a single page that opens on whatever the lottery drew, so
 * until now there was no way to say "look at this one". A share link names
 * the node, and where the node only makes sense in a context — a guest chip
 * exists in the orbit of one release, and is only drawn at all when a toggle
 * is on — it names that too, so the link opens on what the sender was
 * actually looking at rather than somewhere adjacent.
 *
 * Kept as plain functions over strings so the shape is testable without a
 * browser, and so the reader and the writer cannot drift apart.
 *
 * @module utils/shareLink
 */

/**
 * A link to what the info panel is showing.
 *
 * @param {string} base - Page URL without a query, e.g. "https://polaris.mu/".
 * @param {Object} target
 * @param {string|null} [target.nodeId] - The graph node to open on. For a
 *        guest this is the group whose orbit the chip sits in, because that
 *        is what has to be selected before the chip exists.
 * @param {string|null} [target.releaseId] - Release to open in the orbit.
 * @param {string|null} [target.guestId] - Guest chip to mark.
 * @param {boolean} [target.musicalGuests] - Toggle state, carried only when on.
 * @param {boolean} [target.technicians] - Toggle state, carried only when on.
 * @returns {string|null} The link, or null when there is nothing to point at.
 */
export function buildShareUrl(base, target) {
    if (!target || (!target.nodeId && !target.releaseId)) return null;

    const params = new URLSearchParams();
    if (target.nodeId) params.set('node', target.nodeId);
    if (target.releaseId) params.set('release', target.releaseId);
    if (target.guestId) params.set('guest', target.guestId);
    // Only when on. A link to an ordinary member should not carry flags that
    // say nothing, and a reader who opens one gets their own defaults back.
    if (target.musicalGuests) params.set('musicalGuests', 'true');
    if (target.technicians) params.set('technicians', 'true');

    const query = params.toString();
    return query ? `${String(base).split('?')[0]}?${query}` : null;
}

/**
 * Read a share link back.
 *
 * @param {string} search - location.search, with or without the leading "?".
 * @returns {Object|null} The target, or null when this is an ordinary visit.
 */
export function parseShareTarget(search) {
    const params = new URLSearchParams(String(search || ''));

    const nodeId = params.get('node') || null;
    const releaseId = params.get('release') || null;
    if (!nodeId && !releaseId) return null;

    return {
        nodeId,
        releaseId,
        guestId: params.get('guest') || null,
        // Exactly "true", like every other flag this app reads off a query
        // string. The value is attacker-reachable and "1" is not a yes.
        musicalGuests: params.get('musicalGuests') === 'true',
        technicians: params.get('technicians') === 'true',
    };
}

/**
 * Whether two targets point at the same thing.
 *
 * @param {Object|null} a
 * @param {Object|null} b
 * @returns {boolean}
 */
export function sameTarget(a, b) {
    if (!a || !b) return a === b;
    return a.nodeId === b.nodeId
        && a.releaseId === b.releaseId
        && a.guestId === b.guestId;
}

export default { buildShareUrl, parseShareTarget, sameTarget };
