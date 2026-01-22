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
import GraphDatabaseService from '../../src/graph/schema.js';

// Skip these tests if no database is configured
const describeOrSkip = process.env.GRAPH_URI ? describe : describe.skip;

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
        await graphDb.initializeSchema();

    });

    afterAll(async () => {
        if (driver) await driver.close();
    });

    beforeEach(async () => {
        session = driver.session();

        // Clean up test nodes
        await session.run(`
            MATCH (n)
            WHERE (n.id IS NOT NULL AND n.id STARTS WITH 'test-cypher-injection-')
                OR n.id IN [
                    'polaris:person:11111111-1111-1111-1111-111111111111',
                    'polaris:person:22222222-2222-2222-2222-222222222222',
                    'polaris:person:33333333-3333-3333-3333-333333333333',
                    'polaris:person:44444444-4444-4444-4444-444444444444',
                    'polaris:person:55555555-5555-5555-5555-555555555555',
                    'polaris:person:66666666-6666-6666-6666-666666666666',
                    'polaris:person:77777777-7777-7777-7777-777777777777',
                    'polaris:person:88888888-8888-8888-8888-888888888888',
                    'polaris:person:99999999-9999-9999-9999-999999999999'
                ]
                OR n.person_id IN [
                    'polaris:person:11111111-1111-1111-1111-111111111111',
                    'polaris:person:22222222-2222-2222-2222-222222222222',
                    'polaris:person:33333333-3333-3333-3333-333333333333',
                    'polaris:person:44444444-4444-4444-4444-444444444444',
                    'polaris:person:55555555-5555-5555-5555-555555555555',
                    'polaris:person:66666666-6666-6666-6666-666666666666',
                    'polaris:person:77777777-7777-7777-7777-777777777777',
                    'polaris:person:88888888-8888-8888-8888-888888888888',
                    'polaris:person:99999999-9999-9999-9999-999999999999'
                ]
            DETACH DELETE n
        `);

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
        beforeEach(async () => {
            // Create test persons for merge tests
            await session.run(`
              MERGE (p1:Person { id: 'polaris:person:88888888-8888-8888-8888-888888888888' })
              ON CREATE SET
                p1.person_id = 'polaris:person:88888888-8888-8888-8888-888888888888',
                p1.name = 'Source Person',
                p1.status = 'ACTIVE'

              MERGE (p2:Person { id: 'polaris:person:99999999-9999-9999-9999-999999999999' })
              ON CREATE SET
                p2.person_id = 'polaris:person:99999999-9999-9999-9999-999999999999',
                p2.name = 'Target Person',
                p2.status = 'ACTIVE'
            `);

        });

        test('should accept valid lowercase type (person)', async () => {
            // Act: Merge with lowercase type
            const result = await graphDb.mergeNodes(
                'polaris:person:88888888-8888-8888-8888-888888888888',
                'polaris:person:99999999-9999-9999-9999-999999999999',
                'person',
                'test merge'
            );

            // Assert: Should succeed
            expect(result.success).toBe(true);

            // Verify source was deleted
            const verifyResult = await session.run(`
                MATCH (p:Person {id: $id})
                RETURN count(p) as count
            `, { id: 'polaris:person:88888888-8888-8888-8888-888888888888' });

            expect(verifyResult.records[0].get('count').toNumber()).toBe(0);
        });

        test('should accept valid capitalized type (Person)', async () => {
            // Recreate source (previous test deleted it)
            await session.run(`
                MERGE (p:Person { id: 'polaris:person:66666666-6666-6666-6666-666666666666' })
                ON CREATE SET
                  p.person_id = 'polaris:person:66666666-6666-6666-6666-666666666666',
                  p.name = 'Source Person 2',
                  p.status = 'ACTIVE'

            `);

            // Act: Merge with capitalized type
            const result = await graphDb.mergeNodes(
                'polaris:person:66666666-6666-6666-6666-666666666666',
                'polaris:person:99999999-9999-9999-9999-999999999999',
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
                'polaris:person:88888888-8888-8888-8888-888888888888', // existing
                'polaris:person:99999999-9999-9999-9999-999999999999', // existing
                maliciousType,
                'malicious merge'
              )
            ).rejects.toThrow('Invalid nodeType');


            // Verify target person still exists (not deleted by injection)
            const verifyResult = await session.run(`
                MATCH (p:Person {id: $id})
                RETURN count(p) as count
            `, { id: 'polaris:person:99999999-9999-9999-9999-999999999999' });

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
