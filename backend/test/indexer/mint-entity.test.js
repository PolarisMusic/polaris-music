/**
 * @fileoverview Tests for MINT_ENTITY event handler
 *
 * Verifies that:
 * 1. Nodes are created with both 'id' and entity-specific ID field (person_id, group_id, etc.)
 * 2. This satisfies Neo4j uniqueness constraints
 * 3. All entity types are handled correctly
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import neo4j from 'neo4j-driver';
import EventProcessor from '../../src/indexer/eventProcessor.js';
import EventStore from '../../src/storage/eventStore.js';

// Skip these tests if no database is configured
const describeOrSkip = process.env.GRAPH_URI ? describe : describe.skip;

describeOrSkip('MINT_ENTITY Event Handler', () => {
    let driver;
    let eventStore;
    let eventProcessor;
    let session;

    beforeAll(async () => {
        // Connect to test database
        driver = neo4j.driver(
            process.env.GRAPH_URI || 'bolt://localhost:7687',
            neo4j.auth.basic(
                process.env.GRAPH_USER || 'neo4j',
                process.env.GRAPH_PASSWORD || 'password'
            )
        );

        // Initialize event store (minimal config)
        eventStore = new EventStore({
            ipfs: null,
            s3: null,
            redis: null
        });

        // Initialize event processor in injection mode
        eventProcessor = new EventProcessor({
            db: { driver },
            store: eventStore
        });

        // Initialize schema (creates constraints)
        const GraphDB = (await import('../../src/graph/schema.js')).default;
        const graphDB = new GraphDB({ driver });
        await graphDB.initializeSchema();
    });

    afterAll(async () => {
        if (session) await session.close();
        if (driver) await driver.close();
    });

    beforeEach(async () => {
        session = driver.session();

        // Clean up test nodes
        await session.run(`
            MATCH (n)
            WHERE n.id STARTS WITH 'polaris:person:test-'
               OR n.id STARTS WITH 'polaris:group:test-'
               OR n.id STARTS WITH 'polaris:song:test-'
            DETACH DELETE n
        `);
    });

    afterEach(async () => {
        if (session) {
            await session.close();
            session = null;
        }
    });

    test('Person node created with both id and person_id', async () => {
        const event = {
            body: {
                entity_type: 'person',
                canonical_id: 'polaris:person:test-mint-1',
                initial_claims: [],
                provenance: {
                    submitter: 'test-user',
                    source: 'test'
                }
            }
        };

        const actionData = {
            hash: 'test-hash-123',
            author: 'test-user'
        };

        await eventProcessor.handleMintEntity(event, actionData);

        // Verify node exists with both id and person_id
        const result = await session.run(`
            MATCH (p:Person {id: $id})
            RETURN p.id as id, p.person_id as person_id, p.status as status
        `, { id: 'polaris:person:test-mint-1' });

        expect(result.records.length).toBe(1);
        const record = result.records[0];
        expect(record.get('id')).toBe('polaris:person:test-mint-1');
        expect(record.get('person_id')).toBe('polaris:person:test-mint-1'); // CRITICAL: Must be set
        expect(record.get('status')).toBe('ACTIVE');
    });

    test('Group node created with both id and group_id', async () => {
        const event = {
            body: {
                entity_type: 'group',
                canonical_id: 'polaris:group:test-mint-2',
                initial_claims: [],
                provenance: {}
            }
        };

        const actionData = {
            hash: 'test-hash-456',
            author: 'test-user'
        };

        await eventProcessor.handleMintEntity(event, actionData);

        // Verify node exists with both id and group_id
        const result = await session.run(`
            MATCH (g:Group {id: $id})
            RETURN g.id as id, g.group_id as group_id
        `, { id: 'polaris:group:test-mint-2' });

        expect(result.records.length).toBe(1);
        const record = result.records[0];
        expect(record.get('id')).toBe('polaris:group:test-mint-2');
        expect(record.get('group_id')).toBe('polaris:group:test-mint-2'); // CRITICAL: Must be set
    });

    test('Song node created with both id and song_id', async () => {
        const event = {
            body: {
                entity_type: 'song',
                canonical_id: 'polaris:song:test-mint-3',
                initial_claims: [],
                provenance: {}
            }
        };

        const actionData = {
            hash: 'test-hash-789',
            author: 'test-user'
        };

        await eventProcessor.handleMintEntity(event, actionData);

        // Verify node exists with both id and song_id
        const result = await session.run(`
            MATCH (s:Song {id: $id})
            RETURN s.id as id, s.song_id as song_id
        `, { id: 'polaris:song:test-mint-3' });

        expect(result.records.length).toBe(1);
        const record = result.records[0];
        expect(record.get('id')).toBe('polaris:song:test-mint-3');
        expect(record.get('song_id')).toBe('polaris:song:test-mint-3'); // CRITICAL: Must be set
    });

    test('Initial claims are attached correctly', async () => {
        const event = {
            body: {
                entity_type: 'person',
                canonical_id: 'polaris:person:test-mint-4',
                initial_claims: [
                    {
                        property: 'name',
                        value: 'Test Person',
                        confidence: 1.0
                    }
                ],
                provenance: {
                    submitter: 'test-user'
                }
            }
        };

        const actionData = {
            hash: 'test-hash-abc',
            author: 'test-user'
        };

        await eventProcessor.handleMintEntity(event, actionData);

        // Verify claim was created and linked
        const result = await session.run(`
            MATCH (p:Person {id: $id})<-[:CLAIMS_ABOUT]-(c:Claim)
            RETURN c.property as property, c.value as value
        `, { id: 'polaris:person:test-mint-4' });

        expect(result.records.length).toBe(1);
        const record = result.records[0];
        expect(record.get('property')).toBe('name');
        expect(JSON.parse(record.get('value'))).toBe('Test Person');
    });

    test('Constraint violation prevented by setting entity-specific ID', async () => {
        // Create first person
        const event1 = {
            body: {
                entity_type: 'person',
                canonical_id: 'polaris:person:test-mint-5',
                initial_claims: [],
                provenance: {}
            }
        };

        await eventProcessor.handleMintEntity(event1, { hash: 'hash1', author: 'test' });

        // Try to create duplicate - should fail due to person_id uniqueness constraint
        const event2 = {
            body: {
                entity_type: 'person',
                canonical_id: 'polaris:person:test-mint-5', // Same ID
                initial_claims: [],
                provenance: {}
            }
        };

        await expect(
            eventProcessor.handleMintEntity(event2, { hash: 'hash2', author: 'test' })
        ).rejects.toThrow(); // Should throw constraint violation
    });
});
