/**
 * Migration: Unify ID property across all entities
 *
 * Purpose: Backfill universal 'id' property from entity-specific IDs
 *          (person_id, group_id, track_id, etc.) for nodes that don't have it yet.
 *
 * Safety: This migration is idempotent and safe to run multiple times.
 *         It only updates nodes missing the 'id' property.
 *
 * Prerequisites:
 * - Universal ID constraints must exist (created by initializeSchema())
 * - Neo4j connection available
 *
 * See: /docs/migrations/001-unify-id-property.md for detailed runbook
 */

import neo4j from 'neo4j-driver';

/**
 * Run the ID unification migration
 *
 * @param {Object} driver - Neo4j driver instance
 * @returns {Promise<Object>} Migration statistics
 */
export async function migrateUnifyIdProperty(driver) {
    const session = driver.session();
    const stats = {
        person: 0,
        group: 0,
        song: 0,
        track: 0,
        release: 0,
        master: 0,
        label: 0,
        account: 0,
        city: 0,
        claim: 0,
        source: 0,
        media: 0,
        total: 0
    };

    try {
        console.log('Starting ID unification migration...');
        console.log('This will backfill universal "id" property from entity-specific IDs');
        console.log('');

        // Entity types with their specific ID fields
        const entityTypes = [
            { label: 'Person', idField: 'person_id', key: 'person' },
            { label: 'Group', idField: 'group_id', key: 'group' },
            { label: 'Song', idField: 'song_id', key: 'song' },
            { label: 'Track', idField: 'track_id', key: 'track' },
            { label: 'Release', idField: 'release_id', key: 'release' },
            { label: 'Master', idField: 'master_id', key: 'master' },
            { label: 'Label', idField: 'label_id', key: 'label' },
            { label: 'Account', idField: 'account_id', key: 'account' },
            { label: 'City', idField: 'city_id', key: 'city' },
            { label: 'Claim', idField: 'claim_id', key: 'claim' },
            { label: 'Source', idField: 'source_id', key: 'source' },
            { label: 'Media', idField: 'media_id', key: 'media' }
        ];

        // Process each entity type
        for (const entity of entityTypes) {
            console.log(`Processing ${entity.label}...`);

            // Find nodes without 'id' property
            const findQuery = `
                MATCH (n:${entity.label})
                WHERE n.id IS NULL AND n.${entity.idField} IS NOT NULL
                RETURN count(n) as count
            `;

            const findResult = await session.run(findQuery);
            const count = findResult.records[0]?.get('count').toNumber() || 0;

            if (count === 0) {
                console.log(`  ✓ All ${entity.label} nodes already have 'id' property`);
                continue;
            }

            console.log(`  Found ${count} ${entity.label} nodes missing 'id' property`);

            // Backfill 'id' from entity-specific ID
            const updateQuery = `
                MATCH (n:${entity.label})
                WHERE n.id IS NULL AND n.${entity.idField} IS NOT NULL
                SET n.id = n.${entity.idField}
                RETURN count(n) as updated
            `;

            const updateResult = await session.run(updateQuery);
            const updated = updateResult.records[0]?.get('updated').toNumber() || 0;

            stats[entity.key] = updated;
            stats.total += updated;

            console.log(`  ✓ Updated ${updated} ${entity.label} nodes`);
        }

        console.log('');
        console.log('Migration complete!');
        console.log('Summary:');
        console.log(`  Total nodes updated: ${stats.total}`);
        console.log('');

        if (stats.total === 0) {
            console.log('✓ No migration needed - all nodes already have universal ID');
        } else {
            console.log('✓ Successfully backfilled universal ID property');
        }

        return stats;

    } catch (error) {
        console.error('Migration failed:', error);
        throw error;
    } finally {
        await session.close();
    }
}

/**
 * Verify migration completed successfully
 *
 * @param {Object} driver - Neo4j driver instance
 * @returns {Promise<Object>} Verification results
 */
export async function verifyIdUnification(driver) {
    const session = driver.session();
    const results = {
        allHaveId: true,
        issues: []
    };

    try {
        console.log('Verifying ID unification...');
        console.log('');

        const entityTypes = [
            'Person', 'Group', 'Song', 'Track', 'Release',
            'Master', 'Label', 'Account', 'City', 'Claim', 'Source', 'Media'
        ];

        for (const label of entityTypes) {
            // Check for nodes without 'id'
            const checkQuery = `
                MATCH (n:${label})
                WHERE n.id IS NULL
                RETURN count(n) as count
            `;

            const result = await session.run(checkQuery);
            const count = result.records[0]?.get('count').toNumber() || 0;

            if (count > 0) {
                results.allHaveId = false;
                results.issues.push(`${count} ${label} nodes missing 'id' property`);
                console.log(`  ✗ ${count} ${label} nodes missing 'id'`);
            } else {
                console.log(`  ✓ All ${label} nodes have 'id'`);
            }
        }

        console.log('');
        if (results.allHaveId) {
            console.log('✓ Verification passed: All nodes have universal ID');
        } else {
            console.log('✗ Verification failed:');
            results.issues.forEach(issue => console.log(`  - ${issue}`));
        }

        return results;

    } finally {
        await session.close();
    }
}

/**
 * CLI runner for migration
 */
if (import.meta.url === `file://${process.argv[1]}`) {
    const config = {
        uri: process.env.GRAPH_URI || 'bolt://localhost:7687',
        user: process.env.GRAPH_USER || 'neo4j',
        password: process.env.GRAPH_PASSWORD || 'password'
    };

    const driver = neo4j.driver(
        config.uri,
        neo4j.auth.basic(config.user, config.password)
    );

    try {
        // Run migration
        const stats = await migrateUnifyIdProperty(driver);

        // Verify
        const verification = await verifyIdUnification(driver);

        // Exit with appropriate code
        process.exit(verification.allHaveId ? 0 : 1);

    } catch (error) {
        console.error('Migration error:', error);
        process.exit(1);
    } finally {
        await driver.close();
    }
}
