/**
 * Shared test helper utilities for Polaris Music Registry backend tests
 *
 * Provides reusable mock factories for common dependencies:
 * - Neo4j driver, session, and transaction mocks
 * - EventStore mocks
 * - Redis client mocks
 * - IPFS client mocks
 *
 * Usage:
 *   import { createMockNeo4jDriver, createMockEventStore } from '../utils/testHelpers.js';
 *   const { driver, session, tx } = createMockNeo4jDriver();
 *
 * @module test/utils/testHelpers
 */

import { jest } from '@jest/globals';

/**
 * Create a mock Neo4j transaction
 *
 * @param {Object} overrides - Optional overrides for default mock behavior
 * @returns {Object} Mock transaction with run, commit, rollback methods
 */
export function createMockTransaction(overrides = {}) {
    return {
        run: jest.fn().mockResolvedValue({ records: [] }),
        commit: jest.fn().mockResolvedValue(undefined),
        rollback: jest.fn().mockResolvedValue(undefined),
        ...overrides
    };
}

/**
 * Create a mock Neo4j session
 *
 * @param {Object} overrides - Optional overrides for default mock behavior
 * @param {Object} tx - Optional pre-configured mock transaction
 * @returns {Object} Mock session with run, beginTransaction, close methods
 */
export function createMockSession(overrides = {}, tx = null) {
    const mockTx = tx || createMockTransaction();
    return {
        run: jest.fn().mockResolvedValue({ records: [] }),
        beginTransaction: jest.fn().mockReturnValue(mockTx),
        close: jest.fn().mockResolvedValue(undefined),
        ...overrides,
        _tx: mockTx // Expose for test assertions
    };
}

/**
 * Create a mock Neo4j driver with session and transaction
 *
 * @param {Object} overrides - Optional overrides for driver behavior
 * @returns {Object} { driver, session, tx } - All three mock objects
 */
export function createMockNeo4jDriver(overrides = {}) {
    const tx = createMockTransaction(overrides.tx);
    const session = createMockSession(overrides.session, tx);
    const driver = {
        session: jest.fn().mockReturnValue(session),
        close: jest.fn().mockResolvedValue(undefined),
        ...overrides.driver
    };

    return { driver, session, tx };
}

/**
 * Create a mock EventStore
 *
 * @param {Object} overrides - Optional overrides for default mock behavior
 * @returns {Object} Mock EventStore with store, retrieve, and utility methods
 */
export function createMockEventStore(overrides = {}) {
    return {
        storeEvent: jest.fn().mockResolvedValue({
            hash: 'abc123def456',
            canonical_cid: 'bafkreitest123',
            event_cid: 'bafkreitest456',
            s3: 's3://polaris-events/abc123def456',
            redis: true,
            errors: []
        }),
        retrieveEvent: jest.fn().mockResolvedValue({
            v: 1,
            type: 'CREATE_RELEASE_BUNDLE',
            body: {},
            created_at: new Date().toISOString()
        }),
        calculateHash: jest.fn().mockReturnValue('abc123def456'),
        getCanonicalPayload: jest.fn().mockReturnValue('{"test":"payload"}'),
        testConnectivity: jest.fn().mockResolvedValue({
            ipfs: true,
            s3: true,
            redis: true
        }),
        getStats: jest.fn().mockReturnValue({
            stored: 10,
            retrieved: 5,
            enabled: { ipfs: true, s3: true, redis: true }
        }),
        close: jest.fn().mockResolvedValue(undefined),
        ...overrides
    };
}

/**
 * Create a mock Redis client
 *
 * @param {Object} overrides - Optional overrides for default mock behavior
 * @returns {Object} Mock Redis client
 */
export function createMockRedisClient(overrides = {}) {
    return {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
        setex: jest.fn().mockResolvedValue('OK'),
        del: jest.fn().mockResolvedValue(1),
        exists: jest.fn().mockResolvedValue(0),
        ping: jest.fn().mockResolvedValue('PONG'),
        quit: jest.fn().mockResolvedValue(undefined),
        status: 'ready',
        ...overrides
    };
}

/**
 * Create a mock IPFS client
 *
 * @param {Object} overrides - Optional overrides for default mock behavior
 * @returns {Object} Mock IPFS client
 */
export function createMockIPFSClient(overrides = {}) {
    return {
        block: {
            put: jest.fn().mockResolvedValue('bafkreitest123'),
            get: jest.fn().mockResolvedValue(Buffer.from('{}'))
        },
        add: jest.fn().mockResolvedValue({
            cid: 'bafkreitest123',
            size: 100
        }),
        cat: jest.fn().mockImplementation(async function* () {
            yield Buffer.from('{}');
        }),
        id: jest.fn().mockResolvedValue({
            id: 'QmTest123',
            agentVersion: 'test/0.1.0'
        }),
        ...overrides
    };
}

/**
 * Create a mock MusicGraphDatabase instance
 *
 * @param {Object} overrides - Optional overrides for default mock behavior
 * @returns {Object} Mock database with common methods
 */
export function createMockGraphDatabase(overrides = {}) {
    const { driver, session, tx } = createMockNeo4jDriver(overrides.neo4j);

    return {
        driver,
        testConnection: jest.fn().mockResolvedValue(true),
        initializeSchema: jest.fn().mockResolvedValue(undefined),
        processReleaseBundle: jest.fn().mockResolvedValue({
            releaseId: 'release:test',
            tracksCreated: 10,
            groupsCreated: 1,
            personsCreated: 4
        }),
        calculateGroupMemberParticipation: jest.fn().mockResolvedValue([]),
        getStats: jest.fn().mockResolvedValue({
            nodes: { Person: 0, Group: 0, Track: 0, Song: 0, Release: 0, Label: 0 }
        }),
        findPotentialDuplicates: jest.fn().mockResolvedValue([]),
        close: jest.fn().mockResolvedValue(undefined),
        _session: session,
        _tx: tx,
        ...overrides.db
    };
}

/**
 * Create a sample release bundle for testing
 *
 * @param {Object} overrides - Optional overrides for default values
 * @returns {Object} A valid release bundle object
 */
export function createSampleReleaseBundle(overrides = {}) {
    return {
        release: {
            name: 'Test Album',
            release_date: '2024-01-01',
            format: ['CD'],
            country: 'US',
            ...overrides.release
        },
        groups: [{
            name: 'Test Band',
            members: [{
                name: 'Test Person',
                roles: ['vocals', 'guitar'],
                ...overrides.member
            }],
            ...overrides.group
        }],
        tracklist: [{
            title: 'Test Track',
            position: '1',
            duration: '3:30',
            song: { title: 'Test Song' },
            ...overrides.track
        }],
        ...overrides.bundle
    };
}

/**
 * Create a sample event for testing
 *
 * @param {Object} overrides - Optional overrides for default values
 * @returns {Object} A valid event object
 */
export function createSampleEvent(overrides = {}) {
    return {
        v: 1,
        type: 'CREATE_RELEASE_BUNDLE',
        author_pubkey: 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV',
        created_at: new Date().toISOString(),
        body: createSampleReleaseBundle(overrides.bundle),
        sig: 'SIG_K1_test_signature',
        ...overrides.event
    };
}

/**
 * Helper to create a Neo4j record mock with properties
 *
 * @param {Object} properties - Node properties
 * @param {string[]} labels - Node labels (e.g., ['Person'])
 * @returns {Object} Mock Neo4j record
 */
export function createMockNeo4jRecord(data) {
    return {
        get: jest.fn((key) => data[key]),
        toObject: jest.fn(() => data),
        keys: Object.keys(data)
    };
}

/**
 * Helper to create a Neo4j node mock
 *
 * @param {Object} properties - Node properties
 * @param {string[]} labels - Node labels
 * @returns {Object} Mock Neo4j node
 */
export function createMockNeo4jNode(properties, labels = []) {
    return {
        properties,
        labels,
        identity: { low: 1, high: 0 }
    };
}
