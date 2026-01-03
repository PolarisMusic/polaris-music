# Chain Ingestion with Substreams (T5)

This document describes how to run the complete Substreams-based chain ingestion pipeline that extracts events from the blockchain and ingests them into the Polaris backend.

## Architecture

```
┌─────────────────────┐
│  Antelope Chain     │
│  (EOS/WAX/Telos)    │
└──────────┬──────────┘
           │ Firehose
           ▼
┌─────────────────────┐
│    Substreams       │
│  map_anchored_events│
└──────────┬──────────┘
           │ AnchoredEvents (protobuf)
           ▼
┌─────────────────────┐
│   HTTP Sink         │
│  (http-sink.js)     │
└──────────┬──────────┘
           │ HTTP POST
           ▼
┌─────────────────────┐
│  Backend Ingestion  │
│  POST /api/ingest/  │
│   anchored-event    │
└──────────┬──────────┘
           │
           ├─► Event Storage (S3+Redis)
           ├─► Signature Verification
           ├─► ReleaseBundle Validation
           └─► Neo4j Graph Update
```

## Prerequisites

### Required Tools

1. **Substreams CLI**
   ```bash
   brew install streamingfast/tap/substreams
   # OR download from https://github.com/streamingfast/substreams/releases
   ```

2. **Rust Toolchain** (for building)
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   rustup target add wasm32-unknown-unknown
   ```

3. **Node.js 18+** (for HTTP sink)
   ```bash
   node --version  # Should be 18.x or higher
   ```

4. **Pinax API Key**
   - Sign up at https://app.pinax.network
   - Get API key for Firehose access

### Required Services

1. **Neo4j Database** (running on localhost:7687 or configured endpoint)
2. **Redis** (running on localhost:6379 for event cache)
3. **S3-compatible storage** (for event persistence)
4. **Backend API Server** (running on localhost:3000)

## Quick Start

### 1. Build Substreams Module

```bash
cd substreams
make build
```

This generates:
- Protobuf bindings from `proto/polaris.proto`
- WASM module from Rust source
- Output: `target/wasm32-unknown-unknown/release/polaris_substreams.wasm`

### 2. Set API Token

```bash
export SUBSTREAMS_API_TOKEN="your_pinax_api_key"
```

### 3. Start Backend Server

In a separate terminal:

```bash
cd backend
npm install
npm run dev
```

Backend should be running on http://localhost:3000

Verify with:
```bash
curl http://localhost:3000/api/health
```

### 4. Run Chain Ingestion

From the `substreams/sink` directory:

```bash
cd sink
npm install  # Install node-fetch dependency
node http-sink.js --endpoint=http://localhost:3000
```

This will:
1. Stream anchored events from Substreams
2. Post each event to `POST /api/ingest/anchored-event`
3. Display ingestion statistics in real-time

## Configuration

### Environment Variables

**Substreams:**
- `SUBSTREAMS_API_TOKEN` - Pinax API token (required)
- `SUBSTREAMS_ENDPOINT` - Firehose endpoint (default: `eos.firehose.pinax.network:443`)
- `START_BLOCK` - Starting block number (default: latest - 1000)
- `CONTRACT_ACCOUNT` - Contract account name (default: `polaris`)

**HTTP Sink:**
- `BACKEND_URL` - Backend ingestion endpoint (default: `http://localhost:3000`)

**Backend:**
- `GRAPH_URI` - Neo4j URI (default: `bolt://localhost:7687`)
- `GRAPH_USER` - Neo4j username (default: `neo4j`)
- `GRAPH_PASSWORD` - Neo4j password
- `REDIS_HOST` - Redis host (default: `localhost`)
- `REDIS_PORT` - Redis port (default: `6379`)
- `S3_BUCKET` - S3 bucket for events (default: `polaris-events`)

### Command-Line Options

```bash
node http-sink.js \
  --endpoint=http://localhost:3000 \
  --contract=polaris \
  --start-block=100000000
```

## AnchoredEvent Format

Events emitted by Substreams have the following structure:

```typescript
interface AnchoredEvent {
  event_hash: string;           // SHA256 hash of payload
  payload: Buffer | string;     // Raw event JSON
  block_num: number;            // Block number
  block_id: string;             // Block ID (hex)
  trx_id: string;               // Transaction ID (hex)
  action_ordinal: number;       // Action index in transaction
  timestamp: number;            // Block timestamp (Unix seconds)
  source: string;               // "substreams-eos"
  contract_account: string;     // "polaris"
  action_name: string;          // "put", "vote", "finalize"
}
```

## Event Types Supported

### Primary: CREATE_RELEASE_BUNDLE (from `put` action)

Full implementation for T5:
- Validates ReleaseBundle schema (T3)
- Stores event in S3 + Redis (T2)
- Ingests into Neo4j graph
- Creates Release, Track, Group, Person nodes

**Status**: ✅ Fully implemented

### De-scoped: VOTE (from `vote` action)

**Status**: ⚠️ De-scoped for T5

Votes are ingested but not processed. Vote handling requires:
- Respect weight lookup from blockchain tables
- Vote aggregation and score calculation
- Integration with finalization logic

**Current Behavior**: Event is stored but returns status `de-scoped`.

**TODO (Future)**: Implement vote processing
- Query Respect values from chain state
- Store votes in graph with weight
- Update submission approval scores

### De-scoped: FINALIZE (from `finalize` action)

**Status**: ⚠️ De-scoped for T5

Finalization events are ingested but not processed. Finalization requires:
- Vote aggregation and approval calculation
- Reward distribution logic
- Provisional → Canonical ID promotion

**Current Behavior**: Event is stored but returns status `de-scoped`.

**TODO (Future)**: Implement finalization
- Calculate approval percentage from votes
- Update submission status (accepted/rejected)
- Trigger reward distribution
- Promote provisional IDs if accepted

See `backend/src/api/ingestion.js` for implementation details and TODOs.

## Testing Locally

### 1. Test with Fixture Data

Use the included test suite:

```bash
cd backend
npm test -- --testPathPattern="ingestion"
```

Tests verify:
- Event deduplication by eventHash
- Signature verification (blockchain-verified)
- ReleaseBundle validation
- Graph updates (mocked)

### 2. Test Against Testnet

Point Substreams at Jungle4 testnet:

```bash
export SUBSTREAMS_ENDPOINT="jungle4.firehose.pinax.network:443"
export CONTRACT_ACCOUNT="your-test-contract"
export START_BLOCK="1000"  # Early testnet block

cd substreams/sink
node http-sink.js
```

### 3. Manual Event Submission

Test the ingestion endpoint directly:

```bash
curl -X POST http://localhost:3000/api/ingest/anchored-event \
  -H "Content-Type: application/json" \
  -d '{
    "event_hash": "test-hash-12345",
    "payload": "{\"author\":\"testuser\",\"type\":21,\"body\":{\"release\":{\"name\":\"Test\"},\"tracks\":[{\"title\":\"Track 1\"}],\"tracklist\":[{\"position\":\"1\",\"track_title\":\"Track 1\"}]}}",
    "block_num": 100000000,
    "block_id": "abcd1234",
    "trx_id": "trx123",
    "action_ordinal": 0,
    "timestamp": 1704067200,
    "source": "manual-test",
    "contract_account": "polaris",
    "action_name": "put"
  }'
```

Expected response (first time):
```json
{
  "status": "processed",
  "eventHash": "test-hash-12345",
  "eventType": "CREATE_RELEASE_BUNDLE",
  "blockNum": 100000000,
  "trxId": "trx123",
  "processing": { ... }
}
```

Expected response (duplicate):
```json
{
  "status": "duplicate",
  "eventHash": "test-hash-12345",
  "message": "Event already processed (deduplicated)"
}
```

## Monitoring

### HTTP Sink Statistics

The sink displays real-time statistics:

```
Polaris Substreams HTTP Sink
============================
Backend URL:        http://localhost:3000
Substreams Endpoint: eos.firehose.pinax.network:443
Contract Account:   polaris
Start Block:        0

✓ Posted event a1b2c3d4... (block 100000000, action: put)
✓ Posted event e5f6g7h8... (block 100000001, action: put)
✗ Failed to post event i9j0k1l2... HTTP 500: Internal Server Error
  Retrying in 2000ms (attempt 2/5)...
✓ Posted event i9j0k1l2... (block 100000002, action: put)

Statistics:
  Events received: 3
  Events posted:   3
  Events failed:   0
  Retries:         1
```

### Backend Logs

Monitor backend ingestion:

```bash
cd backend
npm run dev
# Watch for:
# - "Chain ingestion: processed event <hash>"
# - "Event already processed (deduplicated)"
# - "Chain ingestion error: ..."
```

### Neo4j Verification

Query ingested data:

```cypher
// Check recent releases
MATCH (r:Release)
WHERE r.id STARTS WITH 'prov:'
RETURN r.name, r.release_date
ORDER BY r.created_at DESC
LIMIT 10;

// Check tracks
MATCH (t:Track)-[:IN_RELEASE]->(r:Release)
RETURN t.title, r.name
LIMIT 10;
```

## Troubleshooting

### "Failed to connect to endpoint"

**Solution**: Verify Substreams API token and endpoint

```bash
echo $SUBSTREAMS_API_TOKEN
substreams info -e eos.firehose.pinax.network:443
```

### "Backend connection refused"

**Solution**: Ensure backend is running

```bash
# Check backend is running
curl http://localhost:3000/api/health

# Restart backend if needed
cd backend && npm run dev
```

### "Event validation failed"

**Solution**: Check ReleaseBundle schema compliance

See `backend/src/schema/releaseBundle.schema.json` for canonical schema.

Common issues:
- Missing required fields (name, tracks, tracklist)
- Empty arrays where minItems: 1
- Unknown fields not in schema

### "Duplicate event" every time

**Solution**: Restart ingestion handler to clear cache

```bash
# Stop http-sink.js (Ctrl+C)
# Restart
node http-sink.js
```

For persistent dedupe, implement Redis-based cache (see TODO in ingestion.js).

### High retry count

**Solution**: Check backend capacity and errors

- Backend may be overloaded (increase resources)
- Database connection issues (check Neo4j/Redis)
- Event validation errors (check logs)

## Performance Considerations

### Throughput

- **Substreams**: ~1000 blocks/second (parallel processing)
- **HTTP Sink**: ~100 events/second (sequential POSTs)
- **Backend Ingestion**: ~50 events/second (graph writes)

Bottleneck is typically backend graph writes.

### Optimization

1. **Batch Events**: Modify sink to batch multiple events per POST (TODO)
2. **Parallel Ingestion**: Run multiple sink instances with block ranges
3. **Dedupe Cache**: Use Redis for distributed deduplication (TODO)
4. **Graph Writes**: Use Neo4j batch transactions

### Resource Requirements

For historical sync of 1M blocks:

- **CPU**: 4+ cores
- **Memory**: 8GB+ RAM
- **Network**: High-bandwidth connection to Firehose
- **Storage**: 100GB+ for event storage

## Development

### Modifying AnchoredEvent Schema

1. Edit `proto/polaris.proto`
2. Rebuild Substreams: `make build`
3. Update ingestion handler: `backend/src/api/ingestion.js`
4. Update tests: `backend/test/api/ingestion.test.js`

### Adding New Action Types

1. Add action filter in `src/lib.rs` `map_anchored_events`
2. Implement handler in `backend/src/api/ingestion.js`
3. Add event type mapping in `reconstructEventFromPayload`
4. Add tests

### Debugging Substreams

```bash
# Verbose output
export SUBSTREAMS_LOG_LEVEL=debug
substreams run -v map_anchored_events --start-block 100000000 --stop-block +10

# Inspect protobuf output
substreams run map_anchored_events \
  --start-block 100000000 \
  --stop-block +1 \
  --output jsonl
```

## Production Deployment

### Recommended Setup

1. **Substreams**: Run on dedicated server/container
2. **HTTP Sink**: Deploy as background service with restart policy
3. **Backend**: Scale horizontally with load balancer
4. **Database**: Neo4j cluster for high availability
5. **Storage**: S3 with replication for event durability

### Monitoring

- **Metrics**: Track events/sec, errors, retries
- **Alerts**: Backend downtime, high error rate
- **Logging**: Centralized logs (ELK, CloudWatch)

### Disaster Recovery

- Event storage in S3 is immutable and durable
- To rebuild graph: Replay all events from S3
- Substreams can restart from any block (idempotent)

## References

- Substreams Documentation: https://substreams.streamingfast.io/
- Pinax Network: https://pinax.network/
- T5 Specification: See main repo docs
- Backend Ingestion: `backend/src/api/ingestion.js`
- Event Processor: `backend/src/indexer/eventProcessor.js`

## Support

For issues:
- Substreams errors: Check Pinax Discord
- Backend errors: Check backend logs and Neo4j
- Schema validation: See `backend/src/schema/releaseBundle.schema.json`

## TODO

Future enhancements:

- [ ] Implement VOTE event processing
- [ ] Implement FINALIZE event processing
- [ ] Add LIKE event support
- [ ] Redis-based dedupe cache for distributed ingestion
- [ ] Batch event ingestion endpoint
- [ ] Metrics and monitoring dashboards
- [ ] Automatic retry with exponential backoff in backend
- [ ] Event replay tool for rebuilding graph
