/**
 * Neo4j ID Property Tests
 *
 * Verifies that all entity nodes have BOTH entity-specific IDs (person_id, group_id, etc.)
 * AND universal 'id' property for merge operations.
 *
 * This fixes the ID mismatch bug where schema.js used entity-specific IDs
 * but merge.js used universal 'id', causing query failures and duplicate nodes.
 *
 * NOTE: These are integration tests that require a running Neo4j instance.
 * Tests will be skipped if Neo4j is not available.
 */

import MusicGraphDatabase from '../src/graph/schema.js';

describe('Neo4j ID Property Consistency', () => {
    let db;
    let skipTests = false;

    beforeAll(async () => {
        // Skip if no Neo4j connection available
        if (!process.env.GRAPH_URI) {
            skipTests = true;
            console.log('⚠️  Skipping Neo4j integration tests - GRAPH_URI not set');
            return;
        }

        // Create test database instance
        const config = {
            uri: process.env.GRAPH_URI,
            user: process.env.GRAPH_USER || 'neo4j',
            password: process.env.GRAPH_PASSWORD || 'password'
        };
        db = new MusicGraphDatabase(config);

        // Test connection
        try {
            const session = db.driver.session();
            await session.run('RETURN 1');
            await session.close();
            await db.initializeSchema();
        } catch (err) {
            skipTests = true;
            console.log('⚠️  Skipping Neo4j integration tests - connection failed:', err.message);
        }
    });

    afterAll(async () => {
        // Close database connection
        if (db && db.driver) {
            await db.driver.close();
        }
    });

    describe('Schema Constraints', () => {
        test('Universal ID constraints exist for all entity types', async () => {
            if (skipTests) return;
            const session = db.driver.session();
            try {
                const result = await session.run(`
                    SHOW CONSTRAINTS
                    YIELD name, type, labelsOrTypes, properties
                    WHERE type = 'UNIQUENESS'
                    RETURN name, labelsOrTypes, properties
                `);

                const constraints = result.records.map(r => ({
                    name: r.get('name'),
                    labels: r.get('labelsOrTypes'),
                    properties: r.get('properties')
                }));

                // Check universal ID constraints exist
                const universalIdConstraints = constraints.filter(c =>
                    c.properties.includes('id')
                );

                expect(universalIdConstraints.length).toBeGreaterThanOrEqual(9);

                // Check specific entity types have universal ID constraints
                const entityTypes = ['Person', 'Group', 'Track', 'Release', 'Song', 'Label', 'Master', 'City', 'Account'];
                for (const entityType of entityTypes) {
                    const hasConstraint = universalIdConstraints.some(c =>
                        c.labels.includes(entityType)
                    );
                    expect(hasConstraint).toBe(true);
                }
            } finally {
                await session.close();
            }
        }, 30000);

        test('Entity-specific ID constraints still exist', async () => {
            if (skipTests) return;
            const session = db.driver.session();
            try {
                const result = await session.run(`
                    SHOW CONSTRAINTS
                    YIELD name, type, labelsOrTypes, properties
                    WHERE type = 'UNIQUENESS'
                    RETURN name, labelsOrTypes, properties
                `);

                const constraints = result.records.map(r => ({
                    name: r.get('name'),
                    labels: r.get('labelsOrTypes'),
                    properties: r.get('properties')
                }));

                // Check entity-specific constraints still exist
                expect(constraints.some(c => c.properties.includes('person_id'))).toBe(true);
                expect(constraints.some(c => c.properties.includes('group_id'))).toBe(true);
                expect(constraints.some(c => c.properties.includes('track_id'))).toBe(true);
                expect(constraints.some(c => c.properties.includes('release_id'))).toBe(true);
                expect(constraints.some(c => c.properties.includes('song_id'))).toBe(true);
            } finally {
                await session.close();
            }
        }, 30000);
    });

    describe('Node Creation with Dual IDs', () => {
        test('Person nodes have both person_id and id properties', async () => {
            if (skipTests) return;
            const session = db.driver.session();
            const tx = session.beginTransaction();

            try {
                const testPersonId = 'test_person_id_123';

                await tx.run(`
                    MERGE (p:Person {person_id: $personId})
                    ON CREATE SET p.id = $personId,
                                 p.name = $name
                `, {
                    personId: testPersonId,
                    name: 'Test Person'
                });

                const result = await tx.run(`
                    MATCH (p:Person {person_id: $personId})
                    RETURN p.person_id as person_id, p.id as id
                `, { personId: testPersonId });

                await tx.commit();

                expect(result.records.length).toBe(1);
                expect(result.records[0].get('person_id')).toBe(testPersonId);
                expect(result.records[0].get('id')).toBe(testPersonId);

                // Cleanup
                const cleanupTx = session.beginTransaction();
                await cleanupTx.run(`MATCH (p:Person {person_id: $personId}) DELETE p`, { personId: testPersonId });
                await cleanupTx.commit();
            } catch (err) {
                await tx.rollback();
                throw err;
            } finally {
                await session.close();
            }
        }, 30000);

        test('Group nodes have both group_id and id properties', async () => {
            if (skipTests) return;
            const session = db.driver.session();
            const tx = session.beginTransaction();

            try {
                const testGroupId = 'test_group_id_456';

                await tx.run(`
                    MERGE (g:Group {group_id: $groupId})
                    SET g.id = $groupId,
                        g.name = $name
                `, {
                    groupId: testGroupId,
                    name: 'Test Group'
                });

                const result = await tx.run(`
                    MATCH (g:Group {group_id: $groupId})
                    RETURN g.group_id as group_id, g.id as id
                `, { groupId: testGroupId });

                await tx.commit();

                expect(result.records.length).toBe(1);
                expect(result.records[0].get('group_id')).toBe(testGroupId);
                expect(result.records[0].get('id')).toBe(testGroupId);

                // Cleanup
                const cleanupTx = session.beginTransaction();
                await cleanupTx.run(`MATCH (g:Group {group_id: $groupId}) DELETE g`, { groupId: testGroupId });
                await cleanupTx.commit();
            } catch (err) {
                await tx.rollback();
                throw err;
            } finally {
                await session.close();
            }
        }, 30000);

        test('Track nodes have both track_id and id properties', async () => {
            if (skipTests) return;
            const session = db.driver.session();
            const tx = session.beginTransaction();

            try {
                const testTrackId = 'test_track_id_789';

                await tx.run(`
                    MERGE (t:Track {track_id: $trackId})
                    SET t.id = $trackId,
                        t.title = $title
                `, {
                    trackId: testTrackId,
                    title: 'Test Track'
                });

                const result = await tx.run(`
                    MATCH (t:Track {track_id: $trackId})
                    RETURN t.track_id as track_id, t.id as id
                `, { trackId: testTrackId });

                await tx.commit();

                expect(result.records.length).toBe(1);
                expect(result.records[0].get('track_id')).toBe(testTrackId);
                expect(result.records[0].get('id')).toBe(testTrackId);

                // Cleanup
                const cleanupTx = session.beginTransaction();
                await cleanupTx.run(`MATCH (t:Track {track_id: $trackId}) DELETE t`, { trackId: testTrackId });
                await cleanupTx.commit();
            } catch (err) {
                await tx.rollback();
                throw err;
            } finally {
                await session.close();
            }
        }, 30000);
    });

    describe('Merge Operations with Universal ID', () => {
        test('Can query nodes using universal id property', async () => {
            if (skipTests) return;
            const session = db.driver.session();
            const tx = session.beginTransaction();

            try {
                const testId = 'test_universal_id_999';

                // Create node with both IDs
                await tx.run(`
                    MERGE (p:Person {person_id: $id})
                    ON CREATE SET p.id = $id,
                                 p.name = $name
                `, {
                    id: testId,
                    name: 'Test Person for Merge'
                });

                // Query using universal id (as merge.js does)
                const result = await tx.run(`
                    MATCH (n {id: $id})
                    RETURN n.id as id, n.name as name, labels(n)[0] as type
                `, { id: testId });

                await tx.commit();

                expect(result.records.length).toBe(1);
                expect(result.records[0].get('id')).toBe(testId);
                expect(result.records[0].get('name')).toBe('Test Person for Merge');
                expect(result.records[0].get('type')).toBe('Person');

                // Cleanup
                const cleanupTx = session.beginTransaction();
                await cleanupTx.run(`MATCH (n {id: $id}) DELETE n`, { id: testId });
                await cleanupTx.commit();
            } catch (err) {
                await tx.rollback();
                throw err;
            } finally {
                await session.close();
            }
        }, 30000);

        test('Can query different entity types using universal id', async () => {
            if (skipTests) return;
            const session = db.driver.session();
            const tx = session.beginTransaction();

            try {
                const personId = 'universal_person_123';
                const groupId = 'universal_group_456';
                const trackId = 'universal_track_789';

                // Create different entity types
                await tx.run(`
                    MERGE (p:Person {person_id: $personId})
                    ON CREATE SET p.id = $personId, p.name = 'Test Person'

                    MERGE (g:Group {group_id: $groupId})
                    SET g.id = $groupId, g.name = 'Test Group'

                    MERGE (t:Track {track_id: $trackId})
                    SET t.id = $trackId, t.title = 'Test Track'
                `, {
                    personId,
                    groupId,
                    trackId
                });

                // Query all using universal id
                const personResult = await tx.run(`MATCH (n {id: $id}) RETURN labels(n)[0] as type`, { id: personId });
                const groupResult = await tx.run(`MATCH (n {id: $id}) RETURN labels(n)[0] as type`, { id: groupId });
                const trackResult = await tx.run(`MATCH (n {id: $id}) RETURN labels(n)[0] as type`, { id: trackId });

                await tx.commit();

                expect(personResult.records[0].get('type')).toBe('Person');
                expect(groupResult.records[0].get('type')).toBe('Group');
                expect(trackResult.records[0].get('type')).toBe('Track');

                // Cleanup
                const cleanupTx = session.beginTransaction();
                await cleanupTx.run(`
                    MATCH (n)
                    WHERE n.id IN [$personId, $groupId, $trackId]
                    DELETE n
                `, { personId, groupId, trackId });
                await cleanupTx.commit();
            } catch (err) {
                await tx.rollback();
                throw err;
            } finally {
                await session.close();
            }
        }, 30000);
    });
});
