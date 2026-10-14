#!/usr/bin/env node
/**
 * Work out, and show, exactly how each shared Track would be split.
 *
 * trackCollisions.js says which Tracks several releases are sharing.
 * This says what to do about each one, with the evidence for every decision,
 * so the migration that follows can be read and argued with before it writes
 * anything.
 *
 * For each shared Track it prints, per release:
 *
 *   - the id the current identity code would give that release's copy, worked
 *     out with IdentityService itself rather than a reimplementation of it, so
 *     the split lands on exactly the ids a fresh submission would produce;
 *   - which band the release belongs to, derived from the groups credited on
 *     that release's *other* tracks — the ones that are not shared and so were
 *     never in doubt. That is the attribution the split has to get right, and
 *     it is the one thing no amount of care in the migration can invent;
 *   - everything attached to the shared node, by relationship type and
 *     direction, so the split can be checked for dropping something. Likes,
 *     stakes and claims hang off these nodes and are not reconstructible.
 *
 * READ ONLY. MATCH queries and arithmetic; it writes nothing and is safe
 * against production.
 *
 * Usage — same as trackCollisions.js:
 *
 *   docker compose run --rm --no-deps \
 *     -v "$PWD/backend/scripts:/app/scripts:ro" \
 *     api node scripts/trackCollisionPlan.js
 */

import neo4j from 'neo4j-driver';
import { IdentityService } from '../src/identity/idService.js';

const asJson = process.argv.includes('--json');

const uri = process.env.GRAPH_URI || process.env.NEO4J_URI || 'bolt://127.0.0.1:7687';
const user = process.env.GRAPH_USER || process.env.NEO4J_USER || 'neo4j';
const password = process.env.GRAPH_PASSWORD || process.env.NEO4J_PASSWORD;

if (!password) {
    console.error(
        'No password. Set GRAPH_PASSWORD (or NEO4J_PASSWORD), or run this through\n' +
        'the api service, which already has them:\n\n' +
        '  docker compose run --rm --no-deps \\\n' +
        '    -v "$PWD/backend/scripts:/app/scripts:ro" \\\n' +
        '    api node scripts/trackCollisionPlan.js\n'
    );
    process.exit(2);
}

/**
 * Every Track in more than one Release, with the release-side facts the
 * fingerprint needs (title comes from the node, position from the edge).
 */
const SHARED = `
    MATCH (t:Track)-[i:IN_RELEASE]->(r:Release)
    WITH t, collect({
        releaseId:   r.release_id,
        releaseName: r.name,
        position:    i.position,
        trackNumber: i.track_number,
        discNumber:  i.disc_number
    }) AS placements
    WHERE size(placements) > 1
    RETURN t.track_id AS trackId,
           properties(t) AS props,
           placements
    ORDER BY t.title
`;

/**
 * Who a release belongs to, judged only on tracks that are not themselves
 * shared. A release whose every track is shared returns nothing, and that is
 * worth seeing rather than guessing at.
 */
const OWNERS = `
    MATCH (g:Group)-[:PERFORMED_ON]->(t:Track)-[:IN_RELEASE]->(r:Release {release_id: $releaseId})
    WHERE size([(t)-[:IN_RELEASE]->(x:Release) | x]) = 1
    RETURN g.group_id AS groupId, g.name AS name, count(DISTINCT t) AS onTracks
    ORDER BY onTracks DESC
`;

/** Everything hanging off one node, so the split can be checked for losses. */
const ATTACHMENTS = `
    MATCH (t:Track {track_id: $trackId})-[rel]-(other)
    RETURN type(rel) AS type,
           startNode(rel).track_id = $trackId AS outgoing,
           labels(other)[0] AS otherLabel,
           coalesce(other.name, other.title, other.release_id, other.id, '?') AS otherName
    ORDER BY type, otherLabel, otherName
`;

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
const session = driver.session({ defaultAccessMode: neo4j.session.READ });

const run = async (cypher, params = {}) =>
    (await session.run(cypher, params)).records.map((r) => r.toObject());
const n = (v) => (typeof v?.toNumber === 'function' ? v.toNumber() : v);

try {
    const shared = await run(SHARED);
    const plan = [];

    for (const track of shared) {
        const attachments = await run(ATTACHMENTS, { trackId: track.trackId });
        const places = [];

        for (const place of track.placements) {
            const owners = await run(OWNERS, { releaseId: place.releaseId });
            // Exactly what processReleaseBundle now feeds the fingerprint:
            // the track as submitted, plus the resolved release id.
            const newId = IdentityService.makeProvisionalId('track',
                IdentityService.trackFingerprint({
                    title: track.props.title,
                    release_id: place.releaseId,
                    track_number: n(place.trackNumber),
                    position: n(place.position),
                }));
            places.push({
                releaseId: place.releaseId,
                releaseName: place.releaseName,
                position: n(place.position),
                trackNumber: n(place.trackNumber),
                discNumber: n(place.discNumber),
                newTrackId: newId,
                owners: owners.map((o) => ({
                    groupId: o.groupId, name: o.name, onTracks: n(o.onTracks),
                })),
            });
        }

        plan.push({
            trackId: track.trackId,
            title: track.props.title,
            props: track.props,
            placements: places,
            attachments: attachments.map((a) => ({
                type: a.type,
                direction: a.outgoing ? '->' : '<-',
                otherLabel: a.otherLabel,
                otherName: a.otherName,
            })),
        });
    }

    if (asJson) {
        console.log(JSON.stringify(plan, null, 2));
    } else {
        console.log(`\nShared tracks to split: ${plan.length}\n`);
        for (const t of plan) {
            console.log(`${'='.repeat(68)}`);
            console.log(`"${t.title}"`);
            console.log(`  current id  ${t.trackId}`);
            const extra = Object.entries(t.props)
                .filter(([k, v]) => !['track_id', 'id', 'title', 'updated_at'].includes(k)
                    && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0));
            if (extra.length) {
                console.log('  properties  ' + extra
                    .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', '));
            }

            console.log('\n  would become:');
            for (const p of t.placements) {
                console.log(`    on "${p.releaseName}"`);
                console.log(`        release id  ${p.releaseId}`);
                console.log(`        new id      ${p.newTrackId}`);
                console.log(`        track no    ${p.trackNumber ?? '(none)'}`
                    + `   position ${p.position ?? '(none)'}`);
                const owners = p.owners.length
                    ? p.owners.map((o) => `${o.name} (${o.onTracks} unshared tracks)`).join(', ')
                    : '(nothing to judge on — every track on this release is shared)';
                console.log(`        belongs to  ${owners}`);
            }

            console.log('\n  attached to the current node:');
            const grouped = new Map();
            for (const a of t.attachments) {
                const key = `${a.direction} ${a.type}`;
                if (!grouped.has(key)) grouped.set(key, []);
                grouped.get(key).push(`${a.otherName} [${a.otherLabel}]`);
            }
            for (const [key, others] of grouped) {
                console.log(`    ${key}  ${others.join(', ')}`);
            }
            console.log('');
        }
    }
} finally {
    await session.close();
    await driver.close();
}
