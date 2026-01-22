/**
 * @fileoverview Tests for MINT_ENTITY event handler
 *
 * Verifies that:
 * 1. Nodes are created with both 'id' and entity-specific ID field (person_id, group_id, etc.)
 * 2. This satisfies Neo4j uniqueness constraints
 * 3. All entity types are handled correctly
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import EventProcessor from '../../src/indexer/eventProcessor.js';
import EventStore from '../../src/storage/eventStore.js';
import MusicGraphDatabase from '../../src/graph/schema.js';

// Deterministic, valid UUIDs for tests.
// (Regex in IdentityService only checks UUID shape, not version bits.)
const testCid = (entityType, n) =>
  `polaris:${entityType}:00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

// Skip these tests if no database is configured
const describeOrSkip = process.env.GRAPH_URI ? describe : describe.skip;

describeOrSkip('MINT_ENTITY Event Handler', () => {
  let driver;
  let graphDb;
  let eventStore;
  let eventProcessor;
  let session;

  beforeAll(async () => {
    // Initialize schema (creates constraints) + driver
    graphDb = new MusicGraphDatabase({
      uri: process.env.GRAPH_URI || 'bolt://localhost:7687',
      user: process.env.GRAPH_USER || 'neo4j',
      password: process.env.GRAPH_PASSWORD || 'password'
    });

    driver = graphDb.driver;

    await driver.verifyConnectivity();
    await graphDb.initializeSchema();

    // Initialize event store (minimal config)
    eventStore = new EventStore({
      ipfs: null,
      s3: null,
      redis: null
    });

    // Initialize event processor with real db instance
    eventProcessor = new EventProcessor({
      db: graphDb,
      store: eventStore
    });
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
      WHERE (n.id IS NOT NULL AND (
        n.id STARTS WITH 'polaris:person:00000000-0000-0000-0000-'
        OR n.id STARTS WITH 'polaris:group:00000000-0000-0000-0000-'
        OR n.id STARTS WITH 'polaris:song:00000000-0000-0000-0000-'
      ))
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
    const id = testCid('person', 1);

    const event = {
      body: {
        entity_type: 'person',
        canonical_id: id,
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
    const result = await session.run(
      `
        MATCH (p:Person {id: $id})
        RETURN p.id as id, p.person_id as person_id, p.status as status
      `,
      { id }
    );

    expect(result.records.length).toBe(1);
    const record = result.records[0];
    expect(record.get('id')).toBe(id);
    expect(record.get('person_id')).toBe(id); // CRITICAL: Must be set
    expect(record.get('status')).toBe('ACTIVE');
  });

  test('Group node created with both id and group_id', async () => {
    const id = testCid('group', 2);

    const event = {
      body: {
        entity_type: 'group',
        canonical_id: id,
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
    const result = await session.run(
      `
        MATCH (g:Group {id: $id})
        RETURN g.id as id, g.group_id as group_id
      `,
      { id }
    );

    expect(result.records.length).toBe(1);
    const record = result.records[0];
    expect(record.get('id')).toBe(id);
    expect(record.get('group_id')).toBe(id); // CRITICAL: Must be set
  });

  test('Song node created with both id and song_id', async () => {
    const id = testCid('song', 3);

    const event = {
      body: {
        entity_type: 'song',
        canonical_id: id,
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
    const result = await session.run(
      `
        MATCH (s:Song {id: $id})
        RETURN s.id as id, s.song_id as song_id
      `,
      { id }
    );

    expect(result.records.length).toBe(1);
    const record = result.records[0];
    expect(record.get('id')).toBe(id);
    expect(record.get('song_id')).toBe(id); // CRITICAL: Must be set
  });

  test('Initial claims are attached correctly', async () => {
    const id = testCid('person', 4);

    const event = {
      body: {
        entity_type: 'person',
        canonical_id: id,
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
    const result = await session.run(
      `
        MATCH (p:Person {id: $id})<-[:CLAIMS_ABOUT]-(c:Claim)
        RETURN c.property as property, c.value as value
      `,
      { id }
    );

    expect(result.records.length).toBe(1);
    const record = result.records[0];
    expect(record.get('property')).toBe('name');
    expect(JSON.parse(record.get('value'))).toBe('Test Person');
  });

  test('MINT_ENTITY is idempotent - replay does not error or duplicate', async () => {
    const id = testCid('person', 5);

    const event = {
      body: {
        entity_type: 'person',
        canonical_id: id,
        initial_claims: [
          {
            property: 'name',
            value: 'Replay Test Person',
            confidence: 1.0
          },
          {
            property: 'birth_year',
            value: 1990,
            confidence: 0.9
          }
        ],
        provenance: {
          submitter: 'test-user',
          source: 'test'
        }
      }
    };

    const actionData = {
      hash: 'test-hash-replay-123',
      author: 'test-user'
    };

    // Process event first time
    await eventProcessor.handleMintEntity(event, actionData);

    // Verify entity and claims exist
    const result1 = await session.run(
      `
        MATCH (p:Person {id: $id})
        OPTIONAL MATCH (p)<-[:CLAIMS_ABOUT]-(c:Claim)
        RETURN p.id as id, count(c) as claimCount
      `,
      { id }
    );

    expect(result1.records.length).toBe(1);
    expect(result1.records[0].get('claimCount').toNumber()).toBe(2);

    // Process EXACT SAME event again (replay scenario)
    // This should NOT throw an error and should NOT duplicate claims
    await eventProcessor.handleMintEntity(event, actionData);

    // Verify still only one entity and two claims (no duplication)
    const result2 = await session.run(
      `
        MATCH (p:Person {id: $id})
        OPTIONAL MATCH (p)<-[:CLAIMS_ABOUT]-(c:Claim)
        RETURN p.id as id, count(c) as claimCount
      `,
      { id }
    );

    expect(result2.records.length).toBe(1);
    expect(result2.records[0].get('claimCount').toNumber()).toBe(2); // Still 2, not 4

    // Verify the claims have deterministic IDs based on event hash
    const claimResult = await session.run(
      `
        MATCH (:Person {id: $id})<-[:CLAIMS_ABOUT]-(c:Claim)
        RETURN c.claim_id as claimId, c.property as property
        ORDER BY c.property
      `,
      { id }
    );

    expect(claimResult.records.length).toBe(2);

    // Verify claim IDs are deterministic (not random UUIDs)
    const claimIds = claimResult.records.map((r) => r.get('claimId'));
    expect(claimIds[0]).toMatch(/^[0-9a-f]{64}$/); // SHA256 hash format
    expect(claimIds[1]).toMatch(/^[0-9a-f]{64}$/);
  });
});
