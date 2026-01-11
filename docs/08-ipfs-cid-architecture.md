# IPFS CID Architecture for Polaris Music Registry

## Overview

The Polaris Music Registry uses a **dual CID system** for event storage and retrieval. This architecture provides both cryptographic verification (via canonical CID) and fast retrieval (via event CID) while maintaining backward compatibility.

## The Dual CID System

### 1. Canonical CID (`canonical_cid`)

**Purpose**: Cryptographic verification and hash derivability

**Content**: Canonical event JSON **without signature**
- Ensures deterministic hashing
- Matches the blockchain-anchored SHA256 hash
- Enables verification without signature

**Storage Format**:
```javascript
{
  v: 1,
  type: 'CREATE_RELEASE_BUNDLE',
  author_pubkey: 'PUB_K1_...',
  created_at: 1700000000,
  parents: [],
  body: { /* event data */ },
  proofs: { /* source links */ }
  // NOTE: No 'sig' field
}
```

**IPFS Storage**:
- CIDv1 with raw codec (`bafkrei...`)
- SHA2-256 multihash
- Pinned to prevent garbage collection

**Use Cases**:
- Verify event content matches blockchain hash
- Derive CID from hash without Redis cache
- IPFS-only verification mode

### 2. Event CID (`event_cid`)

**Purpose**: Fast retrieval and blockchain anchoring

**Content**: Full event JSON **with signature**
- Complete event for auditability
- Includes cryptographic signature
- Ready for immediate processing

**Storage Format**:
```javascript
{
  v: 1,
  type: 'CREATE_RELEASE_BUNDLE',
  author_pubkey: 'PUB_K1_...',
  created_at: 1700000000,
  parents: [],
  body: { /* event data */ },
  proofs: { /* source links */ },
  sig: 'SIG_K1_...'  // SIGNATURE INCLUDED
}
```

**IPFS Storage**:
- CIDv1 with raw codec (`bafkrei...`)
- SHA2-256 multihash
- Pinned to prevent garbage collection

**Use Cases**:
- **Blockchain anchoring** (stored on-chain in `put` action)
- **Fast ingestion** (direct IPFS retrieval without hash derivation)
- **Signature verification** (full signed event available)

## Architecture Flow

### Event Submission Flow

```
┌──────────────┐
│  Frontend    │
└──────┬───────┘
       │ 1. Prepare event (normalized)
       ▼
┌──────────────┐
│   Backend    │  2. Calculate hash
│   API        │  3. Sign event
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────┐
│       EventStore.storeEvent()        │
│                                      │
│  ┌───────────────────────────────┐  │
│  │ IPFS Storage (Parallel)       │  │
│  │                               │  │
│  │ • Canonical bytes → CID₁      │  │
│  │ • Full event JSON → CID₂      │  │
│  └───────────────────────────────┘  │
│                                      │
│  ┌───────────────────────────────┐  │
│  │ S3 Storage (Backup)           │  │
│  │ • Full event JSON             │  │
│  └───────────────────────────────┘  │
│                                      │
│  ┌───────────────────────────────┐  │
│  │ Redis Cache (Hot data)        │  │
│  │ • Full event JSON (24h TTL)   │  │
│  └───────────────────────────────┘  │
└──────────────┬───────────────────────┘
               │
               ▼
       ┌───────────────┐
       │   Returns:    │
       │ • hash        │
       │ • canonical_cid (CID₁)
       │ • event_cid (CID₂)    │  ← CRITICAL for blockchain!
       │ • s3         │
       │ • redis      │
       └───────┬───────┘
               │
               ▼
       ┌──────────────┐
       │  Frontend    │  4. Build blockchain action
       └──────┬───────┘
               │
               ▼
       ┌──────────────────────────┐
       │  Blockchain Put Action   │
       │                          │
       │  author: "alice"         │
       │  type: 21                │
       │  hash: 0x1234...         │ ← SHA256 of canonical event
       │  event_cid: "bafk..."    │ ← CID₂ for retrieval
       │  parent: null            │
       │  ts: 1700000000          │
       │  tags: ["release"]       │
       └──────────────────────────┘
```

### Event Ingestion Flow

```
┌──────────────┐
│ Blockchain   │  1. Read anchored event
│  Indexer     │     (Substreams, SHiP)
└──────┬───────┘
       │
       ▼
┌──────────────────────┐
│ Extract from chain:  │
│ • hash               │
│ • event_cid          │ ← NEW: Direct CID retrieval!
│ • author, type, etc. │
└──────┬───────────────┘
       │
       ▼
┌────────────────────────────────────────┐
│   IngestionHandler.processPutAction()  │
│                                        │
│   if (event_cid) {                    │
│     // NEW PATH: Fast IPFS retrieval  │
│     try {                             │
│       event = retrieveByEventCid(cid) │ ← Direct, no hash→CID derivation
│     } catch (ipfsError) {             │
│       // Fallback to hash retrieval   │
│       event = retrieveEvent(hash)     │
│     }                                 │
│   } else {                            │
│     // LEGACY: Hash-based retrieval   │
│     event = retrieveEvent(hash)       │ ← Derive CID or use S3
│   }                                   │
└────────┬───────────────────────────────┘
         │
         ▼
┌─────────────────┐
│ EventProcessor  │  2. Process event
│ (Graph update)  │     Update Neo4j
└─────────────────┘
```

## Benefits of Dual CID System

### 1. **Performance**
- **Fast Retrieval**: Direct CID lookup skips hash→CID derivation step
- **Parallel Storage**: Canonical and full events stored simultaneously
- **No Cache Dependency**: Can retrieve directly from IPFS without Redis

### 2. **Reliability**
- **Graceful Degradation**: Falls back to hash-based retrieval if IPFS fails
- **Multiple Storage Layers**: IPFS + S3 + Redis redundancy
- **Backward Compatible**: Legacy events without `event_cid` still work

### 3. **Security**
- **Verification**: Canonical CID proves content matches blockchain hash
- **Auditability**: Full event with signature available for verification
- **Immutability**: Both CIDs are content-addressed (tamper-proof)

### 4. **Decentralization**
- **IPFS-First**: Primary storage is decentralized
- **S3 Optional**: Can run fully on IPFS if S3 disabled
- **Public Gateway Compatible**: Events can be retrieved from public IPFS gateways

## Storage Layer Implementation

### EventStore API

```javascript
// Store event (returns both CIDs)
const result = await eventStore.storeEvent(signedEvent);
// {
//   hash: '1234abcd...',
//   canonical_cid: 'bafkreiabc123...',  // Canonical event (no sig)
//   event_cid: 'bafkreixyz789...',      // Full event (with sig)
//   s3: 's3://bucket/events/12/1234...',
//   redis: true
// }

// Retrieve by event_cid (NEW - fast path)
const event = await eventStore.retrieveByEventCid('bafkreixyz789...');

// Retrieve by hash (legacy - still works)
const event = await eventStore.retrieveEvent('1234abcd...');
```

### IPFS Storage Details

**Block Format**: Raw blocks with SHA2-256 multihash
```
Format:    raw (0x55)
Hash:      sha2-256 (0x12)
Version:   CIDv1
Encoding:  base32 (starts with 'bafkrei...')
```

**Deterministic CIDs**:
- Same content → same CID (content-addressed)
- Canonical event always produces same `canonical_cid`
- Full event always produces same `event_cid`

**Pinning**:
- Both CIDs are pinned on storage
- Prevents garbage collection
- Ensures long-term availability

## Error Handling

### IPFS Node Downtime

**Problem**: IPFS daemon unavailable or slow

**Solution**: Automatic fallback chain
```javascript
try {
  // Try IPFS first (fast)
  event = await retrieveByEventCid(event_cid);
} catch (ipfsError) {
  // Fall back to hash-based retrieval
  // (tries CID derivation, then S3)
  event = await retrieveEvent(hash);
}
```

**User Experience**:
- Transparent failover
- Logged warnings for monitoring
- No data loss or service interruption

### IPFS Content Not Found

**Problem**: CID not pinned or IPFS out of sync

**Error Message**:
```
Event not found in IPFS. CID: bafkrei...
The event may not be pinned or IPFS node may be out of sync.
```

**Resolution**:
1. Check IPFS pin status: `ipfs pin ls | grep <cid>`
2. Re-pin if needed: `ipfs pin add <cid>`
3. Or retrieve from S3 backup

### IPFS Timeout

**Problem**: IPFS retrieval taking too long

**Error Message**:
```
IPFS retrieval timeout for CID: bafkrei...
IPFS node may be slow or unavailable. Try again later.
```

**Resolution**:
1. Check IPFS node health
2. Fallback to S3 automatically engaged
3. Consider IPFS gateway configuration

## Smart Contract Integration

### Anchor Table Schema

```cpp
TABLE anchor {
    uint64_t    id;
    name        author;
    uint8_t     type;
    checksum256 hash;           // SHA256 of canonical event
    std::string event_cid;      // IPFS CID of full event (NEW!)
    std::optional<checksum256> parent;
    uint32_t    ts;
    std::vector<name> tags;
    uint32_t    expires_at;
    bool        finalized;
    uint64_t    escrowed_amount;
    uint64_t    submission_x;
};
```

### Put Action Signature

```cpp
ACTION put(
    name author,
    uint8_t type,
    checksum256 hash,
    std::string event_cid,  // REQUIRED!
    std::optional<checksum256> parent,
    uint32_t ts,
    std::vector<name> tags
)
```

**Validation**:
```cpp
check(!event_cid.empty(), "Event CID is required");
check(event_cid.length() < 200, "Event CID too long (max 200 chars)");
```

## Migration Path

### Backward Compatibility

**Legacy Events** (before dual CID):
- Stored with only `hash` (no `event_cid`)
- Ingestion falls back to hash-based retrieval
- Still fully functional

**New Events** (with dual CID):
- Stored with both `hash` and `event_cid`
- Ingestion uses fast CID retrieval
- Falls back if IPFS unavailable

### Transition Strategy

1. **Phase 1**: Deploy dual CID storage (✅ Complete)
   - Backend stores both CIDs
   - Smart contract accepts `event_cid`
   - Frontend sends `event_cid`

2. **Phase 2**: Monitor and optimize
   - Track IPFS retrieval success rate
   - Monitor fallback usage
   - Tune IPFS node configuration

3. **Phase 3**: Full IPFS-first mode (future)
   - Disable S3 for cost savings
   - Run purely on IPFS
   - Use public gateways as fallback

## Monitoring and Metrics

### Storage Metrics

```javascript
const stats = eventStore.getStats();
// {
//   stored: 1000,           // Total events stored
//   retrieved: 5000,        // Total retrievals
//   cacheHits: 4500,        // Redis cache hits
//   cacheMisses: 500,       // Cache misses (IPFS/S3)
//   ipfsStores: 2000,       // IPFS storage ops (2x per event)
//   s3Stores: 1000,         // S3 backups
//   errors: 5,              // Storage errors
//   cacheHitRate: '90.00%'  // Performance metric
// }
```

### Health Checks

**IPFS Health**:
```bash
# Check IPFS daemon
ipfs id

# Check pin count
ipfs pin ls --type=recursive | wc -l

# Check repo size
ipfs repo stat
```

**EventStore Connectivity**:
```javascript
const health = await eventStore.testConnectivity();
// {
//   ipfs: true,   // IPFS daemon reachable
//   s3: true,     // S3 accessible
//   redis: true   // Redis connected
// }
```

## Best Practices

### For Developers

1. **Always use event_cid** when submitting to blockchain
2. **Handle IPFS failures** with try/catch and fallbacks
3. **Pin important events** to ensure availability
4. **Monitor storage metrics** for performance issues
5. **Test with IPFS disabled** to ensure S3 fallback works

### For Operators

1. **Keep IPFS daemon healthy** (restart if issues)
2. **Monitor pin count** (don't exceed capacity)
3. **Configure garbage collection** carefully
4. **Set up IPFS cluster** for redundancy
5. **Use public gateways** as last resort

### For Users

1. **Event CID is proof of storage** - save it!
2. **Canonical CID verifies integrity** - check hash match
3. **Both CIDs are permanent** - content-addressed
4. **IPFS may be slow** - be patient or use S3 fallback

## Troubleshooting

### Event not retrievable by event_cid

**Symptoms**: `retrieveByEventCid()` fails

**Checks**:
1. Is IPFS daemon running? `ipfs id`
2. Is event pinned? `ipfs pin ls <cid>`
3. Is IPFS in sync? Check peer count
4. Try S3 fallback manually

**Fix**:
```bash
# Re-pin the CID
ipfs pin add <event_cid>

# Or retrieve from S3 and re-add
curl <s3_url> | ipfs add --cid-version=1 --raw-leaves
```

### Canonical CID doesn't match hash

**Symptoms**: Verification error on retrieval

**Cause**: Canonicalization mismatch

**Fix**:
1. Check that canonical event excludes `sig`
2. Verify JSON serialization is deterministic
3. Ensure hash uses same algorithm (SHA256)

### High IPFS error rate

**Symptoms**: Many fallbacks to S3

**Checks**:
1. IPFS daemon logs: `ipfs log tail`
2. Disk space: `df -h`
3. Network connectivity: `ipfs swarm peers`

**Fix**:
- Restart IPFS daemon
- Increase storage limit
- Add more IPFS peers

## Future Enhancements

1. **IPFS Cluster**: Multi-node redundancy
2. **Public Gateway Fallback**: Use ipfs.io or others
3. **IPNS Integration**: Mutable pointers to CIDs
4. **DAG-JSON Format**: More efficient than raw blocks
5. **Filecoin Integration**: Long-term archival storage

## References

- [IPFS Specifications](https://github.com/ipfs/specs)
- [CID Specification](https://github.com/multiformats/cid)
- [Multihash Specification](https://github.com/multiformats/multihash)
- [Content Addressing Guide](https://docs.ipfs.tech/concepts/content-addressing/)

---

**Document Version**: 1.0
**Last Updated**: 2025-01-11
**Status**: Production
