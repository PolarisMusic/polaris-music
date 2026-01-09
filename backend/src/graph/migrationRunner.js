/**
 * Migration Runner for Neo4j Database
 *
 * Tracks and executes pending database migrations in order.
 * Stores migration history in the graph database using a (:Migration) node type.
 *
 * Usage:
 *   import { runPendingMigrations } from './migrationRunner.js';
 *   await runPendingMigrations(driver);
 *
 * Environment Variables:
 *   - GRAPH_RUN_MIGRATIONS: Set to 'true' to enable migrations (default: false in prod)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * List of all available migrations in order
 * Each migration must export a function matching the naming pattern
 */
const MIGRATIONS = [
    {
        id: '001-unify-id-property',
        name: 'Unify ID property across all entities',
        file: './migrations/001-unify-id-property.js',
        exportName: 'migrateUnifyIdProperty'
    }
    // Add future migrations here in order
    // {
    //     id: '002-example',
    //     name: 'Example migration',
    //     file: './migrations/002-example.js',
    //     exportName: 'migrateExample'
    // }
];

/**
 * Get list of applied migrations from database
 *
 * @param {Object} driver - Neo4j driver instance
 * @returns {Promise<Set<string>>} Set of applied migration IDs
 */
async function getAppliedMigrations(driver) {
    const session = driver.session();
    try {
        // Create Migration constraint if it doesn't exist
        await session.run(`
            CREATE CONSTRAINT migration_id_unique IF NOT EXISTS
            FOR (m:Migration) REQUIRE m.id IS UNIQUE
        `);

        // Get all applied migrations
        const result = await session.run(`
            MATCH (m:Migration)
            RETURN m.id as id
        `);

        return new Set(result.records.map(record => record.get('id')));
    } finally {
        await session.close();
    }
}

/**
 * Mark a migration as applied
 *
 * @param {Object} driver - Neo4j driver instance
 * @param {string} migrationId - Migration ID to mark as applied
 * @param {Object} stats - Migration statistics
 * @returns {Promise<void>}
 */
async function recordMigration(driver, migrationId, stats) {
    const session = driver.session();
    try {
        await session.run(`
            MERGE (m:Migration {id: $id})
            SET m.applied_at = datetime(),
                m.stats = $stats
        `, {
            id: migrationId,
            stats: JSON.stringify(stats)
        });
        console.log(`  Recorded migration: ${migrationId}`);
    } finally {
        await session.close();
    }
}

/**
 * Run a single migration
 *
 * @param {Object} driver - Neo4j driver instance
 * @param {Object} migration - Migration definition
 * @returns {Promise<Object>} Migration result with stats
 */
async function runMigration(driver, migration) {
    console.log(`\nRunning migration: ${migration.id}`);
    console.log(`  ${migration.name}`);

    try {
        // Dynamically import the migration module
        const modulePath = path.join(__dirname, migration.file);
        const migrationModule = await import(modulePath);

        // Get the migration function
        const migrateFn = migrationModule[migration.exportName];
        if (!migrateFn) {
            throw new Error(`Migration function '${migration.exportName}' not found in ${migration.file}`);
        }

        // Run the migration
        const stats = await migrateFn(driver);

        // Record successful migration
        await recordMigration(driver, migration.id, stats);

        console.log(`  Migration ${migration.id} completed successfully`);
        return { id: migration.id, status: 'success', stats };
    } catch (error) {
        console.error(`  Migration ${migration.id} failed:`, error.message);
        return { id: migration.id, status: 'failed', error: error.message };
    }
}

/**
 * Run all pending migrations in order
 *
 * @param {Object} driver - Neo4j driver instance
 * @returns {Promise<Object>} Summary of migration results
 */
export async function runPendingMigrations(driver) {
    console.log('Checking for pending migrations...');

    // Get list of already-applied migrations
    const appliedMigrations = await getAppliedMigrations(driver);
    console.log(`  Applied migrations: ${appliedMigrations.size}`);

    // Find pending migrations
    const pendingMigrations = MIGRATIONS.filter(m => !appliedMigrations.has(m.id));

    if (pendingMigrations.length === 0) {
        console.log('  No pending migrations');
        return { total: 0, success: 0, failed: 0, results: [] };
    }

    console.log(`  Pending migrations: ${pendingMigrations.length}`);

    // Run each pending migration in order
    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (const migration of pendingMigrations) {
        const result = await runMigration(driver, migration);
        results.push(result);

        if (result.status === 'success') {
            successCount++;
        } else {
            failCount++;
            // Stop on first failure to avoid cascading issues
            console.error(`\nStopping migrations due to failure in ${migration.id}`);
            break;
        }
    }

    // Summary
    console.log(`\nMigration Summary:`);
    console.log(`  Total:   ${results.length}`);
    console.log(`  Success: ${successCount}`);
    console.log(`  Failed:  ${failCount}`);

    if (failCount > 0) {
        throw new Error(`${failCount} migration(s) failed`);
    }

    return {
        total: results.length,
        success: successCount,
        failed: failCount,
        results
    };
}

/**
 * Get migration status (for debugging/ops)
 *
 * @param {Object} driver - Neo4j driver instance
 * @returns {Promise<Object>} Migration status
 */
export async function getMigrationStatus(driver) {
    const appliedMigrations = await getAppliedMigrations(driver);
    const pending = MIGRATIONS.filter(m => !appliedMigrations.has(m.id));

    return {
        total: MIGRATIONS.length,
        applied: appliedMigrations.size,
        pending: pending.length,
        appliedIds: Array.from(appliedMigrations),
        pendingIds: pending.map(m => m.id)
    };
}
