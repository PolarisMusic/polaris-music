# Dockerfile for Polaris Substreams HTTP Sink
# Two stages: `substreams build` (protos → wasm → .spkg) → Node.js runtime
# Builds local custom module with embedded contract ABI to avoid Pinax ABI dependency

# ============================================================================
# Stage 0: source of the substreams CLI binary
# ============================================================================
# The official image is a minimal Ubuntu carrying the binary at /app/substreams
# as its ENTRYPOINT — it has no cargo and no buf, so we lift the binary out
# rather than building inside it.
FROM ghcr.io/streamingfast/substreams:v1.21.0 AS substreams-cli

# ============================================================================
# Stage 1: Generate protobufs, compile WASM, and pack the .spkg
# ============================================================================
# `substreams build` does all three in one pass (proto codegen via buf, cargo
# build, then package). That is the supported workflow — `substreams pack` is
# deprecated — and it also keeps the image self-consistent: bindings are
# regenerated from proto/polaris.proto here rather than trusting whatever is
# committed under src/pb/ to still match.
#
# edition2024 was stabilized in Rust 1.85; transitive dep getrandom requires
# it, so 1.75 no longer builds.
FROM rust:1.85-bookworm AS builder

# WASM target for the compiled module
RUN rustup target add wasm32-unknown-unknown

# buf CLI — `substreams build` shells out to it for protobuf codegen.
# uname-based asset name so this works on both amd64 and arm64 hosts.
ARG BUF_VERSION=1.47.2
RUN curl -fsSL \
      "https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}/buf-$(uname -s)-$(uname -m)" \
      -o /usr/local/bin/buf && \
    chmod +x /usr/local/bin/buf && \
    buf --version

# substreams CLI
COPY --from=substreams-cli /app/substreams /usr/local/bin/substreams
RUN substreams --version

WORKDIR /build

# Full project — `build` needs the manifest, protos, ABI, and Rust sources
# together, since it regenerates bindings and then compiles against them.
COPY Cargo.toml build.rs substreams.yaml ./
COPY src/ ./src/
COPY proto/ ./proto/
COPY abi/ ./abi/

# Build, then normalize the .spkg into /out regardless of where it lands
# relative to the working directory.
RUN substreams build && \
    mkdir -p /out && \
    find /build -name '*.spkg' -exec cp {} /out/ \; && \
    test -n "$(ls -A /out)" && \
    echo "✓ Substreams package created" && \
    ls -lh /out/*.spkg

# ============================================================================
# Stage 2: Node.js runtime with Substreams CLI and the built package
# ============================================================================
FROM node:20-bookworm-slim

# ca-certificates for HTTPS connections to the Substreams endpoint
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The sink spawns `substreams run`, so the CLI must be on PATH here
COPY --from=substreams-cli /app/substreams /usr/local/bin/substreams
RUN substreams --version && \
    echo "✓ Substreams CLI ready"

WORKDIR /app

RUN mkdir -p /app/substreams
COPY --from=builder /out/*.spkg /app/substreams/

COPY sink/ /app/sink/

# Verify structure
RUN test -f /app/sink/http-sink.mjs && \
    ls -lh /app/substreams/*.spkg && \
    echo "✓ Local Substreams package and sink code ready"

# Default command runs the HTTP sink
# Uses local map_anchored_events module with embedded ABI
CMD ["node", "sink/http-sink.mjs"]
