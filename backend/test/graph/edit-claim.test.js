/**
 * @fileoverview Tests for EDIT_CLAIM event processing
 *
 * Verifies that:
 * 1. EDIT_CLAIM creates a new claim that supersedes the old one
 * 2. SUPERSEDES relationship is created correctly
 * 3. Old claim is marked as superseded
 * 4. Node property is updated to new value
 * 5. EDIT_CLAIM is replay-safe (idempotent)
 * 6. Protected fields cannot be edited
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import neo4j from 'neo4j-driver';
import GraphDatabaseService from '../../src/graph/schema.js';

// Skip these tests if no database is configured
const describeOrSkip = (process.env.GRAPH_URI && process.env.SKIP_GRAPH_TESTS !== 'true') ? describe : describe.skip;

describeOrSkip('EDIT_CLAIM Event Processing', () => {
    let driver;
    let graphDb;
    let session;

    const testPersonId = 'polaris:person:22222222-2222-2222-2222-222222222222';
    let originalClaimId;

    beforeAll(async () => {
        graphDb = new GraphDatabaseService({
            uri: process.env.GRAPH_URI || 'bolt://localhost:7687',
            user: process.env.GRAPH_USER || 'neo4j',
            password: process.env.GRAPH_PASSWORD || 'password'
        });
    
        driver = graphDb.driver;

        // If available, initialize schema (constraints/indexes) once
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
                name: 'Test Person for EDIT_CLAIM',
                bio: 'Original biography',
                status: 'ACTIVE',
                created_at: datetime()
            })
        `, { personId: testPersonId });

        // Create original claim via ADD_CLAIM
        const addResult = await graphDb.processAddClaim(
            'test-event-hash-original-claim',
            {
                node: { type: 'person', id: testPersonId },
                field: 'bio',
                value: 'Original biography'
            },
            'original-author'
        );
        originalClaimId = addResult.claimId;
    });

    afterEach(async () => {
        if (session) {
            await session.close();
            session = null;
        }
    });

    describe('Claim Supersession', () => {
        test('should create new claim that supersedes old claim', async () => {
            // Arrange
            const editData = {
                claim_id: originalClaimId,
                value: 'Updated biography after review'
            };

            // Act
            const result = await graphDb.processEditClaim(
                'test-event-hash-edit-claim',
                editData,
                'editor-author'
            );

            // Assert
            expect(result.success).toBe(true);
            expect(result.newClaimId).toBeDefined();
            expect(result.oldClaimId).toBe(originalClaimId);
            expect(result.newClaimId).not.toBe(originalClaimId);

            // Verify new claim exists
            const newClaimResult = await session.run(`
                MATCH (c:Claim {claim_id: $newClaimId})
                RETURN c.field as field, c.value as value
            `, { newClaimId: result.newClaimId });

            expect(newClaimResult.records.length).toBe(1);
            expect(newClaimResult.records[0].get('field')).toBe('bio');
            expect(JSON.parse(newClaimResult.records[0].get('value'))).toBe('Updated biography after review');
        });

        test('should create SUPERSEDES relationship', async () => {
            // Arrange
            const editData = {
                claim_id: originalClaimId,
                value: 'Updated biography v2'
            };

            // Act
            const result = await graphDb.processEditClaim(
                'test-event-hash-edit-claim-2',
                editData,
                'editor-author'
            );

            // Assert - Verify SUPERSEDES relationship exists
            const supersessionResult = await session.run(`
                MATCH (newClaim:Claim {claim_id: $newClaimId})-[:SUPERSEDES]->(oldClaim:Claim {claim_id: $oldClaimId})
                RETURN newClaim, oldClaim
            `, {
                newClaimId: result.newClaimId,
                oldClaimId: originalClaimId
            });

            expect(supersessionResult.records.length).toBe(1);
        });

        test('should mark old claim as superseded', async () => {
            // Arrange
            const editData = {
                claim_id: originalClaimId,
                value: 'Updated biography v3'
            };

            // Act
            const result = await graphDb.processEditClaim(
                'test-event-hash-edit-claim-3',
                editData,
                'editor-author'
            );

            // Assert - Verify old claim has superseded_by and superseded_at
            const oldClaimResult = await session.run(`
                MATCH (old:Claim {claim_id: $oldClaimId})
                RETURN old.superseded_by as supersededBy,
                       old.superseded_at as supersededAt
            `, { oldClaimId: originalClaimId });

            expect(oldClaimResult.records.length).toBe(1);
            expect(oldClaimResult.records[0].get('supersededBy')).toBe(result.newClaimId);
            expect(oldClaimResult.records[0].get('supersededAt')).not.toBeNull();
        });

        test('should update node property to new value', async () => {
            // Arrange
            const editData = {
                claim_id: originalClaimId,
                value: 'Completely rewritten biography'
            };

            // Act
            await graphDb.processEditClaim(
                'test-event-hash-edit-claim-4',
                editData,
                'editor-author'
            );

            // Assert - Verify node has new value
            const nodeResult = await session.run(`
                MATCH (p:Person {id: $personId})
                RETURN p.bio as bio
            `, { personId: testPersonId });

            expect(nodeResult.records[0].get('bio')).toBe('Completely rewritten biography');
        });

        test('should link new claim to target node via CLAIMS_ABOUT', async () => {
            // Arrange
            const editData = {
                claim_id: originalClaimId,
                value: 'Biography with link verification'
            };

            // Act
            const result = await graphDb.processEditClaim(
                'test-event-hash-edit-claim-5',
                editData,
                'editor-author'
            );

            // Assert - Verify CLAIMS_ABOUT relationship exists
            const claimsAboutResult = await session.run(`
                MATCH (c:Claim {claim_id: $newClaimId})-[:CLAIMS_ABOUT]->(p:Person {id: $personId})
                RETURN count(*) as count
            `, {
                newClaimId: result.newClaimId,
                personId: testPersonId
            });

            expect(claimsAboutResult.records[0].get('count').toNumber()).toBe(1);
        });

        test('should support chained edits (edit an edited claim)', async () => {
            // Arrange - First edit
            const firstEdit = await graphDb.processEditClaim(
                'test-event-hash-edit-claim-chain-1',
                {
                    claim_id: originalClaimId,
                    value: 'First edit'
                },
                'editor-1'
            );

            // Act - Second edit (editing the first edit)
            const secondEdit = await graphDb.processEditClaim(
                'test-event-hash-edit-claim-chain-2',
                {
                    claim_id: firstEdit.newClaimId,
                    value: 'Second edit'
                },
                'editor-2'
            );

            // Assert - Chain should exist
            const chainResult = await session.run(`
                MATCH path = (latest:Claim {claim_id: $latestClaimId})-[:SUPERSEDES*]->(original:Claim {claim_id: $originalClaimId})
                RETURN length(path) as chainLength
            `, {
                latestClaimId: secondEdit.newClaimId,
                originalClaimId: originalClaimId
            });

            expect(chainResult.records[0].get('chainLength').toNumber()).toBe(2);

            // Verify node has latest value
            const nodeResult = await session.run(`
                MATCH (p:Person {id: $personId})
                RETURN p.bio as bio
            `, { personId: testPersonId });

            expect(nodeResult.records[0].get('bio')).toBe('Second edit');
        });
    });

    describe('Replay Safety (Idempotency)', () => {
        test('should be idempotent when replaying same edit', async () => {
            // Arrange
            const editData = {
                claim_id: originalClaimId,
                value: 'Replay test biography'
            };

            // Act - Process twice
            const result1 = await graphDb.processEditClaim(
                'test-event-hash-edit-replay',
                editData,
                'replay-author'
            );

            const result2 = await graphDb.processEditClaim(
                'test-event-hash-edit-replay',  // Same event hash
                editData,
                'replay-author'
            );

            // Assert - Both should succeed with same new claim ID
            expect(result1.success).toBe(true);
            expect(result2.success).toBe(true);
            expect(result1.newClaimId).toBe(result2.newClaimId);

            // Verify there's only ONE new claim node (not duplicated)
            const newClaimCountResult = await session.run(`
                MATCH (c:Claim {claim_id: $newClaimId})
                RETURN count(c) as count
            `, { newClaimId: result1.newClaimId });

            expect(newClaimCountResult.records[0].get('count').toNumber()).toBe(1);

            // Verify there's only ONE SUPERSEDES relationship
            const supersessionCountResult = await session.run(`
                MATCH (:Claim {claim_id: $newClaimId})-[r:SUPERSEDES]->(:Claim {claim_id: $oldClaimId})
                RETURN count(r) as count
            `, {
                newClaimId: result1.newClaimId,
                oldClaimId: originalClaimId
            });

            expect(supersessionCountResult.records[0].get('count').toNumber()).toBe(1);
        });
    });

    describe('Error Cases', () => {
        test('should fail if claim_id is missing', async () => {
            // Arrange
            const editData = {
                value: 'Missing claim ID'
            };

            // Act & Assert
            await expect(
                graphDb.processEditClaim(
                    'test-event-hash-edit-error-1',
                    editData,
                    'error-author'
                )
            ).rejects.toThrow('missing claim_id');
        });

        test('should fail if value is missing', async () => {
            // Arrange
            const editData = {
                claim_id: originalClaimId
            };

            // Act & Assert
            await expect(
                graphDb.processEditClaim(
                    'test-event-hash-edit-error-2',
                    editData,
                    'error-author'
                )
            ).rejects.toThrow('missing value');
        });

        test('should fail if claim does not exist', async () => {
            // Arrange
            const editData = {
                claim_id: 'nonexistent-claim-id-12345',
                value: 'This should fail'
            };

            // Act & Assert
            await expect(
                graphDb.processEditClaim(
                    'test-event-hash-edit-error-3',
                    editData,
                    'error-author'
                )
            ).rejects.toThrow('Claim not found');
        });

        test('should reject edit of protected field via claim history', async () => {
            // Arrange - Create a claim on a protected field would fail at ADD_CLAIM
            // But let's test that even if one existed (legacy data), edit would block it

            // Create a "bad" claim directly in database (bypassing validation)
            const badClaimId = 'test-claim-bad-protected-field';
            await session.run(`
                MATCH (p:Person {id: $personId})
                CREATE (c:Claim {
                    claim_id: $claimId,
                    node_type: 'person',
                    node_id: $personId,
                    field: 'created_at',
                    value: '"2000-01-01"',
                    event_hash: 'legacy-event',
                    created_at: datetime()
                })
                CREATE (c)-[:CLAIMS_ABOUT]->(p)
            `, {
                personId: testPersonId,
                claimId: badClaimId
            });

            // Act & Assert - Edit should be rejected
            await expect(
                graphDb.processEditClaim(
                    'test-event-hash-edit-protected',
                    {
                        claim_id: badClaimId,
                        value: '2001-01-01'
                    },
                    'attacker'
                )
            ).rejects.toThrow('protected');
        });
    });
});
