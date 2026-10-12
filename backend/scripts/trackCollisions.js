#!/usr/bin/env node
/**
 * Find Track and Song nodes that several releases are sharing by accident.
 *
 * Track identity used to be a hash of title (and, before that, title plus a
 * duration that Discogs imports never carry). A hidden track called "Untitled"
 * was therefore one node for the whole registry, and the release page — which
 * reads performers through
 *
 *   (Group)-[:PERFORMED_ON]->(:Track)-[:IN_RELEASE]->(Release)
 *
 * — credited every band that had ever released a track by that name. Pearl
 * Jam's "Ten" came back credited to Pearl Jam, Queens Of The Stone Age and The
 * The Aquabats!.
 *
 * Identity is release-scoped now (IdentityService.trackFingerprint, fed with
 * the resolved release), so new submissions cannot do this. Nodes already
 * written are unaffected by that change: this says how many there are and what
 * they are, so the cleanup can be chosen on evidence.
 *
 * READ ONLY. It opens a session, runs MATCH queries and writes nothing. Safe
 * against production.
 *
 * Usage, from backend/:
 *   GRAPH_URI=bolt://127.0.0.1:7687 GRAPH_USER=neo4j GRAPH_PASSWORD=… \
 *     node scripts/trackCollisions.js [--json]
 *
 * Use 127.0.0.1, never localhost: since Node 17 `localhost` resolves to ::1
 * first, which on a machine with the deployment runbook's SSH tunnel open is
 * the *tunnel* — i.e. production, when you meant a local container.
 */

import neo4j from 'neo4j-driver';

const asJson = process.argv.includes('--json');

const uri = process.env.GRAPH_URI || process.env.NEO4J_URI;
const user = process.env.GRAPH_USER || process.env.NEO4J_USER;
const password = process.env.GRAPH_PASSWORD || process.env.NEO4J_PASSWORD;

if (!uri || !user || !password) {
    console.error('Set GRAPH_URI, GRAPH_USER and GRAPH_PASSWORD.');
    process.exit(2);
}

const SHARED_TRACKS = `
    MATCH (t:Track)-[:IN_RELEASE]->(r:Release)
    WITH t, collect(DISTINCT r.name) AS releases
    WHERE size(releases) > 1
    OPTIONAL MATCH (g:Group)-[:PERFORMED_ON]->(t)
    RETURN t.track_id AS trackId,
           t.title    AS title,
           releases,
           collect(DISTINCT g.name) AS performers
    ORDER BY size(releases) DESC, title
`;

/**
 * A release is "contaminated" when a band is credited on it only through a
 * track it shares with somebody else's record. That is the user-visible
 * symptom, and it is what to re-check once a cleanup has run.
 */
const CONTAMINATED_RELEASES = `
    MATCH (g:Group)-[:PERFORMED_ON]->(t:Track)-[:IN_RELEASE]->(r:Release)
    WITH r, g, collect(DISTINCT t) AS viaTracks
    WHERE ALL(t IN viaTracks WHERE size([(t)-[:IN_RELEASE]->(x:Release) | x]) > 1)
    RETURN r.name AS release,
           collect(DISTINCT g.name) AS credited,
           size(collect(DISTINCT g.name)) AS creditedCount
    ORDER BY creditedCount DESC, release
`;

const SHARED_SONGS = `
    MATCH (t:Track)-[:RECORDING_OF]->(s:Song)
    WITH s, collect(DISTINCT t) AS recordings
    WHERE size(recordings) > 1
    RETURN s.song_id AS songId,
           s.title   AS title,
           size(recordings) AS recordingCount,
           [t IN recordings |
               head([(t)-[:IN_RELEASE]->(r:Release) | r.name] + ['(no release)'])] AS onReleases
    ORDER BY recordingCount DESC, title
`;

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
const session = driver.session({ defaultAccessMode: neo4j.session.READ });

const run = async (cypher) => (await session.run(cypher)).records.map(r => r.toObject());
const n = (v) => (typeof v?.toNumber === 'function' ? v.toNumber() : v);

try {
    const tracks = await run(SHARED_TRACKS);
    const releases = await run(CONTAMINATED_RELEASES);
    const songs = await run(SHARED_SONGS);

    if (asJson) {
        console.log(JSON.stringify({ tracks, releases, songs }, null, 2));
    } else {
        console.log(`\nTracks shared by more than one release: ${tracks.length}`);
        for (const t of tracks.slice(0, 40)) {
            console.log(`  ${t.title}`);
            console.log(`      id         ${t.trackId}`);
            console.log(`      releases   ${t.releases.join(', ')}`);
            console.log(`      performers ${t.performers.filter(Boolean).join(', ') || '(none)'}`);
        }
        if (tracks.length > 40) console.log(`  … and ${tracks.length - 40} more`);

        console.log(`\nReleases crediting a band only through a shared track: ${releases.length}`);
        for (const r of releases.slice(0, 40)) {
            console.log(`  ${r.release}: ${r.credited.filter(Boolean).join(', ')}`);
        }
        if (releases.length > 40) console.log(`  … and ${releases.length - 40} more`);

        console.log(`\nSongs with more than one recording: ${songs.length}`);
        console.log('  (expected for real covers and re-recordings; suspicious when the');
        console.log('   releases have nothing to do with each other)');
        for (const s of songs.slice(0, 25)) {
            console.log(`  ${s.title} — ${n(s.recordingCount)} recordings: ${s.onReleases.join(', ')}`);
        }
        if (songs.length > 25) console.log(`  … and ${songs.length - 25} more`);
        console.log('');
    }
} finally {
    await session.close();
    await driver.close();
}
