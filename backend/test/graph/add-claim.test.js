/**
 * @fileoverview Tests for ADD_CLAIM event processing
 *
 * Verifies that:
 * 1. ADD_CLAIM creates a claim and links it to the target node
 * 2. ADD_CLAIM is replay-safe (idempotent via MERGE)
 * 3. Replaying the same ADD_CLAIM doesn't create duplicate claims
 * 4. CLAIMS_ABOUT relationship is created correctly
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import neo4j from 'neo4j-driver';
import GraphDatabaseService from '../../src/graph/schema.js';

// Skip these tests if no database is configured
const describeOrSkip = (process.env.GRAPH_URI && process.env.SKIP_GRAPH_TESTS !== 'true') ? describe : describe.skip;

describeOrSkip('ADD_CLAIM Event Processing', () => {
    let driver;
    let graphDb;
    let session;

    const testEventHash = 'test-event-hash-add-claim-123';
    const testPersonId = 'polaris:person:add-claim-1111-1111-1111-111111111111';

    beforeAll(async () => {
        // Connect to test database
        graphDb = new GraphDatabaseService({
            uri: process.env.GRAPH_URI || 'bolt://localhost:7687',
            user: process.env.GRAPH_USER || 'neo4j',
            password: process.env.GRAPH_PASSWORD || 'password'
        });

        driver = graphDb.driver;

// If your GraphDatabaseService has an initializeSchema method, call it.
// (If it doesn't exist, remove this line.)
        if (typeof graphDb.initializeSchema === 'function') {
            await graphDb.initializeSchema();
        }

    });

    afterAll(async () => {
        if (driver) await driver.close();
    });

    beforeEach(async () => {
        session = driver.session();

        // Clean up test nodes
        await session.run(
            `
            MATCH (n)
            WHERE n.id = $id
            DETACH DELETE n
            `,
            { id: testPersonId }
        );


        // Create test person
        await session.run(`
            CREATE (p:Person {
                id: $personId,
                person_id: $personId,
                name: 'Test Person for ADD_CLAIM',
                status: 'ACTIVE',
                created_at: datetime()
            })
        `, { personId: testPersonId });
    });

    afterEach(async () => {
        if (session) {
            await session.close();
            session = null;
        }
    });

    describe('Replay Safety (Idempotency)', () => {
        test('should process ADD_CLAIM successfully on first run', async () => {
            // Arrange
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'bio',
                value: 'Test biography for replay safety'
            };

            // Act
            const result = await graphDb.processAddClaim(
                testEventHash,
                claimData,
                'test-author'
            );

            // Assert
            expect(result.success).toBe(true);
            expect(result.claimId).toBeDefined();

            // Verify claim was created
            const claimResult = await session.run(`
                MATCH (c:Claim {claim_id: $claimId})
                RETURN c.field as field, c.value as value
            `, { claimId: result.claimId });

            expect(claimResult.records.length).toBe(1);
            expect(claimResult.records[0].get('field')).toBe('bio');
            expect(JSON.parse(claimResult.records[0].get('value'))).toBe('Test biography for replay safety');

            // Verify CLAIMS_ABOUT relationship exists
            const relResult = await session.run(`
                MATCH (c:Claim {claim_id: $claimId})-[:CLAIMS_ABOUT]->(p:Person {id: $personId})
                RETURN count(*) as count
            `, { claimId: result.claimId, personId: testPersonId });

            expect(relResult.records[0].get('count').toNumber()).toBe(1);

            // Verify node property was updated
            const nodeResult = await session.run(`
                MATCH (p:Person {id: $personId})
                RETURN p.bio as bio
            `, { personId: testPersonId });

            expect(nodeResult.records[0].get('bio')).toBe('Test biography for replay safety');
        });

        test('should be idempotent when replaying same ADD_CLAIM', async () => {
            // Arrange
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'bio',
                value: 'Test biography for idempotency'
            };

            // Act - Process first time
            const result1 = await graphDb.processAddClaim(
                testEventHash,
                claimData,
                'test-author'
            );

            // Act - Process second time (replay)
            const result2 = await graphDb.processAddClaim(
                testEventHash,
                claimData,
                'test-author'
            );

            // Assert - Both should succeed
            expect(result1.success).toBe(true);
            expect(result2.success).toBe(true);

            // Claim IDs should be the same (deterministic)
            expect(result1.claimId).toBe(result2.claimId);

            // Verify there's only ONE claim node (not duplicated)
            const claimCountResult = await session.run(`
                MATCH (c:Claim {claim_id: $claimId})
                RETURN count(c) as count
            `, { claimId: result1.claimId });

            expect(claimCountResult.records[0].get('count').toNumber()).toBe(1);

            // Verify CLAIMS_ABOUT relationship exists (and is not duplicated)
            const relCountResult = await session.run(`
                MATCH (c:Claim {claim_id: $claimId})-[r:CLAIMS_ABOUT]->(p:Person {id: $personId})
                RETURN count(r) as count
            `, { claimId: result1.claimId, personId: testPersonId });

            expect(relCountResult.records[0].get('count').toNumber()).toBe(1);
        });

        test('should handle multiple replays without errors', async () => {
            // Arrange
            const claimData = {
                node: { type: 'Person', id: testPersonId },  // Test capitalized type
                field: 'birthplace',
                value: 'Liverpool, England'
            };

            // Act - Process 5 times (simulating multiple replays)
            const results = [];
            for (let i = 0; i < 5; i++) {
                const result = await graphDb.processAddClaim(
                    testEventHash,
                    claimData,
                    'test-author'
                );
                results.push(result);
            }

            // Assert - All should succeed
            results.forEach(result => {
                expect(result.success).toBe(true);
            });

            // All should have same claim ID
            const uniqueClaimIds = new Set(results.map(r => r.claimId));
            expect(uniqueClaimIds.size).toBe(1);

            // Verify only ONE claim node exists
            const claimId = results[0].claimId;
            const claimCountResult = await session.run(`
                MATCH (c:Claim {claim_id: $claimId})
                RETURN count(c) as count
            `, { claimId });

            expect(claimCountResult.records[0].get('count').toNumber()).toBe(1);
        });
    });

    describe('CLAIMS_ABOUT Relationship', () => {
        test('should create CLAIMS_ABOUT relationship to target node', async () => {
            // Arrange
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'website',
                value: 'https://example.com'
            };

            // Act
            const result = await graphDb.processAddClaim(
                testEventHash,
                claimData,
                'test-author'
            );

            // Assert - Verify relationship exists
            const relResult = await session.run(`
                MATCH (c:Claim {claim_id: $claimId})-[:CLAIMS_ABOUT]->(p:Person {id: $personId})
                RETURN c, p
            `, { claimId: result.claimId, personId: testPersonId });

            expect(relResult.records.length).toBe(1);

            // Verify we can traverse from claim to person
            const traverseResult = await session.run(`
                MATCH (c:Claim {claim_id: $claimId})-[:CLAIMS_ABOUT]->(p)
                RETURN p.id as targetId, labels(p)[0] as targetLabel
            `, { claimId: result.claimId });

            expect(traverseResult.records[0].get('targetId')).toBe(testPersonId);
            expect(traverseResult.records[0].get('targetLabel')).toBe('Person');
        });

        test('should allow multiple claims about the same node', async () => {
            // Arrange
            const claimData1 = {
                node: { type: 'person', id: testPersonId },
                field: 'bio',
                value: 'First claim'
            };
            const claimData2 = {
                node: { type: 'person', id: testPersonId },
                field: 'birthdate',
                value: '1980-01-01'
            };

            // Act
            const result1 = await graphDb.processAddClaim(
                testEventHash + '-1',
                claimData1,
                'test-author'
            );
            const result2 = await graphDb.processAddClaim(
                testEventHash + '-2',
                claimData2,
                'test-author'
            );

            // Assert - Both should succeed
            expect(result1.success).toBe(true);
            expect(result2.success).toBe(true);

            // Verify both claims link to the same person
            const relCountResult = await session.run(`
                MATCH (c:Claim)-[:CLAIMS_ABOUT]->(p:Person {id: $personId})
                WHERE c.claim_id IN [$claimId1, $claimId2]
                RETURN count(c) as count
            `, {
                personId: testPersonId,
                claimId1: result1.claimId,
                claimId2: result2.claimId
            });

            expect(relCountResult.records[0].get('count').toNumber()).toBe(2);
        });
    });

    describe('Error Cases', () => {
        test('should fail gracefully if target node does not exist', async () => {
            // Arrange
            const claimData = {
                node: { type: 'person', id: 'polaris:person:nonexistent' },
                field: 'bio',
                value: 'This should fail'
            };

            // Act & Assert
            await expect(
                graphDb.processAddClaim(
                    testEventHash,
                    claimData,
                    'test-author'
                )
            ).rejects.toThrow();
        });

        test('should validate node type against whitelist', async () => {
            // Arrange
            const claimData = {
                node: { type: 'InvalidType', id: testPersonId },
                field: 'bio',
                value: 'This should fail'
            };

            // Act & Assert
            await expect(
                graphDb.processAddClaim(
                    testEventHash,
                    claimData,
                    'test-author'
                )
            ).rejects.toThrow('Invalid node.type: InvalidType');
        });
    });

    describe('Protected Field Validation', () => {
        test('should reject claim attempting to modify universal ID field', async () => {
            // Arrange - Trying to overwrite 'id' field
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'id',
                value: 'malicious-new-id'
            };

            // Act & Assert
            await expect(
                graphDb.processAddClaim(
                    testEventHash,
                    claimData,
                    'test-author'
                )
            ).rejects.toThrow('Invalid claim field: "id" is protected');
        });

        test('should reject claim attempting to modify entity-specific ID field', async () => {
            // Arrange - Trying to overwrite 'person_id' field
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'person_id',
                value: 'malicious-person-id'
            };

            // Act & Assert
            await expect(
                graphDb.processAddClaim(
                    testEventHash,
                    claimData,
                    'test-author'
                )
            ).rejects.toThrow('Invalid claim field: "person_id" is protected');
        });

        test('should reject claim attempting to modify audit fields (created_at)', async () => {
            // Arrange - Trying to overwrite audit trail
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'created_at',
                value: '2000-01-01T00:00:00Z'
            };

            // Act & Assert
            await expect(
                graphDb.processAddClaim(
                    testEventHash,
                    claimData,
                    'test-author'
                )
            ).rejects.toThrow('Invalid claim field: "created_at" is protected');
        });

        test('should reject claim attempting to modify audit fields (created_by)', async () => {
            // Arrange - Trying to fake authorship
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'created_by',
                value: 'fake-author'
            };

            // Act & Assert
            await expect(
                graphDb.processAddClaim(
                    testEventHash,
                    claimData,
                    'test-author'
                )
            ).rejects.toThrow('Invalid claim field: "created_by" is protected');
        });

        test('should reject claim attempting to modify system status field', async () => {
            // Arrange - Trying to manipulate status
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'status',
                value: 'DELETED'
            };

            // Act & Assert
            await expect(
                graphDb.processAddClaim(
                    testEventHash,
                    claimData,
                    'test-author'
                )
            ).rejects.toThrow('Invalid claim field: "status" is protected');
        });

        test('should reject claim attempting to modify event_hash field', async () => {
            // Arrange - Trying to corrupt provenance
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'event_hash',
                value: 'fake-hash-123'
            };

            // Act & Assert
            await expect(
                graphDb.processAddClaim(
                    testEventHash,
                    claimData,
                    'test-author'
                )
            ).rejects.toThrow('Invalid claim field: "event_hash" is protected');
        });

        test('should normalize field name (trim whitespace) before validation', async () => {
            // Arrange - Trying to bypass protection with whitespace
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: '  id  ',  // Whitespace padding
                value: 'malicious-id'
            };

            // Act & Assert - Should still be rejected after normalization
            await expect(
                graphDb.processAddClaim(
                    testEventHash,
                    claimData,
                    'test-author'
                )
            ).rejects.toThrow('Invalid claim field: "id" is protected');
        });

        test('should allow claim on non-protected field (bio)', async () => {
            // Arrange - Valid claim on allowed field
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'bio',
                value: 'This is a valid biography'
            };

            // Act
            const result = await graphDb.processAddClaim(
                testEventHash,
                claimData,
                'test-author'
            );

            // Assert - Should succeed
            expect(result.success).toBe(true);

            // Verify field was set
            const nodeResult = await session.run(`
                MATCH (p:Person {id: $personId})
                RETURN p.bio as bio
            `, { personId: testPersonId });

            expect(nodeResult.records[0].get('bio')).toBe('This is a valid biography');
        });

        test('should allow claim on non-protected field (website)', async () => {
            // Arrange - Valid claim on allowed field
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'website',
                value: 'https://example.com'
            };

            // Act
            const result = await graphDb.processAddClaim(
                testEventHash + '-website',
                claimData,
                'test-author'
            );

            // Assert - Should succeed
            expect(result.success).toBe(true);

            // Verify field was set
            const nodeResult = await session.run(`
                MATCH (p:Person {id: $personId})
                RETURN p.website as website
            `, { personId: testPersonId });

            expect(nodeResult.records[0].get('website')).toBe('https://example.com');
        });

        test('should allow claim on non-protected field (alt_names)', async () => {
            // Arrange - Valid claim on allowed field
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'alt_names',
                value: ['Alias 1', 'Alias 2']
            };

            // Act
            const result = await graphDb.processAddClaim(
                testEventHash + '-altnames',
                claimData,
                'test-author'
            );

            // Assert - Should succeed
            expect(result.success).toBe(true);
        });
    });

    describe('Neo4j Value Normalization', () => {
        test('should handle string values (primitives)', async () => {
            // Arrange
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'bio',
                value: 'Simple string value'
            };

            // Act
            const result = await graphDb.processAddClaim(
                testEventHash + '-string',
                claimData,
                'test-author'
            );

            // Assert
            expect(result.success).toBe(true);

            // Verify value stored correctly
            const nodeResult = await session.run(`
                MATCH (p:Person {id: $personId})
                RETURN p.bio as bio
            `, { personId: testPersonId });

            expect(nodeResult.records[0].get('bio')).toBe('Simple string value');
        });

        test('should handle number values (primitives)', async () => {
            // Arrange
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'birth_year',
                value: 1980
            };

            // Act
            const result = await graphDb.processAddClaim(
                testEventHash + '-number',
                claimData,
                'test-author'
            );

            // Assert
            expect(result.success).toBe(true);

            // Verify value stored correctly
            const nodeResult = await session.run(`
                MATCH (p:Person {id: $personId})
                RETURN p.birth_year as birthYear
            `, { personId: testPersonId });

            expect(nodeResult.records[0].get('birthYear').toNumber()).toBe(1980);
        });

        test('should handle boolean values (primitives)', async () => {
            // Arrange
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'is_verified',
                value: true
            };

            // Act
            const result = await graphDb.processAddClaim(
                testEventHash + '-boolean',
                claimData,
                'test-author'
            );

            // Assert
            expect(result.success).toBe(true);

            // Verify value stored correctly
            const nodeResult = await session.run(`
                MATCH (p:Person {id: $personId})
                RETURN p.is_verified as isVerified
            `, { personId: testPersonId });

            expect(nodeResult.records[0].get('isVerified')).toBe(true);
        });

        test('should handle homogeneous string arrays (Neo4j-compatible)', async () => {
            // Arrange
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'genres',
                value: ['Rock', 'Pop', 'Jazz']
            };

            // Act
            const result = await graphDb.processAddClaim(
                testEventHash + '-string-array',
                claimData,
                'test-author'
            );

            // Assert
            expect(result.success).toBe(true);

            // Verify value stored correctly as array
            const nodeResult = await session.run(`
                MATCH (p:Person {id: $personId})
                RETURN p.genres as genres
            `, { personId: testPersonId });

            expect(nodeResult.records[0].get('genres')).toEqual(['Rock', 'Pop', 'Jazz']);
        });

        test('should JSON-stringify complex objects (not Neo4j primitives)', async () => {
            // Arrange - Complex object that Neo4j can't store directly
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'address',
                value: {
                    street: '123 Main St',
                    city: 'Liverpool',
                    country: 'UK',
                    postalCode: 'L1 1AA'
                }
            };

            // Act
            const result = await graphDb.processAddClaim(
                testEventHash + '-object',
                claimData,
                'test-author'
            );

            // Assert
            expect(result.success).toBe(true);

            // Verify value stored as JSON string
            const nodeResult = await session.run(`
                MATCH (p:Person {id: $personId})
                RETURN p.address as address
            `, { personId: testPersonId });

            const storedValue = nodeResult.records[0].get('address');
            expect(typeof storedValue).toBe('string');
            expect(JSON.parse(storedValue)).toEqual({
                street: '123 Main St',
                city: 'Liverpool',
                country: 'UK',
                postalCode: 'L1 1AA'
            });
        });

        test('should JSON-stringify nested arrays (not Neo4j primitives)', async () => {
            // Arrange - Nested array that Neo4j can't store directly
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'discography',
                value: [
                    { album: 'Album 1', year: 2000 },
                    { album: 'Album 2', year: 2005 }
                ]
            };

            // Act
            const result = await graphDb.processAddClaim(
                testEventHash + '-nested-array',
                claimData,
                'test-author'
            );

            // Assert
            expect(result.success).toBe(true);

            // Verify value stored as JSON string
            const nodeResult = await session.run(`
                MATCH (p:Person {id: $personId})
                RETURN p.discography as discography
            `, { personId: testPersonId });

            const storedValue = nodeResult.records[0].get('discography');
            expect(typeof storedValue).toBe('string');
            expect(JSON.parse(storedValue)).toEqual([
                { album: 'Album 1', year: 2000 },
                { album: 'Album 2', year: 2005 }
            ]);
        });

        test('should handle null values gracefully', async () => {
            // Arrange
            const claimData = {
                node: { type: 'person', id: testPersonId },
                field: 'middle_name',
                value: null
            };

            // Act
            const result = await graphDb.processAddClaim(
                testEventHash + '-null',
                claimData,
                'test-author'
            );

            // Assert
            expect(result.success).toBe(true);

            // Verify value is null
            const nodeResult = await session.run(`
                MATCH (p:Person {id: $personId})
                RETURN p.middle_name as middleName
            `, { personId: testPersonId });

            expect(nodeResult.records[0].get('middleName')).toBeNull();
        });
    });
});
