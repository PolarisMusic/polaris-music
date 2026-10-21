# Backend Dockerfile for Polaris Music Registry
FROM node:20-alpine

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /app

# Copy package files
#
# .npmrc comes with them, and must: it is what stops the install downloading a
# Chromium this image has no use for (nothing in backend/ drives a browser —
# see the file). Left out, the build still works and quietly carries ~150MB of
# a Linux-glibc browser build that cannot run on musl anyway.
COPY package*.json .npmrc ./

# Install dependencies
# Registry fetches from the deploy host are slow enough that npm's default idle
# timeout gives up mid-install (EIDLETIMEOUT), failing the build outright. These
# turn that into a slow build rather than a broken one.
RUN npm config set fetch-retries 5 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm config set fetch-timeout 600000

RUN npm ci

# Copy source code
COPY . .

# Expose API port
EXPOSE 3000

# Default command (can be overridden in docker-compose)
CMD ["npm", "start"]
