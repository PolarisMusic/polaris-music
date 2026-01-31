/**
 * Migration: Normalize status values to uppercase convention
 *
 * Purpose: Existing nodes may have lowercase status values ('canonical', 'provisional')
 *          from the old ingestion code. This migration normalizes them to the new
 *          uppercase convention ('ACTIVE', 'PROVISIONAL') and backfills the id_kind field.
 *
 * Safety: This migration is idempotent and safe to run multiple times.
 *         Nodes already using uppercase values are unaffected.
 *
 * Changes:
 * - status 'canonical'   → 'ACTIVE'
 * - status 'provisional' → 'PROVISIONAL' (case change only)
 * - Backfills id_kind from old status value when missing
 *
 * See: backend/docs/migrations/002-normalize-status-values.md for detailed runbook
 */

/**
 * Run the status normalization migration
 *
 * @param {Object} driver - Neo4j driver instance
 * @returns {Promise<Object>} Migration statistics
 */
export async function migrateNormalizeStatusValues(driver) {
    const session = driver.session();
    const stats = {
        canonical_to_active: 0,
        provisional_normalized: 0,
        id_kind_backfilled: 0,
        total: 0
    };

    try {
        console.log('Migration 002: Normalizing status values...');

        // Step 1: Convert 'canonical' → 'ACTIVE' and backfill id_kind
        const canonicalResult = await session.run(`
            MATCH (n)
            WHERE n.status = 'canonical'
            SET n.status = 'ACTIVE',
                n.id_kind = coalesce(n.id_kind, 'canonical')
            RETURN count(n) as updated
        `);
        stats.canonical_to_active = canonicalResult.records[0]?.get('updated')?.toNumber?.() ?? 0;
        console.log(`  Converted ${stats.canonical_to_active} nodes from 'canonical' to 'ACTIVE'`);

        // Step 2: Normalize 'provisional' → 'PROVISIONAL' (case) and backfill id_kind
        const provisionalResult = await session.run(`
            MATCH (n)
            WHERE n.status = 'provisional'
            SET n.status = 'PROVISIONAL',
                n.id_kind = coalesce(n.id_kind, 'provisional')
            RETURN count(n) as updated
        `);
        stats.provisional_normalized = provisionalResult.records[0]?.get('updated')?.toNumber?.() ?? 0;
        console.log(`  Normalized ${stats.provisional_normalized} nodes from 'provisional' to 'PROVISIONAL'`);

        // Step 3: Backfill id_kind for nodes that already have correct uppercase status
        // but are missing id_kind (e.g., from earlier partial migrations)
        const backfillResult = await session.run(`
            MATCH (n)
            WHERE n.status IN ['ACTIVE', 'PROVISIONAL'] AND n.id_kind IS NULL
            SET n.id_kind = CASE n.status
                WHEN 'ACTIVE' THEN 'canonical'
                WHEN 'PROVISIONAL' THEN 'provisional'
            END
            RETURN count(n) as updated
        `);
        stats.id_kind_backfilled = backfillResult.records[0]?.get('updated')?.toNumber?.() ?? 0;
        console.log(`  Backfilled id_kind for ${stats.id_kind_backfilled} nodes`);

        stats.total = stats.canonical_to_active + stats.provisional_normalized + stats.id_kind_backfilled;
        console.log(`Migration 002 complete: ${stats.total} total updates`);

        return stats;

    } catch (error) {
        console.error('Migration 002 failed:', error.message);
        throw error;
    } finally {
        await session.close();
    }
}

export default migrateNormalizeStatusValues;
