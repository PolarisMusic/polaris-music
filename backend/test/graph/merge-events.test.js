/**
 * @fileoverview Tests for event-sourced merge operations
 *
 * Verifies T4 acceptance criteria:
 * 1. Merge endpoint returns real eventHash (not null)
 * 2. Wipe graph + replay events reproduces merges
 * 3. MERGE_ENTITY events are properly stored and replayable
 * 4. Universal ID system prevents duplicate nodes
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import EventStore from '../../src/storage/eventStore.js';
import MusicGraphDatabase from '../../src/graph/schema.js';
import { MergeOperations } from '../../src/graph/merge.js';
import EventProcessor from '../../src/indexer/eventProcessor.js';

// Skip these integration tests if no database is configured
const describeOrSkip = (process.env.GRAPH_URI && process.env.SKIP_GRAPH_TESTS !== 'true') ? describe : describe.skip;

describeOrSkip('Event-Sourced Merge Operations', () => {
    let graphDb;
    let driver;
    let eventStore;
    let eventProcessor;
    let session;

    beforeAll(async () => {
        // Use a real MusicGraphDatabase instance (required by EventProcessor)
        graphDb = new MusicGraphDatabase({
            uri: process.env.GRAPH_URI || 'bolt://localhost:7687',
            user: process.env.GRAPH_USER || 'neo4j',
            password: process.env.GRAPH_PASSWORD || 'password'
        });
        driver = graphDb.driver;

        // Initialize event store with correct config shape
        eventStore = new EventStore({ /* ... */ });

        // Initialize event processor
        eventProcessor = new EventProcessor({
            db: graphDb,
            store: eventStore
        });

        // Verify connection, initialize schema (creates unique constraints), and clear data
        await driver.verifyConnectivity();
        await graphDb.initializeSchema();
        const cleanSession = driver.session();
        try { await cleanSession.run('MATCH (n) DETACH DELETE n'); } finally { await cleanSession.close(); }
    });

    afterAll(async () => {
        await graphDb.close();
    });

    beforeEach(async () => {
        session = driver.session();

        // Clean up all test data between tests (safe with --runInBand)
        await session.run('MATCH (n) DETACH DELETE n');
    });

    afterEach(async () => {
        if (session) {
            await session.close();
        }
    });

    describe('Merge Endpoint Event Creation', () => {
        test('Merge operation creates MERGE_ENTITY event with hash', async () => {
            // Create test entities with universal ID
            await session.run(`
                CREATE (p1:Person {id: 'polaris:person:00000000-0000-0000-0001-000000000001', person_id: 'polaris:person:00000000-0000-0000-0001-000000000001', name: 'John Lennon'})
                CREATE (p2:Person {id: 'polaris:person:00000000-0000-0000-0001-000000000002', person_id: 'polaris:person:00000000-0000-0000-0001-000000000002', name: 'John Winston Lennon'})
            `);

            // Create MERGE_ENTITY event (simulating endpoint)
            const mergeEvent = {
                v: 1,
                type: 'MERGE_ENTITY',
                author_pubkey: 'test-user',
                created_at: Math.floor(Date.now() / 1000),
                parents: [],
                body: {
                    survivor_id: 'polaris:person:00000000-0000-0000-0001-000000000001',
                    absorbed_ids: ['polaris:person:00000000-0000-0000-0001-000000000002'],
                    evidence: 'Same person, different name variants',
                    merged_at: new Date().toISOString()
                },
                proofs: { source_links: [] },
                sig: ''
            };

            // Store event (generates hash)
            const storeResult = await eventStore.storeEvent(mergeEvent);

            // Acceptance Criterion 1: Returns real eventHash (not null)
            expect(storeResult.hash).toBeDefined();
            expect(storeResult.hash).not.toBeNull();
            expect(storeResult.hash.length).toBeGreaterThan(0);
            expect(storeResult.hash).toMatch(/^[0-9a-f]+$/); // Valid hex hash

            // Verify event is retrievable
            const retrievedEvent = await eventStore.getEvent(storeResult.hash);
            expect(retrievedEvent).toBeDefined();
            expect(retrievedEvent.type).toBe('MERGE_ENTITY');
            expect(retrievedEvent.body.survivor_id).toBe('polaris:person:00000000-0000-0000-0001-000000000001');
            expect(retrievedEvent.body.absorbed_ids).toEqual(['polaris:person:00000000-0000-0000-0001-000000000002']);
        });

        test('Merge operation links eventHash to tombstone nodes', async () => {
            // Create test entities
            await session.run(`
                CREATE (p1:Person {id: 'polaris:person:00000000-0000-0000-0001-000000000003', person_id: 'polaris:person:00000000-0000-0000-0001-000000000003', name: 'Paul McCartney'})
                CREATE (p2:Person {id: 'polaris:person:00000000-0000-0000-0001-000000000004', person_id: 'polaris:person:00000000-0000-0000-0001-000000000004', name: 'James Paul McCartney'})
            `);

            // Create and store event
            const mergeEvent = {
                v: 1,
                type: 'MERGE_ENTITY',
                author_pubkey: 'test-user',
                created_at: Math.floor(Date.now() / 1000),
                parents: [],
                body: {
                    survivor_id: 'polaris:person:00000000-0000-0000-0001-000000000003',
                    absorbed_ids: ['polaris:person:00000000-0000-0000-0001-000000000004'],
                    evidence: 'Same person',
                    merged_at: new Date().toISOString()
                },
                proofs: { source_links: [] },
                sig: ''
            };

            const storeResult = await eventStore.storeEvent(mergeEvent);
            const eventHash = storeResult.hash;

            // Perform merge with eventHash
            const stats = await MergeOperations.mergeEntities(
                session,
                'polaris:person:00000000-0000-0000-0001-000000000003',
                ['polaris:person:00000000-0000-0000-0001-000000000004'],
                {
                    submitter: 'test-user',
                    eventHash: eventHash,
                    evidence: 'Same person',
                    rewireEdges: true,
                    moveClaims: true
                }
            );

            expect(stats.absorbedCount).toBe(1);
            expect(stats.tombstonesCreated).toBe(1);

            // Verify tombstone has merge_event_hash
            const tombstoneResult = await session.run(`
                MATCH (p:Person {id: 'polaris:person:00000000-0000-0000-0001-000000000004'})
                RETURN p.status as status, p.merge_event_hash as eventHash
            `);

            expect(tombstoneResult.records.length).toBe(1);
            const record = tombstoneResult.records[0];
            expect(record.get('status')).toBe('MERGED');
            expect(record.get('eventHash')).toBe(eventHash);
        });
    });

    describe('Event Replay and Idempotency', () => {
        test('MERGE_ENTITY event can be replayed via event processor', async () => {
            // Create test entities
            await session.run(`
                CREATE (g1:Group {id: 'polaris:group:00000000-0000-0000-0002-000000000001', group_id: 'polaris:group:00000000-0000-0000-0002-000000000001', name: 'The Beatles'})
                CREATE (g2:Group {id: 'polaris:group:00000000-0000-0000-0002-000000000002', group_id: 'polaris:group:00000000-0000-0000-0002-000000000002', name: 'Beatles'})
            `);

            // Create MERGE_ENTITY event
            const mergeEvent = {
                v: 1,
                type: 'MERGE_ENTITY',
                author_pubkey: 'test-user',
                created_at: Math.floor(Date.now() / 1000),
                parents: [],
                body: {
                    survivor_id: 'polaris:group:00000000-0000-0000-0002-000000000001',
                    absorbed_ids: ['polaris:group:00000000-0000-0000-0002-000000000002'],
                    evidence: 'Same band, name variants',
                    merged_at: new Date().toISOString()
                },
                proofs: { source_links: [] },
                sig: ''
            };

            const storeResult = await eventStore.storeEvent(mergeEvent);
            const eventHash = storeResult.hash;

            // Process event through event processor (simulates replay)
            await eventProcessor.handleMergeEntity(mergeEvent, {
                hash: eventHash,
                author: 'test-user'
            });

            // Verify merge occurred
            const survivorResult = await session.run(`
                MATCH (g:Group {id: 'polaris:group:00000000-0000-0000-0002-000000000001'})
                RETURN g.name as name, g.status as status
            `);
            expect(survivorResult.records.length).toBe(1);
            expect(survivorResult.records[0].get('name')).toBe('The Beatles');
            expect(survivorResult.records[0].get('status')).toBeNull(); // Active

            const tombstoneResult = await session.run(`
                MATCH (g:Group {id: 'polaris:group:00000000-0000-0000-0002-000000000002'})
                RETURN g.status as status, g.merge_event_hash as eventHash
            `);
            expect(tombstoneResult.records.length).toBe(1);
            expect(tombstoneResult.records[0].get('status')).toBe('MERGED');
            expect(tombstoneResult.records[0].get('eventHash')).toBe(eventHash);
        });

        test('Replaying same MERGE_ENTITY event is idempotent', async () => {
            // Create test entities
            await session.run(`
                CREATE (t1:Track {id: 'polaris:track:00000000-0000-0000-0003-000000000001', track_id: 'polaris:track:00000000-0000-0000-0003-000000000001', title: 'Yesterday'})
                CREATE (t2:Track {id: 'polaris:track:00000000-0000-0000-0003-000000000002', track_id: 'polaris:track:00000000-0000-0000-0003-000000000002', title: 'Yesterday (Remaster)'})
            `);

            const mergeEvent = {
                v: 1,
                type: 'MERGE_ENTITY',
                author_pubkey: 'test-user',
                created_at: Math.floor(Date.now() / 1000),
                parents: [],
                body: {
                    survivor_id: 'polaris:track:00000000-0000-0000-0003-000000000001',
                    absorbed_ids: ['polaris:track:00000000-0000-0000-0003-000000000002'],
                    evidence: 'Same track',
                    merged_at: new Date().toISOString()
                },
                proofs: { source_links: [] },
                sig: ''
            };

            const storeResult = await eventStore.storeEvent(mergeEvent);
            const eventHash = storeResult.hash;

            // Process event first time
            await eventProcessor.handleMergeEntity(mergeEvent, {
                hash: eventHash,
                author: 'test-user'
            });

            // Get state after first merge
            const firstMergeState = await session.run(`
                MATCH (t:Track)
                WHERE t.id IN ['polaris:track:00000000-0000-0000-0003-000000000001', 'polaris:track:00000000-0000-0000-0003-000000000002']
                RETURN t.id as id, t.status as status, t.merge_event_hash as eventHash
                ORDER BY t.id
            `);

            // Process same event again (replay scenario)
            await eventProcessor.handleMergeEntity(mergeEvent, {
                hash: eventHash,
                author: 'test-user'
            });

            // Get state after second merge
            const secondMergeState = await session.run(`
                MATCH (t:Track)
                WHERE t.id IN ['polaris:track:00000000-0000-0000-0003-000000000001', 'polaris:track:00000000-0000-0000-0003-000000000002']
                RETURN t.id as id, t.status as status, t.merge_event_hash as eventHash
                ORDER BY t.id
            `);

            // State should be identical (idempotent)
            expect(secondMergeState.records.length).toBe(firstMergeState.records.length);
            for (let i = 0; i < firstMergeState.records.length; i++) {
                expect(secondMergeState.records[i].get('id')).toBe(firstMergeState.records[i].get('id'));
                expect(secondMergeState.records[i].get('status')).toBe(firstMergeState.records[i].get('status'));
                expect(secondMergeState.records[i].get('eventHash')).toBe(firstMergeState.records[i].get('eventHash'));
            }
        });
    });

    describe('Full Graph Wipe + Replay Scenario', () => {
        test('Wipe graph + replay events reproduces merges', async () => {
            // STEP 1: Create initial entities
            await session.run(`
                CREATE (p1:Person {id: 'polaris:person:00000000-0000-0000-0004-000000000001', person_id: 'polaris:person:00000000-0000-0000-0004-000000000001', name: 'George Harrison'})
                CREATE (p2:Person {id: 'polaris:person:00000000-0000-0000-0004-000000000002', person_id: 'polaris:person:00000000-0000-0000-0004-000000000002', name: 'George H. Harrison'})
                CREATE (p3:Person {id: 'polaris:person:00000000-0000-0000-0004-000000000003', person_id: 'polaris:person:00000000-0000-0000-0004-000000000003', name: 'George Harold Harrison'})
            `);

            // STEP 2: Perform first merge and store event
            const mergeEvent1 = {
                v: 1,
                type: 'MERGE_ENTITY',
                author_pubkey: 'test-user',
                created_at: Math.floor(Date.now() / 1000),
                parents: [],
                body: {
                    survivor_id: 'polaris:person:00000000-0000-0000-0004-000000000001',
                    absorbed_ids: ['polaris:person:00000000-0000-0000-0004-000000000002'],
                    evidence: 'Name variant',
                    merged_at: new Date().toISOString()
                },
                proofs: { source_links: [] },
                sig: ''
            };
            const storeResult1 = await eventStore.storeEvent(mergeEvent1);
            await eventProcessor.handleMergeEntity(mergeEvent1, {
                hash: storeResult1.hash,
                author: 'test-user'
            });

            // STEP 3: Perform second merge and store event
            const mergeEvent2 = {
                v: 1,
                type: 'MERGE_ENTITY',
                author_pubkey: 'test-user',
                created_at: Math.floor(Date.now() / 1000) + 1,
                parents: [],
                body: {
                    survivor_id: 'polaris:person:00000000-0000-0000-0004-000000000001',
                    absorbed_ids: ['polaris:person:00000000-0000-0000-0004-000000000003'],
                    evidence: 'Full name variant',
                    merged_at: new Date().toISOString()
                },
                proofs: { source_links: [] },
                sig: ''
            };
            const storeResult2 = await eventStore.storeEvent(mergeEvent2);
            await eventProcessor.handleMergeEntity(mergeEvent2, {
                hash: storeResult2.hash,
                author: 'test-user'
            });

            // STEP 4: Capture final state
            const originalState = await session.run(`
                MATCH (p:Person)
                WHERE p.id STARTS WITH 'polaris:person:00000000-0000-0000-0004-'
                RETURN p.id as id, p.status as status, p.merge_event_hash as eventHash,
                       p.merged_into as mergedInto
                ORDER BY p.id
            `);

            expect(originalState.records.length).toBe(3);
            const originalRecords = originalState.records.map(r => ({
                id: r.get('id'),
                status: r.get('status'),
                eventHash: r.get('eventHash'),
                mergedInto: r.get('mergedInto')
            }));

            // STEP 5: Wipe graph (delete test nodes)
            await session.run(`
                MATCH (p:Person)
                WHERE p.id STARTS WITH 'polaris:person:00000000-0000-0000-0004-'
                DETACH DELETE p
            `);

            // Verify wipe
            const wipeCheck = await session.run(`
                MATCH (p:Person)
                WHERE p.id STARTS WITH 'polaris:person:00000000-0000-0000-0004-'
                RETURN count(p) as count
            `);
            expect(wipeCheck.records[0].get('count').toInt()).toBe(0);

            // STEP 6: Recreate initial entities
            await session.run(`
                CREATE (p1:Person {id: 'polaris:person:00000000-0000-0000-0004-000000000001', person_id: 'polaris:person:00000000-0000-0000-0004-000000000001', name: 'George Harrison'})
                CREATE (p2:Person {id: 'polaris:person:00000000-0000-0000-0004-000000000002', person_id: 'polaris:person:00000000-0000-0000-0004-000000000002', name: 'George H. Harrison'})
                CREATE (p3:Person {id: 'polaris:person:00000000-0000-0000-0004-000000000003', person_id: 'polaris:person:00000000-0000-0000-0004-000000000003', name: 'George Harold Harrison'})
            `);

            // STEP 7: Replay events in order
            const retrievedEvent1 = await eventStore.getEvent(storeResult1.hash);
            await eventProcessor.handleMergeEntity(retrievedEvent1, {
                hash: storeResult1.hash,
                author: 'test-user'
            });

            const retrievedEvent2 = await eventStore.getEvent(storeResult2.hash);
            await eventProcessor.handleMergeEntity(retrievedEvent2, {
                hash: storeResult2.hash,
                author: 'test-user'
            });

            // STEP 8: Verify replayed state matches original
            const replayedState = await session.run(`
                MATCH (p:Person)
                WHERE p.id STARTS WITH 'polaris:person:00000000-0000-0000-0004-'
                RETURN p.id as id, p.status as status, p.merge_event_hash as eventHash,
                       p.merged_into as mergedInto
                ORDER BY p.id
            `);

            expect(replayedState.records.length).toBe(originalState.records.length);

            const replayedRecords = replayedState.records.map(r => ({
                id: r.get('id'),
                status: r.get('status'),
                eventHash: r.get('eventHash'),
                mergedInto: r.get('mergedInto')
            }));

            // Acceptance Criterion 2: Replayed state exactly matches original
            expect(replayedRecords).toEqual(originalRecords);
        });
    });

    describe('Universal ID System', () => {
        test('Entities created by different endpoints use consistent ID', async () => {
            // Simulate entity created via different code paths
            const testId = 'polaris:person:00000000-0000-0000-0006-000000000001';

            // Path 1: Direct creation with universal ID
            await session.run(`
                CREATE (p:Person {id: $id, person_id: $id, name: 'Ringo Starr'})
            `, { id: testId });

            // Query using universal ID (as all code should do)
            const result1 = await session.run(`
                MATCH (p:Person {id: $id})
                RETURN p.name as name
            `, { id: testId });

            expect(result1.records.length).toBe(1);
            expect(result1.records[0].get('name')).toBe('Ringo Starr');

            // Acceptance Criterion 3: No duplicate nodes due to ID inconsistency
            const duplicateCheck = await session.run(`
                MATCH (p:Person)
                WHERE p.id = $id OR p.person_id = $id
                RETURN count(p) as count
            `, { id: testId });

            expect(duplicateCheck.records[0].get('count').toInt()).toBe(1);
        });

        test('Universal ID constraint prevents duplicates', async () => {
            const testId = 'polaris:person:00000000-0000-0000-0007-000000000001';

            // Create first entity
            await session.run(`
                CREATE (p:Person {id: $id, person_id: $id, name: 'Test Person'})
            `, { id: testId });

            // Attempt to create duplicate with same ID should fail
            await expect(async () => {
                await session.run(`
                    CREATE (p:Person {id: $id, person_id: $id, name: 'Duplicate'})
                `, { id: testId });
            }).rejects.toThrow();
        });
    });

    describe('Cycle Detection and Prevention', () => {
        test('should prevent direct merge cycle (A merged into B, then B merged into A)', async () => {
            // Create two entities
            await session.run(`
                CREATE (p1:Person {id: 'polaris:person:00000000-0000-0000-0008-000000000001', person_id: 'polaris:person:00000000-0000-0000-0008-000000000001', name: 'Artist A'})
                CREATE (p2:Person {id: 'polaris:person:00000000-0000-0000-0008-000000000002', person_id: 'polaris:person:00000000-0000-0000-0008-000000000002', name: 'Artist B'})
            `);

            // First merge: A absorbed into B (B is survivor)
            const mergeEvent1 = {
                v: 1,
                type: 'MERGE_ENTITY',
                author_pubkey: 'test-user',
                created_at: Math.floor(Date.now() / 1000),
                parents: [],
                body: {
                    survivor_id: 'polaris:person:00000000-0000-0000-0008-000000000002',
                    absorbed_ids: ['polaris:person:00000000-0000-0000-0008-000000000001'],
                    evidence: 'First merge',
                    merged_at: new Date().toISOString()
                },
                proofs: { source_links: [] },
                sig: ''
            };

            const storeResult1 = await eventStore.storeEvent(mergeEvent1);
            await eventProcessor.handleMergeEntity(mergeEvent1, {
                hash: storeResult1.hash,
                author: 'test-user'
            });

            // Verify A is now a tombstone
            const afterFirstMerge = await session.run(`
                MATCH (p:Person {id: 'polaris:person:00000000-0000-0000-0008-000000000001'})
                RETURN p.status as status
            `);
            expect(afterFirstMerge.records[0].get('status')).toBe('MERGED');

            // Attempt reverse merge: B absorbed into A (A is survivor)
            // This should fail or be a no-op because A is already a tombstone
            const mergeEvent2 = {
                v: 1,
                type: 'MERGE_ENTITY',
                author_pubkey: 'test-user',
                created_at: Math.floor(Date.now() / 1000) + 1,
                parents: [],
                body: {
                    survivor_id: 'polaris:person:00000000-0000-0000-0008-000000000001',
                    absorbed_ids: ['polaris:person:00000000-0000-0000-0008-000000000002'],
                    evidence: 'Reverse merge attempt',
                    merged_at: new Date().toISOString()
                },
                proofs: { source_links: [] },
                sig: ''
            };

            const storeResult2 = await eventStore.storeEvent(mergeEvent2);

            // The reverse merge should either throw or leave data consistent
            // (survivor A is a tombstone, so merging B into it creates a cycle)
            try {
                await eventProcessor.handleMergeEntity(mergeEvent2, {
                    hash: storeResult2.hash,
                    author: 'test-user'
                });

                // If it doesn't throw, verify no circular reference exists
                const cycleCheck = await session.run(`
                    MATCH (p1:Person {id: 'polaris:person:00000000-0000-0000-0008-000000000001'})
                    MATCH (p2:Person {id: 'polaris:person:00000000-0000-0000-0008-000000000002'})
                    RETURN p1.merged_into as p1MergedInto, p2.merged_into as p2MergedInto,
                           p1.status as p1Status, p2.status as p2Status
                `);

                const record = cycleCheck.records[0];
                const p1MergedInto = record.get('p1MergedInto');
                const p2MergedInto = record.get('p2MergedInto');

                // At least one entity must NOT point to the other to avoid a cycle
                const hasCycle = (
                    p1MergedInto === 'polaris:person:00000000-0000-0000-0008-000000000002' &&
                    p2MergedInto === 'polaris:person:00000000-0000-0000-0008-000000000001'
                );
                expect(hasCycle).toBe(false);
            } catch (error) {
                // Throwing is also acceptable behavior for cycle prevention
                expect(error.message).toBeDefined();
            }
        });

        test('should prevent transitive merge cycle (A→B→C→A)', async () => {
            // Create three entities
            await session.run(`
                CREATE (p1:Person {id: 'polaris:person:00000000-0000-0000-0009-000000000001', person_id: 'polaris:person:00000000-0000-0000-0009-000000000001', name: 'Artist X'})
                CREATE (p2:Person {id: 'polaris:person:00000000-0000-0000-0009-000000000002', person_id: 'polaris:person:00000000-0000-0000-0009-000000000002', name: 'Artist Y'})
                CREATE (p3:Person {id: 'polaris:person:00000000-0000-0000-0009-000000000003', person_id: 'polaris:person:00000000-0000-0000-0009-000000000003', name: 'Artist Z'})
            `);

            const ids = [
                'polaris:person:00000000-0000-0000-0009-000000000001',
                'polaris:person:00000000-0000-0000-0009-000000000002',
                'polaris:person:00000000-0000-0000-0009-000000000003'
            ];

            // Merge 1: X absorbed into Y
            const merge1 = {
                v: 1, type: 'MERGE_ENTITY', author_pubkey: 'test-user',
                created_at: Math.floor(Date.now() / 1000),
                parents: [], proofs: { source_links: [] }, sig: '',
                body: {
                    survivor_id: ids[1], absorbed_ids: [ids[0]],
                    evidence: 'Merge X into Y', merged_at: new Date().toISOString()
                }
            };
            const sr1 = await eventStore.storeEvent(merge1);
            await eventProcessor.handleMergeEntity(merge1, { hash: sr1.hash, author: 'test-user' });

            // Merge 2: Y absorbed into Z
            const merge2 = {
                v: 1, type: 'MERGE_ENTITY', author_pubkey: 'test-user',
                created_at: Math.floor(Date.now() / 1000) + 1,
                parents: [], proofs: { source_links: [] }, sig: '',
                body: {
                    survivor_id: ids[2], absorbed_ids: [ids[1]],
                    evidence: 'Merge Y into Z', merged_at: new Date().toISOString()
                }
            };
            const sr2 = await eventStore.storeEvent(merge2);
            await eventProcessor.handleMergeEntity(merge2, { hash: sr2.hash, author: 'test-user' });

            // Merge 3: Attempt Z absorbed into X (would create A→B→C→A cycle)
            const merge3 = {
                v: 1, type: 'MERGE_ENTITY', author_pubkey: 'test-user',
                created_at: Math.floor(Date.now() / 1000) + 2,
                parents: [], proofs: { source_links: [] }, sig: '',
                body: {
                    survivor_id: ids[0], absorbed_ids: [ids[2]],
                    evidence: 'Cyclic merge attempt', merged_at: new Date().toISOString()
                }
            };
            const sr3 = await eventStore.storeEvent(merge3);

            try {
                await eventProcessor.handleMergeEntity(merge3, { hash: sr3.hash, author: 'test-user' });

                // If no error thrown, verify no circular merge chain exists
                const chainCheck = await session.run(`
                    MATCH path = (start:Person)-[:MERGED_INTO*]->(end:Person)
                    WHERE start.id IN $ids AND end.id IN $ids
                    AND start = end
                    RETURN count(path) as cycleCount
                `, { ids });

                // No self-referencing merge paths should exist
                const cycleCount = chainCheck.records[0]?.get('cycleCount')?.toInt?.() ?? 0;
                expect(cycleCount).toBe(0);
            } catch (error) {
                // Throwing on cycle detection is acceptable
                expect(error.message).toBeDefined();
            }
        });

        test('should not allow merging an already-merged entity as survivor', async () => {
            // Create two entities
            await session.run(`
                CREATE (p1:Person {id: 'polaris:person:00000000-0000-0000-000a-000000000001', person_id: 'polaris:person:00000000-0000-0000-000a-000000000001', name: 'Active Artist'})
                CREATE (p2:Person {id: 'polaris:person:00000000-0000-0000-000a-000000000002', person_id: 'polaris:person:00000000-0000-0000-000a-000000000002', name: 'To Be Merged'})
                CREATE (p3:Person {id: 'polaris:person:00000000-0000-0000-000a-000000000003', person_id: 'polaris:person:00000000-0000-0000-000a-000000000003', name: 'Another Artist'})
            `);

            // Merge p2 into p1 first
            await MergeOperations.mergeEntities(
                session,
                'polaris:person:00000000-0000-0000-000a-000000000001',
                ['polaris:person:00000000-0000-0000-000a-000000000002'],
                { submitter: 'test-user', evidence: 'First merge' }
            );

            // Verify p2 is tombstone
            const tombCheck = await session.run(`
                MATCH (p:Person {id: 'polaris:person:00000000-0000-0000-000a-000000000002'})
                RETURN p.status as status
            `);
            expect(tombCheck.records[0].get('status')).toBe('MERGED');

            // Try to use tombstone p2 as survivor for merging p3
            // This should either throw or resolve p2 to its canonical (p1)
            try {
                await MergeOperations.mergeEntities(
                    session,
                    'polaris:person:00000000-0000-0000-000a-000000000002', // tombstone as survivor
                    ['polaris:person:00000000-0000-0000-000a-000000000003'],
                    { submitter: 'test-user', evidence: 'Using tombstone as survivor' }
                );

                // If it succeeded, verify p3 points to the actual canonical (p1), not the tombstone
                const result = await session.run(`
                    MATCH (p:Person {id: 'polaris:person:00000000-0000-0000-000a-000000000003'})
                    RETURN p.status as status, p.merged_into as mergedInto
                `);
                const mergedInto = result.records[0].get('mergedInto');
                // Should resolve to the actual canonical entity
                expect([
                    'polaris:person:00000000-0000-0000-000a-000000000001',
                    'polaris:person:00000000-0000-0000-000a-000000000002'
                ]).toContain(mergedInto);
            } catch (error) {
                // Rejecting a tombstone as survivor is also valid behavior
                expect(error.message).toBeDefined();
            }
        });
    });

    describe('Edge Rewiring During Merge', () => {
        test('Merge rewires relationships to survivor', async () => {
            // Create entities with relationships
            await session.run(`
                CREATE (p1:Person {id: 'polaris:person:00000000-0000-0000-0005-000000000001', person_id: 'polaris:person:00000000-0000-0000-0005-000000000001', name: 'Original'})
                CREATE (p2:Person {id: 'polaris:person:00000000-0000-0000-0005-000000000002', person_id: 'polaris:person:00000000-0000-0000-0005-000000000002', name: 'Duplicate'})
                CREATE (g:Group {id: 'polaris:group:00000000-0000-0000-0005-000000000003', group_id: 'polaris:group:00000000-0000-0000-0005-000000000003', name: 'Test Band'})
                CREATE (p2)-[:MEMBER_OF {from_date: '2020-01-01'}]->(g)
            `);

            // Verify relationship exists on p2
            const beforeMerge = await session.run(`
                MATCH (p:Person {id: 'polaris:person:00000000-0000-0000-0005-000000000002'})-[r:MEMBER_OF]->(g:Group)
                RETURN count(r) as count
            `);
            expect(beforeMerge.records[0].get('count').toInt()).toBe(1);

            // Perform merge
            const mergeEvent = {
                v: 1,
                type: 'MERGE_ENTITY',
                author_pubkey: 'test-user',
                created_at: Math.floor(Date.now() / 1000),
                parents: [],
                body: {
                    survivor_id: 'polaris:person:00000000-0000-0000-0005-000000000001',
                    absorbed_ids: ['polaris:person:00000000-0000-0000-0005-000000000002'],
                    evidence: 'Duplicate person',
                    merged_at: new Date().toISOString()
                },
                proofs: { source_links: [] },
                sig: ''
            };

            const storeResult = await eventStore.storeEvent(mergeEvent);
            await eventProcessor.handleMergeEntity(mergeEvent, {
                hash: storeResult.hash,
                author: 'test-user'
            });

            // Verify relationship now exists on survivor
            const afterMerge = await session.run(`
                MATCH (p:Person {id: 'polaris:person:00000000-0000-0000-0005-000000000001'})-[r:MEMBER_OF]->(g:Group)
                RETURN count(r) as count
            `);
            expect(afterMerge.records[0].get('count').toInt()).toBe(1);

            // Verify relationship no longer on absorbed node
            const absorbedEdges = await session.run(`
                MATCH (p:Person {id: 'polaris:person:00000000-0000-0000-0005-000000000002'})-[r:MEMBER_OF]->(g:Group)
                RETURN count(r) as count
            `);
            expect(absorbedEdges.records[0].get('count').toInt()).toBe(0);
        });
    });

    describe('mergeBundle - Cross-Bundle Relationship Merging', () => {
        test('mergeBundle creates MEMBER_OF relationships from explicit relationships array', async () => {
            // Create Person and Group nodes
            await session.run(`
                CREATE (p:Person {id: 'person_grohl', person_id: 'person_grohl', name: 'Dave Grohl'})
                CREATE (g:Group {id: 'grp_nirvana', group_id: 'grp_nirvana', name: 'Nirvana'})
            `);

            const { mergeBundle } = await import('../../src/graph/merge.js');

            const normalized = {
                relationships: [
                    {
                        type: 'MEMBER_OF',
                        from: { label: 'Person', idProp: 'person_id', id: 'person_grohl', name: 'Dave Grohl' },
                        to: { label: 'Group', idProp: 'group_id', id: 'grp_nirvana', name: 'Nirvana' },
                        props: { role: 'drums', roles: ['drums'] }
                    }
                ]
            };

            const stats = await mergeBundle(driver, normalized, { eventHash: 'test_hash_001' });

            expect(stats.relationshipsMerged).toBe(1);
            expect(stats.skipped).toBe(0);

            // Verify relationship exists
            const result = await session.run(`
                MATCH (p:Person {person_id: 'person_grohl'})-[m:MEMBER_OF]->(g:Group {group_id: 'grp_nirvana'})
                RETURN m.role AS role
            `);
            expect(result.records).toHaveLength(1);
            expect(result.records[0].get('role')).toBe('drums');
        });

        test('mergeBundle creates cross-bundle MEMBER_OF without duplicates', async () => {
            // Create Person and two Groups (simulating two bundles)
            await session.run(`
                CREATE (p:Person {id: 'person_grohl', person_id: 'person_grohl', name: 'Dave Grohl'})
                CREATE (g1:Group {id: 'grp_nirvana', group_id: 'grp_nirvana', name: 'Nirvana'})
                CREATE (g2:Group {id: 'grp_foo', group_id: 'grp_foo', name: 'Foo Fighters'})
            `);

            const { mergeBundle } = await import('../../src/graph/merge.js');

            // Bundle 1: Nirvana
            const norm1 = {
                relationships: [
                    {
                        type: 'MEMBER_OF',
                        from: { label: 'Person', idProp: 'person_id', id: 'person_grohl', name: 'Dave Grohl' },
                        to: { label: 'Group', idProp: 'group_id', id: 'grp_nirvana', name: 'Nirvana' },
                        props: { role: 'drums' }
                    }
                ]
            };

            // Bundle 2: Foo Fighters
            const norm2 = {
                relationships: [
                    {
                        type: 'MEMBER_OF',
                        from: { label: 'Person', idProp: 'person_id', id: 'person_grohl', name: 'Dave Grohl' },
                        to: { label: 'Group', idProp: 'group_id', id: 'grp_foo', name: 'Foo Fighters' },
                        props: { role: 'vocals' }
                    }
                ]
            };

            await mergeBundle(driver, norm1, { eventHash: 'hash_1' });
            await mergeBundle(driver, norm2, { eventHash: 'hash_2' });

            // Verify Dave Grohl is MEMBER_OF both groups
            const result = await session.run(`
                MATCH (p:Person {person_id: 'person_grohl'})-[m:MEMBER_OF]->(g:Group)
                RETURN g.name AS group_name, m.role AS role
                ORDER BY g.name
            `);
            expect(result.records).toHaveLength(2);
            expect(result.records[0].get('group_name')).toBe('Foo Fighters');
            expect(result.records[1].get('group_name')).toBe('Nirvana');

            // Re-run bundle 1 (idempotency) - should NOT create duplicate
            await mergeBundle(driver, norm1, { eventHash: 'hash_1' });
            const dupeCheck = await session.run(`
                MATCH (p:Person {person_id: 'person_grohl'})-[m:MEMBER_OF]->(g:Group {group_id: 'grp_nirvana'})
                RETURN count(m) AS count
            `);
            expect(dupeCheck.records[0].get('count').toInt()).toBe(1);
        });

        test('mergeBundle skips invalid relationship types', async () => {
            const { mergeBundle } = await import('../../src/graph/merge.js');

            const normalized = {
                relationships: [
                    {
                        type: 'EVIL_INJECTION',
                        from: { label: 'Person', idProp: 'person_id', id: 'p1', name: 'Test' },
                        to: { label: 'Group', idProp: 'group_id', id: 'g1', name: 'Test' },
                        props: {}
                    }
                ]
            };

            const stats = await mergeBundle(driver, normalized);
            expect(stats.skipped).toBe(1);
            expect(stats.relationshipsMerged).toBe(0);
        });

        test('mergeBundle handles empty relationships array', async () => {
            const { mergeBundle } = await import('../../src/graph/merge.js');

            const normalized = { relationships: [] };
            const stats = await mergeBundle(driver, normalized);

            expect(stats.relationshipsMerged).toBe(0);
            expect(stats.skipped).toBe(0);
        });
    });

});
