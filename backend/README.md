# Polaris Music Registry - Backend

Backend services for the Polaris Music decentralized music registry, including API server, event processor, and data storage layer.

## Architecture

```
┌─────────────┐
│  Blockchain │ (Antelope/EOS)
│   Contract  │
└──────┬──────┘
       │ Events
       ↓
┌─────────────┐     ┌──────────┐
│    Event    │────→│  IPFS +  │
│  Processor  │     │    S3    │
└──────┬──────┘     └──────────┘
       │
       ↓
┌─────────────┐     ┌──────────┐
│    Neo4j    │←────│  Redis   │
│    Graph    │     │  Cache   │
└──────┬──────┘     └──────────┘
       │
       ↓
┌─────────────┐
│  API Server │
│   GraphQL   │
│     REST    │
└─────────────┘
```

## Tech Stack

- **Runtime**: Node.js 20+ (ES Modules)
- **Graph Database**: Neo4j 5.15+ (Cypher queries)
- **Cache**: Redis 7+ (hot data layer)
- **Storage**: IPFS + S3 (event persistence)
- **API**: Express (GraphQL + REST)
- **Testing**: Mocha, Chai, Sinon

## Directory Structure

```
backend/
├── src/
│   ├── api/              # API server (GraphQL + REST)
│   │   ├── server.js     # Express server entry point
│   │   ├── routes/       # REST endpoints
│   │   └── graphql/      # GraphQL schema and resolvers
│   │
│   ├── graph/            # Neo4j graph database operations
│   │   ├── schema.js     # Graph schema and constraints
│   │   ├── queries.js    # Common Cypher queries
│   │   └── operations.js # Graph operations (CRUD)
│   │
│   ├── storage/          # Event storage layer
│   │   ├── eventStore.js # Event persistence (IPFS + S3)
│   │   ├── ipfs.js       # IPFS client wrapper
│   │   └── s3.js         # S3 client wrapper
│   │
│   ├── indexer/          # Blockchain event processor
│   │   ├── eventProcessor.js  # Process events → graph
│   │   ├── blockchainClient.js # Antelope RPC client
│   │   └── syncState.js  # Track sync progress
│   │
│   └── utils/            # Shared utilities
│       ├── hash.js       # Deterministic hashing
│       ├── validation.js # Data validation
│       └── logger.js     # Logging configuration
│
├── test/                 # Test suites
│   ├── api/             # API endpoint tests
│   ├── graph/           # Graph database tests
│   ├── storage/         # Storage layer tests
│   ├── crypto/          # Cryptographic signature tests
│   ├── e2e/             # End-to-end workflow tests
│   ├── fixtures/        # Test data (Beatles example)
│   └── setup.js         # Test environment configuration
│
├── smoke-tests/         # Smoke test data
│   ├── releases/        # 21 release bundle templates
│   └── README.md        # Smoke test documentation
│
├── scripts/             # Utility scripts
│   ├── loadSmokeTests.js     # Load smoke test bundles into Neo4j
│   └── loadWhiteAlbumData.js # Load Beatles example data
│
├── Dockerfile           # Production Docker image
├── package.json         # Dependencies and scripts
└── README.md           # This file
```

## Prerequisites

- **Node.js**: 20.x or higher
- **npm**: 10.x or higher
- **Docker**: 24.x or higher (for infrastructure)
- **Docker Compose**: 2.x or higher

## Quick Start (Docker Compose)

The easiest way to get started is using Docker Compose, which sets up all required services:

```bash
# From project root
docker-compose up -d

# Check service health
docker-compose ps

# View API logs
docker-compose logs -f api

# View event processor logs
docker-compose logs -f processor
```

Services will be available at:
- **API Server**: http://localhost:3000
- **GraphQL Playground**: http://localhost:3000/graphql
- **Neo4j Browser**: http://localhost:7474 (user: neo4j, pass: polarisdev)
- **MinIO Console**: http://localhost:9001 (user: polaris, pass: polarisdev123)
- **IPFS Gateway**: http://localhost:8080
- **Redis**: localhost:6379

## Manual Setup

If you prefer to run services manually:

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Set Up Infrastructure

**Neo4j** (Graph Database):
```bash
docker run -d \
  --name polaris-neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/polarisdev \
  -e NEO4J_PLUGINS='["apoc", "graph-data-science"]' \
  neo4j:5.15-community
```

**Redis** (Cache):
```bash
docker run -d \
  --name polaris-redis \
  -p 6379:6379 \
  redis:7-alpine redis-server --requirepass polarisdev
```

**IPFS** (Storage):
```bash
docker run -d \
  --name polaris-ipfs \
  -p 4001:4001 -p 5001:5001 -p 8080:8080 \
  ipfs/kubo:v0.24.0
```

**Pinata** (Cloud IPFS - Optional):
- For testnet/production deployments, configure Pinata for reliable IPFS pinning
- Implementation uses native `fetch` API (REST) - no SDK dependency
- Set `PINATA_API_KEY` and `PINATA_SECRET_API_KEY` in `.env`
- See `backend/src/storage/ipfs.js` for implementation details

**MinIO** (S3-compatible Storage):
```bash
docker run -d \
  --name polaris-minio \
  -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=polaris \
  -e MINIO_ROOT_PASSWORD=polarisdev123 \
  minio/minio server /data --console-address ":9001"

# Create bucket
docker exec polaris-minio \
  mc alias set local http://localhost:9000 polaris polarisdev123
docker exec polaris-minio \
  mc mb local/polaris-events --ignore-existing
```

### 3. Configure Environment

Copy the example environment file and update as needed:

```bash
cp ../.env.example .env
```

Edit `.env` to match your local setup (especially if not using Docker).

### 4. Initialize Database

```bash
# Initialize Neo4j schema (constraints, indexes)
npm run db:init

# Optional: Load test data (Beatles example)
npm run db:seed

# Optional: Load smoke test bundles (21 release bundles for comprehensive testing)
node scripts/loadSmokeTests.js
```

### 5. Run Development Servers

**Terminal 1** - API Server:
```bash
npm run dev
```

**Terminal 2** - Event Processor:
```bash
npm run processor
```

## Available Scripts

```bash
# Development
npm run dev              # Start API server with hot reload
npm run processor        # Start event processor
npm run db:init          # Initialize graph database schema
npm run db:seed          # Load test data
npm run db:reset         # Drop all data and reinitialize

# Testing
npm test                 # Run all tests
npm run test:unit        # Unit tests only
npm run test:integration # Integration tests only
npm run test:e2e         # End-to-end tests
npm run test:coverage    # Generate coverage report
npm run test:watch       # Run tests in watch mode

# Smoke Tests
node scripts/loadSmokeTests.js              # Load all smoke test bundles
node scripts/loadSmokeTests.js --clear      # Clear graph and load smoke tests
node scripts/loadSmokeTests.js --file <filename>  # Load specific bundle

# Production
npm start                # Start API server (production)
npm run build            # Build for production (if needed)

# Utilities
npm run lint             # Check code style
npm run lint:fix         # Fix code style issues
npm run format           # Format code with Prettier
```

## API Endpoints

### REST API

```
GET  /health              # Health check
GET  /api/events/:hash    # Retrieve event by hash
POST /api/releases        # Submit new release
GET  /api/releases/:id    # Get release details
GET  /api/graph/stats     # Graph statistics
POST /api/ingest          # Chain ingestion endpoint (Substreams → Backend)
```

#### Authentication

**Chain Ingestion Endpoints** (`/api/ingest`):
- **Required in chain/production mode**: Requests must include `X-API-Key` header
- **Development mode**: No authentication required (use `INGEST_MODE=dev`)
- **Configuration**:
  ```bash
  export INGEST_MODE=chain        # Enable auth for ingestion
  export INGEST_API_KEY=your_key  # API key for ingestion
  ```
- **Usage**: Substreams HTTP sink automatically includes this header when `INGEST_API_KEY` is set
- **Security**: This prevents unauthorized writes to the graph database in production

### GraphQL API

Access GraphQL Playground at `http://localhost:3000/graphql`

**Example Query**:
```graphql
query GetRelease($id: ID!) {
  release(id: $id) {
    release_name
    release_date
    labels {
      label_name
      label_city {
        city_name
      }
    }
    tracks {
      title
      groups {
        group_name
        members {
          person_name
          person_roles {
            role_name
          }
        }
      }
    }
  }
}
```

## Environment Variables

See `.env.example` for all available configuration options.

**Key Variables**:

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment (development/production) | development |
| `PORT` | API server port | 3000 |
| `GRAPH_URI` | Neo4j connection URI | bolt://localhost:7687 |
| `GRAPH_USER` | Neo4j username | neo4j |
| `GRAPH_PASSWORD` | Neo4j password | polarisdev |
| `IPFS_URL` | IPFS API endpoint | http://localhost:5001 |
| `S3_ENDPOINT` | S3 endpoint URL | http://localhost:9000 |
| `S3_BUCKET` | S3 bucket name | polaris-events |
| `REDIS_HOST` | Redis hostname | localhost |
| `RPC_URL` | Blockchain RPC endpoint | https://eos.greymass.com |
| `CONTRACT_ACCOUNT` | Smart contract account | polaris |

## Testing

### Running Tests

```bash
# All tests
npm test

# Specific test suite
npm run test:unit
npm run test:integration
npm run test:e2e

# With coverage
npm run test:coverage

# Watch mode during development
npm run test:watch

# Load testing with Artillery
npm run test:load
```

### Load Testing

Load tests use [Artillery](https://www.artillery.io/) to simulate realistic traffic against the full pipeline:
- **prepare** → **dev-sign** → **create** → **ingest anchored event**

**Prerequisites:**
- API server running locally: `docker compose up -d` or `npm run dev`
- Dev signer enabled: `DEV_SIGNER_PRIVATE_KEY` set in API container
- Account auth disabled: `REQUIRE_ACCOUNT_AUTH=false` in API container

**Run load test:**
```bash
npm run test:load
```

**Load test profile:**
- **Phase 1**: Ramp from 1 to 10 requests/second over 30 seconds
- **Phase 2**: Sustain 10 requests/second for 60 seconds
- **Total duration**: 90 seconds

Artillery will report:
- Request latency (p50, p95, p99)
- Throughput (requests/second)
- Error rate (4xx/5xx responses)

**Safety:** Load tests refuse to run if `NODE_ENV=production`. Only run against development/test environments.

### Test Data

Test fixtures use the Beatles White Album as a canonical example:
- **Release**: "The Beatles" (White Album)
- **Groups**: The Beatles
- **Members**: John Lennon, Paul McCartney, George Harrison, Ringo Starr
- **Guests**: Eric Clapton (lead guitar on "While My Guitar Gently Weeps")
- **Tracks**: 30 tracks across 2 discs

See `test/fixtures/beatles-white-album.json` for complete data.

### Performance Targets

- API Response Time: < 100ms (p95)
- Graph Query Time: < 500ms (complex traversals)
- Event Processing: > 100 events/second
- Database Connection Pool: 10-50 connections

## Development Workflow

### 1. Making Changes

```bash
# Create feature branch
git checkout -b feature/your-feature

# Make changes, add tests
npm test

# Ensure code style
npm run lint:fix
npm run format
```

### 2. Database Changes

When modifying graph schema:

1. Update `src/graph/schema.js`
2. Add migration logic (if needed)
3. Update tests
4. Run `npm run db:reset` to test fresh initialization
5. Document changes in `/docs/02-graph-database-schema.md`

### 3. Adding API Endpoints

1. Add route to `src/api/routes/`
2. Add resolver to `src/api/graphql/resolvers/` (if GraphQL)
3. Add tests to `test/api/`
4. Update this README's API section

## Troubleshooting

### Database Connection Issues

```bash
# Check Neo4j is running
docker ps | grep neo4j

# Test connection
cypher-shell -a bolt://localhost:7687 -u neo4j -p polarisdev

# View Neo4j logs
docker logs polaris-neo4j
```

### IPFS Connection Issues

```bash
# Check IPFS is running
docker ps | grep ipfs

# Test API
curl http://localhost:5001/api/v0/id

# View IPFS logs
docker logs polaris-ipfs
```

### Redis Connection Issues

```bash
# Check Redis is running
docker ps | grep redis

# Test connection
redis-cli -h localhost -p 6379 -a polarisdev ping

# View Redis logs
docker logs polaris-redis
```

### Event Processing Issues

```bash
# Check processor logs
docker-compose logs -f processor

# Verify blockchain connectivity
curl -X POST https://eos.greymass.com/v1/chain/get_info

# Check sync state in Redis
redis-cli -h localhost -p 6379 -a polarisdev GET polaris:sync:lastBlock
```

### Port Conflicts

If ports are already in use, you can modify them in `docker-compose.yml`:

```yaml
services:
  api:
    ports:
      - "3001:3000"  # Changed from 3000:3000
```

## Production Deployment

For production deployment:

1. **Environment Variables**: Set all required env vars in production
2. **Database Backups**: Configure automated Neo4j backups
3. **IPFS Pinning**: Ensure events are pinned to prevent garbage collection
4. **Redis Persistence**: Enable RDB or AOF persistence
5. **Monitoring**: Set up health checks and alerting
6. **Rate Limiting**: Enable rate limiting on API endpoints
7. **HTTPS**: Use SSL/TLS certificates
8. **Logging**: Configure structured logging to external service

See `/docs/` for detailed deployment documentation.

## Performance Optimization

### Neo4j Tuning

```cypher
// Create indexes for common queries
CREATE INDEX person_name IF NOT EXISTS FOR (p:Person) ON (p.person_name);
CREATE INDEX group_name IF NOT EXISTS FOR (g:Group) ON (g.group_name);
CREATE INDEX track_title IF NOT EXISTS FOR (t:Track) ON (t.title);
CREATE INDEX release_name IF NOT EXISTS FOR (r:Release) ON (r.release_name);

// Check query performance
PROFILE MATCH (p:Person)-[:MEMBER_OF]->(g:Group) RETURN p, g LIMIT 10;
```

### Redis Caching

Hot data is cached in Redis with TTL:
- Release details: 1 hour
- Graph stats: 5 minutes
- Event data: 24 hours

### Connection Pooling

Neo4j driver uses connection pooling:
- Min connections: 10
- Max connections: 50
- Acquisition timeout: 60s

## Contributing

1. Follow the code style (ESLint + Prettier)
2. Write tests for new features
3. Update documentation
4. Ensure all tests pass: `npm test`
5. Check no regressions: `npm run test:e2e`

## Additional Resources

- **Main README**: `/README.md` - User-facing documentation
- **CLAUDE.md**: `/CLAUDE.md` - AI assistant guide
- **Smart Contract**: `/contracts/polaris.music.cpp`
- **Graph Schema**: `/docs/02-graph-database-schema.md`
- **API Spec**: `/docs/07-api-server.md`
- **Event Storage**: `/docs/03-event-storage.md`

## License

See main project LICENSE file.

## Support

- **Issues**: https://github.com/PolarisMusic/polaris-music/issues
- **Documentation**: `/docs/` directory
- **Community**: [Link to Discord/Forum when available]
