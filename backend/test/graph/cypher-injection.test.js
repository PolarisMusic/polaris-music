/**
 * @fileoverview Tests for Cypher Injection Prevention
 *
 * Verifies that:
 * 1. SAFE_NODE_TYPES whitelist prevents Cypher injection in processAddClaim
 * 2. SAFE_NODE_TYPES whitelist prevents Cypher injection in findPotentialDuplicates
 * 3. SAFE_NODE_TYPES whitelist prevents Cypher injection in mergeNodes
 * 4. Normal node types (both lowercase and capitalized) work correctly
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { randomUUID } from 'crypto';
import GraphDatabaseService from '../../src/graph/schema.js';

// Skip these tests if no database is configured
const describeOrSkip = (process.env.GRAPH_URI && process.env.SKIP_GRAPH_TESTS !== 'true') ? describe : describe.skip;

describeOrSkip('Cypher Injection Prevention', () => {
    let driver;
    let graphDb;
    let session;

    beforeAll(async () => {
        // Connect to test database
        graphDb = new GraphDatabaseService({
            uri: process.env.GRAPH_URI || 'bolt://localhost:7687',
            user: process.env.GRAPH_USER || 'neo4j',
            password: process.env.GRAPH_PASSWORD || 'password'
        });

        driver = graphDb.driver;

        await driver.verifyConnectivity();
        // Clear DB to prevent pollution from prior test files
        const cleanSession = driver.session();
        try { await cleanSession.run('MATCH (n) DETACH DELETE n'); } finally { await cleanSession.close(); }
        await graphDb.initializeSchema();

    });

    afterAll(async () => {
        if (driver) await driver.close();
    });

    beforeEach(async () => {
        session = driver.session();
        // Full DB clear to prevent constraint violations from prior test pollution
        await session.run('MATCH (n) DETACH DELETE n');
    });

    afterEach(async () => {
        if (session) {
            await session.close();
            session = null;
        }
    });

    describe('processAddClaim - Injection Prevention', () => {
        test('should accept valid lowercase node type (person)', async () => {
            // Setup: Create test person
            await session.run(`
                CREATE (p:Person {
                    id: 'polaris:person:11111111-1111-1111-1111-111111111111',
                    person_id: 'polaris:person:11111111-1111-1111-1111-111111111111',
                    name: 'Test Person',
                    status: 'ACTIVE'
                })
            `);

            // Act: Add claim with lowercase type
            const result = await graphDb.processAddClaim(
                'test-event-hash-123',
                {
                    node: { type: 'person', id: 'polaris:person:11111111-1111-1111-1111-111111111111' },
                    field: 'bio',
                    value: 'Test biography'
                },
                'test-user'
            );

            // Assert: Should succeed
            expect(result.success).toBe(true);
            expect(result.claimId).toBeDefined();

            // Verify claim was created
            const verifyResult = await session.run(`
                MATCH (p:Person {id: $id})
                RETURN p.bio as bio
            `, { id: 'polaris:person:11111111-1111-1111-1111-111111111111' });

            expect(verifyResult.records[0].get('bio')).toBe('Test biography');
        });

        test('should accept valid capitalized node type (Person)', async () => {
            // Setup: Create test person
            await session.run(`
                CREATE (p:Person {
                    id: 'polaris:person:22222222-2222-2222-2222-222222222222',
                    person_id: 'polaris:person:22222222-2222-2222-2222-222222222222',
                    name: 'Test Person 2',
                    status: 'ACTIVE'
                })
            `);

            // Act: Add claim with capitalized type
            const result = await graphDb.processAddClaim(
                'test-event-hash-456',
                {
                    node: { type: 'Person', id: 'polaris:person:22222222-2222-2222-2222-222222222222' },
                    field: 'bio',
                    value: 'Test biography 2'
                },
                'test-user'
            );

            // Assert: Should succeed (normalized to lowercase internally)
            expect(result.success).toBe(true);
        });

        test('should reject invalid node type', async () => {
            // Act & Assert: Should throw error for invalid type
            await expect(
                graphDb.processAddClaim(
                    'test-event-hash-789',
                    {
                        node: { type: 'InvalidType', id: 'some-id' },
                        field: 'bio',
                        value: 'Test'
                    },
                    'test-user'
                )
            ).rejects.toThrow('Invalid node.type: InvalidType');
            await expect(
                graphDb.processAddClaim(
                    'test-event-hash-789',
                    {
                        node: { type: 'InvalidType', id: 'some-id' },
                        field: 'bio',
                        value: 'Test'
                    },
                    'test-user'
                )
            ).rejects.toThrow('Allowed types:');
        });

        test('should prevent Cypher injection via node.type', async () => {
            // Setup: Create test person
            await session.run(`
                CREATE (p:Person {
                    id: 'polaris:person:77777777-7777-7777-7777-777777777777',
                    person_id: 'polaris:person:77777777-7777-7777-7777-777777777777',
                    name: 'Victim',
                    status: 'ACTIVE'
                })
            `);

            // Act & Assert: Injection attempt should be rejected
            const maliciousType = 'Person) MATCH (x) DETACH DELETE x //';

            await expect(
                graphDb.processAddClaim(
                    'test-event-hash-inject-1',
                    {
                        node: { type: maliciousType, id: 'polaris:person:77777777-7777-7777-7777-777777777777' },
                        field: 'bio',
                        value: 'Malicious'
                    },
                    'attacker'
                )
            ).rejects.toThrow('Invalid node.type');

            // Verify person still exists (not deleted by injection)
            const verifyResult = await session.run(`
                MATCH (p:Person {id: $id})
                RETURN count(p) as count
            `, { id: 'polaris:person:77777777-7777-7777-7777-777777777777' });

            expect(verifyResult.records[0].get('count').toNumber()).toBe(1);
        });

        test('should prevent property injection via node.type', async () => {
            // Act & Assert: Property exfiltration attempt should be rejected
            const maliciousType = 'Person {person_id: $nodeId}) WITH n MATCH (admin:User {role: "admin"}) RETURN admin.password //';

            await expect(
                graphDb.processAddClaim(
                    'test-event-hash-inject-2',
                    {
                        node: { type: maliciousType, id: 'some-id' },
                        field: 'bio',
                        value: 'Malicious'
                    },
                    'attacker'
                )
            ).rejects.toThrow('Invalid node.type');
        });
    });

    describe('findPotentialDuplicates - Injection Prevention', () => {
        test('should accept valid lowercase type (person)', async () => {
            // Setup: Create test person
            await session.run(`
                CREATE (p:Person {
                    id: 'polaris:person:44444444-4444-4444-4444-444444444444',
                    person_id: 'polaris:person:44444444-4444-4444-4444-444444444444',
                    name: 'John Doe',
                    status: 'ACTIVE'
                })
            `);

            // Act: Search with lowercase type
            const duplicates = await graphDb.findPotentialDuplicates('person', 'John');

            // Assert: Should find the person
            expect(duplicates.length).toBeGreaterThan(0);
        });

        test('should accept valid capitalized type (Person)', async () => {
            // Act: Search with capitalized type
            const duplicates = await graphDb.findPotentialDuplicates('Person', 'John');

            // Assert: Should work (normalized internally)
            expect(Array.isArray(duplicates)).toBe(true);
        });

        test('should reject invalid type', async () => {
            // Act & Assert: Should throw error for invalid type
            await expect(
                graphDb.findPotentialDuplicates('InvalidType', 'John')
            ).rejects.toThrow('Invalid type: InvalidType');
        });

        test('should prevent Cypher injection via type parameter', async () => {
            // Act & Assert: Injection attempt should be rejected
            const maliciousType = 'Person) MATCH (x) DETACH DELETE x RETURN x //';

            await expect(
                graphDb.findPotentialDuplicates(maliciousType, 'John')
            ).rejects.toThrow('Invalid type');
        });
    });

    describe('mergeNodes - Injection Prevention', () => {
        // Use dynamic IDs per test to avoid constraint violations from static ID reuse
        let sourceId, targetId;

        beforeEach(async () => {
            sourceId = `polaris:person:${randomUUID()}`;
            targetId = `polaris:person:${randomUUID()}`;

            // Create test persons for merge tests
            await session.run(`
              CREATE (p1:Person {
                id: $sourceId,
                person_id: $sourceId,
                name: 'Source Person',
                status: 'ACTIVE'
              })
              CREATE (p2:Person {
                id: $targetId,
                person_id: $targetId,
                name: 'Target Person',
                status: 'ACTIVE'
              })
            `, { sourceId, targetId });
        });

        test('should accept valid lowercase type (person)', async () => {
            // Act: Merge with lowercase type
            const result = await graphDb.mergeNodes(
                sourceId,
                targetId,
                'person',
                'test merge'
            );

            // Assert: Should succeed
            expect(result.success).toBe(true);

            // Verify source was deleted
            const verifyResult = await session.run(`
                MATCH (p:Person {id: $id})
                RETURN count(p) as count
            `, { id: sourceId });

            expect(verifyResult.records[0].get('count').toNumber()).toBe(0);
        });

        test('should accept valid capitalized type (Person)', async () => {
            // Act: Merge with capitalized type
            const result = await graphDb.mergeNodes(
                sourceId,
                targetId,
                'Person',
                'test merge 2'
            );

            // Assert: Should succeed (normalized internally)
            expect(result.success).toBe(true);
        });

        test('should reject invalid node type', async () => {
            // Act & Assert: Should throw error for invalid type
            await expect(
                graphDb.mergeNodes(
                    'some-source-id',
                    'some-target-id',
                    'InvalidType',
                    'test merge'
                )
            ).rejects.toThrow('Invalid nodeType: InvalidType');
        });

        test('should prevent Cypher injection via nodeType parameter', async () => {
            // Act & Assert: Injection attempt should be rejected
            const maliciousType = 'Person) MATCH (x) DETACH DELETE x //';

            await expect(
              graphDb.mergeNodes(
                sourceId,
                targetId,
                maliciousType,
                'malicious merge'
              )
            ).rejects.toThrow('Invalid nodeType');

            // Verify target person still exists (not deleted by injection)
            const verifyResult = await session.run(`
                MATCH (p:Person {id: $id})
                RETURN count(p) as count
            `, { id: targetId });

            expect(verifyResult.records[0].get('count').toNumber()).toBe(1);
        });
    });

    describe('Edge Cases', () => {
        test('should handle null node.type gracefully', async () => {
            await expect(
                graphDb.processAddClaim(
                    'test-event-hash-null',
                    {
                        node: { type: null, id: 'some-id' },
                        field: 'bio',
                        value: 'Test'
                    },
                    'test-user'
                )
            ).rejects.toThrow();
        });

        test('should handle undefined node.type gracefully', async () => {
            await expect(
                graphDb.processAddClaim(
                    'test-event-hash-undefined',
                    {
                        node: { id: 'some-id' },
                        field: 'bio',
                        value: 'Test'
                    },
                    'test-user'
                )
            ).rejects.toThrow('missing required fields');
        });

        test('should handle numeric node.type gracefully', async () => {
            await expect(
                graphDb.processAddClaim(
                    'test-event-hash-numeric',
                    {
                        node: { type: 123, id: 'some-id' },
                        field: 'bio',
                        value: 'Test'
                    },
                    'test-user'
                )
            ).rejects.toThrow('Invalid node.type');
        });

        test('should handle object node.type gracefully', async () => {
            await expect(
                graphDb.processAddClaim(
                    'test-event-hash-object',
                    {
                        node: { type: {}, id: 'some-id' },
                        field: 'bio',
                        value: 'Test'
                    },
                    'test-user'
                )
            ).rejects.toThrow('Invalid node.type');
        });
    });
});
