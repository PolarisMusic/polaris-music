# Build stage
FROM node:25-alpine AS builder
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

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
