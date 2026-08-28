/**
 * Migration: status becomes a lifecycle field only
 *
 * Purpose: `status` was carrying two unrelated meanings — the node's lifecycle
 *          and its identity kind. graph/merge.js defines the lifecycle
 *          vocabulary as ACTIVE / MERGED / TOMBSTONE; 'PROVISIONAL' was never
 *          part of it. Identity kind belongs in `id_kind`, which migration 002
 *          introduced for exactly that purpose.
 *
 *          The consequence was not cosmetic. 32 read queries filter
 *          `status = 'ACTIVE'` (21 in api/resolvers/index.js, 11 in
 *          api/playerService.js), so every user-submitted Group, Person and
 *          Release — all provisionally identified until merged with an external
 *          id — was invisible. The player returned an empty queue for every
 *          context and the GraphQL surface hid the same rows.
 *
 *          Migration 002 already backfilled id_kind from the old status value,
 *          so the information this migration clears from `status` is preserved
 *          there. This completes the transition 002 began.
 *
 * Safety: Idempotent. Only touches nodes whose status is exactly 'PROVISIONAL',
 *         and backfills id_kind first so nothing is lost if it is missing.
 *         MERGED and TOMBSTONE nodes are untouched — they must stay filtered
 *         out, which is what the read queries were always for.
 *
 * @module graph/migrations/003-status-is-lifecycle-only
 */

import { safeClose } from '../safeTx.js';

/**
 * Promote PROVISIONAL nodes to ACTIVE, preserving identity kind in id_kind.
 *
 * @param {Object} tx - Neo4j transaction (migration runner) or driver (CLI)
 * @returns {Promise<Object>} { id_kind_backfilled, promoted_to_active, total }
 */
export async function migrateStatusIsLifecycleOnly(tx) {
    const session = tx.run ? null : tx.session();
    const runner = tx.run ? tx : session;

    const stats = {
        id_kind_backfilled: 0,
        promoted_to_active: 0,
        total: 0
    };

    try {
        console.log('Migration 003: status becomes lifecycle-only...');

        // Backfill first. A node that reaches step 2 without id_kind would
        // otherwise lose the provisional marker entirely.
        const backfill = await runner.run(`
            MATCH (n)
            WHERE n.status = 'PROVISIONAL' AND n.id_kind IS NULL
            SET n.id_kind = 'provisional'
            RETURN count(n) AS updated
        `);
        stats.id_kind_backfilled = backfill.records[0]?.get('updated')?.toNumber?.() ?? 0;
        console.log(`  Backfilled id_kind on ${stats.id_kind_backfilled} node(s)`);

        // MERGED and TOMBSTONE are deliberately excluded: those nodes should
        // stay invisible to the read queries.
        const promote = await runner.run(`
            MATCH (n)
            WHERE n.status = 'PROVISIONAL'
            SET n.status = 'ACTIVE'
            RETURN count(n) AS updated
        `);
        stats.promoted_to_active = promote.records[0]?.get('updated')?.toNumber?.() ?? 0;
        console.log(`  Promoted ${stats.promoted_to_active} node(s) from PROVISIONAL to ACTIVE`);

        stats.total = stats.promoted_to_active;
        return stats;
    } finally {
        if (session) await safeClose(session);
    }
}

/**
 * Verify no node still carries PROVISIONAL in its lifecycle field.
 *
 * @param {Object} tx - Neo4j transaction or driver
 * @returns {Promise<{clean: boolean, remaining: number}>}
 */
export async function verifyStatusIsLifecycleOnly(tx) {
    const session = tx.run ? null : tx.session();
    const runner = tx.run ? tx : session;

    try {
        const result = await runner.run(`
            MATCH (n) WHERE n.status = 'PROVISIONAL' RETURN count(n) AS remaining
        `);
        const remaining = result.records[0]?.get('remaining')?.toNumber?.() ?? 0;
        return { clean: remaining === 0, remaining };
    } finally {
        if (session) await safeClose(session);
    }
}

export default migrateStatusIsLifecycleOnly;
