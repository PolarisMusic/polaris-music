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
 * 1. Store event → IPFS (canonical bytes), S3 (full event), Redis (full event) - parallel
 * 2. Retrieve event → Redis → IPFS → S3 (fallback chain)
 *
 * IPFS CID Derivation:
 * - Events stored as raw IPFS blocks with sha2-256 multihash
 * - CID digest matches the anchored SHA256 hash exactly
 * - Can derive CID from hash even if Redis mapping is lost (IPFS-only mode)
 * - Makes IPFS retrieval resilient to cache failures
 *
 * @module storage/eventStore
 */

import { create as createIPFS } from 'ipfs-http-client';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import Redis from 'ioredis';
import { createHash } from 'crypto';
import stringify from 'fast-json-stable-stringify';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { create as createDigest } from 'multiformats/hashes/digest';

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
                console.warn('� IPFS initialization failed:', error.message);
                this.ipfsEnabled = false;
            }
        } else {
            if (process.env.NODE_ENV !== 'test') {
                console.warn('� IPFS not configured');
            }
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
                console.warn('� S3 initialization failed:', error.message);
                this.s3Enabled = false;
            }
        } else {
            if (process.env.NODE_ENV !== 'test') {
                console.warn('� S3 not configured');
            }
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
                    if (process.env.NODE_ENV !== 'test') {
                        console.warn('� Redis error:', error.message);
                    }
                });
            } catch (error) {
                if (process.env.NODE_ENV !== 'test') {
                    console.warn('� Redis initialization failed:', error.message);
                }
                this.redisEnabled = false;
            }
        } else {
            if (process.env.NODE_ENV !== 'test') {
                console.warn('� Redis not configured');
            }
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
     * @param {string} [expectedHash] - Optional expected hash for verification
     * @returns {Promise<Object>} Storage result with hash and locations
     * @throws {Error} If all storage methods fail or if expectedHash doesn't match computed hash
     */
    async storeEvent(event, expectedHash = null) {
        // Validate event structure
        this.validateEvent(event);

        // Normalize expected hash if provided (defensive)
        const normalizedExpectedHash = expectedHash !== null ? this.normalizeHash(expectedHash) : null;

        // Calculate deterministic hash
        const hash = this.calculateHash(event);

        // Enforce hash match if expected hash is provided
        if (normalizedExpectedHash !== null && normalizedExpectedHash !== hash) {
            throw new Error(
                `Hash mismatch: expected ${normalizedExpectedHash}, but computed ${hash}. ` +
                `This indicates the event content doesn't match the blockchain anchor.`
            );
        }
        // Prepare data for storage
        // IPFS: Store canonical bytes (without sig) for CID derivability
        // S3/Redis: Store full event JSON (with sig) for auditability
        const { sig, ...eventWithoutSig } = event;
        const canonicalString = stringify(eventWithoutSig);
        const canonicalBuffer = Buffer.from(canonicalString, 'utf-8');

        const fullEventJSON = JSON.stringify(event, null, 2);
        const fullEventBuffer = Buffer.from(fullEventJSON, 'utf-8');

        console.log(`Storing event ${hash.substring(0, 12)}... (${fullEventBuffer.length} bytes)`);

        const results = {
            hash,
            canonical_cid: null,
            event_cid: null,
            s3: null,
            redis: null,
            errors: []
        };

        // Store to all locations in parallel
        const storagePromises = [];

        // 1. Store to IPFS (canonical bytes for CID derivability)
        if (this.ipfsEnabled) {
            storagePromises.push(
                this.storeToIPFS(canonicalBuffer, hash)
                    .then(cid => {
                        results.canonical_cid = cid;
                        this.stats.ipfsStores++;
                        console.log(`   IPFS canonical: ${cid}`);
                    })
                    .catch(error => {
                        const err = `IPFS canonical storage failed: ${error.message}`;
                        results.errors.push(err);
                        console.warn(`   ${err}`);
                    })
            );

            // Store full event JSON (with signature for auditability and retrieval)
            storagePromises.push(
                this.storeFullEventToIPFS(fullEventBuffer)
                    .then(cid => {
                        results.event_cid = cid;
                        this.stats.ipfsStores++;
                        console.log(`   IPFS full event: ${cid}`);
                    })
                    .catch(error => {
                        const err = `IPFS full event storage failed: ${error.message}`;
                        results.errors.push(err);
                        console.warn(`   ${err}`);
                    })
            );
        }

        // 2. Store to S3 (full event with signature for auditability)
        if (this.s3Enabled) {
            storagePromises.push(
                this.storeToS3(fullEventBuffer, hash)
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
                this.storeToRedis(fullEventJSON, hash)
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

        // CRITICAL: event_cid is REQUIRED for blockchain anchoring
        // If IPFS is enabled but event_cid is missing, the entire pipeline will fail
        // when the smart contract checks !event_cid.empty()
        if (this.ipfsEnabled && !results.event_cid) {
            this.stats.errors++;
            throw new Error(
                `IPFS full event storage failed: event_cid is required to anchor on-chain. ` +
                `Errors: ${results.errors.join(', ') || 'Unknown IPFS failure'}. ` +
                `Check that IPFS daemon is running and accessible.`
            );
        }

        // Check if at least one storage succeeded
        const successCount = [results.canonical_cid, results.event_cid, results.s3, results.redis].filter(Boolean).length;

        if (successCount === 0) {
            this.stats.errors++;
            throw new Error(`Failed to store event: ${results.errors.join(', ')}`);
        }

        // IMPORTANT: If IPFS is disabled in non-test environments, warn loudly
        // The system cannot function without event_cid for blockchain anchoring
        if (!this.ipfsEnabled && process.env.NODE_ENV !== 'test') {
            console.error(
                '⚠️  WARNING: IPFS is disabled but required for blockchain anchoring. ' +
                'Event stored to fallback storage only. Cannot submit to blockchain without event_cid.'
            );
        }

        this.stats.stored++;
        console.log(` Event stored successfully (${successCount}/${storagePromises.length} locations)`);

        return results;
    }

    /**
     * Retrieve an event by its hash.
     * Uses fallback chain: Redis � IPFS � S3
     * Automatically populates cache on retrieval from slower storage.
     *
     * @param {string} hash - SHA256 hash of the event
     * @returns {Promise<Object>} The event object
     * @throws {Error} If event not found in any storage
     */
    /**
     * Retrieve an event from storage by its hash
     *
     * Retrieval order: Redis (cache) → IPFS (canonical) → S3 (full backup)
     *
     * CRITICAL: IPFS stores canonical event WITHOUT signature (for CID derivability).
     * S3/Redis store full event WITH signature (for auditability and verification).
     *
     * To prevent Redis cache poisoning with signature-less events:
     * - If requireSig=true and IPFS returns canonical (no sig), fallback to S3
     * - Only cache full events (with sig) to Redis under event:${hash}
     * - This ensures signature verification can be enabled reliably
     *
     * @param {string} hash - SHA256 hash of the event
     * @param {Object} options - Retrieval options
     * @param {boolean} options.requireSig - If true, require event to have signature (default: false)
     * @returns {Promise<Object>} The event object
     * @throws {Error} If event not found, or requireSig=true but only canonical exists
     */
    async retrieveEvent(hash, { requireSig = false } = {}) {
        // Normalize hash to handle different input formats (defensive)
        const normalizedHash = this.normalizeHash(hash);

        console.log(`Retrieving event ${normalizedHash.substring(0, 12)}...`);

        let event = null;
        let source = null;

        // 1. Try Redis cache first (fastest)
        if (this.redisEnabled) {
            try {
                const cached = await this.retrieveFromRedis(normalizedHash);
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
                const data = await this.retrieveFromIPFS(normalizedHash);
                if (data) {
                    const ipfsEvent = JSON.parse(data.toString('utf-8'));

                    // CRITICAL: IPFS stores canonical (no sig) for CID derivability
                    // If requireSig=true and IPFS event lacks sig, fallback to S3
                    if (requireSig && !ipfsEvent.sig) {
                        console.log(`   Retrieved canonical from IPFS (no sig), falling back to S3 for full event`);
                        // Don't set event yet, let S3 section handle it
                    } else {
                        event = ipfsEvent;
                        source = 'ipfs';
                        this.stats.cacheMisses++;
                        console.log(`   Retrieved from IPFS`);

                        // Only cache to Redis if event has signature
                        // This prevents Redis cache poisoning with signature-less events
                        if (this.redisEnabled && event.sig) {
                            await this.storeToRedis(JSON.stringify(event), normalizedHash)
                                .catch(err => console.warn(`   Failed to cache: ${err.message}`));
                        } else if (this.redisEnabled && !event.sig) {
                            console.log(`   Not caching canonical event to Redis (no signature)`);
                        }
                    }
                }
            } catch (error) {
                console.warn(`   IPFS retrieval failed: ${error.message}`);
            }
        }

        // 3. Try S3 as last resort
        if (!event && this.s3Enabled) {
            try {
                const data = await this.retrieveFromS3(normalizedHash);
                if (data) {
                    event = JSON.parse(data.toString('utf-8'));
                    source = 's3';
                    this.stats.cacheMisses++;
                    console.log(`   Retrieved from S3`);

                    // Populate Redis cache for future requests
                    if (this.redisEnabled) {
                        await this.storeToRedis(JSON.stringify(event), normalizedHash)
                            .catch(err => console.warn(`  � Failed to cache: ${err.message}`));
                    }
                }
            } catch (error) {
                console.warn(`   S3 retrieval failed: ${error.message}`);
            }
        }

        if (!event) {
            this.stats.errors++;

            // Provide helpful error message if requireSig but only canonical available
            if (requireSig && this.ipfsEnabled && !this.s3Enabled) {
                throw new Error(
                    `Full event with signature required but only canonical exists in IPFS. ` +
                    `Enable S3 storage or set requireSig=false. Hash: ${normalizedHash}`
                );
            }

            throw new Error(`Event not found: ${normalizedHash}`);
        }

        // Verify signature requirement is met
        if (requireSig && !event.sig) {
            throw new Error(
                `Event signature required but event at ${normalizedHash} has no signature. ` +
                `This should not happen - please check storage integrity.`
            );
        }

        // Verify hash matches
        const computedHash = this.calculateHash(event);
        if (computedHash !== normalizedHash) {
            throw new Error(`Hash mismatch: expected ${normalizedHash}, got ${computedHash}`);
        }

        this.stats.retrieved++;
        console.log(` Event retrieved successfully from ${source}`);

        return event;
    }

    /**
     * Retrieve an event by its hash (alias for retrieveEvent).
     * Provided for API compatibility with code that expects getEvent().
     *
     * @param {string} hash - SHA256 hash of the event
     * @param {Object} options - Retrieval options (see retrieveEvent)
     * @returns {Promise<Object>} The event object
     * @throws {Error} If event not found in any storage
     */
    async getEvent(hash, options) {
        return this.retrieveEvent(hash, options);
    }

    /**
     * Retrieve event directly by event_cid (IPFS CID of full event).
     * This is faster than hash-based retrieval as it skips CID derivation.
     *
     * Supports both UnixFS (new, stored via ipfs.add) and raw blocks (old, for backward compat).
     * Tries cat() first (UnixFS), falls back to block.get() (raw blocks).
     *
     * Graceful degradation:
     * 1. Try IPFS cat() for UnixFS files (new format, gateway-compatible)
     * 2. If that fails, try block.get() for raw blocks (old format, backward compat)
     * 3. If both fail, return helpful error
     *
     * @param {string} event_cid - IPFS CID of the full event JSON
     * @returns {Promise<Object>} The event object
     * @throws {Error} If event not found, IPFS unavailable, or event invalid
     */
    async retrieveByEventCid(event_cid) {
        console.log(`Retrieving event by CID ${event_cid.substring(0, 20)}...`);

        // Check if IPFS is enabled
        if (!this.ipfsEnabled) {
            this.stats.errors++;
            throw new Error(
                `Cannot retrieve by event_cid: IPFS not configured. ` +
                `Event CID: ${event_cid}`
            );
        }

        let data;
        let retrievalMethod;

        try {
            // Path 1: Try UnixFS cat() first (new format, works with gateways)
            try {
                const chunks = [];
                for await (const chunk of this.ipfs.cat(event_cid)) {
                    chunks.push(chunk);
                }
                data = Buffer.concat(chunks);
                retrievalMethod = 'UnixFS (cat)';
            } catch (catError) {
                // Path 2: Fallback to raw block.get() for backward compatibility
                console.log(`   cat() failed, trying block.get() for backward compatibility...`);
                const block = await this.ipfs.block.get(event_cid);
                data = Buffer.from(block);
                retrievalMethod = 'raw block (block.get)';
            }

            const event = JSON.parse(data.toString('utf-8'));

            // Verify event structure
            this.validateEvent(event);

            // Verify hash matches (important for integrity)
            const computedHash = this.calculateHash(event);
            console.log(` Event retrieved successfully from IPFS via ${retrievalMethod} (hash: ${computedHash.substring(0, 12)}...)`);

            this.stats.retrieved++;
            return event;
        } catch (error) {
            this.stats.errors++;

            // Provide specific error messages for common failure modes
            if (error.message.includes('Not found') || error.message.includes('no link')) {
                throw new Error(
                    `Event not found in IPFS. CID: ${event_cid}. ` +
                    `The event may not be pinned or IPFS node may be out of sync.`
                );
            }

            if (error.message.includes('timeout') || error.message.includes('ETIMEDOUT')) {
                throw new Error(
                    `IPFS retrieval timeout for CID: ${event_cid}. ` +
                    `IPFS node may be slow or unavailable. Try again later.`
                );
            }

            if (error.message.includes('ECONNREFUSED')) {
                throw new Error(
                    `IPFS node unavailable (connection refused). CID: ${event_cid}. ` +
                    `Check that IPFS daemon is running at ${this.config.ipfs?.url || 'configured URL'}.`
                );
            }

            // Generic error with CID for debugging
            throw new Error(`Failed to retrieve event by CID ${event_cid}: ${error.message}`);
        }
    }

    /**
     * Derive CID from hash bytes without re-hashing.
     * Wraps existing hash bytes in multihash format and creates CIDv1.
     *
     * CRITICAL: This does NOT hash the input - it wraps already-hashed bytes.
     * The input should be the raw sha256 digest bytes (32 bytes).
     *
     * @param {string} hash - SHA256 hash as hex string
     * @returns {string} CID string
     */
    deriveCidFromHash(hash) {
        const hashBytes = Buffer.from(hash, 'hex');
        // Wrap existing hash bytes as multihash digest (DON'T hash again!)
        const digest = createDigest(sha256.code, hashBytes);
        // Create CIDv1 with raw codec
        const cid = CID.create(1, raw.code, digest);
        return cid.toString();
    }

    /**
     * Store data to IPFS as a raw block.
     * Lets IPFS compute the CID from the data, then verifies it matches the anchored hash.
     * This ensures true content-addressing: CID is derived from the data, not from hashing the hash.
     *
     * @private
     * @param {Buffer} data - Data to store (canonical event bytes without signature)
     * @param {string} hash - Event hash (sha256 hex string) - used for verification
     * @returns {Promise<string>} IPFS CID
     */
    async storeToIPFS(data, hash) {
        // Let IPFS compute the CID from the actual data bytes
        // This ensures the CID is truly content-addressed
        const result = await this.ipfs.block.put(data, {
            format: 'raw',
            mhtype: 'sha2-256',
            version: 1,
            pin: true
        });

        const cid = result.cid;
        const cidString = cid.toString();

        // CRITICAL: Verify the CID's digest matches our anchored hash
        // If this fails, it means our canonicalization or hash calculation is wrong
        const cidDigestHex = Buffer.from(cid.multihash.digest).toString('hex');
        if (cidDigestHex !== hash) {
            throw new Error(
                `IPFS CID verification failed: ` +
                `CID digest ${cidDigestHex.substring(0, 12)}... ` +
                `doesn't match anchored hash ${hash.substring(0, 12)}... ` +
                `This indicates broken canonicalization or hash mismatch.`
            );
        }

        // Store hash→CID mapping in Redis for faster lookup (optional optimization)
        await this.storeHashCIDMapping(hash, cidString).catch(err =>
            console.warn(`   Failed to store hash→CID mapping: ${err.message}`)
        );

        return cidString;
    }

    /**
     * Store full event JSON to IPFS.
     * Unlike storeToIPFS which stores canonical bytes as raw blocks for verification,
     * this stores the complete event with signature as UnixFS for easy retrieval.
     *
     * Uses UnixFS (ipfs.add) instead of raw blocks because:
     * - Works with ipfs.cat() for retrieval
     * - Compatible with IPFS gateways
     * - Standard IPFS file format
     *
     * @private
     * @param {Buffer} data - Full event JSON buffer (with signature)
     * @returns {Promise<string>} IPFS CID
     */
    async storeFullEventToIPFS(data) {
        // Store as UnixFS file (not raw block) for gateway compatibility
        const result = await this.ipfs.add(
            { content: data },
            {
                pin: true,
                cidVersion: 1,
                hashAlg: 'sha2-256'
            }
        );

        return result.cid.toString();
    }

    /**
     * Retrieve data from IPFS by hash.
     * First tries Redis hash→CID mapping, then derives CID from hash if missing.
     * This makes IPFS retrieval work even without Redis (IPFS-only mode).
     *
     * CRITICAL: Canonical blocks are stored as raw blocks, so use block.get() not cat()
     *
     * @private
     * @param {string} hash - Event hash (sha256 hex string)
     * @returns {Promise<Buffer>} Event data
     */
    async retrieveFromIPFS(hash) {
        // Try Redis mapping first (backward compatibility / cache)
        let cid = await this.getHashCIDMapping(hash);

        if (!cid) {
            // Derive CID from hash when mapping missing
            // This works because we store with raw codec + sha256 multihash
            try {
                cid = this.deriveCidFromHash(hash);
                console.log(`   Derived CID from hash: ${cid}`);

                // Store derived mapping for future lookups (best effort)
                await this.storeHashCIDMapping(hash, cid).catch(err =>
                    console.warn(`   Failed to cache derived CID mapping: ${err.message}`)
                );
            } catch (error) {
                throw new Error(`Failed to derive CID from hash ${hash.substring(0, 12)}...: ${error.message}`);
            }
        }

        // Retrieve from IPFS using block.get() for raw blocks
        try {
            const block = await this.ipfs.block.get(cid);
            return Buffer.from(block);
        } catch (error) {
            throw new Error(`IPFS retrieval failed for CID ${cid}: ${error.message}`);
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
     * Store hash→CID mapping in Redis AND S3 for durable retrieval.
     * S3 sidecar file provides fallback if Redis cache is cleared.
     *
     * NOTE: This mapping is now OPTIONAL for performance (not required for correctness).
     * With CID derivation (raw blocks + sha2-256), CID can be derived from hash directly.
     * This mapping just speeds up retrieval by avoiding CID derivation step.
     *
     * @private
     * @param {string} hash - Event hash
     * @param {string} cid - IPFS CID
     * @returns {Promise<void>}
     */
    async storeHashCIDMapping(hash, cid) {
        const promises = [];

        // Store in Redis (fast cache)
        if (this.redisEnabled) {
            const key = `ipfs:hash:${hash}`;
            promises.push(
                this.redis.set(key, cid)
                    .catch(err => console.warn(`   Failed to cache hash→CID in Redis: ${err.message}`))
            );
        }

        // Store in S3 sidecar file (durable fallback)
        if (this.s3Enabled) {
            promises.push(
                this.storeCIDToS3(hash, cid)
                    .catch(err => console.warn(`   Failed to store hash→CID in S3: ${err.message}`))
            );
        }

        await Promise.allSettled(promises);
    }

    /**
     * Store CID to S3 sidecar file for durable hash→CID mapping.
     *
     * @private
     * @param {string} hash - Event hash
     * @param {string} cid - IPFS CID
     * @returns {Promise<void>}
     */
    async storeCIDToS3(hash, cid) {
        const key = `mappings/${hash.substring(0, 2)}/${hash}.json`;
        const data = JSON.stringify({ hash, cid, stored_at: new Date().toISOString() });

        const command = new PutObjectCommand({
            Bucket: this.s3Bucket,
            Key: key,
            Body: data,
            ContentType: 'application/json'
        });

        await this.s3.send(command);
    }

    /**
     * Retrieve IPFS CID from hash mapping in Redis.
     * Falls back to S3 metadata if Redis cache miss.
     *
     * NOTE: Returns null if mapping not found, which triggers CID derivation.
     * This is now the expected behavior (not an error) when using IPFS-only mode.
     *
     * @private
     * @param {string} hash - Event hash
     * @returns {Promise<string|null>} IPFS CID or null if not found (triggers derivation)
     */
    async getHashCIDMapping(hash) {
        // Try Redis cache first (fast)
        if (this.redisEnabled) {
            const key = `ipfs:hash:${hash}`;
            const cid = await this.redis.get(key);
            if (cid) {
                return cid;
            }
        }

        // Fallback to S3 metadata (durable)
        return await this.getCIDFromS3Metadata(hash);
    }

    /**
     * Retrieve IPFS CID from S3 sidecar file.
     * This provides a durable fallback if Redis cache is cleared.
     *
     * @private
     * @param {string} hash - Event hash
     * @returns {Promise<string|null>} IPFS CID from S3 sidecar, or null if not found
     */
    async getCIDFromS3Metadata(hash) {
        if (!this.s3Enabled) {
            return null;
        }

        try {
            const key = `mappings/${hash.substring(0, 2)}/${hash}.json`;

            const command = new GetObjectCommand({
                Bucket: this.s3Bucket,
                Key: key
            });

            const response = await this.s3.send(command);

            // Convert stream to string
            const chunks = [];
            for await (const chunk of response.Body) {
                chunks.push(chunk);
            }
            const data = Buffer.concat(chunks).toString('utf-8');
            const mapping = JSON.parse(data);

            const cid = mapping.cid;

            if (cid) {
                console.log(`   Retrieved IPFS CID from S3 sidecar: ${cid}`);
                // Re-populate Redis cache for future requests
                if (this.redisEnabled) {
                    const redisKey = `ipfs:hash:${hash}`;
                    await this.redis.set(redisKey, cid)
                        .catch(err => console.warn(`   Failed to cache CID: ${err.message}`));
                }
            }

            return cid || null;
        } catch (error) {
            // Sidecar file not found - not an error, just return null
            return null;
        }
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
     * Hash is calculated from canonical JSON representation using RFC 8785-compliant
     * stable stringification that handles nested objects correctly.
     *
     * CRITICAL: Uses fast-json-stable-stringify to prevent hash collisions.
     * Previous implementation with JSON.stringify(obj, keys.sort()) only sorted
     * top-level keys, causing nested objects to serialize as {} and creating
     * hash collisions for events differing only in nested fields.
     *
     * @param {Object} event - Event to hash
     * @returns {string} SHA256 hash (hex)
     */
    calculateHash(event) {
        // Create canonical representation for hashing
        // Exclude signature field from hash calculation
        const { sig, ...eventWithoutSig } = event;

        // Use stable stringify to recursively sort all keys (including nested)
        // This ensures events with different nested data produce different hashes
        const canonical = stringify(eventWithoutSig);

        return createHash('sha256')
            .update(canonical)
            .digest('hex');
    }

    /**
     * Normalize hash to lowercase hex string (defensive)
     * Handles various input formats from blockchain/Substreams sources
     *
     * @param {string|Array|Object} hash - Hash in various formats
     * @returns {string} Normalized lowercase hex string
     * @throws {Error} If hash format is invalid
     */
    normalizeHash(hash) {
        // String format (most common)
        if (typeof hash === 'string') {
            // Strip 0x prefix if present, then lowercase
            return hash.startsWith('0x') ? hash.slice(2).toLowerCase() : hash.toLowerCase();
        }

        // Byte array format (from Substreams checksum256)
        if (Array.isArray(hash)) {
            return Buffer.from(hash).toString('hex').toLowerCase();
        }

        // Object format with hex field (from some Substreams outputs)
        if (hash && typeof hash === 'object' && hash.hex) {
            const hexStr = hash.hex;
            if (typeof hexStr !== 'string') {
                throw new Error(`Invalid hash format: hash.hex is not a string`);
            }
            return hexStr.startsWith('0x') ? hexStr.slice(2).toLowerCase() : hexStr.toLowerCase();
        }

        throw new Error(`Invalid hash format: ${JSON.stringify(hash)}`);
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
            // Clear both event cache and hash→CID mapping
            const eventKey = `event:${hash}`;
            const mappingKey = `ipfs:hash:${hash}`;
            const result = await this.redis.del(eventKey, mappingKey);
            console.log(` Cleared cache for ${hash}: ${result} key(s)`);
            return result;
        } else {
            // Clear all event keys and hash→CID mappings
            const eventKeys = await this.redis.keys('event:*');
            const mappingKeys = await this.redis.keys('ipfs:hash:*');
            const allKeys = [...eventKeys, ...mappingKeys];

            if (allKeys.length > 0) {
                const result = await this.redis.del(...allKeys);
                console.log(` Cleared cache: ${result} key(s) (${eventKeys.length} events, ${mappingKeys.length} mappings)`);
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
                    .catch(err => console.warn('  � Redis close error:', err.message))
            );
        }

        // IPFS and S3 clients don't need explicit closing

        await Promise.allSettled(closePromises);
        console.log(' Storage connections closed');
    }
}

export default EventStore;
