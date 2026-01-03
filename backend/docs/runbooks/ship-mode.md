# Runbook: Running SHiP Mode

**Purpose**: Run Polaris chain ingestion using SHiP (State History Plugin) as the event source instead of Substreams.

**When to Use**:
- Substreams is unavailable or experiencing issues
- Direct access to node's State History Plugin
- Testing fallback ingestion path
- Cost optimization (no Pinax fees)

---

## Prerequisites

### Required Services

1. **Antelope Node with SHiP Enabled**
   - EOS/WAX/Telos node with State History Plugin
   - WebSocket endpoint accessible (default: `ws://localhost:8080`)
   - ABI serialization library if using binary format

2. **Backend Services**
   - Neo4j database running
   - Redis cache running
   - S3-compatible storage configured
   - Backend API server stopped (will run in SHiP mode)

3. **Configuration**
   - `CHAIN_SOURCE=ship` environment variable
   - `SHIP_URL` pointing to SHiP WebSocket endpoint
   - `CONTRACT_ACCOUNT` set to contract name (default: `polaris`)

### Environment Variables

```bash
# Chain source selection
export CHAIN_SOURCE=ship

# SHiP connection
export SHIP_URL=ws://localhost:8080
export CONTRACT_ACCOUNT=polaris
export START_BLOCK=0
export END_BLOCK=0xffffffff

# Database
export GRAPH_URI=bolt://localhost:7687
export GRAPH_USER=neo4j
export GRAPH_PASSWORD=your_password

# Storage
export REDIS_HOST=localhost
export REDIS_PORT=6379
export S3_BUCKET=polaris-events
```

---

## Step-by-Step Procedure

### 1. Verify SHiP Endpoint

```bash
# Test SHiP connection
wscat -c ws://localhost:8080

# Or with curl upgrade
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
  http://localhost:8080/
```

**Expected**: WebSocket connection established

**Troubleshooting**:
- Verify node has `state-history-plugin` enabled
- Check firewall allows port 8080
- Confirm node is synced to latest blocks

### 2. Configure Backend for SHiP Mode

```bash
cd /home/user/polaris-music/backend

# Create/update .env file
cat > .env << EOF
CHAIN_SOURCE=ship
SHIP_URL=ws://localhost:8080
CONTRACT_ACCOUNT=polaris
START_BLOCK=100000000
GRAPH_URI=bolt://localhost:7687
GRAPH_USER=neo4j
GRAPH_PASSWORD=your_password
REDIS_HOST=localhost
REDIS_PORT=6379
S3_BUCKET=polaris-events
EOF
```

### 3. Start Backend with SHiP Mode

```bash
cd backend

# Option A: Direct node execution
node src/api/server.js

# Option B: With npm script (if configured)
npm run start:ship

# Option C: Development mode
npm run dev
```

**Expected Output**:
```
Starting chain source: ship
Initializing SHiP event source: {
  url: 'ws://localhost:8080',
  contract: 'polaris',
  startBlock: 100000000
}
Connecting to SHiP at ws://localhost:8080
SHiP WebSocket connected
Requesting blocks from 100000000 to 4294967295
Processing block 100000000
✓ Posted event a1b2c3d4... (block 100000000, action: put)
SHiP Progress: Block 100000001, Blocks: 1, Events: 1
```

### 4. Monitor Ingestion

```bash
# Watch logs
tail -f logs/ship-ingestion.log

# Check ingestion statistics
curl http://localhost:3000/api/stats | jq .

# Query Neo4j for recent ingestions
cypher-shell -u neo4j -p password << EOF
MATCH (r:Release)
WHERE r.created_at > datetime() - duration({hours: 1})
RETURN r.name, r.id
ORDER BY r.created_at DESC
LIMIT 10;
EOF
```

### 5. Verify Events Are Processing

```bash
# Check event storage
curl http://localhost:3000/api/events/recent | jq .

# Verify dedupe is working (POST same event twice)
curl -X POST http://localhost:3000/api/ingest/anchored-event \
  -H "Content-Type: application/json" \
  -d @fixtures/test-event.json

# Second POST should return status: "duplicate"
```

---

## Monitoring

### Key Metrics

**SHiP Connection**:
- WebSocket connection status (connected/disconnected)
- Reconnection attempts
- Blocks processed per second
- Events extracted per block

**Ingestion Pipeline**:
- Events ingested (processed)
- Events deduped (duplicate)
- Processing errors
- Graph updates committed

**Performance**:
- Current block lag (blockchain head - current block)
- Events per second
- Memory usage
- Database connection pool

### Log Patterns

**Normal Operation**:
```
Processing block 100000123
✓ Event a1b2c3... processed (CREATE_RELEASE_BUNDLE)
SHiP Progress: Block 100000124, Blocks: 124, Events: 45
Ingestion stats: 45 processed, 3 deduped, 0 errors
```

**Warning Signs**:
```
⚠ Received binary message, skipping (implement ABI deserialization)
⚠ Action data is not JSON, skipping
⚠ Reconnecting in 3000ms (attempt 2/10)
```

**Error Conditions**:
```
✗ SHiP WebSocket error: Connection refused
✗ Error processing block: Unexpected end of JSON input
✗ Chain ingestion error: Neo4j connection lost
✗ Max reconnection attempts reached, stopping
```

---

## Common Issues and Solutions

### Issue: "Connection refused" to SHiP

**Symptoms**:
- Cannot connect to WebSocket
- Error: `ECONNREFUSED`

**Solutions**:
1. Verify SHiP is running: `netstat -an | grep 8080`
2. Check node config has `state-history-plugin` enabled
3. Verify firewall allows connections
4. Try alternative endpoint: `export SHIP_URL=ws://127.0.0.1:8080`

### Issue: "Received binary message, skipping"

**Symptoms**:
- Events not being extracted
- Warning about binary format

**Solutions**:
1. SHiP is sending binary ABI-serialized data
2. Implement ABI deserialization (requires `eosjs` library)
3. Request JSON format from SHiP (if supported)
4. Configure node to send JSON format

### Issue: High block lag (falling behind)

**Symptoms**:
- Current block significantly behind chain head
- Processing slows over time

**Solutions**:
1. Increase `max_messages_in_flight` in SHiP request
2. Optimize Neo4j queries (add indexes)
3. Use batch event ingestion
4. Scale backend horizontally

### Issue: Memory usage growing

**Symptoms**:
- Node process memory increases continuously
- Eventually crashes with OOM

**Solutions**:
1. Clear dedupe caches periodically
2. Use Redis for dedupe instead of in-memory Set
3. Implement cache size limits (LRU eviction)
4. Restart process periodically (cron job)

### Issue: Duplicate events after restart

**Symptoms**:
- Same events processed twice
- Graph shows duplicate entries

**Solutions**:
1. Verify `START_BLOCK` is set correctly after restart
2. Use storage-based dedupe (not just in-memory)
3. Track last processed block in persistent storage
4. Clean up test data between runs

---

## Performance Tuning

### SHiP Configuration

```javascript
// In shipEventSource.js
const request = {
    start_block_num: this.currentBlock,
    end_block_num: this.config.endBlock,
    max_messages_in_flight: 10,  // Increase for faster streaming
    irreversible_only: true,      // Only final blocks (recommended)
    fetch_traces: true,
    fetch_deltas: false           // Disable if not needed
};
```

### Backend Configuration

```bash
# Increase connection pool sizes
export NEO4J_POOL_SIZE=50
export REDIS_POOL_SIZE=20

# Enable batch processing
export BATCH_SIZE=100
export BATCH_TIMEOUT=5000

# Adjust dedupe cache sizes
export DEDUPE_CACHE_SIZE=10000
```

### Database Optimization

```cypher
// Create indexes for faster lookups
CREATE INDEX release_created_at IF NOT EXISTS FOR (r:Release) ON (r.created_at);
CREATE INDEX track_title IF NOT EXISTS FOR (t:Track) ON (t.title);
CREATE INDEX person_name IF NOT EXISTS FOR (p:Person) ON (p.name);
```

---

## Stopping SHiP Mode

### Graceful Shutdown

```bash
# Send SIGTERM to allow cleanup
kill -TERM <pid>

# Or use Ctrl+C if running in foreground
```

**Expected**:
```
Stopping chain source: ship
SHiP event source stopped
SHiP WebSocket closed
Server stopped gracefully
```

### Force Stop (if hung)

```bash
# Force kill
kill -KILL <pid>

# Clean up state
rm -f /tmp/ship-*.lock
```

### Verify Cleanup

```bash
# Check no lingering processes
ps aux | grep ship

# Verify WebSocket closed
netstat -an | grep 8080

# Check last processed block
curl http://localhost:3000/api/stats | jq .currentBlock
```

---

## Recovery Procedures

### Scenario: Lost Connection to SHiP

1. **Auto-reconnect** will try up to 10 times
2. If reconnect fails, manually restart
3. Set `START_BLOCK` to last processed block
4. Resume ingestion

### Scenario: Database Connection Lost

1. SHiP mode will error out
2. Fix database connection
3. Restart SHiP mode with last processed block
4. Dedupe will prevent re-processing

### Scenario: Corrupt State

1. Stop SHiP mode
2. Clear in-memory caches (restart)
3. Verify storage integrity
4. Resume from known good block

---

## Maintenance

### Daily Tasks

- [ ] Check logs for errors
- [ ] Verify block lag is acceptable (<1000 blocks)
- [ ] Monitor disk space (event storage)
- [ ] Review ingestion statistics

### Weekly Tasks

- [ ] Clear old logs
- [ ] Review Neo4j query performance
- [ ] Update `START_BLOCK` in config
- [ ] Test failover to Substreams

### Monthly Tasks

- [ ] Review dedupe cache efficiency
- [ ] Optimize database indexes
- [ ] Test full recovery from backup
- [ ] Update SHiP endpoint if needed

---

## References

- SHiP Plugin Documentation: https://github.com/EOSIO/eosio.contracts/blob/master/docs/05_state-history-plugin.md
- Antelope WebSocket Protocol: https://developers.eos.io/manuals/eos/latest/nodeos/plugins/state_history_plugin/
- Backend Ingestion Endpoint: `backend/src/api/ingestion.js`
- SHiP Event Source: `backend/src/indexer/shipEventSource.js`
- Source Switching Runbook: `source-switching.md`

---

**Version**: 1.0
**Last Updated**: 2026-01-03
**Maintained By**: Polaris DevOps Team
