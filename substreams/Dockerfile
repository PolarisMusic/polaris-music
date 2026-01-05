# Dockerfile for Polaris Substreams HTTP Sink
# Includes Node.js + Substreams CLI for chain event ingestion

FROM node:20-bookworm-slim

# Install dependencies for downloading and running substreams
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Download and install Substreams CLI
# Using version v1.10.8 (stable as of 2024)
# For latest version, check: https://github.com/streamingfast/substreams/releases
ENV SUBSTREAMS_VERSION=v1.10.8
RUN curl -sSL "https://github.com/streamingfast/substreams/releases/download/${SUBSTREAMS_VERSION}/substreams_linux_x86_64.tar.gz" \
    | tar -xz -C /usr/local/bin substreams \
    && chmod +x /usr/local/bin/substreams \
    && substreams --version

# Set working directory
WORKDIR /app

# Copy substreams configuration and code
# Note: .proto and .spkg files are built separately via substreams build
COPY . /app/

# Verify structure
RUN ls -la /app/ && \
    ls -la /app/sink/ && \
    test -f /app/sink/http-sink.mjs && \
    echo "✓ Substreams sink code ready"

# Default command runs the HTTP sink
# Override with environment variables or docker-compose
CMD ["node", "sink/http-sink.mjs"]
