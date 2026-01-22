# Building the Polaris Substreams Module

This directory contains a custom Substreams module for indexing Polaris Music Registry events on Antelope blockchains.

## Why Use the Local Module?

The local `map_anchored_events` module has several advantages over using Pinax's generic `filtered_actions`:

1. **Embedded Contract ABI**: The module includes the Polaris contract ABI, so it doesn't rely on Pinax having your custom contract ABI available
2. **Clean Event Structure**: Outputs `AnchoredEvents` with all necessary fields pre-formatted
3. **Reliable on Testnets**: Works on Jungle4 and other testnets where ABIs may not be published
4. **Direct Content Hash Extraction**: Extracts `put.hash` directly from decoded actions

## Prerequisites

### 1. Install Rust Toolchain

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown
```

### 2. Install Substreams CLI

```bash
curl https://substreams.streamingfast.io/install.sh | bash
```

Or download from: https://github.com/streamingfast/substreams/releases

## Building the Module

### Quick Build

```bash
cd substreams
make package
```

This will:
1. Generate protobuf bindings (`substreams protogen`)
2. Build the WASM module (`cargo build --target wasm32-unknown-unknown --release`)
3. Create the .spkg package (`substreams pack`)

Output: `polaris_music_substreams-v0.1.0.spkg`

### Manual Steps

If you need to build manually:

```bash
# 1. Generate protobuf bindings (REQUIRED before cargo build)
substreams protogen ./substreams.yaml --exclude-paths="sf/substreams,google"

# 2. Build WASM (this also regenerates ABI bindings via build.rs)
cargo build --target wasm32-unknown-unknown --release

# 3. Pack .spkg
substreams pack ./substreams.yaml
```

**CRITICAL**: Step 1 (protogen) MUST be run before Step 2 (cargo build):
- Protogen generates `src/pb/polaris.v1.rs` from protobuf definitions
- Cargo build.rs generates `src/abi/polaris_music.rs` from `abi/polaris.music.json`
- Both generated files are required for compilation

**After ABI Changes**: If the contract ABI changes (e.g., adding `event_cid` field):
1. Update `abi/polaris.music.json` with new field
2. Run full clean build: `make clean && make package`
3. The build.rs will regenerate bindings with the new field automatically

## Using the Local Module

### Option 1: Docker Compose (Recommended)

Update your `.env` file:

```bash
SUBSTREAMS_PACKAGE=/app/substreams/polaris_music_substreams-v0.1.0.spkg
SUBSTREAMS_MODULE=map_anchored_events
SUBSTREAMS_PARAMS=map_anchored_events="polaris"
```

The docker-compose.yml already mounts `./substreams` at `/app/substreams` so the sink can access the .spkg file.

### Option 2: Direct CLI Usage

```bash
cd substreams
substreams run -e jungle4.substreams.pinax.network:443 \
  ./polaris_music_substreams-v0.1.0.spkg \
  map_anchored_events \
  -p map_anchored_events="polaris" \
  --start-block 100000 \
  --stop-block +1000
```

## Module Parameters

The `map_anchored_events` module accepts a single string parameter:

- **Contract Account**: The account name of the Polaris contract (default: "polaris")

Example:
```bash
# Use default contract account
-p map_anchored_events="polaris"

# Use custom contract account
-p map_anchored_events="mycontract"
```

## Output Format

The module outputs `polaris.v1.AnchoredEvents` containing:

```protobuf
message AnchoredEvent {
  string content_hash = 1;         // From put.hash (SHA256 of off-chain event)
  string event_hash = 2;           // SHA256 of action payload
  bytes payload = 3;               // Raw action JSON
  uint64 block_num = 4;
  string block_id = 5;
  string trx_id = 6;
  uint32 action_ordinal = 7;
  uint64 timestamp = 8;
  string source = 9;               // "substreams-eos"
  string contract_account = 10;
  string action_name = 11;         // "put", "vote", etc.
}
```

## Troubleshooting

### "substreams: not found"

Install the Substreams CLI (see prerequisites above).

### "cargo: not found"

Install Rust toolchain (see prerequisites above).

### "target 'wasm32-unknown-unknown' not found"

```bash
rustup target add wasm32-unknown-unknown
```

### Build errors about missing dependencies

```bash
cargo clean
cargo build --target wasm32-unknown-unknown --release
```

## Development

### Run Tests

```bash
make test
```

### Format Code

```bash
make fmt
```

### Lint Code

```bash
make lint
```

### Clean Build Artifacts

```bash
make clean
```

## Further Reading

- [Substreams Documentation](https://substreams.streamingfast.io/)
- [Pinax Antelope Substreams](https://github.com/pinax-network/substreams-antelope)
- [Polaris Smart Contract](../contracts/polaris.music.cpp)
