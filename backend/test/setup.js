/**
 * Jest setup file - runs before all tests
 *
 * Sets up test environment, loads env vars, and configures global test utilities.
 *
 * For resource cleanup (Neo4j drivers, Redis clients, HTTP servers):
 *   import { registerHandle } from './test/handles.js';
 *   registerHandle('Resource name', () => resource.close());
 */

// Import and re-export handle registration utilities
export { registerHandle, clearHandles, getHandleCount } from './handles.js';

// Note: jest global is not available in ES modules setup
// Timeout is configured in jest.config.js instead

// Set dummy environment variables for tests to suppress warnings
process.env.IPFS_URL = process.env.IPFS_URL || 'http://localhost:5001';
process.env.S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://localhost:9000';
process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'test_access_key';
process.env.S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'test_secret_key';
process.env.S3_BUCKET = process.env.S3_BUCKET || 'test-bucket';
process.env.REDIS_HOST = process.env.REDIS_HOST || 'localhost';
process.env.REDIS_PORT = process.env.REDIS_PORT || '6379';

// Security: Allow unsigned events in tests (avoids needing valid EOSIO signatures)
// This is ONLY for testing - production code enforces signature verification
process.env.ALLOW_UNSIGNED_EVENTS = 'true';

// Skip account authorization in tests (no RPC available)
// Production enforces this by default; tests run without a blockchain node
process.env.REQUIRE_ACCOUNT_AUTH = process.env.REQUIRE_ACCOUNT_AUTH || 'false';

// Use dev ingest mode in tests (apply merges immediately, no chain anchoring required)
process.env.INGEST_MODE = process.env.INGEST_MODE || 'dev';

// Neo4j validation - warn if not set (tests will use mocks)
if (!process.env.GRAPH_URI) {
    console.warn('⚠️  GRAPH_URI not set - Neo4j tests will use mocks');
}

console.log('✓ Jest test environment ready');

// Global cleanup handled by globalTeardown in jest.config.js
// Individual test files should register resources via registerHandle()
