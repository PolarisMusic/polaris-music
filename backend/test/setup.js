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

console.log('✓ Jest test environment ready');
