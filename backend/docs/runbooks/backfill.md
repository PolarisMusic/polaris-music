# Runbook: Backfilling Block Range

**Purpose**: Re-ingest events from a specific block range to recover from data loss or fill gaps.

**Safety**: Dedupe ensures idempotent ingestion - safe to re-process blocks.

---

## Use Cases

### When to Backfill

1. **Data Loss**: Database corruption or deletion
2. **Missed Blocks**: Source downtime created gaps
3. **Schema Migration**: Need to reprocess with new schema
4. **Bug Fixes**: Fixed event processing bug, need to reprocess
5. **Testing**: Verify ingestion with known block range

### When NOT to Backfill

- Regular operation (use continuous streaming)
- Blocks already processed (dedupe will reject)
- Without backup (always backup first)

---

## Prerequisites

### Required Information

- [ ] Start block number
- [ ] End block number (or "latest")
- [ ] Source to use (Substreams or SHiP)
- [ ] Reason for backfill (document)
- [ ] Expected event count (estimate)

### Pre-Backfill Checklist

- [ ] Database backup completed
- [ ] Event storage backup completed
- [ ] Verify source is operational
- [ ] Check disk space (storage + database)
- [ ] Estimate time required
- [ ] Schedule maintenance window

---

## Backfill Procedures

### Method 1: Substreams Backfill

**Best For**: Large block ranges (>10,000 blocks)

**Steps**:

1. **Calculate Block Range**

   ```bash
   START_BLOCK=100000000
   END_BLOCK=100010000
   BLOCK_COUNT=$((END_BLOCK - START_BLOCK))

   echo "Backfilling $BLOCK_COUNT blocks"
   ```

2. **Estimate Time**

   ```bash
   # Substreams: ~1000 blocks/second
   SECONDS=$((BLOCK_COUNT / 1000))
   MINUTES=$((SECONDS / 60))

   echo "Estimated time: $MINUTES minutes"
   ```

3. **Stop Current Ingestion** (Optional)

   ```bash
   # If continuous ingestion is running
   pm2 stop backend
   kill -TERM <http-sink-pid>
   ```

4. **Run Backfill**

   ```bash
   cd /home/user/polaris-music/substreams/sink

   export SUBSTREAMS_API_TOKEN="your_token"
   export START_BLOCK=100000000
   export BACKEND_URL=http://localhost:3000

   # Run sink with specific block range
   node http-sink.js --start-block=$START_BLOCK --end-block=$END_BLOCK

   # Or using substreams directly
   substreams run \
     -e eos.firehose.pinax.network:443 \
     ./substreams.yaml \
     map_anchored_events \
     -p map_anchored_events="polaris" \
     --start-block $START_BLOCK \
     --stop-block $END_BLOCK \
     --output jsonl | \
     while read line; do
       # POST each event to backend
       echo "$line" | jq -r '.["@data"].events[]' | \
       while read event; do
         curl -X POST http://localhost:3000/api/ingest/anchored-event \
           -H "Content-Type: application/json" \
           -d "$event"
       done
     done
   ```

5. **Monitor Progress**

   ```bash
   # Watch logs
   tail -f logs/backfill.log

   # Check statistics
   watch -n 10 'curl -s http://localhost:3000/api/stats | jq .eventsIngested'
   ```

6. **Verify Completion**

   ```bash
   # Check last processed block
   curl http://localhost:3000/api/events/recent | \
     jq '.[0].blockchain_metadata.block_num'

   # Should be >= END_BLOCK
   ```

7. **Resume Normal Operation**

   ```bash
   # If stopped, restart continuous ingestion
   pm2 start backend
   ```

---

### Method 2: SHiP Backfill

**Best For**: Recent blocks (<10,000), self-hosted

**Steps**:

1. **Configure SHiP for Range**

   ```bash
   cd /home/user/polaris-music/backend

   export CHAIN_SOURCE=ship
   export SHIP_URL=ws://localhost:8080
   export START_BLOCK=100000000
   export END_BLOCK=100001000
   ```

2. **Start Backfill**

   ```bash
   node -e "
   const { ChainSourceManager } = require('./src/indexer/chainSourceManager.js');
   const config = {
     chainSource: 'ship',
     shipUrl: process.env.SHIP_URL,
     contractAccount: 'polaris',
     startBlock: parseInt(process.env.START_BLOCK),
     endBlock: parseInt(process.env.END_BLOCK)
   };

   const manager = new ChainSourceManager(config, ingestionHandler);
   manager.start();
   " > logs/backfill-ship.log 2>&1 &
   ```

3. **Monitor Progress**

   ```bash
   tail -f logs/backfill-ship.log | grep "Processing block"
   ```

4. **Auto-Stop at End Block**

   SHiP will automatically stop when reaching END_BLOCK

---

### Method 3: Manual Backfill (Small Ranges)

**Best For**: <100 blocks, specific events, testing

**Steps**:

1. **Get Block Data**

   ```bash
   # Using cleos (if available)
   for block in $(seq 100000000 100000010); do
     cleos get block $block > block_$block.json
   done
   ```

2. **Extract Actions**

   ```bash
   # Extract polaris contract actions
   jq '.transactions[].trx.transaction.actions[] |
       select(.account == "polaris") |
       select(.name | IN("put", "vote", "finalize"))' \
     block_*.json > actions.json
   ```

3. **Create Anchored Events**

   ```bash
   # Transform to AnchoredEvent format
   jq -s 'map({
     event_hash: (.data | tostring | @base64),
     payload: (.data | tostring),
     block_num: .block_num,
     block_id: .block_id,
     trx_id: .trx_id,
     action_ordinal: .action_ordinal,
     timestamp: .timestamp,
     source: "manual-backfill",
     contract_account: .account,
     action_name: .name
   })' actions.json > anchored_events.json
   ```

4. **Ingest Events**

   ```bash
   jq -c '.[]' anchored_events.json | while read event; do
     curl -X POST http://localhost:3000/api/ingest/anchored-event \
       -H "Content-Type: application/json" \
       -d "$event"
     sleep 0.1  # Rate limit
   done
   ```

---

## Monitoring Backfill

### Progress Tracking

```bash
# Real-time progress
watch -n 5 '
  echo "Current Block: $(curl -s http://localhost:3000/api/stats | jq .currentBlock)"
  echo "Events Ingested: $(curl -s http://localhost:3000/api/stats | jq .eventsIngested)"
  echo "Events Deduped: $(curl -s http://localhost:3000/api/stats | jq .eventsDeduped)"
  echo ""
  echo "Last 5 Events:"
  curl -s http://localhost:3000/api/events/recent | jq -r ".[0:5] | .[] | .event_hash[0:16]"
'
```

### Performance Metrics

```bash
# Blocks per second
START_TIME=$(date +%s)
START_BLOCK=$(curl -s http://localhost:3000/api/stats | jq .currentBlock)

sleep 60

END_TIME=$(date +%s)
END_BLOCK=$(curl -s http://localhost:3000/api/stats | jq .currentBlock)

ELAPSED=$((END_TIME - START_TIME))
BLOCKS_PROCESSED=$((END_BLOCK - START_BLOCK))
BLOCKS_PER_SEC=$((BLOCKS_PROCESSED / ELAPSED))

echo "Blocks/sec: $BLOCKS_PER_SEC"
```

### Error Detection

```bash
# Watch for errors
tail -f logs/backfill.log | grep -i error

# Check error count
curl -s http://localhost:3000/api/stats | jq .errors
```

---

## Handling Issues

### Issue: Backfill Stalls

**Symptoms**:
- Block number not advancing
- No events being ingested
- High CPU usage

**Solutions**:

1. **Check Source Connection**
   ```bash
   # Substreams
   curl -i https://eos.firehose.pinax.network:443

   # SHiP
   wscat -c ws://localhost:8080
   ```

2. **Check Backend Health**
   ```bash
   curl http://localhost:3000/health
   ```

3. **Restart Backfill**
   ```bash
   # Stop current backfill
   kill -TERM <pid>

   # Resume from last processed block
   LAST_BLOCK=$(curl -s http://localhost:3000/api/stats | jq .currentBlock)
   export START_BLOCK=$((LAST_BLOCK + 1))

   # Restart
   node http-sink.js
   ```

### Issue: High Duplicate Rate

**Symptoms**:
- Most events returning "duplicate"
- Slow progress despite high event rate

**Explanation**: Blocks already processed (expected)

**Actions**:
- This is normal for re-backfilling
- Verify dedupe is working correctly
- Skip to next unprocessed block range

### Issue: Out of Disk Space

**Symptoms**:
- Write errors in logs
- Database errors
- Event storage failures

**Solutions**:

1. **Check Disk Usage**
   ```bash
   df -h
   du -sh /var/lib/neo4j
   du -sh /var/lib/redis
   ```

2. **Clear Old Logs**
   ```bash
   find logs -name "*.log" -mtime +7 -delete
   ```

3. **Archive Events**
   ```bash
   # Move old events to cold storage
   aws s3 sync s3://polaris-events s3://polaris-events-archive \
     --exclude "*" --include "2024-01-*"
   ```

4. **Increase Storage**
   - Add disk space
   - Or split backfill into smaller ranges

---

## Verification

### Data Integrity Checks

**1. Event Count**
```bash
# Expected events in range
EXPECTED_EVENTS=<calculate_from_blockchain>

# Actual events ingested
ACTUAL_EVENTS=$(curl -s http://localhost:3000/api/events/count?start_block=$START_BLOCK&end_block=$END_BLOCK)

echo "Expected: $EXPECTED_EVENTS"
echo "Actual: $ACTUAL_EVENTS"
echo "Difference: $((EXPECTED_EVENTS - ACTUAL_EVENTS))"
```

**2. Block Coverage**
```cypher
// Check for gaps in block coverage
MATCH (e:Event)
WHERE e.blockchain_metadata.block_num >= 100000000
  AND e.blockchain_metadata.block_num <= 100001000
RETURN min(e.blockchain_metadata.block_num) as min_block,
       max(e.blockchain_metadata.block_num) as max_block,
       count(DISTINCT e.blockchain_metadata.block_num) as block_count;

// Should show continuous coverage
```

**3. Event Types Distribution**
```cypher
MATCH (e:Event)
WHERE e.blockchain_metadata.block_num >= 100000000
  AND e.blockchain_metadata.block_num <= 100001000
RETURN e.type, count(*) as count
ORDER BY count DESC;
```

**4. Graph Consistency**
```cypher
// Verify all tracks have releases
MATCH (t:Track)
WHERE NOT (t)-[:IN_RELEASE]->(:Release)
RETURN count(t) as orphaned_tracks;

// Should be 0
```

---

## Rollback Backfill

If backfill introduced bad data:

### 1. Identify Bad Block Range

```bash
BAD_START=100005000
BAD_END=100005100
```

### 2. Delete Events from Range

```cypher
// WARNING: Destructive operation
MATCH (e:Event)
WHERE e.blockchain_metadata.block_num >= 100005000
  AND e.blockchain_metadata.block_num <= 100005100
DETACH DELETE e;
```

### 3. Delete Graph Nodes from Range

```cypher
// Delete releases created in bad range
MATCH (r:Release)
WHERE r.created_at >= datetime('2024-01-15T10:00:00')
  AND r.created_at <= datetime('2024-01-15T11:00:00')
DETACH DELETE r;
```

### 4. Clear Dedupe Cache

```bash
# Restart backend to clear in-memory caches
pm2 restart backend
```

### 5. Re-run Backfill

```bash
export START_BLOCK=$BAD_START
export END_BLOCK=$BAD_END

# Run backfill again
node http-sink.js
```

---

## Best Practices

### Before Backfill

- [ ] **Backup first** - Always
- [ ] **Test on small range** - Verify process works
- [ ] **Calculate estimates** - Time, disk, events
- [ ] **Schedule downtime** - If stopping live ingestion

### During Backfill

- [ ] **Monitor continuously** - First 1000 blocks closely
- [ ] **Check dedupe rate** - Should stabilize
- [ ] **Watch resources** - CPU, memory, disk
- [ ] **Log everything** - For post-mortem

### After Backfill

- [ ] **Verify data integrity** - Run checks
- [ ] **Compare counts** - Expected vs actual
- [ ] **Resume normal ops** - Switch back to streaming
- [ ] **Document results** - What worked, what didn't

---

## Common Scenarios

### Scenario 1: Fill 1-Day Gap

```bash
# Gap: 2024-01-15 (blocks 100,000,000 - 100,002,000)
export START_BLOCK=100000000
export END_BLOCK=100002000

# ~2000 blocks * 0.001s/block = ~2 seconds
# Plus network overhead = ~5 minutes total

cd substreams/sink
node http-sink.js
```

### Scenario 2: Reprocess Last Week

```bash
# Last week: ~604,800 seconds * 2 blocks/sec = ~1,209,600 blocks
CURRENT_BLOCK=$(curl -s http://localhost:3000/api/stats | jq .currentBlock)
START_BLOCK=$((CURRENT_BLOCK - 1209600))

export START_BLOCK
export END_BLOCK=$CURRENT_BLOCK

# ~1.2M blocks / 1000 blocks/sec = ~20 minutes
node http-sink.js
```

### Scenario 3: Full Historical Sync

```bash
# From contract deployment to current
export START_BLOCK=1  # Or deployment block
export END_BLOCK=0    # Latest

# This could take hours/days
# Consider splitting into chunks:
for start in $(seq 1 10000000 100000000); do
  end=$((start + 9999999))
  export START_BLOCK=$start
  export END_BLOCK=$end

  echo "Backfilling $start to $end"
  node http-sink.js

  # Verify chunk completed
  sleep 60
done
```

---

## References

- Substreams Documentation: https://substreams.streamingfast.io/
- SHiP Plugin: https://github.com/EOSIO/eosio.contracts/blob/master/docs/05_state-history-plugin.md
- Ingestion Endpoint: `backend/src/api/ingestion.js`
- Source Switching: `source-switching.md`
- SHiP Mode: `ship-mode.md`

---

**Version**: 1.0
**Last Updated**: 2026-01-03
**Maintained By**: Polaris DevOps Team
