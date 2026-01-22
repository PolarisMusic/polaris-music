/**
 * @fileoverview Tests for EventProcessor injection mode
 *
 * Verifies that EventProcessor can be instantiated in injection mode
 * (with pre-initialized db and store) without blockchain config,
 * as needed by the API server.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import EventProcessor from '../../src/indexer/eventProcessor.js';

describe('EventProcessor Injection Mode', () => {
    let mockDb;
    let mockStore;

    beforeEach(() => {
        // Create mock database
        mockDb = {
            driver: {
                session: jest.fn(() => ({
                    close: jest.fn()
                }))
            },
            testConnection: jest.fn().mockResolvedValue(true),
            close: jest.fn().mockResolvedValue(undefined)
        };

        // Create mock event store
        mockStore = {
            retrieveEvent: jest.fn(),
            storeEvent: jest.fn(),
            calculateHash: jest.fn(),
            testConnectivity: jest.fn().mockResolvedValue({ ipfs: false, s3: false, redis: false }),
            close: jest.fn().mockResolvedValue(undefined)
        };
    });

    describe('Constructor', () => {
        it('should initialize in injection mode with {db, store}', () => {
            // Should not throw
            const processor = new EventProcessor({ db: mockDb, store: mockStore });

            expect(processor).toBeDefined();
            expect(processor.db).toBe(mockDb);
            expect(processor.store).toBe(mockStore);
            expect(processor.blockchainEnabled).toBe(false);
            expect(processor.rpc).toBeNull();
        });

        it('should create event handlers even in injection mode', () => {
            const processor = new EventProcessor({ db: mockDb, store: mockStore });

            expect(processor.eventHandlers).toBeDefined();
            expect(typeof processor.eventHandlers).toBe('object');
            expect(Object.keys(processor.eventHandlers).length).toBeGreaterThan(0);

            // Check that handlers are functions
            expect(typeof processor.eventHandlers[21]).toBe('function'); // CREATE_RELEASE_BUNDLE
            expect(typeof processor.eventHandlers[60]).toBe('function'); // MERGE_ENTITY
        });

        it('should initialize statistics in injection mode', () => {
            const processor = new EventProcessor({ db: mockDb, store: mockStore });

            expect(processor.stats).toBeDefined();
            expect(processor.stats.eventsProcessed).toBe(0);
            expect(processor.stats.errors).toBe(0);
        });

        it('should throw error if neither injection mode nor blockchain config provided', () => {
            expect(() => {
                new EventProcessor({});
            }).toThrow('EventProcessor requires either {db, store} or {blockchain, database, storage}');
        });
    });

    describe('Blockchain Methods Guard', () => {
        let processor;

        beforeEach(() => {
            processor = new EventProcessor({ db: mockDb, store: mockStore });
        });

        it('should throw clear error when start() called in injection mode', async () => {
            await expect(processor.start()).rejects.toThrow(
                'EventProcessor.start() requires blockchain configuration'
            );
        });

        it('should throw clear error when processLoop() called in injection mode', async () => {
            await expect(processor.processLoop()).rejects.toThrow(
                'processLoop() not available in injection mode'
            );
        });

        it('should throw clear error when processBlockRange() called in injection mode', async () => {
            await expect(processor.processBlockRange(100, 200)).rejects.toThrow(
                'processBlockRange() not available in injection mode'
            );
        });

        it('should throw clear error when getActionsInRange() called in injection mode', async () => {
            await expect(processor.getActionsInRange(100, 200)).rejects.toThrow(
                'getActionsInRange() not available in injection mode'
            );
        });
    });

    describe('API Server Compatibility', () => {
        it('should allow IngestionHandler to access eventHandlers', () => {
            const processor = new EventProcessor({ db: mockDb, store: mockStore });

            // Simulate what IngestionHandler does
            const eventType = 21; // CREATE_RELEASE_BUNDLE
            const handler = processor.eventHandlers[eventType];

            expect(handler).toBeDefined();
            expect(typeof handler).toBe('function');
        });

        it('should match the way APIServer constructs EventProcessor', () => {
            // This is how backend/src/api/server.js constructs it
            const processor = new EventProcessor({
                db: mockDb,
                store: mockStore
            });

            expect(processor).toBeDefined();
            expect(processor.blockchainEnabled).toBe(false);
            expect(processor.eventHandlers).toBeDefined();
        });
    });
});
