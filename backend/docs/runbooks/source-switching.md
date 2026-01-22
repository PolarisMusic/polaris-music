# Runbook: Switching Chain Ingestion Sources

**Purpose**: Safely switch between Substreams and SHiP chain ingestion sources without double-ingesting events.

**Key Safety Feature**: Robust deduplication by both eventHash and (block, trx, ordinal) prevents duplicate processing when switching sources.

---

## Overview

Polaris supports two chain ingestion sources:

1. **Substreams** (Primary)
   - Cloud-hosted via Pinax
   - High-performance parallel processing
   - Requires API token
   - Cost: Pay per query

2. **SHiP** (Fallback)
   - Direct node connection
   - Self-hosted option
   - No external dependencies
   - Cost: Node infrastructure only

**When to Switch**:
- Substreams outage or maintenance
- Cost optimization
- Testing fallback path
- Migrating to self-hosted infrastructure

---

## Prerequisites

### Before Switching

- [ ] Identify last successfully processed block
- [ ] Verify target source is operational
- [ ] Backup current state (database + event storage)
- [ ] Review dedupe cache status
- [ ] Plan maintenance window (5-15 minutes)

### Required Access

- Backend server SSH/console access
- Environment variable configuration
- Database admin credentials
- Log monitoring access

---

## Switching Procedures

### From Substreams to SHiP

**Use Case**: Substreams unavailable, switch to SHiP

**Steps**:

1. **Stop Substreams HTTP Sink**

   ```bash
   # Find sink process
   ps aux | grep http-sink.js

   # Stop gracefully
   kill -TERM <pid>

   # Or if running in screen/tmux
   screen -r substreams-sink
   # Press Ctrl+C
   ```

2. **Identify Last Processed Block**

   ```bash
   # Query last event in storage
   curl http://localhost:3000/api/events/recent | jq '.[0].blockchain_metadata.block_num'

   # Or check logs
   grep "Processing block" logs/substreams.log | tail -1
   ```

   **Record this block number**: `LAST_BLOCK=100000500`

3. **Update Configuration**

   ```bash
   cd /home/user/polaris-music/backend

   # Update .env
   sed -i 's/CHAIN_SOURCE=substreams/CHAIN_SOURCE=ship/' .env

   # Set SHiP start block (LAST_BLOCK + 1)
   echo "START_BLOCK=100000501" >> .env
   echo "SHIP_URL=ws://localhost:8080" >> .env
   ```

4. **Verify SHiP Endpoint**

   ```bash
   # Test connection
   wscat -c ws://localhost:8080
   # Should connect successfully
   ```

5. **Restart Backend in SHiP Mode**

   ```bash
   # Stop current backend
   pm2 stop backend
   # Or: kill -TERM <backend-pid>

   # Start with SHiP mode
   export CHAIN_SOURCE=ship
   pm2 start backend
   # Or: npm run dev
   ```

6. **Monitor Initial Blocks**

   ```bash
   # Watch logs for first 10 blocks
   tail -f logs/backend.log | grep "Processing block"

   # Verify no duplicates
   tail -f logs/backend.log | grep "duplicate"
   ```

7. **Verify Dedupe is Working**

   ```bash
   # Check ingestion statistics
   curl http://localhost:3000/api/stats | jq '
     {
       eventsIngested: .eventsIngested,
       eventsDeduped: .eventsDeduped,
       currentBlock: .currentBlock
     }
   '
   ```

   **Expected**: `eventsDeduped` increases if there's overlap

8. **Confirm Graph Updates**

   ```cypher
   // Neo4j query - verify recent releases
   MATCH (r:Release)
   WHERE r.created_at > datetime() - duration({minutes: 10})
   RETURN count(r) as recent_releases;

   // Should show new releases being added
   ```

**Rollback** (if issues):
```bash
# Stop SHiP mode
pm2 stop backend

# Revert configuration
sed -i 's/CHAIN_SOURCE=ship/CHAIN_SOURCE=substreams/' .env

# Restart Substreams HTTP sink
cd substreams/sink
node http-sink.js &

# Restart backend
pm2 start backend
```

---

### From SHiP to Substreams

**Use Case**: Substreams back online, switch from SHiP

**Steps**:

1. **Identify Last Processed Block from SHiP**

   ```bash
   # Check SHiP current block
   curl http://localhost:3000/api/stats | jq .currentBlock
   ```

   **Record**: `LAST_SHIP_BLOCK=100001234`

2. **Stop SHiP Mode**

   ```bash
   # Graceful stop
   pm2 stop backend
   # Or: kill -TERM <pid>

   # Verify WebSocket closed
   netstat -an | grep 8080 | grep ESTABLISHED
   # Should be empty
   ```

3. **Update Configuration**

   ```bash
   # Switch to Substreams
   sed -i 's/CHAIN_SOURCE=ship/CHAIN_SOURCE=substreams/' .env
   ```

4. **Start Substreams HTTP Sink**

   ```bash
   cd substreams/sink

   # Set start block (LAST_SHIP_BLOCK + 1)
   export START_BLOCK=100001235
   export SUBSTREAMS_API_TOKEN="your_token"

   # Start sink
   node http-sink.js &
   # Or: screen -S substreams -dm node http-sink.js
   ```

5. **Restart Backend**

   ```bash
   cd ../backend
   pm2 start backend
   ```

6. **Monitor for Duplicates**

   ```bash
   # Watch first 100 events
   tail -f logs/backend.log | head -100 | grep -E "(processed|duplicate)"
   ```

   **Expected**: Some duplicates due to overlap, then clean processing

7. **Verify Continuous Ingestion**

   ```bash
   # Check event flow
   watch -n 5 'curl -s http://localhost:3000/api/stats | jq .eventsIngested'

   # Should increment steadily
   ```

---

## Handling Overlap (Critical)

When switching sources, there may be an overlap period where both sources process the same blocks.

### Overlap Scenario

```
Timeline:
┌─────────────────────────────────────────┐
│ Substreams processing...                │
│ ├─ Block 100000500                      │
│ ├─ Block 100000501 ← Last Substreams   │
│ └─ Stopped                              │
│                                          │
│ SHiP starts...                          │
│ ├─ Block 100000501 ← Same block!       │
│ ├─ Block 100000502                      │
│ └─ ...                                  │
└─────────────────────────────────────────┘
```

### Dedupe Protection

**Primary Dedupe** (eventHash):
- Same blockchain action → same eventHash
- Second ingestion attempt returns `status: "duplicate"`

**Secondary Dedupe** (block/trx/ordinal):
- Prevents duplicates even if eventHash differs
- Key: `${blockNum}:${trxId}:${actionOrdinal}`
- Both sources produce same key for same action

**Example**:
```javascript
// First source ingests event
POST /api/ingest/anchored-event
{
  "event_hash": "abc123...",
  "block_num": 100000501,
  "trx_id": "def456...",
  "action_ordinal": 0,
  ...
}
Response: { "status": "processed" }

// Second source tries same event
POST /api/ingest/anchored-event
{
  "event_hash": "abc123...",  // Same hash
  "block_num": 100000501,     // Same block
  "trx_id": "def456...",      // Same trx
  "action_ordinal": 0,        // Same ordinal
  ...
}
Response: {
  "status": "duplicate",
  "dedupeKey": "100000501:def456...:0"
}
```

### Verifying Dedupe

```bash
# Test duplicate submission
EVENT_HASH=$(curl -s http://localhost:3000/api/events/recent | jq -r '.[0].event_hash')

curl -X POST http://localhost:3000/api/ingest/anchored-event \
  -H "Content-Type: application/json" \
  -d @<(curl -s http://localhost:3000/api/events/${EVENT_HASH})

# Should return: "status": "duplicate"
```

---

## Testing Source Switching

### Test Environment Setup

```bash
# Create isolated test environment
export GRAPH_URI=bolt://localhost:7688  # Test DB
export S3_BUCKET=polaris-test-events
export REDIS_DB=1  # Separate Redis database
```

### Dry Run Switch

1. **Record Current State**

   ```bash
   # Capture statistics before switch
   curl http://localhost:3000/api/stats > stats_before.json

   # Capture recent events
   curl http://localhost:3000/api/events/recent > events_before.json
   ```

2. **Perform Switch** (use test config)

3. **Compare After Switch**

   ```bash
   curl http://localhost:3000/api/stats > stats_after.json

   # Check for duplicates in graph
   cypher-shell << EOF
   MATCH (r:Release)
   WITH r.name as name, count(*) as count
   WHERE count > 1
   RETURN name, count
   ORDER BY count DESC;
   EOF
   # Should return no results
   ```

4. **Rollback Test Environment**

---

## Emergency Procedures

### Scenario: Double Ingestion Detected

**Symptoms**:
- Same events appearing twice in logs
- Duplicate releases in Neo4j
- `eventsDeduped` counter not incrementing

**Immediate Actions**:

1. **Stop Both Sources**
   ```bash
   pm2 stop backend
   kill -TERM <http-sink-pid>
   ```

2. **Identify Duplicate Range**
   ```cypher
   // Find duplicate releases
   MATCH (r:Release)
   WITH r.name as name, r.release_date as date, collect(r.id) as ids
   WHERE size(ids) > 1
   RETURN name, date, ids;
   ```

3. **Clean Up Duplicates**
   ```cypher
   // Keep first, delete rest (CAREFUL!)
   MATCH (r:Release)
   WITH r.name as name, r.release_date as date, collect(r) as releases
   WHERE size(releases) > 1
   UNWIND releases[1..] as duplicate
   DETACH DELETE duplicate;
   ```

4. **Clear Dedupe Caches**
   ```bash
   # Restart backend to clear in-memory caches
   pm2 restart backend
   ```

5. **Resume from Safe Block**
   ```bash
   # Set START_BLOCK before first duplicate
   export START_BLOCK=<safe_block>
   ```

### Scenario: Lost Track of Last Block

**Recovery**:

1. **Query Neo4j for Latest**
   ```cypher
   MATCH (r:Release)
   RETURN max(r.created_at) as latest;
   ```

2. **Query Event Storage**
   ```bash
   curl http://localhost:3000/api/events/recent | jq '.[0].blockchain_metadata.block_num'
   ```

3. **Conservative Approach**
   - Resume from 100 blocks before latest
   - Dedupe will handle overlap
   - Better safe than miss events

---

## Best Practices

### Planning

- [ ] Schedule switches during low-traffic periods
- [ ] Test in staging environment first
- [ ] Document last processed block before switch
- [ ] Have rollback plan ready

### Execution

- [ ] Stop source 1 completely before starting source 2
- [ ] Allow 30-second buffer between stops
- [ ] Monitor first 100 blocks after switch
- [ ] Verify dedupe counters are working

### Verification

- [ ] Check for duplicate events in logs
- [ ] Query Neo4j for duplicate nodes
- [ ] Compare event counts before/after
- [ ] Verify continuous block progression

### Documentation

- [ ] Record switch time and blocks
- [ ] Note any duplicates found
- [ ] Document rollback if performed
- [ ] Update runbook with lessons learned

---

## Monitoring Checklist

### During Switch

- [ ] WebSocket connections (SHiP)
- [ ] HTTP sink status (Substreams)
- [ ] Backend process status
- [ ] Log for errors/warnings
- [ ] Dedupe counter increments

### Post-Switch (First Hour)

- [ ] Block processing rate stable
- [ ] No error spike in logs
- [ ] Graph updates continuing
- [ ] Event storage growing normally
- [ ] No duplicate nodes created

### Post-Switch (First Day)

- [ ] Review all logs for anomalies
- [ ] Verify database integrity
- [ ] Check for missed blocks
- [ ] Confirm dedupe cache effectiveness

---

## References

- SHiP Mode Runbook: `ship-mode.md`
- Backfill Runbook: `backfill.md`
- Ingestion Handler: `backend/src/api/ingestion.js`
- Chain Source Manager: `backend/src/indexer/chainSourceManager.js`
- T6 Implementation Summary: `backend/docs/T6-SHIP-FALLBACK-SUMMARY.md`

---

**Version**: 1.0
**Last Updated**: 2026-01-03
**Maintained By**: Polaris DevOps Team
