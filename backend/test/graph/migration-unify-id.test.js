/**
 * @fileoverview Tests for ID unification migration
 *
 * Verifies migration script 001-unify-id-property.js:
 * 1. Backfills universal 'id' property from entity-specific IDs
 * 2. Is idempotent (safe to run multiple times)
 * 3. Handles edge cases (missing IDs, already migrated nodes)
 * 4. Verification function correctly detects incomplete migrations
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import neo4j from 'neo4j-driver';
import { migrateUnifyIdProperty, verifyIdUnification } from '../../src/graph/migrations/001-unify-id-property.js';

// Mock Neo4j driver to avoid real database connections in CI
jest.mock('neo4j-driver', () => ({
    default: {
        driver: jest.fn(() => ({
            session: jest.fn(() => ({
                run: jest.fn().mockResolvedValue({ records: [] }),
                close: jest.fn(),
                beginTransaction: jest.fn(() => ({
                    run: jest.fn().mockResolvedValue({ records: [] }),
                    commit: jest.fn().mockResolvedValue(undefined),
                    rollback: jest.fn().mockResolvedValue(undefined),
                })),
            })),
            close: jest.fn(),
            verifyConnectivity: jest.fn().mockResolvedValue(true),
        })),
        auth: {
            basic: jest.fn(() => ({})),
        },
    },
    // Also export the mocks directly for default import syntax
    driver: jest.fn(() => ({
        session: jest.fn(() => ({
            run: jest.fn().mockResolvedValue({ records: [] }),
            close: jest.fn(),
            beginTransaction: jest.fn(() => ({
                run: jest.fn().mockResolvedValue({ records: [] }),
                commit: jest.fn().mockResolvedValue(undefined),
                rollback: jest.fn().mockResolvedValue(undefined),
            })),
        })),
        close: jest.fn(),
        verifyConnectivity: jest.fn().mockResolvedValue(true),
    })),
    auth: {
        basic: jest.fn(() => ({})),
    },
}));

describe('ID Unification Migration (001-unify-id-property)', () => {
    let driver;
    let session;

    beforeAll(async () => {
        driver = neo4j.driver(
            process.env.GRAPH_URI || 'bolt://localhost:7687',
            neo4j.auth.basic(
                process.env.GRAPH_USER || 'neo4j',
                process.env.GRAPH_PASSWORD || 'password'
            )
        );

        await driver.verifyConnectivity();
    });

    afterAll(async () => {
        await driver.close();
        jest.restoreAllMocks();
    });

    beforeEach(async () => {
        session = driver.session();
    });

    afterEach(async () => {
        if (session) {
            // Clean up test data
            await session.run(`
                MATCH (n)
                WHERE n.id STARTS WITH 'mig-test-'
                   OR n.person_id STARTS WITH 'mig-test-'
                   OR n.group_id STARTS WITH 'mig-test-'
                   OR n.track_id STARTS WITH 'mig-test-'
                DETACH DELETE n
            `);
            await session.close();
        }
    });

    describe('Basic Migration Functionality', () => {
        test('Backfills id from person_id for Person nodes', async () => {
            // Create Person without universal ID
            await session.run(`
                CREATE (p:Person {person_id: 'mig-test-person-1', name: 'Test Person'})
            `);

            // Verify id is missing
            const beforeResult = await session.run(`
                MATCH (p:Person {person_id: 'mig-test-person-1'})
                RETURN p.id as id, p.person_id as person_id
            `);
            expect(beforeResult.records[0].get('id')).toBeNull();
            expect(beforeResult.records[0].get('person_id')).toBe('mig-test-person-1');

            // Run migration
            const stats = await migrateUnifyIdProperty(driver);

            // Verify id was backfilled
            const afterResult = await session.run(`
                MATCH (p:Person {person_id: 'mig-test-person-1'})
                RETURN p.id as id, p.person_id as person_id
            `);
            expect(afterResult.records[0].get('id')).toBe('mig-test-person-1');
            expect(afterResult.records[0].get('person_id')).toBe('mig-test-person-1');
            expect(stats.person).toBeGreaterThanOrEqual(1);
        });

        test('Backfills id from group_id for Group nodes', async () => {
            await session.run(`
                CREATE (g:Group {group_id: 'mig-test-group-1', name: 'Test Band'})
            `);

            const stats = await migrateUnifyIdProperty(driver);

            const result = await session.run(`
                MATCH (g:Group {group_id: 'mig-test-group-1'})
                RETURN g.id as id, g.group_id as group_id
            `);
            expect(result.records[0].get('id')).toBe('mig-test-group-1');
            expect(result.records[0].get('group_id')).toBe('mig-test-group-1');
        });

        test('Backfills id from track_id for Track nodes', async () => {
            await session.run(`
                CREATE (t:Track {track_id: 'mig-test-track-1', title: 'Test Song'})
            `);

            const stats = await migrateUnifyIdProperty(driver);

            const result = await session.run(`
                MATCH (t:Track {track_id: 'mig-test-track-1'})
                RETURN t.id as id, t.track_id as track_id
            `);
            expect(result.records[0].get('id')).toBe('mig-test-track-1');
        });

        test('Handles all entity types', async () => {
            // Create one node of each type without universal ID
            await session.run(`
                CREATE (:Person {person_id: 'mig-test-person-2', name: 'Test'})
                CREATE (:Group {group_id: 'mig-test-group-2', name: 'Test'})
                CREATE (:Song {song_id: 'mig-test-song-1', title: 'Test'})
                CREATE (:Track {track_id: 'mig-test-track-2', title: 'Test'})
                CREATE (:Release {release_id: 'mig-test-release-1', name: 'Test'})
                CREATE (:Master {master_id: 'mig-test-master-1', name: 'Test'})
                CREATE (:Label {label_id: 'mig-test-label-1', name: 'Test'})
                CREATE (:Account {account_id: 'mig-test-account-1'})
                CREATE (:City {city_id: 'mig-test-city-1', name: 'Test'})
            `);

            const stats = await migrateUnifyIdProperty(driver);

            // Verify all types were migrated
            expect(stats.person).toBeGreaterThanOrEqual(1);
            expect(stats.group).toBeGreaterThanOrEqual(1);
            expect(stats.song).toBeGreaterThanOrEqual(1);
            expect(stats.track).toBeGreaterThanOrEqual(1);
            expect(stats.release).toBeGreaterThanOrEqual(1);
            expect(stats.master).toBeGreaterThanOrEqual(1);
            expect(stats.label).toBeGreaterThanOrEqual(1);
            expect(stats.account).toBeGreaterThanOrEqual(1);
            expect(stats.city).toBeGreaterThanOrEqual(1);
        });
    });

    describe('Idempotency', () => {
        test('Running migration twice does not duplicate or change data', async () => {
            // Create test node
            await session.run(`
                CREATE (p:Person {person_id: 'mig-test-person-3', name: 'Idempotent Test'})
            `);

            // Run migration first time
            const stats1 = await migrateUnifyIdProperty(driver);
            expect(stats1.person).toBeGreaterThanOrEqual(1);

            // Capture state after first migration
            const firstState = await session.run(`
                MATCH (p:Person {person_id: 'mig-test-person-3'})
                RETURN p.id as id, p.person_id as person_id, p.name as name
            `);
            const firstRecord = {
                id: firstState.records[0].get('id'),
                person_id: firstState.records[0].get('person_id'),
                name: firstState.records[0].get('name')
            };

            // Run migration second time
            const stats2 = await migrateUnifyIdProperty(driver);

            // Should find no nodes to migrate
            expect(stats2.person).toBe(0);

            // Capture state after second migration
            const secondState = await session.run(`
                MATCH (p:Person {person_id: 'mig-test-person-3'})
                RETURN p.id as id, p.person_id as person_id, p.name as name
            `);
            const secondRecord = {
                id: secondState.records[0].get('id'),
                person_id: secondState.records[0].get('person_id'),
                name: secondState.records[0].get('name')
            };

            // State should be identical
            expect(secondRecord).toEqual(firstRecord);

            // Verify no duplicates created
            const countResult = await session.run(`
                MATCH (p:Person)
                WHERE p.person_id = 'mig-test-person-3' OR p.id = 'mig-test-person-3'
                RETURN count(p) as count
            `);
            expect(countResult.records[0].get('count').toInt()).toBe(1);
        });

        test('Migration skips nodes that already have id property', async () => {
            // Create nodes: one with id, one without
            await session.run(`
                CREATE (p1:Person {person_id: 'mig-test-person-4', id: 'mig-test-person-4', name: 'Already Has ID'})
                CREATE (p2:Person {person_id: 'mig-test-person-5', name: 'Missing ID'})
            `);

            const stats = await migrateUnifyIdProperty(driver);

            // Should only migrate the one without id
            const p1Result = await session.run(`
                MATCH (p:Person {person_id: 'mig-test-person-4'})
                RETURN p.id as id, p.name as name
            `);
            expect(p1Result.records[0].get('id')).toBe('mig-test-person-4');
            expect(p1Result.records[0].get('name')).toBe('Already Has ID'); // Unchanged

            const p2Result = await session.run(`
                MATCH (p:Person {person_id: 'mig-test-person-5'})
                RETURN p.id as id, p.name as name
            `);
            expect(p2Result.records[0].get('id')).toBe('mig-test-person-5'); // Backfilled
        });
    });

    describe('Edge Cases', () => {
        test('Handles nodes with NULL entity-specific ID gracefully', async () => {
            // Create node without person_id (invalid state but should not crash)
            await session.run(`
                CREATE (p:Person {name: 'No ID'})
            `);

            // Migration should not crash
            const stats = await migrateUnifyIdProperty(driver);

            // Node should still have no id (can't backfill from NULL)
            const result = await session.run(`
                MATCH (p:Person {name: 'No ID'})
                RETURN p.id as id, p.person_id as person_id
            `);
            expect(result.records[0].get('id')).toBeNull();
            expect(result.records[0].get('person_id')).toBeNull();
        });

        test('Handles empty database gracefully', async () => {
            // Clean up all test data first
            await session.run(`
                MATCH (n)
                WHERE n.id STARTS WITH 'mig-test-'
                   OR n.person_id STARTS WITH 'mig-test-'
                DETACH DELETE n
            `);

            // Should complete without errors
            const stats = await migrateUnifyIdProperty(driver);
            expect(stats.total).toBe(0);
        });

        test('Handles nodes with mismatched id and entity-specific ID', async () => {
            // Create node where id != person_id (legacy data scenario)
            await session.run(`
                CREATE (p:Person {person_id: 'mig-test-person-6', id: 'different-id', name: 'Mismatched'})
            `);

            // Migration should skip (id already exists)
            const stats = await migrateUnifyIdProperty(driver);

            // id should remain unchanged
            const result = await session.run(`
                MATCH (p:Person {person_id: 'mig-test-person-6'})
                RETURN p.id as id, p.person_id as person_id
            `);
            expect(result.records[0].get('id')).toBe('different-id'); // Not overwritten
            expect(result.records[0].get('person_id')).toBe('mig-test-person-6');
        });
    });

    describe('Verification Function', () => {
        test('Verification passes when all nodes have id', async () => {
            // Create nodes with complete IDs
            await session.run(`
                CREATE (p:Person {person_id: 'mig-test-person-7', id: 'mig-test-person-7', name: 'Complete'})
                CREATE (g:Group {group_id: 'mig-test-group-3', id: 'mig-test-group-3', name: 'Complete'})
            `);

            const verification = await verifyIdUnification(driver);

            expect(verification.allHaveId).toBe(true);
            expect(verification.issues.length).toBe(0);
        });

        test('Verification detects missing id properties', async () => {
            // Create node without id
            await session.run(`
                CREATE (p:Person {person_id: 'mig-test-person-8', name: 'Incomplete'})
            `);

            const verification = await verifyIdUnification(driver);

            expect(verification.allHaveId).toBe(false);
            expect(verification.issues.length).toBeGreaterThan(0);
            expect(verification.issues.some(issue => issue.includes('Person'))).toBe(true);
        });

        test('Verification after migration shows success', async () => {
            // Create unmigrated nodes
            await session.run(`
                CREATE (p1:Person {person_id: 'mig-test-person-9', name: 'Test 1'})
                CREATE (p2:Person {person_id: 'mig-test-person-10', name: 'Test 2'})
            `);

            // Verify incomplete before migration
            const beforeVerification = await verifyIdUnification(driver);
            expect(beforeVerification.allHaveId).toBe(false);

            // Run migration
            await migrateUnifyIdProperty(driver);

            // Verify complete after migration
            const afterVerification = await verifyIdUnification(driver);
            expect(afterVerification.allHaveId).toBe(true);
            expect(afterVerification.issues.length).toBe(0);
        });
    });

    describe('Migration Statistics', () => {
        test('Returns accurate counts of migrated nodes', async () => {
            // Create exactly 3 Person nodes without id
            await session.run(`
                CREATE (p1:Person {person_id: 'mig-test-person-11', name: 'Test 1'})
                CREATE (p2:Person {person_id: 'mig-test-person-12', name: 'Test 2'})
                CREATE (p3:Person {person_id: 'mig-test-person-13', name: 'Test 3'})
            `);

            const stats = await migrateUnifyIdProperty(driver);

            expect(stats.person).toBe(3);
            expect(stats.total).toBeGreaterThanOrEqual(3);
        });

        test('Returns zero counts when no migration needed', async () => {
            // Create nodes that already have id
            await session.run(`
                CREATE (p:Person {person_id: 'mig-test-person-14', id: 'mig-test-person-14', name: 'Already Migrated'})
            `);

            const stats = await migrateUnifyIdProperty(driver);

            // All counts should be zero (no work needed)
            expect(stats.person).toBe(0);
            expect(stats.group).toBe(0);
            expect(stats.total).toBe(0);
        });
    });

    describe('Data Integrity', () => {
        test('Migration preserves all existing properties', async () => {
            // Create node with multiple properties
            await session.run(`
                CREATE (p:Person {
                    person_id: 'mig-test-person-15',
                    name: 'Test Person',
                    birth_date: '1990-01-01',
                    birth_name: 'Original Name',
                    custom_field: 'custom value'
                })
            `);

            // Capture original properties
            const beforeResult = await session.run(`
                MATCH (p:Person {person_id: 'mig-test-person-15'})
                RETURN properties(p) as props
            `);
            const beforeProps = beforeResult.records[0].get('props');

            // Run migration
            await migrateUnifyIdProperty(driver);

            // Capture properties after migration
            const afterResult = await session.run(`
                MATCH (p:Person {person_id: 'mig-test-person-15'})
                RETURN properties(p) as props
            `);
            const afterProps = afterResult.records[0].get('props');

            // All original properties should still exist
            expect(afterProps.name).toBe(beforeProps.name);
            expect(afterProps.birth_date).toBe(beforeProps.birth_date);
            expect(afterProps.birth_name).toBe(beforeProps.birth_name);
            expect(afterProps.custom_field).toBe(beforeProps.custom_field);

            // id should be added
            expect(afterProps.id).toBe('mig-test-person-15');
        });

        test('Migration preserves relationships', async () => {
            // Create nodes with relationship
            await session.run(`
                CREATE (p:Person {person_id: 'mig-test-person-16', name: 'Member'})
                CREATE (g:Group {group_id: 'mig-test-group-4', name: 'Band'})
                CREATE (p)-[:MEMBER_OF {from_date: '2020-01-01', role: 'guitar'}]->(g)
            `);

            // Run migration
            await migrateUnifyIdProperty(driver);

            // Verify relationship still exists with properties intact
            const relResult = await session.run(`
                MATCH (p:Person {person_id: 'mig-test-person-16'})-[r:MEMBER_OF]->(g:Group {group_id: 'mig-test-group-4'})
                RETURN r.from_date as from_date, r.role as role
            `);
            expect(relResult.records.length).toBe(1);
            expect(relResult.records[0].get('from_date')).toBe('2020-01-01');
            expect(relResult.records[0].get('role')).toBe('guitar');
        });
    });
});
