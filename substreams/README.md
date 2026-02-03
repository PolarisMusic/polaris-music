# Polaris Music Registry - Substreams

This directory contains the Substreams module for indexing Polaris Music Registry events from Antelope blockchains (EOS, WAX, Telos, UX).

## Overview

**Substreams** is a powerful blockchain indexing technology that enables:
- **High-performance indexing** through parallelization
- **Composable data streams** for modular processing
- **Deterministic processing** with replay guarantees
- **Real-time and historical data** extraction

This Substreams module extracts and processes all Polaris smart contract events including:
- 📝 **Event Anchoring** (PUT) - Creating new submissions
- ✅ **Attestations** (ATTEST) - Verifying submissions
- 🗳️ **Voting** (VOTE) - Community voting on submissions
- 🏁 **Finalization** (FINALIZE) - Completing voting rounds
- 💰 **Staking** (STAKE/UNSTAKE) - Token staking on entities
- ❤️ **Likes** (LIKE/UNLIKE) - User preferences with path tracking
- 🏆 **Respect Updates** (UPDATE_RESPECT) - Fractally integration

## Architecture

```
┌─────────────────┐
│  Antelope Node  │
│  (EOS/WAX/...)  │
└────────┬────────┘
         │
         │ Firehose
         ▼
┌─────────────────┐
│   Substreams    │
│   ┌─────────┐   │
│   │map_events│──────► Events (protobuf)
│   └─────────┘   │
│        │        │
│        ├────────► store_stats
│        └────────► store_account_activity
│                  │
│   ┌─────────┐   │
│   │map_stats │───────► Stats (protobuf)
│   └─────────┘   │
└─────────────────┘
         │
         ▼
┌─────────────────┐
│   Event Store   │
│  (IPFS/S3/DB)   │
└─────────────────┘
```

## Prerequisites

### Required Tools

1. **Substreams CLI**
   ```bash
   # Install via brew (macOS)
   brew install streamingfast/tap/substreams

   # Or download from releases
   # https://github.com/streamingfast/substreams/releases
   ```

2. **Rust Toolchain** (for building)
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   rustup target add wasm32-unknown-unknown
   ```

3. **Pinax API Key** (for Firehose access)
   - Sign up at https://app.pinax.network
   - Get API key for EOS/WAX/Telos endpoints

### Optional Tools

- **Protocol Buffer Compiler** (if modifying .proto files)
  ```bash
  # macOS
  brew install protobuf

  # Ubuntu/Debian
  sudo apt install protobuf-compiler
  ```

## Quick Start

### 1. Build the Module

```bash
make build
```

This will:
- Generate protobuf bindings
- Generate ABI bindings from the Polaris contract
- Compile the Rust code to WASM

### 2. Set API Key

```bash
export SUBSTREAMS_API_TOKEN="your_pinax_api_key"
```

### 3. Run Locally

```bash
# Extract events from blocks 100M - 100M+1000
make run

# Or with custom parameters
make run-custom CONTRACT=polaris START=100000000 BLOCKS=1000
```

### 4. View Statistics

```bash
make stats
```

### 5. Launch GUI Explorer

```bash
make gui
```

## Module Reference

### map_events

**Type:** Map module (stateless transformation)

**Input:**
- `params: string` - Contract account name (default: "polaris")
- `Block` - Antelope block from Firehose

**Output:** `polaris.v1.Events` - Extracted events

**Example:**
```bash
substreams run \
  -e eos.firehose.pinax.network:443 \
  ./substreams.yaml \
  map_events \
  -p map_events="polaris" \
  --start-block 100000000 \
  --stop-block +1000
```

### store_stats

**Type:** Store module (stateful aggregation)

**Input:** `Events` from map_events

**Keys:**
- `total_events` - Total events processed
- `total_puts` - Total PUT events
- `total_votes` - Total VOTE events
- `total_stakes` - Total STAKE events
- `total_likes` - Total LIKE events

### store_account_activity

**Type:** Store module (stateful aggregation)

**Input:** `Events` from map_events

**Keys (per account):**
- `account:{name}:events` - Event count
- `account:{name}:last_block` - Last active block

### map_stats

**Type:** Map module (query aggregates)

**Input:** `store_stats` in get mode

**Output:** `polaris.v1.Stats` - Aggregated statistics

### map_anchored_events

**Type:** Map module (primary chain ingestion output)

**Input:**
- `params: string` - Contract account name (default: "polaris")
- `Block` - Antelope block from Firehose

**Output:** `polaris.v1.AnchoredEvents` - Events with blockchain provenance

**Purpose:** Primary output for T5 ingestion pipeline. Extracts anchored events with complete blockchain metadata including event hash, payload, block metadata, transaction metadata, and source identifier.

**Example:**
```bash
substreams run \
  -e eos.firehose.pinax.network:443 \
  ./substreams.yaml \
  map_anchored_events \
  -p map_anchored_events="polaris" \
  --start-block 100000000 \
  --stop-block +1000
```

## Development

### Project Structure

```
substreams/
├── abi/
│   └── polaris.music.json       # Contract ABI for codegen
├── proto/
│   └── polaris.proto            # Event schema definitions
├── src/
│   ├── abi/
│   │   ├── mod.rs
│   │   └── polaris_music.rs     # Generated ABI bindings
│   ├── pb/
│   │   ├── mod.rs
│   │   └── polaris.v1.rs        # Generated proto bindings
│   └── lib.rs                   # Main module logic
├── build.rs                     # Build script for codegen
├── Cargo.toml                   # Rust dependencies
├── substreams.yaml              # Substreams manifest
├── Makefile                     # Build automation
└── README.md                    # This file
```

### Modifying Event Schema

1. Edit `proto/polaris.proto` to add/change event types
2. Run `make protogen` to regenerate bindings
3. Update extraction logic in `src/lib.rs`
4. Rebuild: `make build`

### Adding New Contract Actions

1. Update `abi/polaris.music.json` with new action
2. Add extraction function in `src/lib.rs` (e.g., `extract_new_event`)
3. Call it from `map_events` match statement
4. Rebuild: `make build`

### Testing

```bash
# Run Rust tests
make test

# Test on testnet
substreams run \
  -e jungle4.firehose.pinax.network:443 \
  ./substreams.yaml \
  map_events \
  --start-block 1 \
  --stop-block +100
```

## Deployment

### Creating a Package

```bash
make package
```

This creates `polaris_music_substreams-v0.1.0.spkg` which can be:
- Published to a Substreams registry
- Shared with other developers
- Imported by other Substreams modules

### Available Endpoints

**EOS Mainnet:**
```
eos.firehose.pinax.network:443
```

**WAX Mainnet:**
```
wax.firehose.pinax.network:443
```

**Telos Mainnet:**
```
telos.firehose.pinax.network:443
```

**UX Mainnet:**
```
ux.firehose.pinax.network:443
```

**Jungle 4 Testnet (EOS):**
```
jungle4.firehose.pinax.network:443
```

### Integration with Event Processor

The event processor (`backend/src/indexer/eventProcessor.js`) can consume Substreams output:

```javascript
// Subscribe to Substreams events
const stream = await substreamsClient.stream({
  endpoint: 'eos.firehose.pinax.network:443',
  package: './polaris_music_substreams-v0.1.0.spkg',
  module: 'map_events',
  startBlock: lastProcessedBlock,
});

for await (const event of stream) {
  await processEvent(event);
}
```

## Performance Considerations

### Block Range Selection

- **Full sync**: Start from contract deployment block
- **Recent events**: Start from (current_block - 1M)
- **Real-time**: Use `--stop-block 0` for continuous streaming

### Parallelization

Substreams automatically parallelizes processing:
- Multiple block ranges processed simultaneously
- Significant speedup for historical indexing
- CPU/memory usage scales with parallelization

### Resource Requirements

For full EOS mainnet indexing:
- **CPU**: 8+ cores recommended
- **Memory**: 16GB+ RAM
- **Network**: High-bandwidth connection to Firehose

## Troubleshooting

### "Failed to connect to endpoint"

**Solution:** Check API key and endpoint URL
```bash
# Verify API key is set
echo $SUBSTREAMS_API_TOKEN

# Test connection
substreams info -e eos.firehose.pinax.network:443
```

### "Module not found: protobuf"

**Solution:** Generate protobuf bindings
```bash
make protogen
```

### "Failed to parse action data"

**Solution:** Verify ABI matches deployed contract
```bash
# Fetch latest ABI from chain
cleos -u https://eos.api.eosnation.io get abi polaris > abi/polaris.music.json
make build
```

### Build errors with WASM target

**Solution:** Install WASM target
```bash
rustup target add wasm32-unknown-unknown
```

## Advanced Usage

### Custom Filtering

Modify `map_events` to filter specific event types:

```rust
// Only extract PUT events
match action.name.as_str() {
    "put" => extract_put_event(&tx_hash, &block, action_trace),
    _ => None, // Skip other events
}
```

### Custom Aggregations

Add new store modules for custom metrics:

```yaml
# In substreams.yaml
- name: store_stake_by_node
  kind: store
  updatePolicy: add
  valueType: int64
  inputs:
    - map: map_events
```

### Exporting to Database

Use Substreams sinks for direct database export:

```bash
# PostgreSQL sink
substreams-sink-postgres run \
  "postgresql://user:pass@localhost/polaris" \
  "./substreams.yaml" \
  map_events

# MongoDB sink
substreams-sink-mongodb run \
  "mongodb://localhost:27017/polaris" \
  "./substreams.yaml" \
  map_events
```

## Monitoring

### Log Levels

```bash
# Debug output
export SUBSTREAMS_LOG_LEVEL=debug
make run

# Verbose output
substreams run -v ./substreams.yaml map_events
```

### Progress Tracking

```bash
# Show progress every 1000 blocks
substreams run \
  ./substreams.yaml \
  map_events \
  --start-block 100000000 \
  --stop-block 110000000 \
  --progress-messages
```

## Resources

- **Substreams Documentation**: https://substreams.streamingfast.io/
- **Pinax Network**: https://pinax.network/
- **Antelope Substreams**: https://github.com/pinax-network/substreams-antelope
- **Polaris Documentation**: ../docs/
- **Contract Source**: ../contracts/

## Contributing

When contributing to this Substreams module:

1. Test changes locally with small block ranges
2. Verify protobuf schema changes are backwards compatible
3. Update this README with new features
4. Run `make fmt` and `make lint` before committing

## License

See [LICENSE](../LICENSE) in repository root.

## Support

For Substreams-specific issues:
- Review documentation at https://substreams.streamingfast.io/
- Check Pinax Discord for Antelope-specific help
- Open an issue in the main repository

For Polaris integration questions:
- Review `../docs/` directory
- Check the event processor implementation
- Consult the smart contract documentation
