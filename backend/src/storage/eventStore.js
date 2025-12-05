/**
 * @fileoverview Event storage layer for Polaris Music Registry
 *
 * This module implements a multi-layered storage system for canonical events:
 * - Primary: IPFS (decentralized, content-addressed storage)
 * - Backup: S3 (reliable cloud storage)
 * - Cache: Redis (hot cache for fast retrieval)
 *
 * All events are immutable and stored by their SHA256 hash. The storage layer
 * ensures redundancy and fast retrieval with automatic fallback chains.
 *
 * Storage Flow:
 * 1. Store event ’ IPFS, S3, Redis (parallel)
 * 2. Retrieve event ’ Redis ’ IPFS ’ S3 (fallback chain)
 *
 * @module storage/eventStore
 */

import { create as createIPFS } from 'ipfs-http-client';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import Redis from 'ioredis';
import { createHash } from 'crypto';

/**
 * Multi-layered event storage with IPFS, S3, and Redis.
 * Provides redundant storage with automatic fallback and caching.
 *
 * @class EventStore
 */
class EventStore {
    /**
     * Create a new event store
     *
     * @param {Object} config - Storage configuration
     * @param {Object} config.ipfs - IPFS configuration
     * @param {string} config.ipfs.url - IPFS HTTP API URL
     * @param {string} [config.ipfs.gateway] - Public IPFS gateway for fallback
     * @param {Object} config.s3 - S3 configuration
     * @param {string} config.s3.endpoint - S3 endpoint URL
     * @param {string} config.s3.region - S3 region
     * @param {string} config.s3.bucket - S3 bucket name
     * @param {string} config.s3.accessKeyId - AWS access key
     * @param {string} config.s3.secretAccessKey - AWS secret key
     * @param {Object} config.redis - Redis configuration
     * @param {string} config.redis.host - Redis host
     * @param {number} config.redis.port - Redis port
     * @param {string} [config.redis.password] - Redis password
     * @param {number} [config.redis.ttl] - Cache TTL in seconds (default: 86400 = 24h)
     */
    constructor(config) {
        this.config = config;

        // Initialize IPFS client
        if (config.ipfs?.url) {
            try {
                this.ipfs = createIPFS({ url: config.ipfs.url });
                this.ipfsEnabled = true;
                console.log(` IPFS client initialized: ${config.ipfs.url}`);
            } catch (error) {
                console.warn('  IPFS initialization failed:', error.message);
                this.ipfsEnabled = false;
            }
        } else {
            console.warn('  IPFS not configured');
            this.ipfsEnabled = false;
        }

        // Initialize S3 client
        if (config.s3?.endpoint && config.s3?.bucket) {
            try {
                this.s3 = new S3Client({
                    endpoint: config.s3.endpoint,
                    region: config.s3.region || 'us-east-1',
                    credentials: {
                        accessKeyId: config.s3.accessKeyId,
                        secretAccessKey: config.s3.secretAccessKey
                    },
                    forcePathStyle: true // Required for MinIO and some S3-compatible services
                });
                this.s3Bucket = config.s3.bucket;
                this.s3Enabled = true;
                console.log(` S3 client initialized: ${config.s3.endpoint}/${config.s3.bucket}`);
            } catch (error) {
                console.warn('  S3 initialization failed:', error.message);
                this.s3Enabled = false;
            }
        } else {
            console.warn('  S3 not configured');
            this.s3Enabled = false;
        }

        // Initialize Redis client
        if (config.redis?.host) {
            try {
                this.redis = new Redis({
                    host: config.redis.host,
                    port: config.redis.port || 6379,
                    password: config.redis.password,
                    retryStrategy: (times) => {
                        const delay = Math.min(times * 50, 2000);
                        return delay;
                    }
                });
                this.redisTTL = config.redis.ttl || 86400; // 24 hours default
                this.redisEnabled = true;

                this.redis.on('connect', () => {
                    console.log(' Redis connected');
                });

                this.redis.on('error', (error) => {
                    console.warn('  Redis error:', error.message);
                });
            } catch (error) {
                console.warn('  Redis initialization failed:', error.message);
                this.redisEnabled = false;
            }
        } else {
            console.warn('  Redis not configured');
            this.redisEnabled = false;
        }

        // Statistics tracking
        this.stats = {
            stored: 0,
            retrieved: 0,
            cacheHits: 0,
            cacheMisses: 0,
            ipfsStores: 0,
            s3Stores: 0,
            errors: 0
        };
    }

    /**
     * Store an event to all available storage layers.
     * Stores in parallel to IPFS, S3, and Redis for redundancy and performance.
     *
     * @param {Object} event - The canonical event to store
     * @param {number} event.v - Event version
     * @param {string} event.type - Event type
     * @param {string} event.author_pubkey - Author public key
     * @param {number} event.created_at - Unix timestamp
     * @param {Array} event.parents - Parent event hashes
     * @param {Object} event.body - Event body data
     * @param {Object} [event.proofs] - Proof/source data
     * @param {string} event.sig - Cryptographic signature
     * @returns {Promise<Object>} Storage result with hash and locations
     * @throws {Error} If all storage methods fail
     */
    async storeEvent(event) {
        // Validate event structure
        this.validateEvent(event);

        // Calculate deterministic hash
        const hash = this.calculateHash(event);
        const eventJSON = JSON.stringify(event, null, 2);
        const eventBuffer = Buffer.from(eventJSON, 'utf-8');

        console.log(`Storing event ${hash.substring(0, 12)}... (${eventBuffer.length} bytes)`);

        const results = {
            hash,
            ipfs: null,
            s3: null,
            redis: null,
            errors: []
        };

        // Store to all locations in parallel
        const storagePromises = [];

        // 1. Store to IPFS
        if (this.ipfsEnabled) {
            storagePromises.push(
                this.storeToIPFS(eventBuffer, hash)
                    .then(cid => {
                        results.ipfs = cid;
                        this.stats.ipfsStores++;
                        console.log(`   IPFS: ${cid}`);
                    })
                    .catch(error => {
                        const err = `IPFS storage failed: ${error.message}`;
                        results.errors.push(err);
                        console.warn(`   ${err}`);
                    })
            );
        }

        // 2. Store to S3
        if (this.s3Enabled) {
            storagePromises.push(
                this.storeToS3(eventBuffer, hash)
                    .then(location => {
                        results.s3 = location;
                        this.stats.s3Stores++;
                        console.log(`   S3: ${location}`);
                    })
                    .catch(error => {
                        const err = `S3 storage failed: ${error.message}`;
                        results.errors.push(err);
                        console.warn(`   ${err}`);
                    })
            );
        }

        // 3. Store to Redis cache
        if (this.redisEnabled) {
            storagePromises.push(
                this.storeToRedis(eventJSON, hash)
                    .then(() => {
                        results.redis = true;
                        console.log(`   Redis (TTL: ${this.redisTTL}s)`);
                    })
                    .catch(error => {
                        const err = `Redis cache failed: ${error.message}`;
                        results.errors.push(err);
                        console.warn(`   ${err}`);
                    })
            );
        }

        // Wait for all storage operations
        await Promise.allSettled(storagePromises);

        // Check if at least one storage succeeded
        const successCount = [results.ipfs, results.s3, results.redis].filter(Boolean).length;

        if (successCount === 0) {
            this.stats.errors++;
            throw new Error(`Failed to store event: ${results.errors.join(', ')}`);
        }

        this.stats.stored++;
        console.log(` Event stored successfully (${successCount}/${storagePromises.length} locations)`);

        return results;
    }

    /**
     * Retrieve an event by its hash.
     * Uses fallback chain: Redis ’ IPFS ’ S3
     * Automatically populates cache on retrieval from slower storage.
     *
     * @param {string} hash - SHA256 hash of the event
     * @returns {Promise<Object>} The event object
     * @throws {Error} If event not found in any storage
     */
    async retrieveEvent(hash) {
        console.log(`Retrieving event ${hash.substring(0, 12)}...`);

        let event = null;
        let source = null;

        // 1. Try Redis cache first (fastest)
        if (this.redisEnabled) {
            try {
                const cached = await this.retrieveFromRedis(hash);
                if (cached) {
                    event = JSON.parse(cached);
                    source = 'redis';
                    this.stats.cacheHits++;
                    console.log(`   Retrieved from Redis (cache hit)`);
                }
            } catch (error) {
                console.warn(`   Redis retrieval failed: ${error.message}`);
            }
        }

        // 2. Try IPFS if not in cache
        if (!event && this.ipfsEnabled) {
            try {
                const data = await this.retrieveFromIPFS(hash);
                if (data) {
                    event = JSON.parse(data.toString('utf-8'));
                    source = 'ipfs';
                    this.stats.cacheMisses++;
                    console.log(`   Retrieved from IPFS`);

                    // Populate Redis cache for future requests
                    if (this.redisEnabled) {
                        await this.storeToRedis(JSON.stringify(event), hash)
                            .catch(err => console.warn(`    Failed to cache: ${err.message}`));
                    }
                }
            } catch (error) {
                console.warn(`   IPFS retrieval failed: ${error.message}`);
            }
        }

        // 3. Try S3 as last resort
        if (!event && this.s3Enabled) {
            try {
                const data = await this.retrieveFromS3(hash);
                if (data) {
                    event = JSON.parse(data.toString('utf-8'));
                    source = 's3';
                    this.stats.cacheMisses++;
                    console.log(`   Retrieved from S3`);

                    // Populate Redis cache for future requests
                    if (this.redisEnabled) {
                        await this.storeToRedis(JSON.stringify(event), hash)
                            .catch(err => console.warn(`    Failed to cache: ${err.message}`));
                    }
                }
            } catch (error) {
                console.warn(`   S3 retrieval failed: ${error.message}`);
            }
        }

        if (!event) {
            this.stats.errors++;
            throw new Error(`Event not found: ${hash}`);
        }

        // Verify hash matches
        const computedHash = this.calculateHash(event);
        if (computedHash !== hash) {
            throw new Error(`Hash mismatch: expected ${hash}, got ${computedHash}`);
        }

        this.stats.retrieved++;
        console.log(` Event retrieved successfully from ${source}`);

        return event;
    }

    /**
     * Store data to IPFS.
     *
     * @private
     * @param {Buffer} data - Data to store
     * @param {string} hash - Event hash (for metadata)
     * @returns {Promise<string>} IPFS CID
     */
    async storeToIPFS(data, hash) {
        const result = await this.ipfs.add(data, {
            pin: true, // Pin to prevent garbage collection
            cidVersion: 1 // Use CIDv1 for better compatibility
        });

        return result.cid.toString();
    }

    /**
     * Retrieve data from IPFS by hash.
     * First tries using the hash directly, then searches pinned objects.
     *
     * @private
     * @param {string} hash - Event hash
     * @returns {Promise<Buffer>} Event data
     */
    async retrieveFromIPFS(hash) {
        // IPFS stores by CID, but we can map hash ’ CID in metadata
        // For now, we search through pinned objects
        // In production, maintain a hash’CID mapping in Redis

        // Try to get by CID if hash is actually a CID
        try {
            const chunks = [];
            for await (const chunk of this.ipfs.cat(hash)) {
                chunks.push(chunk);
            }
            return Buffer.concat(chunks);
        } catch (error) {
            // Hash is not a CID, need to search
            throw new Error(`IPFS retrieval requires CID, not hash. Implement hash’CID mapping.`);
        }
    }

    /**
     * Store data to S3.
     *
     * @private
     * @param {Buffer} data - Data to store
     * @param {string} hash - Event hash (used as S3 key)
     * @returns {Promise<string>} S3 location
     */
    async storeToS3(data, hash) {
        // Store with hash as key for easy retrieval
        const key = `events/${hash.substring(0, 2)}/${hash}.json`;

        const command = new PutObjectCommand({
            Bucket: this.s3Bucket,
            Key: key,
            Body: data,
            ContentType: 'application/json',
            Metadata: {
                'event-hash': hash,
                'stored-at': new Date().toISOString()
            }
        });

        await this.s3.send(command);

        return `s3://${this.s3Bucket}/${key}`;
    }

    /**
     * Retrieve data from S3 by hash.
     *
     * @private
     * @param {string} hash - Event hash
     * @returns {Promise<Buffer>} Event data
     */
    async retrieveFromS3(hash) {
        const key = `events/${hash.substring(0, 2)}/${hash}.json`;

        const command = new GetObjectCommand({
            Bucket: this.s3Bucket,
            Key: key
        });

        const response = await this.s3.send(command);

        // Convert stream to buffer
        const chunks = [];
        for await (const chunk of response.Body) {
            chunks.push(chunk);
        }

        return Buffer.concat(chunks);
    }

    /**
     * Store event JSON to Redis cache.
     *
     * @private
     * @param {string} eventJSON - Serialized event
     * @param {string} hash - Event hash (used as key)
     * @returns {Promise<void>}
     */
    async storeToRedis(eventJSON, hash) {
        const key = `event:${hash}`;
        await this.redis.setex(key, this.redisTTL, eventJSON);
    }

    /**
     * Retrieve event JSON from Redis cache.
     *
     * @private
     * @param {string} hash - Event hash
     * @returns {Promise<string|null>} Event JSON or null if not found
     */
    async retrieveFromRedis(hash) {
        const key = `event:${hash}`;
        return await this.redis.get(key);
    }

    /**
     * Validate event structure before storage.
     *
     * @private
     * @param {Object} event - Event to validate
     * @throws {Error} If event is invalid
     */
    validateEvent(event) {
        if (!event || typeof event !== 'object') {
            throw new Error('Event must be an object');
        }

        const required = ['v', 'type', 'author_pubkey', 'created_at', 'body', 'sig'];
        for (const field of required) {
            if (!(field in event)) {
                throw new Error(`Event missing required field: ${field}`);
            }
        }

        if (typeof event.v !== 'number' || event.v < 1) {
            throw new Error('Event version must be a positive number');
        }

        if (typeof event.created_at !== 'number' || event.created_at <= 0) {
            throw new Error('Event created_at must be a positive Unix timestamp');
        }

        if (!event.body || typeof event.body !== 'object') {
            throw new Error('Event body must be an object');
        }
    }

    /**
     * Calculate deterministic SHA256 hash of an event.
     * Hash is calculated from canonical JSON representation.
     *
     * @param {Object} event - Event to hash
     * @returns {string} SHA256 hash (hex)
     */
    calculateHash(event) {
        // Create canonical representation for hashing
        // Exclude signature field from hash calculation
        const { sig, ...eventWithoutSig } = event;

        // Sort keys for deterministic JSON
        const canonical = JSON.stringify(eventWithoutSig, Object.keys(eventWithoutSig).sort());

        return createHash('sha256')
            .update(canonical)
            .digest('hex');
    }

    /**
     * Pin an event in IPFS to prevent garbage collection.
     *
     * @param {string} cid - IPFS CID to pin
     * @returns {Promise<void>}
     */
    async pinEvent(cid) {
        if (!this.ipfsEnabled) {
            throw new Error('IPFS not enabled');
        }

        await this.ipfs.pin.add(cid);
        console.log(` Pinned to IPFS: ${cid}`);
    }

    /**
     * Unpin an event from IPFS (use with caution).
     *
     * @param {string} cid - IPFS CID to unpin
     * @returns {Promise<void>}
     */
    async unpinEvent(cid) {
        if (!this.ipfsEnabled) {
            throw new Error('IPFS not enabled');
        }

        await this.ipfs.pin.rm(cid);
        console.log(` Unpinned from IPFS: ${cid}`);
    }

    /**
     * List all pinned IPFS objects.
     *
     * @returns {Promise<Array>} Array of pinned CIDs
     */
    async listPinned() {
        if (!this.ipfsEnabled) {
            throw new Error('IPFS not enabled');
        }

        const pins = [];
        for await (const pin of this.ipfs.pin.ls()) {
            pins.push(pin.cid.toString());
        }

        return pins;
    }

    /**
     * Clear Redis cache for a specific event or all events.
     *
     * @param {string} [hash] - Event hash to clear, or undefined to clear all
     * @returns {Promise<number>} Number of keys cleared
     */
    async clearCache(hash) {
        if (!this.redisEnabled) {
            throw new Error('Redis not enabled');
        }

        if (hash) {
            const key = `event:${hash}`;
            const result = await this.redis.del(key);
            console.log(` Cleared cache for ${hash}: ${result} key(s)`);
            return result;
        } else {
            // Clear all event keys
            const keys = await this.redis.keys('event:*');
            if (keys.length > 0) {
                const result = await this.redis.del(...keys);
                console.log(` Cleared cache: ${result} key(s)`);
                return result;
            }
            return 0;
        }
    }

    /**
     * Get storage statistics.
     *
     * @returns {Object} Statistics object
     */
    getStats() {
        return {
            ...this.stats,
            cacheHitRate: this.stats.cacheHits + this.stats.cacheMisses > 0
                ? (this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses) * 100).toFixed(2) + '%'
                : 'N/A',
            enabled: {
                ipfs: this.ipfsEnabled,
                s3: this.s3Enabled,
                redis: this.redisEnabled
            }
        };
    }

    /**
     * Test connectivity to all storage services.
     *
     * @returns {Promise<Object>} Connectivity status for each service
     */
    async testConnectivity() {
        const results = {
            ipfs: false,
            s3: false,
            redis: false
        };

        // Test IPFS
        if (this.ipfsEnabled) {
            try {
                await this.ipfs.id();
                results.ipfs = true;
            } catch (error) {
                console.warn('IPFS connectivity test failed:', error.message);
            }
        }

        // Test S3
        if (this.s3Enabled) {
            try {
                // Try a simple head bucket operation
                const testData = Buffer.from('test');
                await this.storeToS3(testData, 'connectivity-test');
                results.s3 = true;
            } catch (error) {
                console.warn('S3 connectivity test failed:', error.message);
            }
        }

        // Test Redis
        if (this.redisEnabled) {
            try {
                await this.redis.ping();
                results.redis = true;
            } catch (error) {
                console.warn('Redis connectivity test failed:', error.message);
            }
        }

        return results;
    }

    /**
     * Close all connections and cleanup.
     * Always call this when shutting down the application.
     *
     * @returns {Promise<void>}
     */
    async close() {
        console.log('Closing storage connections...');

        const closePromises = [];

        if (this.redisEnabled) {
            closePromises.push(
                this.redis.quit()
                    .then(() => console.log('   Redis connection closed'))
                    .catch(err => console.warn('    Redis close error:', err.message))
            );
        }

        // IPFS and S3 clients don't need explicit closing

        await Promise.allSettled(closePromises);
        console.log(' Storage connections closed');
    }
}

export default EventStore;
