/**
 * Clear all data from Neo4j graph database
 * Use this to reset the database before loading new data
 */

import neo4j from 'neo4j-driver';

const driver = neo4j.driver(
    process.env.GRAPH_URI || 'bolt://localhost:7687',
    neo4j.auth.basic(
        process.env.GRAPH_USER || 'neo4j',
        process.env.GRAPH_PASSWORD || 'polarisdev'
    )
);

async function clearAllData() {
    const session = driver.session();

    try {
        console.log('🗑️  Clearing all graph data...\n');

        // Delete all relationships
        await session.run('MATCH ()-[r]->() DELETE r');
        console.log('✓ Deleted all relationships');

        // Delete all nodes
        await session.run('MATCH (n) DELETE n');
        console.log('✓ Deleted all nodes');

        console.log('\n✨ Database cleared successfully!');

    } catch (error) {
        console.error('Error clearing data:', error);
        throw error;
    } finally {
        await session.close();
        await driver.close();
    }
}

clearAllData()
    .then(() => {
        process.exit(0);
    })
    .catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
