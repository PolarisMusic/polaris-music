# Dockerfile for Polaris Substreams HTTP Sink
# Multi-stage build: Rust WASM compilation → Substreams packaging → Node.js runtime
# Builds local custom module with embedded contract ABI to avoid Pinax ABI dependency

# ============================================================================
# Stage 1: Build Rust WASM module
# ============================================================================
FROM rust:1.75-bookworm AS rust-builder

# Install WASM target
RUN rustup target add wasm32-unknown-unknown

WORKDIR /build

# Copy Rust project files
COPY Cargo.toml build.rs ./
COPY src/ ./src/
COPY proto/ ./proto/
COPY abi/ ./abi/

# Build WASM module
RUN cargo build --target wasm32-unknown-unknown --release && \
    echo "✓ WASM module compiled" && \
    ls -lh target/wasm32-unknown-unknown/release/*.wasm

# ============================================================================
# Stage 2: Generate protobuf bindings and pack .spkg
# ============================================================================
FROM ghcr.io/streamingfast/substreams:v1.10.8 AS substreams-builder

WORKDIR /build

# Copy files needed for packaging
COPY substreams.yaml ./
COPY proto/ ./proto/
COPY abi/ ./abi/

# Copy compiled WASM from Rust builder
COPY --from=rust-builder /build/target/wasm32-unknown-unknown/release/polaris_substreams.wasm \
    ./target/wasm32-unknown-unknown/release/polaris_substreams.wasm

# Generate protobuf bindings (required for packaging)
RUN substreams protogen ./substreams.yaml --exclude-paths="sf/substreams,google" && \
    echo "✓ Protobuf bindings generated"

# Pack the Substreams package
RUN substreams pack ./substreams.yaml && \
    echo "✓ Substreams package created" && \
    ls -lh *.spkg

# ============================================================================
# Stage 3: Build Node.js runtime with Substreams CLI and local package
# ============================================================================
FROM node:20-bookworm-slim

# Install ca-certificates for HTTPS connections
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy Substreams CLI binary from official image
# The binary is located at /app/substreams in the official image
COPY --from=substreams-builder /app/substreams /usr/local/bin/substreams

# Verify Substreams CLI installation
RUN substreams --version && \
    echo "✓ Substreams CLI ready"

# Set working directory
WORKDIR /app

# Create substreams directory for package
RUN mkdir -p /app/substreams

# Copy local Substreams package from builder
COPY --from=substreams-builder /build/*.spkg /app/substreams/

# Copy sink code
COPY sink/ /app/sink/

# Verify structure
RUN test -f /app/sink/http-sink.mjs && \
    ls -lh /app/substreams/*.spkg && \
    echo "✓ Local Substreams package and sink code ready"

# Default command runs the HTTP sink
# Now uses local map_anchored_events module with embedded ABI
CMD ["node", "sink/http-sink.mjs"]
