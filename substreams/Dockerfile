# Dockerfile for Polaris Substreams HTTP Sink
# Multi-stage build using official StreamingFast Substreams CLI image
# Eliminates manual downloads and ensures version compatibility

# Stage 1: Get the official Substreams CLI binary
FROM ghcr.io/streamingfast/substreams:v1.10.8 AS substreams

# Stage 2: Build the sink runtime with Node.js + Substreams CLI
FROM node:20-bookworm-slim

# Install ca-certificates for HTTPS connections
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy Substreams CLI binary from official image
# The binary is located at /app/substreams in the official image
COPY --from=substreams /app/substreams /usr/local/bin/substreams

# Verify installation
RUN substreams --version && \
    echo "✓ Substreams CLI copied from official image"

# Set working directory
WORKDIR /app

# Copy sink code
# Note: We no longer need local .proto or .spkg files
# The sink now uses published Pinax packages (antelope_common@v0.4.0)
COPY sink/ /app/sink/

# Verify structure
RUN test -f /app/sink/http-sink.mjs && \
    echo "✓ Substreams sink code ready"

# Default command runs the HTTP sink
# Uses Pinax foundational modules via registry (no local build required)
CMD ["node", "sink/http-sink.mjs"]
