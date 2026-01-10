/**
 * @fileoverview Tests for Alias operations
 *
 * Verifies that:
 * 1. createAlias() only creates alias when canonical node exists
 * 2. createAlias() throws error when canonical node missing (no orphans)
 * 3. Alias relationships are created correctly
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import neo4j from 'neo4j-driver';
import { MergeOperations } from '../../src/graph/merge.js';

// Skip these tests if no database is configured
const describeOrSkip = process.env.GRAPH_URI ? describe : describe.skip;

describeOrSkip('MergeOperations - createAlias', () => {
    let driver;
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
    });

    afterAll(async () => {
        if (driver) await driver.close();
    });

    beforeEach(async () => {
        session = driver.session();

        // Clean up test nodes
        await session.run(`
            MATCH (n)
            WHERE n.id STARTS WITH 'test-alias-'
               OR n.id STARTS WITH 'polaris:person:test-alias-'
            DETACH DELETE n
        `);
    });

    afterEach(async () => {
        if (session) {
            await session.close();
            session = null;
        }
    });

    test('should create alias when canonical node exists', async () => {
        // Setup: Create canonical node
        await session.run(`
            CREATE (p:Person {
                id: 'polaris:person:test-alias-canonical-1',
                person_id: 'polaris:person:test-alias-canonical-1',
                status: 'ACTIVE'
            })
        `);

        // Act: Create alias
        await MergeOperations.createAlias(
            session,
            'test-alias-prov-1',
            'polaris:person:test-alias-canonical-1',
            {
                createdBy: 'test-user',
                aliasKind: 'provisional',
                method: 'test'
            }
        );

        // Assert: Verify alias node and relationship exist
        const result = await session.run(`
            MATCH (alias:Alias {id: $aliasId})-[:ALIAS_OF]->(canonical {id: $canonicalId})
            RETURN alias.id as aliasId, canonical.id as canonicalId, alias.alias_kind as aliasKind
        `, {
            aliasId: 'test-alias-prov-1',
            canonicalId: 'polaris:person:test-alias-canonical-1'
        });

        expect(result.records.length).toBe(1);
        const record = result.records[0];
        expect(record.get('aliasId')).toBe('test-alias-prov-1');
        expect(record.get('canonicalId')).toBe('polaris:person:test-alias-canonical-1');
        expect(record.get('aliasKind')).toBe('provisional');
    });

    test('should throw error when canonical node does not exist', async () => {
        // Act & Assert: Attempt to create alias without canonical node
        await expect(
            MergeOperations.createAlias(
                session,
                'test-alias-orphan-1',
                'polaris:person:test-alias-missing-canonical',
                {
                    createdBy: 'test-user',
                    aliasKind: 'provisional',
                    method: 'test'
                }
            )
        ).rejects.toThrow(); // Should throw error
    });

    test('should NOT create orphan alias node when canonical missing', async () => {
        // Act: Try to create alias without canonical (will throw)
        try {
            await MergeOperations.createAlias(
                session,
                'test-alias-orphan-2',
                'polaris:person:test-alias-missing-canonical-2',
                {
                    createdBy: 'test-user',
                    aliasKind: 'provisional',
                    method: 'test'
                }
            );
            // Should not reach here
            expect(true).toBe(false);
        } catch (error) {
            // Expected to throw
        }

        // Assert: Verify NO orphan alias node was created
        const result = await session.run(`
            MATCH (alias:Alias {id: $aliasId})
            RETURN count(alias) as count
        `, { aliasId: 'test-alias-orphan-2' });

        expect(result.records[0].get('count').toNumber()).toBe(0);
    });

    test('should be idempotent - creating same alias twice is safe', async () => {
        // Setup: Create canonical node
        await session.run(`
            CREATE (p:Person {
                id: 'polaris:person:test-alias-canonical-3',
                person_id: 'polaris:person:test-alias-canonical-3',
                status: 'ACTIVE'
            })
        `);

        // Act: Create alias twice
        await MergeOperations.createAlias(
            session,
            'test-alias-prov-3',
            'polaris:person:test-alias-canonical-3',
            {
                createdBy: 'test-user',
                aliasKind: 'provisional',
                method: 'test'
            }
        );

        await MergeOperations.createAlias(
            session,
            'test-alias-prov-3', // Same alias ID
            'polaris:person:test-alias-canonical-3',
            {
                createdBy: 'test-user',
                aliasKind: 'provisional',
                method: 'test'
            }
        );

        // Assert: Should have exactly one alias node and one relationship
        const aliasCount = await session.run(`
            MATCH (alias:Alias {id: $aliasId})
            RETURN count(alias) as count
        `, { aliasId: 'test-alias-prov-3' });

        expect(aliasCount.records[0].get('count').toNumber()).toBe(1);

        const relCount = await session.run(`
            MATCH (:Alias {id: $aliasId})-[r:ALIAS_OF]->()
            RETURN count(r) as count
        `, { aliasId: 'test-alias-prov-3' });

        expect(relCount.records[0].get('count').toNumber()).toBe(1);
    });

    test('should set alias metadata correctly', async () => {
        // Setup: Create canonical node
        await session.run(`
            CREATE (p:Person {
                id: 'polaris:person:test-alias-canonical-4',
                person_id: 'polaris:person:test-alias-canonical-4',
                status: 'ACTIVE'
            })
        `);

        // Act: Create alias with metadata
        await MergeOperations.createAlias(
            session,
            'test-alias-prov-4',
            'polaris:person:test-alias-canonical-4',
            {
                createdBy: 'importer-bot',
                aliasKind: 'external',
                method: 'discogs-import'
            }
        );

        // Assert: Verify metadata
        const result = await session.run(`
            MATCH (alias:Alias {id: $aliasId})
            RETURN alias.created_by as createdBy,
                   alias.alias_kind as aliasKind,
                   alias.resolution_method as method
        `, { aliasId: 'test-alias-prov-4' });

        expect(result.records.length).toBe(1);
        const record = result.records[0];
        expect(record.get('createdBy')).toBe('importer-bot');
        expect(record.get('aliasKind')).toBe('external');
        expect(record.get('method')).toBe('discogs-import');
    });
});
