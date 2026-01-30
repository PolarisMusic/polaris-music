# Migration 002: Normalize Status Values

## Overview

**Purpose:** Convert legacy lowercase status values (`canonical`, `provisional`) to the uppercase convention (`ACTIVE`, `PROVISIONAL`) used by the current ingestion and GraphQL layer. Also backfills the `id_kind` field that separates identity classification from visibility status.

**When to run:** After deploying the status-normalization changes to `schema.js` and `server.js`, before querying an existing database. Without this migration, GraphQL queries filtering `WHERE n.status = 'ACTIVE'` will not find nodes that were ingested with the old lowercase values.

**Safety:** Idempotent — safe to run multiple times. Nodes already using uppercase values are unaffected.

## What Changes

| Before | After | Affected Property |
|--------|-------|-------------------|
| `status: 'canonical'` | `status: 'ACTIVE'` | All node types |
| `status: 'provisional'` | `status: 'PROVISIONAL'` | All node types |
| *(missing)* | `id_kind: 'canonical'` or `'provisional'` | Backfilled from old status |

### Semantics

- **`status`** controls visibility: `ACTIVE` nodes appear in GraphQL/search; `PROVISIONAL` nodes are hidden until confirmed.
- **`id_kind`** records identity provenance: `canonical` (has a real external ID like Discogs), `provisional` (hash-based temporary ID), or `external` (third-party system ID).

## Running the Migration

### Option 1: Automated (Recommended)

Set `GRAPH_RUN_MIGRATIONS=true` in your `.env` and restart the backend:

```bash
cd backend
export GRAPH_RUN_MIGRATIONS=true
npm run dev
```

The migration runner checks which migrations have been applied (tracked via `(:Migration)` nodes in Neo4j) and runs only pending ones.

### Option 2: Manual Cypher

```cypher
// Step 1: Convert 'canonical' → 'ACTIVE', backfill id_kind
MATCH (n) WHERE n.status = 'canonical'
SET n.status = 'ACTIVE', n.id_kind = coalesce(n.id_kind, 'canonical')
RETURN count(n) as updated;

// Step 2: Normalize 'provisional' case, backfill id_kind
MATCH (n) WHERE n.status = 'provisional'
SET n.status = 'PROVISIONAL', n.id_kind = coalesce(n.id_kind, 'provisional')
RETURN count(n) as updated;

// Step 3: Backfill id_kind for nodes already uppercase but missing id_kind
MATCH (n)
WHERE n.status IN ['ACTIVE', 'PROVISIONAL'] AND n.id_kind IS NULL
SET n.id_kind = CASE n.status WHEN 'ACTIVE' THEN 'canonical' WHEN 'PROVISIONAL' THEN 'provisional' END
RETURN count(n) as updated;
```

## Verification

```cypher
// Should return 0 — no lowercase status values remain
MATCH (n) WHERE n.status IN ['canonical', 'provisional'] RETURN count(n);

// Should return 0 — all status nodes have id_kind
MATCH (n) WHERE n.status IN ['ACTIVE', 'PROVISIONAL'] AND n.id_kind IS NULL RETURN count(n);

// Summary of status distribution
MATCH (n) WHERE n.status IS NOT NULL
RETURN n.status, count(n) ORDER BY n.status;
```

## Rollback

If needed, reverse the migration:

```cypher
// Revert to lowercase (loses distinction between status and id_kind)
MATCH (n) WHERE n.status = 'ACTIVE' SET n.status = 'canonical';
MATCH (n) WHERE n.status = 'PROVISIONAL' SET n.status = 'provisional';
```

## References

- Migration script: `backend/src/graph/migrations/002-normalize-status-values.js`
- Migration runner: `backend/src/graph/migrationRunner.js`
- Status convention change: `backend/src/graph/schema.js` (processReleaseBundle)
- GraphQL filters: `backend/src/api/server.js` (all queries use `status = 'ACTIVE'`)
