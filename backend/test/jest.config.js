/**
 * Jest configuration for Polaris Music Registry backend tests
 *
 * This configuration sets up Jest for testing the Node.js backend,
 * including integration tests with Neo4j, Redis, and S3.
 */

export default {
    // Use Node.js test environment
    testEnvironment: 'node',

    // Test file patterns
    testMatch: [
        '**/test/**/*.test.js',
        '**/test/**/*.spec.js'
    ],

    // Coverage configuration
    coverageDirectory: '../coverage',
    collectCoverageFrom: [
        '../src/**/*.js',
        '!../src/**/*.spec.js',
        '!../src/**/*.test.js'
    ],

    // Module resolution
    moduleFileExtensions: ['js', 'json'],

    // Transform - no transformation needed for ES modules in Node 18+
    transform: {},

    // Verbose output for better debugging
    verbose: true,

    // Test timeout (10 seconds for integration tests)
    testTimeout: 10000,

    // Setup files
    setupFilesAfterEnv: ['<rootDir>/setup.js'],

    // Global teardown - close all registered handles
    globalTeardown: '<rootDir>/teardown.js',

    // Module paths
    modulePaths: ['<rootDir>/../src'],

    // Map modules for tools/ tests (tools/ dir can't resolve backend/node_modules)
    moduleNameMapper: {
        '^axios$': '<rootDir>/../node_modules/axios/index.js',
        '^fast-json-stable-stringify$': '<rootDir>/../node_modules/fast-json-stable-stringify/index.js',
    },

    // Clear mocks between tests
    clearMocks: true,
    resetMocks: false,
    restoreMocks: false
};
