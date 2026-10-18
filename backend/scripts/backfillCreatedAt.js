#!/usr/bin/env node
/**
 * @fileoverview Date the lottery candidates that have no creation record.
 *
 * The sponsored-node draw pins its field to the snapshot block (see
 * docs/15-sponsored-node-lottery.md §4.1), which it can only do for a node that
 * says when it first appeared. A candidate with no `created_at` stays in the
 * draw — excluding it would empty the field on any registry older than the
 * stamping — but it is the part of the field a cutoff cannot pin, so while any
 * exist, adding one mid-period still re-rolls the winner.
 *
 * Measured on the live registry on 2026-10-18: 13 of 276 candidates. They are
 * the ones predating the `ON CREATE SET g.created_at` fix, or loaded by a
 * script rather than submitted.
 *
 * Nothing is invented. A date is taken only from evidence already in the graph,
 * best first:
 *
 *   1. the earliest SUBMITTED edge from the submitting Account
 *   2. the earliest Claim about this node
 *   3. the earliest created_at among its immediate neighbours
 *
 * The third is weaker than the first two — it says "no later than", which is
 * all the draw needs — so anything dated that way is marked
 * `created_at_inferred: true`, and nothing reading `created_at` afterwards is
 * misled about where it came from. A node no evidence reaches is left alone and
 * reported: a wrong date is worse than a missing one, and the draw already
 * copes with missing.
 *
 * Usage:
 *
 *   # Report only. Writes nothing.
 *   docker compose exec api node scripts/backfillCreatedAt.js
 *
 *   # Apply.
 *   docker compose exec api node scripts/backfillCreatedAt.js --execute
 *
 * Safe by default, unlike the older backfillRelationships.js, which writes
 * unless told not to. This one runs against a production registry and sets a
 * property that a draw is then pinned against; the inversion is deliberate.
 *
 * Environment: GRAPH_URI, GRAPH_USER, GRAPH_PASSWORD — read from the process,
 * so inside the api container it needs none of them on the command line.
 */

import neo4j from 'neo4j-driver';

const execute = process.argv.includes('--execute');

const driver = neo4j.driver(
    // 127.0.0.1, never localhost: the runbook documents an SSH tunnel on 7687,
    // ssh binds it on ::1, Docker publishes on 127.0.0.1, and since Node 17
    // dns.lookup no longer prefers IPv4 — so `localhost` can reach the tunnel
    // and this script would write to production from a laptop.
    process.env.GRAPH_URI || 'bolt://127.0.0.1:7687',
    neo4j.auth.basic(
        process.env.GRAPH_USER || 'neo4j',
        process.env.GRAPH_PASSWORD || 'polarisdev'
    )
);

/** The same eligibility rule the draw uses, limited to what it cannot date. */
const UNDATED = `
    MATCH (n)
    WHERE (n:Group OR n:Person)
      AND n.created_at IS NULL
      AND NOT (n)-[:MERGED_INTO]->()
      AND (n:Group OR (n)-[:MEMBER_OF]->(:Group))
    RETURN coalesce(n.group_id, n.person_id) AS id,
           labels(n)[0] AS label,
           n.name AS name
    ORDER BY id
`;

/**
 * How a candidate type is addressed, and nothing else is addressable.
 *
 * The label is interpolated into Cypher below, which is only acceptable
 * because it is matched against this table first: it arrives from
 * `labels(n)[0]` on a node the discovery query already restricted to these
 * two, and a value not in here is a bug rather than a node to repair. Matching
 * by label and id property hits the uniqueness constraint; the alternative,
 * `coalesce(n.group_id, n.person_id) = $id`, scans every node in the graph
 * once per candidate.
 */
export const ADDRESSABLE = Object.freeze({
    Group: 'group_id',
    Person: 'person_id',
});

/**
 * The earliest thing the graph can say about when a node existed.
 *
 * Three separate queries rather than one with three OPTIONAL MATCHes, because
 * the combination multiplies rows: a hub group with forty members, each with
 * claims, would expand to thousands before the aggregate collapses them again.
 *
 * Order is the point. A submission edge and a claim are the node's own
 * history; a neighbour's date is only an upper bound, which is why it is last
 * and why the caller flags what comes from it.
 *
 * @param {{run: Function}} session
 * @param {string} id
 * @param {string} label - a key of ADDRESSABLE
 * @returns {Promise<{at: unknown, source: string}|null>}
 */
export async function earliestEvidence(session, id, label) {
    const key = ADDRESSABLE[label];
    if (!key) throw new Error(`Not a candidate label: ${label}`);
    const node = `(n:${label} {${key}: $id})`;

    const probes = [
        {
            source: 'submitted',
            query: `MATCH (:Account)-[sub:SUBMITTED]->${node}
                    RETURN min(sub.timestamp) AS at`,
        },
        {
            source: 'claim',
            query: `MATCH (c:Claim {node_id: $id})
                    RETURN min(c.created_at) AS at`,
        },
        {
            source: 'neighbour',
            query: `MATCH ${node}--(peer)
                    WHERE peer.created_at IS NOT NULL
                    RETURN min(peer.created_at) AS at`,
        },
    ];

    for (const probe of probes) {
        const result = await session.run(probe.query, { id });
        const at = result.records[0]?.get('at');
        if (at) return { at, source: probe.source };
    }
    return null;
}

async function main() {
    const session = driver.session();
    try {
        const found = await session.run(UNDATED);
        const rows = found.records.map((r) => ({
            id: r.get('id'),
            label: r.get('label'),
            name: r.get('name'),
        }));

        console.log(`${rows.length} candidate(s) with no creation record\n`);
        if (rows.length === 0) {
            console.log('Nothing to do: every candidate can be pinned to a snapshot block.');
            return 0;
        }

        const counts = { submitted: 0, claim: 0, neighbour: 0, none: 0 };

        for (const row of rows) {
            const evidence = await earliestEvidence(session, row.id, row.label);

            if (!evidence) {
                counts.none++;
                console.log(`  ?  ${row.label} ${row.id} — ${row.name ?? '(unnamed)'}`);
                console.log('       no evidence in the graph; left as it is');
                continue;
            }

            counts[evidence.source]++;
            const when = evidence.at.toString();
            console.log(`  ${execute ? '+' : '·'}  ${row.label} ${row.id} — ${row.name ?? '(unnamed)'}`);
            console.log(`       ${when}  (from ${evidence.source})`);

            if (!execute) continue;

            // The neighbour date is an upper bound rather than the node's own
            // fact, so it is flagged. The other two are the node's own history.
            // `created_at IS NULL` keeps it idempotent: a second run, or two
            // runs racing, cannot move a date that is already there.
            await session.run(`
                MATCH (n:${row.label} {${ADDRESSABLE[row.label]}: $id})
                WHERE n.created_at IS NULL
                SET n.created_at = $at
                ${evidence.source === 'neighbour' ? ', n.created_at_inferred = true' : ''}
            `, { id: row.id, at: evidence.at });
        }

        console.log('\nFrom a submission edge:', counts.submitted);
        console.log('From a claim:          ', counts.claim);
        console.log('From a neighbour:      ', counts.neighbour, '(marked inferred)');
        console.log('Nothing to go on:      ', counts.none);

        if (!execute) {
            console.log('\nReport only — nothing was written. Re-run with --execute to apply.');
        }
        return 0;
    } finally {
        await session.close();
        await driver.close();
    }
}

// Only when run, not when imported: the helpers above are unit-tested, and a
// test importing this file must not open a driver or touch a database.
if (process.argv[1] && process.argv[1].endsWith('backfillCreatedAt.js')) {
    main()
        .then((code) => process.exit(code))
        .catch((error) => {
            console.error('backfill failed:', error.message);
            process.exit(1);
        });
}
