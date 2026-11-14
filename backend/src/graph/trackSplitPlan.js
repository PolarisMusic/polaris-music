/**
 * Working out how one shared Track splits into one Track per Release.
 *
 * A Track is release-scoped: it is a specific recording as a specific release
 * carries it, and `IdentityService.trackFingerprint` has always included the
 * release id. A Track node reachable from two Releases is therefore a defect,
 * not a modelling choice — and it has a visible cost, because every read that
 * walks `(Group)-[:PERFORMED_ON]->(Track)` and onward finds the stranger's
 * release on the far side. That is how Pearl Jam ended up credited beside the
 * Aquabats' photographer: one Track called "(silence)" on both "Ten" and "The
 * Fury Of The Aquabats!".
 *
 * The split itself is mechanical. Deciding *which copy each credit belongs to*
 * is not, and it is the whole of the risk, so it lives here as a pure function
 * with no database access — testable against the real shapes rather than
 * reasoned about once and run against production.
 *
 * Four kinds of evidence, strongest first:
 *
 *   1. `IN_RELEASE` names its own release. Nothing to decide.
 *   2. The claim id. Every credit edge carries the `claim_id` of the
 *      submission that wrote it, and a Claim node carries that submission's
 *      event hash, which names the Release it was submitted for. Two
 *      submissions of the same title produce two sets of edges with different
 *      claim ids — visible in the data as "Butch Trucks" twice on one node.
 *      This is the only evidence that separates two releases by the *same*
 *      band, which is six of the twenty-six.
 *   3. The performing group. A `PERFORMED_ON` from a Group belongs to the
 *      release that group owns; a Person's carries `via_group_id`, which says
 *      the same thing.
 *   4. Elimination. A release whose every track is shared has no unshared
 *      track to judge ownership from — both "Sadie" and "Oblivion" are in
 *      that position. But if exactly one group on the node owns no other
 *      placement, and exactly one placement has no owner, they are each
 *      other's.
 *
 * Anything still unattributed is reported, never guessed at and never
 * discarded. `RECORDING_OF` is copied to every placement: each copy is a
 * recording of the same song.
 *
 * @module graph/trackSplitPlan
 */

/** Relationship types this split knows how to place. */
const HANDLED = new Set(['IN_RELEASE', 'RECORDING_OF', 'PERFORMED_ON', 'GUEST_ON']);

/**
 * Which group owns each placement, by release id.
 *
 * Starts from the unshared-track evidence the caller gathered, then fills one
 * gap by elimination where the evidence allows exactly one answer.
 *
 * @param {Array} placements
 * @param {Array} attachments
 * @returns {Map<string, string>} releaseId → groupId
 */
function ownersByRelease(placements, attachments) {
    const owners = new Map();
    for (const place of placements) {
        // The group credited on most of this release's unshared tracks. More
        // than one is possible on a split release; the leader is the claim.
        const best = (place.owners || [])[0];
        if (best?.groupId) owners.set(place.releaseId, best.groupId);
    }

    const unowned = placements.filter((p) => !owners.has(p.releaseId));
    if (unowned.length !== 1) return owners;

    const claimed = new Set(owners.values());
    const groupsHere = [...new Set(attachments
        .filter((a) => a.type === 'PERFORMED_ON' && !a.outgoing && a.otherLabel === 'Group')
        .map((a) => a.otherId))];
    const spare = groupsHere.filter((id) => !claimed.has(id));

    if (spare.length === 1) owners.set(unowned[0].releaseId, spare[0]);
    return owners;
}

/**
 * Decide how a shared Track splits.
 *
 * @param {Object} input
 * @param {string} input.trackId - The shared node's current id.
 * @param {Array} input.placements - One per release, each with newTrackId and owners.
 * @param {Array} input.attachments - Every relationship on the node.
 * @param {Object} input.claimReleases - claim_id → release_id, from the Claim nodes.
 * @returns {Object} The plan.
 */
export function planTrackSplit({ trackId, placements, attachments, claimReleases = {} }) {
    const unhandled = [...new Set(attachments
        .map((a) => a.type)
        .filter((type) => !HANDLED.has(type)))];

    const owners = ownersByRelease(placements, attachments);
    const byRelease = new Map(placements.map((p) => [p.releaseId, {
        ...p,
        owner: owners.get(p.releaseId) || null,
        moves: [],
        copies: [],
    }]));

    // A group that owns exactly one placement can attribute an edge on its own.
    // One that owns two cannot, and the claim id has to carry it.
    const soleReleaseOf = new Map();
    for (const [releaseId, groupId] of owners) {
        soleReleaseOf.set(groupId, soleReleaseOf.has(groupId) ? null : releaseId);
    }

    const leftovers = [];

    for (const attachment of attachments) {
        if (!HANDLED.has(attachment.type)) {
            leftovers.push({ ...attachment, why: 'relationship type not handled' });
            continue;
        }

        if (attachment.type === 'IN_RELEASE') {
            const target = byRelease.get(attachment.otherId);
            if (target) target.moves.push({ ...attachment, by: 'release' });
            else leftovers.push({ ...attachment, why: 'release is not one of the placements' });
            continue;
        }

        if (attachment.type === 'RECORDING_OF') {
            // Every copy records the same song.
            for (const target of byRelease.values()) {
                target.copies.push({ ...attachment, by: 'every copy records the song' });
            }
            continue;
        }

        // 2. The claim id, which is the only thing that separates two releases
        //    by the same band.
        const claimed = attachment.claimId ? claimReleases[attachment.claimId] : null;
        if (claimed && byRelease.has(claimed)) {
            byRelease.get(claimed).moves.push({ ...attachment, by: 'claim' });
            continue;
        }

        // 3. The performing group, directly or through via_group_id.
        const groupId = attachment.viaGroupId
            || (attachment.otherLabel === 'Group' && !attachment.outgoing ? attachment.otherId : null);
        if (groupId) {
            const sole = soleReleaseOf.get(groupId);
            if (sole) {
                byRelease.get(sole).moves.push({ ...attachment, by: 'performing group' });
                continue;
            }
            leftovers.push({
                ...attachment,
                why: soleReleaseOf.has(groupId)
                    ? 'this group owns more than one of these releases and no claim id resolved it'
                    : 'this group owns none of these releases',
            });
            continue;
        }

        leftovers.push({ ...attachment, why: 'no claim id and nothing names a group' });
    }

    return {
        trackId,
        placements: [...byRelease.values()],
        leftovers,
        unhandledTypes: unhandled,
        // Safe to remove once everything has moved off it, and not before.
        originalIsEmpty: leftovers.length === 0,
    };
}

export default { planTrackSplit };
