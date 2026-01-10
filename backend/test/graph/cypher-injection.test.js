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
import neo4j from 'neo4j-driver';
import GraphDatabaseService from '../../src/graph/schema.js';

// Skip these tests if no database is configured
const describeOrSkip = process.env.GRAPH_URI ? describe : describe.skip;

describeOrSkip('Cypher Injection Prevention', () => {
    let driver;
    let graphDb;
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

        graphDb = new GraphDatabaseService({ driver });
    });

    afterAll(async () => {
        if (driver) await driver.close();
    });

    beforeEach(async () => {
        session = driver.session();

        // Clean up test nodes
        await session.run(`
            MATCH (n)
            WHERE n.id STARTS WITH 'test-cypher-injection-'
               OR n.id STARTS WITH 'polaris:person:test-cypher-'
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
                    id: 'polaris:person:test-cypher-person-1',
                    person_id: 'polaris:person:test-cypher-person-1',
                    name: 'Test Person',
                    status: 'ACTIVE'
                })
            `);

            // Act: Add claim with lowercase type
            const result = await graphDb.processAddClaim(
                'test-event-hash-123',
                {
                    node: { type: 'person', id: 'polaris:person:test-cypher-person-1' },
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
            `, { id: 'polaris:person:test-cypher-person-1' });

            expect(verifyResult.records[0].get('bio')).toBe('Test biography');
        });

        test('should accept valid capitalized node type (Person)', async () => {
            // Setup: Create test person
            await session.run(`
                CREATE (p:Person {
                    id: 'polaris:person:test-cypher-person-2',
                    person_id: 'polaris:person:test-cypher-person-2',
                    name: 'Test Person 2',
                    status: 'ACTIVE'
                })
            `);

            // Act: Add claim with capitalized type
            const result = await graphDb.processAddClaim(
                'test-event-hash-456',
                {
                    node: { type: 'Person', id: 'polaris:person:test-cypher-person-2' },
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
                    id: 'polaris:person:test-cypher-person-3',
                    person_id: 'polaris:person:test-cypher-person-3',
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
                        node: { type: maliciousType, id: 'polaris:person:test-cypher-person-3' },
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
            `, { id: 'polaris:person:test-cypher-person-3' });

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
                    id: 'polaris:person:test-cypher-person-4',
                    person_id: 'polaris:person:test-cypher-person-4',
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
                CREATE (p1:Person {
                    id: 'polaris:person:test-cypher-source',
                    person_id: 'polaris:person:test-cypher-source',
                    name: 'Source Person',
                    status: 'ACTIVE'
                })
                CREATE (p2:Person {
                    id: 'polaris:person:test-cypher-target',
                    person_id: 'polaris:person:test-cypher-target',
                    name: 'Target Person',
                    status: 'ACTIVE'
                })
            `);
        });

        test('should accept valid lowercase type (person)', async () => {
            // Act: Merge with lowercase type
            const result = await graphDb.mergeNodes(
                'polaris:person:test-cypher-source',
                'polaris:person:test-cypher-target',
                'person',
                'test merge'
            );

            // Assert: Should succeed
            expect(result.success).toBe(true);

            // Verify source was deleted
            const verifyResult = await session.run(`
                MATCH (p:Person {id: $id})
                RETURN count(p) as count
            `, { id: 'polaris:person:test-cypher-source' });

            expect(verifyResult.records[0].get('count').toNumber()).toBe(0);
        });

        test('should accept valid capitalized type (Person)', async () => {
            // Recreate source (previous test deleted it)
            await session.run(`
                MERGE (p:Person {
                    id: 'polaris:person:test-cypher-source-2',
                    person_id: 'polaris:person:test-cypher-source-2',
                    name: 'Source Person 2',
                    status: 'ACTIVE'
                })
            `);

            // Act: Merge with capitalized type
            const result = await graphDb.mergeNodes(
                'polaris:person:test-cypher-source-2',
                'polaris:person:test-cypher-target',
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
                    'polaris:person:test-cypher-target',
                    'some-id',
                    maliciousType,
                    'malicious merge'
                )
            ).rejects.toThrow('Invalid nodeType');

            // Verify target person still exists (not deleted by injection)
            const verifyResult = await session.run(`
                MATCH (p:Person {id: $id})
                RETURN count(p) as count
            `, { id: 'polaris:person:test-cypher-target' });

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
