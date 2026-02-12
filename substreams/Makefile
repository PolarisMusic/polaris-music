.PHONY: all build protogen package clean test

PACKAGE_NAME := polaris_music_substreams
VERSION := v0.1.0

all: build

# Generate protobuf Rust bindings
protogen:
	@echo "Generating protobuf bindings..."
	substreams protogen ./substreams.yaml --exclude-paths="sf/substreams,google"

# Build the WASM module
build: protogen
	@echo "Building WASM module..."
	cargo build --target wasm32-unknown-unknown --release

# Create Substreams package
package: build
	@echo "Creating Substreams package..."
	substreams pack ./substreams.yaml

# Run tests
test:
	@echo "Running tests..."
	cargo test

# Run the substreams locally (requires Firehose endpoint)
run:
	@echo "Running map_events module..."
	substreams run -e eos.firehose.pinax.network:443 \
		./substreams.yaml \
		map_events \
		--start-block 100000000 \
		--stop-block +1000

# Run with custom contract account
run-custom:
	@echo "Running map_events with custom contract..."
	substreams run -e eos.firehose.pinax.network:443 \
		./substreams.yaml \
		map_events \
		-p map_events="$(CONTRACT)" \
		--start-block $(START) \
		--stop-block +$(BLOCKS)

# Run on Jungle4 testnet
run-testnet:
	@echo "Running map_anchored_events on Jungle4 testnet..."
	substreams run -e jungle4.substreams.pinax.network:443 \
		./substreams.yaml \
		map_anchored_events \
		-p map_anchored_events="$(CONTRACT_ACCOUNT)" \
		--start-block $(START_BLOCK) \
		--stop-block +$(BLOCKS)

# View stats
stats:
	@echo "Running map_stats module..."
	substreams run -e eos.firehose.pinax.network:443 \
		./substreams.yaml \
		map_stats \
		--start-block 100000000 \
		--stop-block +10000

# GUI explorer
gui:
	@echo "Launching Substreams GUI..."
	substreams gui ./substreams.yaml map_events \
		-e eos.firehose.pinax.network:443 \
		--start-block 100000000

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	cargo clean
	rm -rf output/
	rm -f *.spkg

# Install required tools
install-tools:
	@echo "Installing Substreams CLI..."
	@echo "Visit: https://substreams.streamingfast.io/getting-started/installing-the-cli"
	@echo ""
	@echo "Installing Rust toolchain..."
	rustup target add wasm32-unknown-unknown

# Format code
fmt:
	cargo fmt

# Lint code
lint:
	cargo clippy -- -D warnings

help:
	@echo "Polaris Music Substreams - Available targets:"
	@echo ""
	@echo "  make build          - Build the WASM module"
	@echo "  make protogen       - Generate protobuf bindings"
	@echo "  make package        - Create .spkg package"
	@echo "  make test           - Run tests"
	@echo "  make run            - Run locally on EOS mainnet"
	@echo "  make run-custom     - Run with custom params (CONTRACT=... START=... BLOCKS=...)"
	@echo "  make run-testnet    - Run on Jungle4 testnet (CONTRACT_ACCOUNT=... START_BLOCK=... BLOCKS=...)"
	@echo "  make stats          - View aggregated statistics"
	@echo "  make gui            - Launch GUI explorer"
	@echo "  make clean          - Clean build artifacts"
	@echo "  make install-tools  - Install required tools"
	@echo "  make fmt            - Format Rust code"
	@echo "  make lint           - Lint Rust code"
	@echo ""
