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
const describeOrSkip = process.env.GRAPH_URI ? describe : describe.skip;

describeOrSkip('ADD_CLAIM Event Processing', () => {
    let driver;
    let graphDb;
    let session;

    const testEventHash = 'test-event-hash-add-claim-123';
    const testPersonId = 'polaris:person:test-add-claim-person';

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
            WHERE n.id STARTS WITH 'polaris:person:test-add-claim-'
               OR n.claim_id STARTS WITH 'test-claim-'
               OR n.event_hash = $eventHash
            DETACH DELETE n
        `, { eventHash: testEventHash });

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
});
