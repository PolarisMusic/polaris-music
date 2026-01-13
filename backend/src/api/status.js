/**
 * @fileoverview System Status Helper
 *
 * Provides comprehensive health checks for all pipeline services.
 * Used by GET /api/status endpoint for monitoring and smoke tests.
 *
 * @module api/status
 */

/**
 * Get comprehensive system status
 *
 * Checks all critical services and returns detailed health information.
 *
 * @param {Object} options - Service instances
 * @param {EventStore} options.eventStore - Event store with IPFS clients
 * @param {neo4j.Driver} options.neo4jDriver - Neo4j driver instance
 * @param {Redis} options.redisClient - Redis client (optional)
 * @param {PinningProvider} options.pinningProvider - Pinning provider (optional)
 * @returns {Promise<Object>} Status object
 *
 * Response format:
 * {
 *   ok: boolean,              // true if all critical services are healthy
 *   timestamp: string,         // ISO8601 timestamp
 *   services: {
 *     ipfs: [                 // Array of IPFS nodes
 *       {
 *         url: string,        // IPFS API endpoint
 *         ok: boolean,        // Node health
 *         id: string,         // IPFS peer ID (if reachable)
 *         version: string,    // IPFS version (if reachable)
 *         error: string       // Error message (if unreachable)
 *       }
 *     ],
 *     neo4j: { ok: boolean, error?: string },
 *     redis: { ok: boolean, error?: string },
 *     pinning_provider: {
 *       enabled: boolean,
 *       provider: string      // "none" | "pinata" | "web3storage" | "custom"
 *     }
 *   }
 * }
 */
export async function getStatus({ eventStore, neo4jDriver, redisClient, pinningProvider }) {
    const timestamp = new Date().toISOString();

    const status = {
        ok: true,
        timestamp,
        services: {
            ipfs: [],
            neo4j: { ok: false },
            redis: { ok: false },
            pinning_provider: {
                enabled: false,
                provider: 'none'
            }
        }
    };

    // ========== IPFS Node Checks ==========
    // Check all configured IPFS nodes (primary + secondary)
    if (eventStore?.ipfsClients && eventStore.ipfsClients.length > 0) {
        for (const { client, url } of eventStore.ipfsClients) {
            const ipfsStatus = {
                url,
                ok: false
            };

            try {
                // Get node ID and version (fast health check)
                const [idResult, versionResult] = await Promise.all([
                    client.id(),
                    client.version()
                ]);

                ipfsStatus.ok = true;
                ipfsStatus.id = idResult.id;
                ipfsStatus.version = versionResult.version;
            } catch (error) {
                ipfsStatus.error = error.message;
                status.ok = false;  // Any IPFS node failure = pipeline unhealthy
            }

            status.services.ipfs.push(ipfsStatus);
        }
    } else {
        // No IPFS clients configured - pipeline cannot function
        status.ok = false;
        status.services.ipfs.push({
            url: 'none',
            ok: false,
            error: 'No IPFS clients configured'
        });
    }

    // ========== Neo4j Check ==========
    if (neo4jDriver) {
        try {
            // Use verifyConnectivity (recommended) or fallback to simple query
            if (typeof neo4jDriver.verifyConnectivity === 'function') {
                await neo4jDriver.verifyConnectivity();
                status.services.neo4j.ok = true;
            } else {
                // Fallback: run simple query
                const session = neo4jDriver.session();
                try {
                    await session.run('RETURN 1');
                    status.services.neo4j.ok = true;
                } finally {
                    await session.close();
                }
            }
        } catch (error) {
            status.services.neo4j.error = error.message;
            status.ok = false;
        }
    } else {
        status.services.neo4j.error = 'Neo4j driver not configured';
        status.ok = false;
    }

    // ========== Redis Check ==========
    if (redisClient) {
        try {
            await redisClient.ping();
            status.services.redis.ok = true;
        } catch (error) {
            status.services.redis.error = error.message;
            status.ok = false;
        }
    } else {
        // Redis is optional in some configurations (e.g., tests)
        // Don't fail overall status if Redis is not configured
        status.services.redis.ok = false;
        status.services.redis.error = 'Redis not configured';
    }

    // ========== Pinning Provider Check ==========
    if (pinningProvider) {
        status.services.pinning_provider.enabled = pinningProvider.isEnabled();
        status.services.pinning_provider.provider = pinningProvider.provider || 'none';
    }

    // ========== Final OK Computation ==========
    // Pipeline requires:
    // - At least one IPFS node (ideally all configured nodes should be healthy)
    // - Neo4j database
    // - Redis (optional but recommended)
    //
    // We already set status.ok = false above for any critical failures
    // Double-check: require at least primary IPFS node healthy
    if (status.services.ipfs.length === 0 || !status.services.ipfs[0]?.ok) {
        status.ok = false;
    }

    return status;
}

export default getStatus;
