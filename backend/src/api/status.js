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
 * Critical services (required for ok:true):
 * - Primary IPFS node
 * - Neo4j database
 *
 * Non-critical services (reported but don't affect ok):
 * - Secondary IPFS nodes (best-effort redundancy)
 * - Redis cache (optional)
 * - Pinning provider (optional)
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
 *   ok: boolean,              // true if all CRITICAL services are healthy
 *   timestamp: string,         // ISO8601 timestamp
 *   summary: {                // Quick health summary
 *     ipfs: {
 *       primary_ok: boolean,
 *       secondary_ok: number, // Count of healthy secondary nodes
 *       secondary_total: number
 *     }
 *   },
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
        summary: {
            ipfs: {
                primary_ok: false,
                secondary_ok: 0,
                secondary_total: 0
            }
        },
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
    // Only primary is critical for ok:true
    if (eventStore?.ipfsClients && eventStore.ipfsClients.length > 0) {
        for (let i = 0; i < eventStore.ipfsClients.length; i++) {
            const { client, url } = eventStore.ipfsClients[i];
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
                // Don't set status.ok = false here - we'll compute it after the loop
            }

            status.services.ipfs.push(ipfsStatus);
        }

        // Compute IPFS summary
        const primaryOk = status.services.ipfs[0]?.ok === true;
        const secondaryNodes = status.services.ipfs.slice(1);
        const secondaryOkCount = secondaryNodes.filter(n => n.ok).length;
        const secondaryTotal = secondaryNodes.length;

        status.summary.ipfs.primary_ok = primaryOk;
        status.summary.ipfs.secondary_ok = secondaryOkCount;
        status.summary.ipfs.secondary_total = secondaryTotal;

        // CRITICAL: Only primary IPFS node is required for ok:true
        if (!primaryOk) {
            status.ok = false;
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
    // CRITICAL: Required for ok:true
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
            status.ok = false;  // CRITICAL failure
        }
    } else {
        status.services.neo4j.error = 'Neo4j driver not configured';
        status.ok = false;  // CRITICAL failure
    }

    // ========== Redis Check ==========
    // NON-CRITICAL: Optional, doesn't affect ok:true
    if (redisClient) {
        try {
            await redisClient.ping();
            status.services.redis.ok = true;
        } catch (error) {
            status.services.redis.error = error.message;
            // Redis failure is non-critical - don't set status.ok = false
        }
    } else {
        // Redis not configured - this is OK
        status.services.redis.ok = false;
        status.services.redis.error = 'Redis not configured';
    }

    // ========== Pinning Provider Check ==========
    // NON-CRITICAL: Optional, doesn't affect ok:true
    if (pinningProvider) {
        status.services.pinning_provider.enabled = pinningProvider.isEnabled();
        status.services.pinning_provider.provider = pinningProvider.provider || 'none';
    }

    // ========== Final OK Computation ==========
    // Pipeline is healthy (ok: true) when:
    // - Primary IPFS node is reachable (CRITICAL)
    // - Neo4j database is reachable (CRITICAL)
    //
    // Non-critical services (don't affect ok):
    // - Secondary IPFS nodes (best-effort redundancy)
    // - Redis cache (improves performance but optional)
    // - Pinning provider (best-effort external backup)
    //
    // status.ok is already set correctly above

    return status;
}

export default getStatus;
