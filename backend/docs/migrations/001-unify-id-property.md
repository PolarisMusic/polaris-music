# Migration 001: Unify ID Property

## Overview

**Purpose:** Backfill universal `id` property from entity-specific IDs (person_id, group_id, etc.) for existing nodes.

**When to run:** After deploying schema updates that added universal ID constraints, before enabling merge operations.

**Safety:** Idempotent - safe to run multiple times. Only updates nodes missing the `id` property.

## Prerequisites

1. **Neo4j database accessible**
   ```bash
   # Test connection
   echo "RETURN 1" | cypher-shell -u neo4j -p yourpassword
   ```

2. **Universal ID constraints exist**
   ```cypher
   // Check constraints
   SHOW CONSTRAINTS WHERE name CONTAINS 'universal_id'
   ```
   Expected: Constraints for Person, Group, Song, Track, Release, Master, Label, Account, City

3. **Backup database** (recommended for production)
   ```bash
   # Stop database
   neo4j stop

   # Backup data directory
   cp -r /var/lib/neo4j/data /backup/neo4j-data-$(date +%Y%m%d)

   # Restart database
   neo4j start
   ```

## Running the Migration

### Option 1: Automated Script (Recommended)

```bash
cd backend

# Set environment variables
export GRAPH_URI="bolt://localhost:7687"
export GRAPH_USER="neo4j"
export GRAPH_PASSWORD="yourpassword"

# Run migration
node src/graph/migrations/001-unify-id-property.js
```

**Expected output:**
```
Starting ID unification migration...
This will backfill universal "id" property from entity-specific IDs

Processing Person...
  Found 150 Person nodes missing 'id' property
  ✓ Updated 150 Person nodes
Processing Group...
  Found 45 Group nodes missing 'id' property
  ✓ Updated 45 Group nodes
...

Migration complete!
Summary:
  Total nodes updated: 500

✓ Successfully backfilled universal ID property

Verifying ID unification...

  ✓ All Person nodes have 'id'
  ✓ All Group nodes have 'id'
  ...

✓ Verification passed: All nodes have universal ID
```

### Option 2: Manual Cypher Queries

```cypher
// 1. Check how many nodes need migration
MATCH (n:Person) WHERE n.id IS NULL AND n.person_id IS NOT NULL RETURN count(n);
MATCH (n:Group) WHERE n.id IS NULL AND n.group_id IS NOT NULL RETURN count(n);
// ... repeat for each entity type

// 2. Backfill Person nodes
MATCH (n:Person)
WHERE n.id IS NULL AND n.person_id IS NOT NULL
SET n.id = n.person_id
RETURN count(n) as updated;

// 3. Backfill Group nodes
MATCH (n:Group)
WHERE n.id IS NULL AND n.group_id IS NOT NULL
SET n.id = n.group_id
RETURN count(n) as updated;

// 4. Repeat for all entity types:
// - Song (song_id)
// - Track (track_id)
// - Release (release_id)
// - Master (master_id)
// - Label (label_id)
// - Account (account_id)
// - City (city_id)
// - Claim (claim_id)
// - Source (source_id)
// - Media (media_id)
```

## Verification

### Post-Migration Checks

```cypher
// Verify no nodes missing 'id' property
MATCH (n:Person) WHERE n.id IS NULL RETURN count(n);  // Should return 0
MATCH (n:Group) WHERE n.id IS NULL RETURN count(n);   // Should return 0
// ... check all entity types

// Verify 'id' matches entity-specific ID
MATCH (n:Person)
WHERE n.id <> n.person_id
RETURN count(n);  // Should return 0

// Sample check - view some nodes
MATCH (p:Person)
RETURN p.id, p.person_id, p.name
LIMIT 10;
```

### Rollback (if needed)

If migration fails partway through:

```cypher
// Option 1: Remove 'id' property and re-run migration
MATCH (n:Person) WHERE n.id = n.person_id REMOVE n.id;
MATCH (n:Group) WHERE n.id = n.group_id REMOVE n.id;
// ... for entity types that were updated

// Option 2: Restore from backup
// Stop database, restore backup directory, restart
```

## Impact Assessment

### What Changes

- **Before migration:**
  - Nodes have entity-specific IDs: person_id, group_id, track_id, etc.
  - Merge operations may fail due to missing universal `id` property

- **After migration:**
  - All nodes have BOTH entity-specific ID AND universal `id` property
  - `id` value equals the entity-specific ID value
  - Merge operations can use universal `id` for querying

### What Doesn't Change

- Entity-specific IDs remain unchanged
- No relationships are modified
- No data loss occurs
- Existing queries continue to work

### Performance Impact

- **During migration:** Light load, processes nodes sequentially
- **After migration:** No performance impact (indexes already exist on `id`)

## Troubleshooting

### Issue: Constraint violation

**Error:** `Node already exists with label Person and property id = 'person_123'`

**Cause:** Duplicate values in entity-specific ID fields

**Solution:**
```cypher
// Find duplicates
MATCH (n:Person)
WITH n.person_id as id, collect(n) as nodes
WHERE size(nodes) > 1
RETURN id, size(nodes) as count;

// Merge duplicates manually before migration
```

### Issue: Migration script fails to connect

**Error:** `Failed to connect to server`

**Solution:**
```bash
# Check Neo4j is running
neo4j status

# Check connection details
echo $GRAPH_URI
echo $GRAPH_USER

# Test connection
echo "RETURN 1" | cypher-shell -a $GRAPH_URI -u $GRAPH_USER -p $GRAPH_PASSWORD
```

### Issue: Some nodes still missing 'id'

**Cause:** Nodes without entity-specific ID (data quality issue)

**Solution:**
```cypher
// Find nodes without any ID
MATCH (n:Person)
WHERE n.id IS NULL AND n.person_id IS NULL
RETURN n
LIMIT 10;

// Manual cleanup: either delete invalid nodes or assign IDs
```

## Timeline

- **Preparation:** 5-10 minutes (backup, verify prerequisites)
- **Execution:** 1-5 minutes (depends on database size)
- **Verification:** 2-3 minutes
- **Total:** ~15 minutes for typical database

## Next Steps

After successful migration:

1. ✓ Verify all acceptance criteria
2. Enable merge API endpoint
3. Test merge operations
4. Monitor for any ID-related issues
5. Document in release notes

## References

- Migration script: `backend/src/graph/migrations/001-unify-id-property.js`
- Schema constraints: `backend/src/graph/schema.js` (initializeSchema)
- ID property tests: `backend/test/id-property.test.js`
