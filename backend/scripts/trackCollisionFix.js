#!/usr/bin/env node
/**
 * Split every Track that several Releases are sharing into one Track each.
 *
 * A Track is release-scoped — `IdentityService.trackFingerprint` has always
 * included the release id — so a node reachable from two Releases is a defect.
 * It is not a cosmetic one: every read that walks
 * `(Group)-[:PERFORMED_ON]->(Track)` and onward lands on the stranger's
 * release, which is how Pearl Jam came to be drawn beside the Aquabats'
 * photographer over a Track called "(silence)".
 *
 * trackCollisions.js says which Tracks are shared. trackCollisionPlan.js says
 * what a split would look like. This one does it.
 *
 * The decisions live in src/graph/trackSplitPlan.js, which is a pure function
 * with its own tests against these exact shapes. This file is the reader and
 * the writer around it, and deliberately contains no judgement of its own.
 *
 * DRY RUN BY DEFAULT. Pass --execute to write. Even then it refuses any track
 * whose credits it could not fully attribute, so a partial split never lands:
 * the whole point of the exercise is to stop guessing which band a credit
 * belongs to.
 *
 * Usage:
 *
 *   docker compose run --rm --no-deps \
 *     -v "$PWD/backend/scripts:/app/scripts:ro" \
 *     api node scripts/trackCollisionFix.js
 *
 *   ... same, plus --execute, to write
 *   ... plus --force to split the attributable tracks and leave the rest
 */

import neo4j from 'neo4j-driver';
import { IdentityService } from '../src/identity/idService.js';
import { planTrackSplit } from '../src/graph/trackSplitPlan.js';

const execute = process.argv.includes('--execute');
const force = process.argv.includes('--force');

const uri = process.env.GRAPH_URI || process.env.NEO4J_URI || 'bolt://127.0.0.1:7687';
const user = process.env.GRAPH_USER || process.env.NEO4J_USER || 'neo4j';
const password = process.env.GRAPH_PASSWORD || process.env.NEO4J_PASSWORD;

if (!password) {
    console.error('No password. Set GRAPH_PASSWORD, or run this through the api service.');
    process.exit(2);
}

/** Every Track in more than one Release, with the release-side facts. */
const SHARED = `
    MATCH (t:Track)-[i:IN_RELEASE]->(r:Release)
    WITH t, collect({
        releaseId: r.release_id, releaseName: r.name,
        position: i.position, trackNumber: i.track_number, discNumber: i.disc_number
    }) AS placements
    WHERE size(placements) > 1
    RETURN t.track_id AS trackId, properties(t) AS props, placements
    ORDER BY t.title
`;

/** Who a release belongs to, judged only on its unshared tracks. */
const OWNERS = `
    MATCH (g:Group)-[:PERFORMED_ON]->(t:Track)-[:IN_RELEASE]->(r:Release {release_id: $releaseId})
    WHERE size([(t)-[:IN_RELEASE]->(x:Release) | x]) = 1
    RETURN g.group_id AS groupId, g.name AS name, count(DISTINCT t) AS onTracks
    ORDER BY onTracks DESC
`;

/**
 * Everything on the node, addressed by elementId so two edges that differ only
 * by claim id — the same band submitted twice — stay separable.
 */
const ATTACHMENTS = `
    MATCH (t:Track {track_id: $trackId})-[rel]-(other)
    RETURN elementId(rel) AS relId,
           type(rel) AS type,
           startNode(rel).track_id = $trackId AS outgoing,
           labels(other)[0] AS otherLabel,
           coalesce(other.release_id, other.song_id, other.group_id,
                    other.person_id, other.track_id, other.account_id) AS otherId,
           coalesce(other.name, other.title, '?') AS otherName,
           rel.claim_id AS claimId,
           rel.via_group_id AS viaGroupId,
           properties(rel) AS props
`;

/** Which release each submission was for: claim → event hash → release. */
const CLAIM_RELEASES = `
    MATCH (c:Claim) WHERE c.claim_id IN $claimIds
    MATCH (:Account)-[:SUBMITTED {event_hash: c.event_hash}]->(r:Release)
    RETURN c.claim_id AS claimId, collect(DISTINCT r.release_id) AS releases
`;

/**
 * Copying one relationship onto the new node. The type cannot be a parameter
 * in Cypher, so each is written out — and the set is closed, checked by
 * trackSplitPlan before anything reaches here.
 */
const COPY = {
    IN_RELEASE: `
        MATCH (nt:Track {track_id: $newId}) MATCH (o:Release {release_id: $otherId})
        MERGE (nt)-[r:IN_RELEASE]->(o) SET r += $props`,
    RECORDING_OF: `
        MATCH (nt:Track {track_id: $newId}) MATCH (o:Song {song_id: $otherId})
        MERGE (nt)-[r:RECORDING_OF]->(o) SET r += $props`,
    PERFORMED_ON_GROUP: `
        MATCH (nt:Track {track_id: $newId}) MATCH (o:Group {group_id: $otherId})
        MERGE (o)-[r:PERFORMED_ON {claim_id: $claimKey}]->(nt) SET r += $props`,
    PERFORMED_ON_PERSON: `
        MATCH (nt:Track {track_id: $newId}) MATCH (o:Person {person_id: $otherId})
        MERGE (o)-[r:PERFORMED_ON {claim_id: $claimKey, via_group_id: $viaKey}]->(nt)
        SET r += $props`,
    GUEST_ON: `
        MATCH (nt:Track {track_id: $newId}) MATCH (o:Person {person_id: $otherId})
        MERGE (o)-[r:GUEST_ON {claim_id: $claimKey}]->(nt) SET r += $props`,
};

/** Which COPY query one attachment needs. */
const copyKeyFor = (a) =>
    a.type === 'PERFORMED_ON'
        ? (a.otherLabel === 'Group' ? 'PERFORMED_ON_GROUP' : 'PERFORMED_ON_PERSON')
        : a.type;

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
const n = (v) => (typeof v?.toNumber === 'function' ? v.toNumber() : v);

async function readAll(session, cypher, params = {}) {
    return (await session.run(cypher, params)).records.map((r) => r.toObject());
}

/** Gather everything the planner needs for one shared track. */
async function gather(session, track) {
    const attachments = (await readAll(session, ATTACHMENTS, { trackId: track.trackId }))
        .map((a) => ({ ...a, props: a.props || {} }));

    const claimIds = [...new Set(attachments.map((a) => a.claimId).filter(Boolean))];
    const claimReleases = {};
    if (claimIds.length > 0) {
        for (const row of await readAll(session, CLAIM_RELEASES, { claimIds })) {
            // One bundle is one release. Anything else is not evidence.
            if (row.releases.length === 1) claimReleases[row.claimId] = row.releases[0];
        }
    }

    const placements = [];
    for (const place of track.placements) {
        placements.push({
            releaseId: place.releaseId,
            releaseName: place.releaseName,
            position: n(place.position),
            trackNumber: n(place.trackNumber),
            discNumber: n(place.discNumber),
            newTrackId: IdentityService.makeProvisionalId('track',
                IdentityService.trackFingerprint({
                    title: track.props.title,
                    release_id: place.releaseId,
                    track_number: n(place.trackNumber),
                    position: n(place.position),
                })),
            owners: await readAll(session, OWNERS, { releaseId: place.releaseId }),
        });
    }

    return { trackId: track.trackId, placements, attachments, claimReleases };
}

/** Apply one track's plan, in one transaction. */
async function apply(session, track, plan) {
    const tx = session.beginTransaction();
    try {
        const nodeProps = { ...track.props };
        delete nodeProps.track_id;
        delete nodeProps.id;

        for (const place of plan.placements) {
            await tx.run(
                `MERGE (nt:Track {track_id: $newId})
                 ON CREATE SET nt.id = $newId, nt += $nodeProps`,
                { newId: place.newTrackId, nodeProps }
            );

            for (const edge of [...place.moves, ...place.copies]) {
                await tx.run(COPY[copyKeyFor(edge)], {
                    newId: place.newTrackId,
                    otherId: edge.otherId,
                    props: edge.props,
                    // MERGE keys cannot be null or two distinct edges collapse
                    // into one; the empty string stands in and SET puts the
                    // real value back.
                    claimKey: edge.claimId ?? '',
                    viaKey: edge.viaGroupId ?? '',
                });
            }
        }

        // Only what moved. Copies stay where they are.
        const moved = plan.placements.flatMap((p) => p.moves.map((m) => m.relId));
        if (moved.length > 0) {
            // Anchored on the node: an unanchored match scans every
            // relationship in the graph to find a handful.
            await tx.run(
                `MATCH (t:Track {track_id: $trackId})-[r]-()
                 WHERE elementId(r) IN $ids DELETE r`,
                { trackId: track.trackId, ids: moved }
            );
        }

        // The husk, once nothing is left on it.
        const { records } = await tx.run(
            `MATCH (t:Track {track_id: $trackId})
             RETURN count { (t)--() } AS degree`,
            { trackId: track.trackId }
        );
        const degree = n(records[0].get('degree'));
        if (degree === 0) {
            await tx.run(`MATCH (t:Track {track_id: $trackId}) DELETE t`,
                { trackId: track.trackId });
        }

        await tx.commit();
        return { degree };
    } catch (error) {
        await tx.rollback();
        throw error;
    }
}

const session = driver.session();
let split = 0;
let skipped = 0;

try {
    const shared = await readAll(session, SHARED);
    console.log(`\nShared tracks: ${shared.length}`);
    console.log(execute ? 'MODE: executing\n' : 'MODE: dry run — nothing will be written\n');

    for (const track of shared) {
        const input = await gather(session, track);
        const plan = planTrackSplit(input);
        const clean = plan.leftovers.length === 0;

        console.log('='.repeat(68));
        console.log(`"${track.props.title}"  ${track.trackId}`);
        for (const place of plan.placements) {
            const owner = place.owner || '(unattributed)';
            console.log(`  → ${place.newTrackId}  on "${place.releaseName}"  [${owner}]`);
            console.log(`      ${place.moves.length} moved, ${place.copies.length} copied`);
        }
        if (!clean) {
            console.log(`  LEFT BEHIND (${plan.leftovers.length}):`);
            for (const l of plan.leftovers) {
                console.log(`      ${l.type} ${l.otherName} — ${l.why}`);
            }
        }

        if (!execute) { clean ? split++ : skipped++; continue; }

        if (!clean && !force) {
            console.log('  SKIPPED — rerun with --force to split it anyway');
            skipped++;
            continue;
        }

        const { degree } = await apply(session, track, plan);
        console.log(degree === 0
            ? '  split; the shared node was removed'
            : `  split; the shared node remains with ${degree} relationship(s)`);
        split++;
    }

    console.log('\n' + '='.repeat(68));
    console.log(execute ? `Split ${split}, skipped ${skipped}.`
        : `Would split ${split} cleanly; ${skipped} need a decision first.`);
    if (!execute && split + skipped > 0) {
        console.log('Nothing was written. Add --execute when the plan above reads right.');
    }
} finally {
    await session.close();
    await driver.close();
}
