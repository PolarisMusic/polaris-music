/**
 * Jest setup file - runs before all tests
 *
 * Sets up test environment, loads env vars, and configures global test utilities.
 */

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

// Neo4j validation - warn if not set (tests will use mocks)
if (!process.env.GRAPH_URI) {
    console.warn('⚠️  GRAPH_URI not set - Neo4j tests will use mocks');
}

console.log('✓ Jest test environment ready');

// Global cleanup to close any open connections/timers
// This prevents "Worker failed to exit gracefully" errors
global.afterAll = global.afterAll || (() => {
    // Placeholder for global cleanup
    // Individual test files should close their own resources
});
