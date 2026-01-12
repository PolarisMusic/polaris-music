/**
 * @fileoverview Tests for Chain Ingestion Handler
 *
 * Tests the ingestion of blockchain `put` actions that anchor content hashes
 * and require fetching full event data from off-chain storage.
 *
 * Note: Tests use unsigned events (no sig field) which are allowed in devMode
 * when NODE_ENV=test. This avoids needing to generate valid EOSIO signatures.
 */

import { describe, it, expect, beforeEach, afterAll, jest } from '@jest/globals';
import IngestionHandler from '../../src/api/ingestion.js';
import EventStore from '../../src/storage/eventStore.js';

describe('IngestionHandler', () => {
    let ingestionHandler;
    let mockEventStore;
    let mockEventProcessor;
    let mockEvent;
    let mockActionData;

    beforeEach(() => {
        // Create a mock event that would be stored off-chain
        mockEvent = {
            v: 1,
            type: 'CREATE_RELEASE_BUNDLE',
            author_pubkey: 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV',
            created_at: Math.floor(Date.now() / 1000),
            parents: [],
            body: {
                release: {
                    name: 'Test Album',
                    catalog_number: 'TEST001',
                    release_date: '2024-01-01',
                    format: 'Digital',
                    country: 'US'
                },
                groups: [
                    {
                        name: 'Test Artist',
                        type: 'person'
                    }
                ],
                tracks: [
                    {
                        position: '1',
                        title: 'Test Song',
                        duration: 180,
                        credits: []
                    }
                ]
            },
            proofs: {
                source_links: []
            }
            // Note: No sig field - devMode allows unsigned events in tests
        };

        // Mock EventStore
        mockEventStore = {
            retrieveEvent: jest.fn(),
            calculateHash: jest.fn(),
            storeEvent: jest.fn()
        };

        // Mock EventProcessor
        mockEventProcessor = {
            eventHandlers: {
                21: jest.fn() // CREATE_RELEASE_BUNDLE handler
            }
        };

        // Create ingestion handler
        ingestionHandler = new IngestionHandler(mockEventStore, mockEventProcessor);

        // Mock action data (what comes from the blockchain put action)
        mockActionData = {
            author: 'testuser1234',
            type: 21, // CREATE_RELEASE_BUNDLE
            hash: 'abc123def456', // Content hash
            ts: Math.floor(Date.now() / 1000),
            tags: ['rock', 'album']
        };
    });

    describe('processPutAction', () => {
        it('should fetch event from storage using content hash', async () => {
            // Setup: EventStore returns the mock event
            mockEventStore.retrieveEvent.mockResolvedValue(mockEvent);
            mockEventStore.calculateHash.mockReturnValue('abc123def456');

            // Act: Process the put action
            const result = await ingestionHandler.processPutAction(mockActionData);

            // Assert: retrieveEvent was called with correct hash
            expect(mockEventStore.retrieveEvent).toHaveBeenCalledWith('abc123def456', { requireSig: true });
            expect(result.status).toBe('success');
            expect(result.contentHash).toBe('abc123def456');
        });

        it('should attach blockchain metadata to fetched event', async () => {
            // Setup
            mockEventStore.retrieveEvent.mockResolvedValue(mockEvent);
            mockEventStore.calculateHash.mockReturnValue('abc123def456');

            const blockchainMetadata = {
                block_num: 12345,
                block_id: 'block_abc123',
                trx_id: 'trx_def456',
                action_ordinal: 0,
                source: 'substreams-eos'
            };

            // Act
            await ingestionHandler.processPutAction(mockActionData, blockchainMetadata);

            // Assert: Event processor called with enriched event
            expect(mockEventProcessor.eventHandlers[21]).toHaveBeenCalledWith(
                expect.objectContaining({
                    ...mockEvent,
                    blockchain_verified: true,
                    blockchain_metadata: expect.objectContaining({
                        anchor_hash: 'abc123def456',
                        block_num: 12345,
                        block_id: 'block_abc123',
                        trx_id: 'trx_def456',
                        action_ordinal: 0,
                        source: 'substreams-eos'
                    })
                }),
                expect.objectContaining({
                    hash: 'abc123def456',
                    type: 21,
                    author: 'testuser1234'
                })
            );
        });

        it('should call event processor with fetched event', async () => {
            // Setup
            mockEventStore.retrieveEvent.mockResolvedValue(mockEvent);
            mockEventStore.calculateHash.mockReturnValue('abc123def456');

            // Act
            await ingestionHandler.processPutAction(mockActionData);

            // Assert: Event handler was called
            expect(mockEventProcessor.eventHandlers[21]).toHaveBeenCalled();
        });

        it('should return not_found if event not in storage', async () => {
            // Setup: EventStore returns null (event not found)
            mockEventStore.retrieveEvent.mockResolvedValue(null);

            // Act
            const result = await ingestionHandler.processPutAction(mockActionData);

            // Assert
            expect(result.status).toBe('not_found');
            expect(result.contentHash).toBe('abc123def456');
            expect(ingestionHandler.stats.eventsNotFound).toBe(1);
        });

        it('should verify hash matches fetched event', async () => {
            // Setup: Hash mismatch
            mockEventStore.retrieveEvent.mockResolvedValue(mockEvent);
            mockEventStore.calculateHash.mockReturnValue('different_hash');

            // Act
            const result = await ingestionHandler.processPutAction(mockActionData);

            // Assert: Should fail with hash mismatch
            expect(result.status).toBe('failed');
            expect(result.error).toContain('Hash mismatch');
            expect(ingestionHandler.stats.eventsFailed).toBe(1);
        });

        it('should reject event when on-chain type does not match off-chain event.type', async () => {
            // Setup: On-chain says type 22 (MINT_ENTITY) but event says 'ADD_CLAIM'
            const wrongTypeEvent = {
                ...mockEvent,
                type: 'ADD_CLAIM' // Wrong type!
            };

            const mintEntityAction = {
                author: 'testuser1234',
                type: 22, // MINT_ENTITY
                hash: 'abc123def456',
                ts: Math.floor(Date.now() / 1000)
            };

            mockEventStore.retrieveEvent.mockResolvedValue(wrongTypeEvent);
            mockEventStore.calculateHash.mockReturnValue('abc123def456');

            // Mock handler for type 22
            mockEventProcessor.eventHandlers[22] = jest.fn();

            // Act
            const result = await ingestionHandler.processPutAction(mintEntityAction);

            // Assert: Should fail with type mismatch error
            expect(result.status).toBe('failed');
            expect(result.error).toContain('Type mismatch');
            expect(result.error).toContain('on-chain type 22 (MINT_ENTITY)');
            expect(result.error).toContain('ADD_CLAIM');
            expect(ingestionHandler.stats.eventsFailed).toBe(1);

            // Assert: Handler should NOT be called
            expect(mockEventProcessor.eventHandlers[22]).not.toHaveBeenCalled();
        });

        it('should accept event when on-chain type matches off-chain event.type (string)', async () => {
            // Setup: Both agree it's CREATE_RELEASE_BUNDLE
            const correctEvent = {
                ...mockEvent,
                type: 'CREATE_RELEASE_BUNDLE' // Matches type code 21
            };

            mockEventStore.retrieveEvent.mockResolvedValue(correctEvent);
            mockEventStore.calculateHash.mockReturnValue('abc123def456');

            // Act
            const result = await ingestionHandler.processPutAction(mockActionData);

            // Assert: Should succeed
            expect(result.status).toBe('success');
            expect(mockEventProcessor.eventHandlers[21]).toHaveBeenCalled();
        });

        it('should accept event when off-chain event.type is numeric', async () => {
            // Setup: Event uses numeric type (backward compatibility)
            const numericTypeEvent = {
                ...mockEvent,
                type: 21 // Numeric instead of string
            };

            mockEventStore.retrieveEvent.mockResolvedValue(numericTypeEvent);
            mockEventStore.calculateHash.mockReturnValue('abc123def456');

            // Act
            const result = await ingestionHandler.processPutAction(mockActionData);

            // Assert: Should succeed (allows numeric types)
            expect(result.status).toBe('success');
            expect(mockEventProcessor.eventHandlers[21]).toHaveBeenCalled();
        });

        it('should deduplicate events', async () => {
            // Setup
            mockEventStore.retrieveEvent.mockResolvedValue(mockEvent);
            mockEventStore.calculateHash.mockReturnValue('abc123def456');

            // Act: Process same event twice
            const result1 = await ingestionHandler.processPutAction(mockActionData);
            const result2 = await ingestionHandler.processPutAction(mockActionData);

            // Assert: First succeeds, second is duplicate
            expect(result1.status).toBe('success');
            expect(result2.status).toBe('duplicate');
            expect(ingestionHandler.stats.eventsDuplicate).toBe(1);
            expect(mockEventStore.retrieveEvent).toHaveBeenCalledTimes(1);
        });

        it('should handle missing hash field', async () => {
            // Setup: Action data without hash
            const invalidActionData = {
                author: 'testuser1234',
                type: 21,
                ts: Math.floor(Date.now() / 1000)
                // hash field missing
            };

            // Act & Assert
            await expect(
                ingestionHandler.processPutAction(invalidActionData)
            ).rejects.toThrow('Missing required field: hash');
        });

        it('should normalize hash formats', async () => {
            // Setup
            mockEventStore.retrieveEvent.mockResolvedValue(mockEvent);
            mockEventStore.calculateHash.mockReturnValue('abc123def456');

            // Test uppercase hash
            const actionWithUpperHash = {
                ...mockActionData,
                hash: 'ABC123DEF456'
            };

            // Act
            const result = await ingestionHandler.processPutAction(actionWithUpperHash);

            // Assert: Hash normalized to lowercase
            expect(result.status).toBe('success');
            expect(mockEventStore.retrieveEvent).toHaveBeenCalledWith('abc123def456', { requireSig: true });
        });

        it('should handle array hash format (checksum256)', async () => {
            // Setup
            mockEventStore.retrieveEvent.mockResolvedValue(mockEvent);
            mockEventStore.calculateHash.mockReturnValue('0102030405');

            const actionWithArrayHash = {
                ...mockActionData,
                hash: [1, 2, 3, 4, 5] // Byte array
            };

            // Act
            const result = await ingestionHandler.processPutAction(actionWithArrayHash);

            // Assert
            expect(result.status).toBe('success');
            expect(mockEventStore.retrieveEvent).toHaveBeenCalledWith('0102030405', { requireSig: true });
        });

        it('should update statistics on success', async () => {
            // Setup
            mockEventStore.retrieveEvent.mockResolvedValue(mockEvent);
            mockEventStore.calculateHash.mockReturnValue('abc123def456');

            // Act
            await ingestionHandler.processPutAction(mockActionData);

            // Assert
            const stats = ingestionHandler.getStats();
            expect(stats.eventsProcessed).toBe(1);
            expect(stats.eventsFailed).toBe(0);
            expect(stats.cacheSize).toBe(1);
        });

        it('should handle storage errors gracefully', async () => {
            // Setup: EventStore throws error
            mockEventStore.retrieveEvent.mockRejectedValue(
                new Error('Storage connection failed')
            );

            // Act
            const result = await ingestionHandler.processPutAction(mockActionData);

            // Assert: Should return failed status, not throw
            expect(result.status).toBe('failed');
            expect(result.error).toContain('Storage connection failed');
            expect(ingestionHandler.stats.eventsFailed).toBe(1);
        });

        it('should process events without blockchain metadata', async () => {
            // Setup
            mockEventStore.retrieveEvent.mockResolvedValue(mockEvent);
            mockEventStore.calculateHash.mockReturnValue('abc123def456');

            // Act: Process without blockchain metadata
            const result = await ingestionHandler.processPutAction(mockActionData);

            // Assert: Should succeed with default metadata
            expect(result.status).toBe('success');
            expect(mockEventProcessor.eventHandlers[21]).toHaveBeenCalledWith(
                expect.objectContaining({
                    blockchain_verified: true,
                    blockchain_metadata: expect.objectContaining({
                        anchor_hash: 'abc123def456',
                        source: 'unknown'
                    })
                }),
                expect.any(Object)
            );
        });
    });

    describe('normalizeHash', () => {
        it('should normalize hex string to lowercase', () => {
            const result = ingestionHandler.normalizeHash('ABCDEF123456');
            expect(result).toBe('abcdef123456');
        });

        it('should convert byte array to hex string', () => {
            const result = ingestionHandler.normalizeHash([171, 205, 239, 18, 52, 86]);
            expect(result).toBe('abcdef123456');
        });

        it('should extract hex from object', () => {
            const result = ingestionHandler.normalizeHash({ hex: 'ABCDEF123456' });
            expect(result).toBe('abcdef123456');
        });

        it('should strip 0x prefix from hex string', () => {
            const result = ingestionHandler.normalizeHash('0xABCDEF123456');
            expect(result).toBe('abcdef123456');
        });

        it('should strip 0x prefix from object hex field', () => {
            const result = ingestionHandler.normalizeHash({ hex: '0xABCDEF123456' });
            expect(result).toBe('abcdef123456');
        });

        it('should throw on invalid format', () => {
            expect(() => ingestionHandler.normalizeHash(12345)).toThrow('Invalid hash format');
        });
    });

    describe('processAnchoredEvent hash format handling', () => {
        let baseAnchoredEvent;

        beforeEach(() => {
            // Base anchored event structure
            baseAnchoredEvent = {
                event_hash: 'event_hash_123',
                payload: JSON.stringify({
                    author: 'testuser1234',
                    type: 21,
                    hash: 'abc123def456',
                    ts: Math.floor(Date.now() / 1000),
                    tags: ['test']
                }),
                block_num: 12345,
                block_id: 'block_id_123',
                trx_id: 'trx_id_123',
                action_ordinal: 0,
                timestamp: Date.now(),
                source: 'substreams-test',
                contract_account: 'polaris',
                action_name: 'put'
            };

            // Mock successful event retrieval
            mockEventStore.retrieveEvent.mockResolvedValue(mockEvent);
            mockEventStore.calculateHash.mockReturnValue('abc123def456');
        });

        it('should handle content_hash as hex string', async () => {
            // Arrange: content_hash is a hex string (most common format)
            const anchoredEvent = {
                ...baseAnchoredEvent,
                content_hash: 'abc123def456' // Hex string
            };

            // Act
            const result = await ingestionHandler.processAnchoredEvent(anchoredEvent);

            // Assert: Should process successfully
            expect(result.status).toBe('success');
            expect(result.contentHash).toBe('abc123def456');
            expect(mockEventStore.retrieveEvent).toHaveBeenCalledWith('abc123def456', { requireSig: true });
        });

        it('should handle content_hash as byte array', async () => {
            // Arrange: content_hash is a byte array (common in protobuf JSON)
            const anchoredEvent = {
                ...baseAnchoredEvent,
                content_hash: [171, 193, 35, 222, 244, 86] // Byte array
            };

            // Act
            const result = await ingestionHandler.processAnchoredEvent(anchoredEvent);

            // Assert: Should convert to hex string and process
            expect(result.status).toBe('success');
            expect(result.contentHash).toBe('abc123def456');
            expect(mockEventStore.retrieveEvent).toHaveBeenCalledWith('abc123def456', { requireSig: true });
        });

        it('should handle content_hash as object with hex field', async () => {
            // Arrange: content_hash is an object with hex field
            const anchoredEvent = {
                ...baseAnchoredEvent,
                content_hash: { hex: 'abc123def456' } // Object
            };

            // Act
            const result = await ingestionHandler.processAnchoredEvent(anchoredEvent);

            // Assert: Should extract hex and process
            expect(result.status).toBe('success');
            expect(result.contentHash).toBe('abc123def456');
            expect(mockEventStore.retrieveEvent).toHaveBeenCalledWith('abc123def456', { requireSig: true });
        });

        it('should handle content_hash with 0x prefix', async () => {
            // Arrange: content_hash has 0x prefix
            const anchoredEvent = {
                ...baseAnchoredEvent,
                content_hash: '0xabc123def456'
            };

            // Act
            const result = await ingestionHandler.processAnchoredEvent(anchoredEvent);

            // Assert: Should strip 0x prefix and process
            expect(result.status).toBe('success');
            expect(result.contentHash).toBe('abc123def456');
            expect(mockEventStore.retrieveEvent).toHaveBeenCalledWith('abc123def456', { requireSig: true });
        });

        it('should handle uppercase hex and normalize to lowercase', async () => {
            // Arrange: content_hash is uppercase
            const anchoredEvent = {
                ...baseAnchoredEvent,
                content_hash: 'ABC123DEF456'
            };

            // Act
            const result = await ingestionHandler.processAnchoredEvent(anchoredEvent);

            // Assert: Should normalize to lowercase
            expect(result.status).toBe('success');
            expect(result.contentHash).toBe('abc123def456');
            expect(mockEventStore.retrieveEvent).toHaveBeenCalledWith('abc123def456', { requireSig: true });
        });

        it('should deduplicate using normalized hash', async () => {
            // Arrange: Two events with same hash in different formats
            const event1 = {
                ...baseAnchoredEvent,
                content_hash: 'abc123def456' // String
            };
            const event2 = {
                ...baseAnchoredEvent,
                content_hash: [171, 193, 35, 222, 244, 86] // Array (same hash)
            };

            // Act: Process both
            const result1 = await ingestionHandler.processAnchoredEvent(event1);
            const result2 = await ingestionHandler.processAnchoredEvent(event2);

            // Assert: First succeeds, second is duplicate
            expect(result1.status).toBe('success');
            expect(result2.status).toBe('duplicate');
            expect(ingestionHandler.stats.eventsDuplicate).toBe(1);
        });
    });

    describe('cache management', () => {
        it('should clear deduplication cache', async () => {
            // Setup
            mockEventStore.retrieveEvent.mockResolvedValue(mockEvent);
            mockEventStore.calculateHash.mockReturnValue('abc123def456');

            // Add some hashes
            await ingestionHandler.processPutAction(mockActionData);

            // Act
            const cleared = ingestionHandler.clearCache();

            // Assert
            expect(cleared).toBe(1);
            expect(ingestionHandler.getStats().cacheSize).toBe(0);
        });

        it('should allow reprocessing after cache clear', async () => {
            // Setup
            mockEventStore.retrieveEvent.mockResolvedValue(mockEvent);
            mockEventStore.calculateHash.mockReturnValue('abc123def456');

            // Process, clear, process again
            await ingestionHandler.processPutAction(mockActionData);
            ingestionHandler.clearCache();
            const result = await ingestionHandler.processPutAction(mockActionData);

            // Assert: Should process again (not duplicate)
            expect(result.status).toBe('success');
            expect(ingestionHandler.stats.eventsProcessed).toBe(2);
            expect(ingestionHandler.stats.eventsDuplicate).toBe(0);
        });
    });

    describe('statistics', () => {
        it('should track success rate', async () => {
            // Setup
            mockEventStore.retrieveEvent
                .mockResolvedValueOnce(mockEvent)
                .mockResolvedValueOnce(mockEvent)
                .mockRejectedValueOnce(new Error('Failed'));

            mockEventStore.calculateHash.mockReturnValue('hash1');

            // Process 2 success, 1 failure
            await ingestionHandler.processPutAction({ ...mockActionData, hash: 'hash1' });
            mockEventStore.calculateHash.mockReturnValue('hash2');
            await ingestionHandler.processPutAction({ ...mockActionData, hash: 'hash2' });
            mockEventStore.calculateHash.mockReturnValue('hash3');
            await ingestionHandler.processPutAction({ ...mockActionData, hash: 'hash3' });

            // Assert
            const stats = ingestionHandler.getStats();
            expect(stats.eventsProcessed).toBe(2);
            expect(stats.eventsFailed).toBe(1);
            expect(stats.successRate).toBe('66.67%');
        });
    });

    // Cleanup to prevent worker exit issues
    afterAll(async () => {
        jest.restoreAllMocks();
    });
});
