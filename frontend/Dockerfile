# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

# Install deps (including devDeps needed for Vite build)
COPY frontend/package*.json ./
RUN npm ci

# Copy shared config (used by src/config/chain.js)
COPY shared/ /shared/

# Copy source and build
COPY frontend/ .
RUN npm run build

# Runtime stage
FROM nginx:alpine

# Copy built assets only
COPY --from=builder /app/dist /usr/share/nginx/html

# Extensionless routing (/submit -> submit.html) and asset caching
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# Probe 127.0.0.1, not localhost. `listen 80` above binds IPv4 only, while
# `localhost` inside the container resolves ::1 ahead of 127.0.0.1 — so a
# localhost probe connects to an address nginx never bound and is refused.
# The container stays Up and serves traffic fine over the Docker network;
# only the healthcheck fails, which reads as a broken deploy when it isn't.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
