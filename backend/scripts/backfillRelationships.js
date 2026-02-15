/**
 * Backfill Missing Cross-Bundle Relationships
 *
 * Repairs graph data where nodes were correctly merged (via person_id uniqueness
 * constraint) but cross-bundle relationships were not created — e.g., a Person
 * who is a MEMBER_OF multiple Groups across different release bundles.
 *
 * This script infers missing MEMBER_OF relationships from existing graph structure
 * (PERFORMED_ON edges) and creates them idempotently using MERGE.
 *
 * Usage:
 *   node backend/scripts/backfillRelationships.js [--dry-run]
 *
 * Options:
 *   --dry-run   Show what would be created without modifying the database
 *
 * Environment Variables:
 *   GRAPH_URI       Neo4j connection URI (default: bolt://localhost:7687)
 *   GRAPH_USER      Neo4j username (default: neo4j)
 *   GRAPH_PASSWORD  Neo4j password (default: polarisdev)
 */

import neo4j from 'neo4j-driver';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const driver = neo4j.driver(
    process.env.GRAPH_URI || 'bolt://localhost:7687',
    neo4j.auth.basic(
        process.env.GRAPH_USER || 'neo4j',
        process.env.GRAPH_PASSWORD || 'polarisdev'
    )
);

/**
 * Infer missing MEMBER_OF relationships.
 *
 * Logic: If a Person has PERFORMED_ON edges to Tracks that a Group also
 * PERFORMED_ON, and there is no existing MEMBER_OF relationship between
 * that Person and Group, create one with roles='inferred'.
 */
async function backfillMemberOf(session) {
    console.log('\n--- Backfilling MEMBER_OF relationships ---');

    // Find persons who performed on tracks alongside a group but lack MEMBER_OF
    const detectQuery = `
        MATCH (p:Person)-[:PERFORMED_ON]->(t:Track)<-[:PERFORMED_ON]-(g:Group)
        WHERE NOT (p)-[:MEMBER_OF]->(g)
          AND NOT (p)-[:GUEST_ON]->(t)
        WITH p, g, count(DISTINCT t) AS shared_tracks
        WHERE shared_tracks >= 1
        RETURN p.person_id AS person_id,
               p.name AS person_name,
               g.group_id AS group_id,
               g.name AS group_name,
               shared_tracks
        ORDER BY shared_tracks DESC
    `;

    const result = await session.run(detectQuery);
    const missing = result.records.map(r => ({
        person_id: r.get('person_id'),
        person_name: r.get('person_name'),
        group_id: r.get('group_id'),
        group_name: r.get('group_name'),
        shared_tracks: r.get('shared_tracks').toNumber
            ? r.get('shared_tracks').toNumber()
            : r.get('shared_tracks')
    }));

    console.log(`Found ${missing.length} missing MEMBER_OF relationships`);

    if (missing.length === 0) {
        console.log('No backfill needed.');
        return 0;
    }

    for (const m of missing) {
        console.log(`  ${m.person_name} --[MEMBER_OF]--> ${m.group_name} (${m.shared_tracks} shared tracks)`);
    }

    if (dryRun) {
        console.log('\n[DRY RUN] No changes made.');
        return missing.length;
    }

    // Create missing MEMBER_OF relationships
    const backfillQuery = `
        MATCH (p:Person)-[:PERFORMED_ON]->(t:Track)<-[:PERFORMED_ON]-(g:Group)
        WHERE NOT (p)-[:MEMBER_OF]->(g)
          AND NOT (p)-[:GUEST_ON]->(t)
        WITH p, g, count(DISTINCT t) AS shared_tracks
        WHERE shared_tracks >= 1
        MERGE (p)-[m:MEMBER_OF]->(g)
        ON CREATE SET m.roles = ['inferred'],
                      m.role = 'inferred',
                      m.backfilled = true,
                      m.backfilled_at = datetime(),
                      m.shared_track_count = shared_tracks
        RETURN count(*) AS created
    `;

    const backfillResult = await session.run(backfillQuery);
    const created = backfillResult.records[0]?.get('created');
    const createdNum = created?.toNumber ? created.toNumber() : created;
    console.log(`Created ${createdNum} MEMBER_OF relationships`);
    return createdNum;
}

/**
 * Ensure all nodes have the universal 'id' property set.
 * The loadSmokeTests.js script may not set this, which breaks merge operations.
 */
async function backfillUniversalIds(session) {
    console.log('\n--- Backfilling universal id property ---');

    const entityTypes = [
        { label: 'Person', idField: 'person_id' },
        { label: 'Group', idField: 'group_id' },
        { label: 'Release', idField: 'release_id' },
        { label: 'Track', idField: 'track_id' },
        { label: 'Song', idField: 'song_id' },
        { label: 'Label', idField: 'label_id' },
        { label: 'City', idField: 'city_id' }
    ];

    let totalFixed = 0;

    for (const { label, idField } of entityTypes) {
        const detectQuery = `
            MATCH (n:${label})
            WHERE n.id IS NULL AND n.${idField} IS NOT NULL
            RETURN count(n) AS missing
        `;

        const detectResult = await session.run(detectQuery);
        const missingCount = detectResult.records[0]?.get('missing');
        const missingNum = missingCount?.toNumber ? missingCount.toNumber() : missingCount;

        if (missingNum > 0) {
            console.log(`  ${label}: ${missingNum} nodes missing universal id`);

            if (!dryRun) {
                await session.run(`
                    MATCH (n:${label})
                    WHERE n.id IS NULL AND n.${idField} IS NOT NULL
                    SET n.id = n.${idField}
                `);
                console.log(`    Fixed ${missingNum} ${label} nodes`);
            }
            totalFixed += missingNum;
        }
    }

    if (totalFixed === 0) {
        console.log('All nodes have universal id property.');
    } else if (dryRun) {
        console.log(`\n[DRY RUN] Would fix ${totalFixed} nodes.`);
    } else {
        console.log(`\nFixed ${totalFixed} nodes total.`);
    }

    return totalFixed;
}

/**
 * Report graph connectivity statistics
 */
async function reportStats(session) {
    console.log('\n--- Graph Connectivity Statistics ---');

    const queries = [
        {
            name: 'MEMBER_OF connections',
            query: 'MATCH (p:Person)-[:MEMBER_OF]->(g:Group) RETURN count(*) AS count'
        },
        {
            name: 'PERFORMED_ON connections (Group->Track)',
            query: 'MATCH (g:Group)-[:PERFORMED_ON]->(t:Track) RETURN count(*) AS count'
        },
        {
            name: 'PERFORMED_ON connections (Person->Track)',
            query: 'MATCH (p:Person)-[:PERFORMED_ON]->(t:Track) RETURN count(*) AS count'
        },
        {
            name: 'GUEST_ON connections',
            query: 'MATCH (p:Person)-[:GUEST_ON]->() RETURN count(*) AS count'
        },
        {
            name: 'Persons in multiple groups',
            query: `MATCH (p:Person)-[:MEMBER_OF]->(g:Group)
                    WITH p, count(g) AS groups
                    WHERE groups > 1
                    RETURN count(p) AS count`
        },
        {
            name: 'Cross-group paths (via shared members)',
            query: `MATCH (g1:Group)<-[:MEMBER_OF]-(p:Person)-[:MEMBER_OF]->(g2:Group)
                    WHERE g1 <> g2
                    RETURN count(DISTINCT p) AS count`
        }
    ];

    for (const { name, query } of queries) {
        const result = await session.run(query);
        const count = result.records[0]?.get('count');
        const num = count?.toNumber ? count.toNumber() : count;
        console.log(`  ${name}: ${num}`);
    }
}

async function main() {
    console.log('Polaris Music - Relationship Backfill');
    console.log('='.repeat(50));
    if (dryRun) console.log('[DRY RUN MODE]');

    const session = driver.session();

    try {
        await backfillUniversalIds(session);
        await backfillMemberOf(session);
        await reportStats(session);
    } catch (error) {
        console.error('Backfill failed:', error.message);
        process.exit(1);
    } finally {
        await session.close();
        await driver.close();
    }

    console.log('\nBackfill complete.');
}

main();
