# Implementation in backend/src/storage/eventStore.js

# Event Storage - Off-chain Canonical Events

## Overview
Handles storage and retrieval of canonical off-chain events. Events are stored in multiple locations for redundancy and are content-addressed by SHA-256 hash.

## Implementation

```javascript
// File: backend/src/storage/eventStore.js
// Manages off-chain event storage across IPFS, S3, and local cache
// All events are canonical (deterministic) and signed

import { create } from 'ipfs-http-client';
import AWS from 'aws-sdk';
import { canonicalize } from 'json-canonicalize';
import { createHash, sign, verify } from 'crypto';
import { PrivateKey, PublicKey, Signature } from 'eosjs/dist/eosjs-key-conversions';
import Redis from 'ioredis';

class EventStore {
    constructor(config) {
        /**
         * Initialize storage backends
         * We use multiple storage layers for redundancy and performance
         */
        
        // IPFS for decentralized, content-addressed storage
        this.ipfs = create({ 
            url: config.ipfsUrl,
            timeout: 30000
        });
        
        // S3 for fast CDN-backed retrieval
        this.s3 = new AWS.S3({
            accessKeyId: config.aws.accessKeyId,
            secretAccessKey: config.aws.secretAccessKey,
            region: config.aws.region
        });
        this.bucket = config.aws.bucket;
        
        // Redis for hot cache
        this.redis = new Redis({
            host: config.redis.host,
            port: config.redis.port,
            password: config.redis.password,
            retryStrategy: (times) => Math.min(times * 50, 2000)
        });
        
        // Local file cache
        this.localCachePath = config.localCachePath || './cache/events';
        
        // Minimum number of successful stores before anchoring
        this.minRedundancy = config.minRedundancy || 2;
    }
    
    /**
     * Create a canonical event with deterministic structure
     * This ensures the same event always produces the same hash
     * Events follow the Clarion-style format
     * 
     * @param {string} type - Event type (CREATE_RELEASE_BUNDLE, etc)
     * @param {object} body - Event-specific payload
     * @param {string} authorPubkey - EOS public key of author
     * @param {array} parents - Optional parent event hashes for threading
     * @param {object} proofs - Optional external proofs/sources
     * @returns {object} Event object with hash
     */
    async createEvent(type, body, authorPubkey, parents = [], proofs = {}) {
        // Create the event structure
        const event = {
            v: 1,                           // Version for future compatibility
            type,                          // Event type string
            author_pubkey: authorPubkey,   // EOS public key
            created_at: Math.floor(Date.now() / 1000), // Unix timestamp
            parents,                       // Parent events for threading
            body,                          // Main payload
            proofs                         // External references
        };
        
        // Canonicalize to ensure deterministic JSON
        // This uses RFC 8785 JSON Canonicalization Scheme
        const canonical = canonicalize(event);
        
        // Calculate SHA-256 hash of canonical bytes
        const hashBuffer = createHash('sha256').update(canonical).digest();
        const hash = hashBuffer.toString('hex');
        
        // Event is not yet signed - that happens client-side
        // Return structure ready for signing
        return { 
            event, 
            canonical, 
            hash,
            hashBuffer
        };
    }
    
    /**
     * Sign an event with EOS private key
     * This proves the author created this exact event
     * 
     * @param {object} event - Event to sign
     * @param {string} privateKey - EOS private key
     * @returns {object} Signed event
     */
    signEvent(event, privateKey) {
        // Convert EOS private key to signing key
        const key = PrivateKey.fromString(privateKey);
        
        // Sign the hash
        const signature = key.sign(event.hashBuffer, false, 'utf8');
        
        // Add signature to event
        event.event.sig = signature.toString();
        
        return event;
    }
    
    /**
     * Verify an event signature
     * Ensures the event hasn't been tampered with
     * 
     * @param {object} event - Event with signature
     * @returns {boolean} True if valid
     */
    verifyEventSignature(event) {
        try {
            // Extract signature and remove from event for verification
            const { sig, ...eventWithoutSig } = event;
            
            // Recreate canonical form
            const canonical = canonicalize(eventWithoutSig);
            const hashBuffer = createHash('sha256').update(canonical).digest();
            
            // Convert public key and signature
            const pubKey = PublicKey.fromString(event.author_pubkey);
            const signature = Signature.fromString(sig);
            
            // Verify signature
            return signature.verify(hashBuffer, pubKey, false, 'utf8');
        } catch (error) {
            console.error('Signature verification failed:', error);
            return false;
        }
    }
    
    /**
     * Store event in multiple locations for redundancy
     * Must succeed in at least minRedundancy locations before anchoring
     * 
     * @param {object} event - Complete signed event
     * @param {string} hash - Event hash
     * @returns {array} Storage locations where successful
     */
    async storeEvent(event, hash) {
        const stored = [];
        const errors = [];
        
        // Prepare event data
        const eventJson = JSON.stringify(event);
        const eventBuffer = Buffer.from(eventJson);
        
        // === 1. Store in Redis (hot cache) ===
        try {
            await this.redis.set(
                `event:${hash}`, 
                eventJson,
                'EX', 86400 * 7  // Expire after 7 days
            );
            stored.push({ type: 'redis', key: hash });
        } catch (error) {
            console.error('Redis storage failed:', error);
            errors.push({ type: 'redis', error: error.message });
        }
        
        // === 2. Store in IPFS (decentralized) ===
        try {
            const ipfsResult = await this.ipfs.add({
                path: `${hash}.json`,
                content: eventBuffer
            }, {
                pin: true,  // Pin to prevent garbage collection
                timeout: 10000
            });
            
            stored.push({ 
                type: 'ipfs', 
                cid: ipfsResult.cid.toString(),
                path: ipfsResult.path
            });
            
            // Also pin by hash for easier retrieval
            await this.ipfs.pin.add(ipfsResult.cid);
            
        } catch (error) {
            console.error('IPFS storage failed:', error);
            errors.push({ type: 'ipfs', error: error.message });
        }
        
        // === 3. Store in S3 (CDN-backed) ===
        try {
            await this.s3.putObject({
                Bucket: this.bucket,
                Key: `events/${hash}.json`,
                Body: eventBuffer,
                ContentType: 'application/json',
                // Immutable content - can cache forever
                CacheControl: 'public, max-age=31536000, immutable',
                Metadata: {
                    'event-type': event.type,
                    'event-author': event.author_pubkey,
                    'event-timestamp': event.created_at.toString()
                }
            }).promise();
            
            stored.push({ 
                type: 's3', 
                bucket: this.bucket,
                key: `events/${hash}.json` 
            });
            
        } catch (error) {
            console.error('S3 storage failed:', error);
            errors.push({ type: 's3', error: error.message });
        }
        
        // === 4. Store locally (fallback) ===
        try {
            const fs = require('fs').promises;
            const path = require('path');
            
            const filePath = path.join(this.localCachePath, `${hash}.json`);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, eventJson);
            
            stored.push({ 
                type: 'local', 
                path: filePath 
            });
            
        } catch (error) {
            console.error('Local storage failed:', error);
            errors.push({ type: 'local', error: error.message });
        }
        
        // Check minimum redundancy requirement
        if (stored.length < this.minRedundancy) {
            throw new Error(
                `Failed to achieve minimum redundancy. ` +
                `Required: ${this.minRedundancy}, Successful: ${stored.length}. ` +
                `Errors: ${JSON.stringify(errors)}`
            );
        }
        
        // Log storage summary
        console.log(`Event ${hash} stored in ${stored.length} locations:`, 
                   stored.map(s => s.type).join(', '));
        
        return stored;
    }
    
    /**
     * Retrieve event from any available source
     * Tries fastest sources first, falls back to slower ones
     * Validates hash on retrieval
     * 
     * @param {string} hash - Event hash to retrieve
     * @returns {object} Event object
     */
    async retrieveEvent(hash) {
        let event = null;
        const attempts = [];
        
        // === 1. Try Redis first (fastest) ===
        try {
            const redisData = await this.redis.get(`event:${hash}`);
            if (redisData) {
                event = JSON.parse(redisData);
                attempts.push({ source: 'redis', success: true });
                
                // Validate hash matches
                if (await this.validateEventHash(event, hash)) {
                    return event;
                }
            }
        } catch (error) {
            attempts.push({ source: 'redis', error: error.message });
        }
        
        // === 2. Try S3/CDN (fast, reliable) ===
        if (!event) {
            try {
                const s3Result = await this.s3.getObject({
                    Bucket: this.bucket,
                    Key: `events/${hash}.json`
                }).promise();
                
                event = JSON.parse(s3Result.Body.toString());
                attempts.push({ source: 's3', success: true });
                
                // Cache in Redis for next time
                this.redis.set(`event:${hash}`, s3Result.Body.toString(), 'EX', 86400);
                
                // Validate hash
                if (await this.validateEventHash(event, hash)) {
                    return event;
                }
                
            } catch (error) {
                attempts.push({ source: 's3', error: error.message });
            }
        }
        
        // === 3. Try local cache ===
        if (!event) {
            try {
                const fs = require('fs').promises;
                const path = require('path');
                
                const filePath = path.join(this.localCachePath, `${hash}.json`);
                const fileData = await fs.readFile(filePath, 'utf8');
                event = JSON.parse(fileData);
                attempts.push({ source: 'local', success: true });
                
                // Validate hash
                if (await this.validateEventHash(event, hash)) {
                    return event;
                }
                
            } catch (error) {
                attempts.push({ source: 'local', error: error.message });
            }
        }
        
        // === 4. Try IPFS (slower but decentralized) ===
        if (!event) {
            try {
                // Try different retrieval methods
                const chunks = [];
                
                // First try by path
                try {
                    for await (const chunk of this.ipfs.cat(`/ipfs/${hash}.json`)) {
                        chunks.push(chunk);
                    }
                } catch {
                    // Try by CID if we have it stored
                    // This would require storing CID mapping
                }
                
                if (chunks.length > 0) {
                    const data = Buffer.concat(chunks).toString();
                    event = JSON.parse(data);
                    attempts.push({ source: 'ipfs', success: true });
                    
                    // Cache in faster storage
                    this.redis.set(`event:${hash}`, data, 'EX', 86400);
                    
                    // Validate hash
                    if (await this.validateEventHash(event, hash)) {
                        return event;
                    }
                }
                
            } catch (error) {
                attempts.push({ source: 'ipfs', error: error.message });
            }
        }
        
        // All retrieval attempts failed
        console.error('Event retrieval attempts:', attempts);
        throw new Error(`Event ${hash} not found in any storage location`);
    }
    
    /**
     * Validate that an event matches its expected hash
     * Prevents tampering and ensures integrity
     * 
     * @param {object} event - Event to validate
     * @param {string} expectedHash - Expected hash
     * @returns {boolean} True if valid
     */
    async validateEventHash(event, expectedHash) {
        try {
            // Remove signature for hash calculation
            const { sig, ...eventWithoutSig } = event;
            
            // Recreate canonical form
            const canonical = canonicalize(eventWithoutSig);
            const computedHash = createHash('sha256')
                .update(canonical)
                .digest('hex');
            
            if (computedHash !== expectedHash) {
                console.error(`Hash mismatch! Expected: ${expectedHash}, Got: ${computedHash}`);
                return false;
            }
            
            // Also verify signature if present
            if (sig && !this.verifyEventSignature(event)) {
                console.error('Invalid signature on event');
                return false;
            }
            
            return true;
            
        } catch (error) {
            console.error('Hash validation error:', error);
            return false;
        }
    }
    
    /**
     * Batch retrieve multiple events efficiently
     * Used when processing related events
     * 
     * @param {array} hashes - Array of event hashes
     * @returns {Map} Map of hash to event
     */
    async retrieveEvents(hashes) {
        const events = new Map();
        
        // Try to get all from Redis first (fastest)
        const pipeline = this.redis.pipeline();
        for (const hash of hashes) {
            pipeline.get(`event:${hash}`);
        }
        
        const results = await pipeline.exec();
        const missing = [];
        
        results.forEach((result, index) => {
            if (result[1]) {  // result is [error, value]
                try {
                    const event = JSON.parse(result[1]);
                    events.set(hashes[index], event);
                } catch (error) {
                    missing.push(hashes[index]);
                }
            } else {
                missing.push(hashes[index]);
            }
        });
        
        // Fetch missing events individually
        for (const hash of missing) {
            try {
                const event = await this.retrieveEvent(hash);
                events.set(hash, event);
            } catch (error) {
                console.error(`Failed to retrieve event ${hash}:`, error);
            }
        }
        
        return events;
    }
    
    /**
     * Archive events to cold storage
     * Used for older events to reduce storage costs
     * 
     * @param {Date} beforeDate - Archive events before this date
     */
    async archiveEvents(beforeDate) {
        // Implementation would:
        // 1. Query events before date
        // 2. Create CAR (Content Addressed Archive) files
        // 3. Upload to Glacier or Filecoin
        // 4. Remove from hot storage
        // 5. Keep index of archived events
        
        console.log('Archiving events before:', beforeDate);
        // TODO: Implement archival strategy
    }
    
    /**
     * Health check for all storage backends
     * Used for monitoring and alerting
     */
    async healthCheck() {
        const health = {
            redis: false,
            ipfs: false,
            s3: false,
            local: false,
            overall: false
        };
        
        // Test Redis
        try {
            await this.redis.ping();
            health.redis = true;
        } catch (error) {
            console.error('Redis health check failed:', error);
        }
        
        // Test IPFS
        try {
            const id = await this.ipfs.id();
            health.ipfs = !!id;
        } catch (error) {
            console.error('IPFS health check failed:', error);
        }
        
        // Test S3
        try {
            await this.s3.headBucket({ Bucket: this.bucket }).promise();
            health.s3 = true;
        } catch (error) {
            console.error('S3 health check failed:', error);
        }
        
        // Test local filesystem
        try {
            const fs = require('fs').promises;
            await fs.access(this.localCachePath);
            health.local = true;
        } catch (error) {
            console.error('Local storage health check failed:', error);
        }
        
        // Overall health (at least minRedundancy backends working)
        const workingCount = Object.values(health).filter(v => v).length;
        health.overall = workingCount >= this.minRedundancy;
        
        return health;
    }
    
    /**
     * Clean up connections and resources
     */
    async close() {
        await this.redis.quit();
        // IPFS and S3 don't need explicit cleanup
    }
}

/**
 * Event type definitions
 * Maps event types to numeric codes for on-chain storage
 */
const EventTypes = {
    // Release and content creation
    CREATE_RELEASE_BUNDLE: 21,
    
    // Claims and edits
    ADD_CLAIM: 30,
    EDIT_CLAIM: 31,
    DELETE_CLAIM: 32,
    
    // Voting and curation
    VOTE: 40,
    LIKE: 41,
    DISCUSS: 42,
    
    // Finalization and rewards
    FINALIZE: 50,
    DISTRIBUTE_REWARDS: 51,
    
    // Deduplication
    MERGE_NODE: 60,
    SPLIT_NODE: 61
};

export { EventStore, EventTypes };
```

## Event Structure Examples

THESE EXAMPLES ARE INTENDED TO BE INTERPRETED AS CANONICAL TO THE DATA STRUCTURE. The code above might not match this format, and needs to be changed to reflect this format. 

### CREATE_RELEASE_BUNDLE Event
```json
{
    "v": 1,
    "type": "CREATE_RELEASE_BUNDLE",
    "author_pubkey": "PUB_K1_...",
    "created_at": 1758390021,
    "parents": [],
    "body": {
        "release": {
            "release_name": "The Beatles",
            "release_altnames": ["The White Album", ],
            "release_date": "1968-11-22",
            "release_format": ["LP"],
            "liner_notes": "Lorem ipsum",
            "master_release": [true, null], //For reissues (false), the second value is the Master node ID
            "labels": [{ //UI will Search to see if label exists, input label_id 
                    "label_id":"57230498f3982de...",
                    "label_name": "Apple Records",
                    "label_altnames":"Apple Corps",
                    "label_parents":"",
                    "label_city":[{
                        "city_id":"d857a85e07f2344290...",
                        "city_name":"London",
                        "city_lat":51.50735,
                        "city_long":-0.12776
                    }]
                    
                }, {
                    "label_id":"909876543b46a8e...",
                    "label_name": "EMI Records",
                    "label_altnames":["EMI", "EMI Group plc","Electric and Musical Industries" ],
                    "label_parents":"",
                    "label_city":[{
                        "city_id":"d857a85e07f2344290...",
                        "city_name":"London",
                        "city_lat":51.50735,
                        "city_long":-0.12776
                    }]
                },
                {
                    "label_id":"78efc658da7d5438...",
                    "label_name": "Capitol Records",
                    "label_altnames":["Capitol Records, Inc.", "Capitol Records, LLC","Capitol"],
                    "label_parents":["909876543b46a8e..."],
                    "label_city":[{
                        "city_id":"22342522fa68c6e089d...",
                        "city_name":"Los Angeles",
                        "city_lat":34.09834,
                        "city_long":-118.32674
                    }]
                }
            ],
            "tracks": [
                {
                "track_id":"8d0b789a634ac54...",
                "title": "Back in the U.S.S.R.",
                "listen_link":["https://open.spotify.com/track/0j3p1p06deJ7f9xmJ9yG22", "https://music.apple.com/us/song/back-in-the-u-s-s-r/1441133197"],
                "cover_song":[],
                "sampled_songs":[],
                "songwriters":[{"person_id": "d36547078b701635a7412...", 
                        "person_name":"Paul McCartney",
                        "person_roles": [{
                            "role_id": "96e96770c07b0707a07e078f078...",
                            "role_name": "Lyrics"}, {
                            "role_id": "9a96c96e78fac74e765876b...",
                            "role_name": "Songwriter"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}, {"person_id": "347a746e8c9606f78978fd...", 
                        "person_name":"John Lennon",
                        "person_roles": [{
                            "role_id": "9a96c96e78fac74e765876b...",
                            "role_name": "Songwriter"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}],
                "producers": [{"person_id": "436a765c764e73567978b6979e97f97...", 
                        "person_name":"George Martin",
                        "person_roles": [{
                            "role_id": "c976b975aa254354665e9...",
                            "role_name": "Producer"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}
                ],
                "groups": [{
                    "group_id": "875a968e0d079c90766544...", //create if does not already exist
                    "group_name": "The Beatles",
                    "group_altnames":"The Fab Four",
                    "members": [
                        {"person_id": "347a746e8c9606f78978fd...", 
                        "person_name":"John Lennon",
                        "person_roles": [{
                            "role_id": "007697d63b680e6ac254365...",
                            "role_name": "Backing Vocals"}, {
                            "role_id": "53429f698e98a789c635...",
                            "role_name": "Electric Guitar" }, {
                            "role_id": "a123456c234567890e9987...",
                            "role_name": "Drum Kit" }, {
                            "role_id": "d869a6354675b07e079476eec...",
                            "role_name": "Percussion" }, {
                            "role_id": "960e264a079b957c207296...",
                            "role_name": "Handclaps" }, {
                            "role_id": "7e4a648c57697089f2653a8796b...",
                            "role_name": "Bass Guitar" 
                        }], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                        {"person_id": "d36547078b701635a7412...", 
                        "person_name":"Paul McCartney",
                        "person_roles": [{
                            "role_id": "969e63c089a465...",
                            "role_name": "Lead Vocals"}, {
                            "role_id": "007697d63b680e6ac254365...",
                            "role_name": "Backing Vocals"}, {
                            "role_id": "7e4a648c57697089f2653a8796b...",
                            "role_name": "Bass Guitar" }, {
                            "role_id": "a123456c234567890e9987...",
                            "role_name": "Drum Kit" }, {
                            "role_id": "d869a6354675b07e079476eec...",
                            "role_name": "Percussion" }, {
                            "role_id": "960e264a079b957c207296...",
                            "role_name": "Handclaps" }, {
                            "role_id": "53429f698e98a789c635...",
                            "role_name": "Electric Guitar" }, {
                            "role_id": "70a3654eb7654c67bbc...",
                            "role_name": "Piano" 
                        }], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                        {"person_id": "2c689b96a8960e79f0d...", 
                        "person_name":"George Harrison",
                        "person_roles": [{
                            "role_id": "007697d63b680e6ac254365...",
                            "role_name": "Backing Vocals"}, {
                            "role_id": "53429f698e98a789c635...",
                            "role_name": "Electric Guitar" }, {
                            "role_id": "a123456c234567890e9987...",
                            "role_name": "Drum Kit" }, {
                            "role_id": "d869a6354675b07e079476eec...",
                            "role_name": "Percussion" }, {
                            "role_id": "960e264a079b957c207296...",
                            "role_name": "Handclaps" }, {
                            "role_id": "7e4a648c57697089f2653a8796b...",
                            "role_name": "Bass Guitar" }], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}
                    ]
                }],
                "guests": [
                ]
            }, {
                "track_id":"b4354534d0778e98c68...",
                "title": "Dear Prudence",
                "listen_link":["https://open.spotify.com/track/5NQYyej46WQkgCbnzGD21W", "https://music.apple.com/us/song/dear-prudence/1441133428"],
                "cover_song":[],
                "sampled_songs":[],
                "songwriters":[{"person_id": "d36547078b701635a7412...", 
                        "person_name":"Paul McCartney",
                        "person_roles": [{
                            "role_id": "9a96c96e78fac74e765876b...",
                            "role_name": "Songwriter"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}, {"person_id": "347a746e8c9606f78978fd...", 
                        "person_name":"John Lennon",
                        "person_roles": [{
                            "role_id": "96e96770c07b0707a07e078f078...",
                            "role_name": "Lyrics"}, {
                            "role_id": "9a96c96e78fac74e765876b...",
                            "role_name": "Songwriter"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}],
                "producers": [{"person_id": "436a765c764e73567978b6979e97f97...", 
                        "person_name":"George Martin",
                        "person_roles": [{
                            "role_id": "c976b975aa254354665e9...",
                            "role_name": "Producer"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}
                ],
                "groups": [{
                    "group_id": "875a968e0d079c90766544...", 
                    "group_name": "The Beatles",
                    "group_altnames":"The Fab Four",
                    "members": [
                        {"person_id": "347a746e8c9606f78978fd...", 
                        "person_name":"John Lennon",
                        "person_roles": [{
                            "role_id": "969e63c089a465...",
                            "role_name": "Lead Vocals"}, {
                            "role_id": "007697d63b680e6ac254365...",
                            "role_name": "Backing Vocals"}, {
                            "role_id": "53429f698e98a789c635...",
                            "role_name": "Electric Guitar" }
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                        {"person_id": "d36547078b701635a7412...", 
                        "person_name":"Paul McCartney",
                        "person_roles": [ {
                            "role_id": "007697d63b680e6ac254365...",
                            "role_name": "Backing Vocals"}, {
                            "role_id": "7e4a648c57697089f2653a8796b...",
                            "role_name": "Bass Guitar" }, {
                            "role_id": "a123456c234567890e9987...",
                            "role_name": "Drum Kit" }, {
                            "role_id": "c745a1b27389e897468a654c8...",
                            "role_name": "Tambourine" }, {
                            "role_id": "960e264a079b957c207296...",
                            "role_name": "Handclaps" }, {
                            "role_id": "70a3654eb7654c67bbc...",
                            "role_name": "Piano" 
                        }], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                        {"person_id": "2c689b96a8960e79f0d...", 
                        "person_name":"George Harrison",
                        "person_roles": [{
                            "role_id": "007697d63b680e6ac254365...",
                            "role_name": "Backing Vocals"}, {
                            "role_id": "53429f698e98a789c635...",
                            "role_name": "Electric Guitar" }, {
                            "role_id": "c745a1b27389e897468a654c8...",
                            "role_name": "Tambourine" }, {
                            "role_id": "960e264a079b957c207296...",
                            "role_name": "Handclaps" }
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}
                    ]
                }],
                "guests": []
            }, {
                "track_id":"c63b233ae432ccf8544...",
                "title": "Glass Onion",
                "listen_link":["https://open.spotify.com/track/2jAojvUaPoHPFSPpF0UNRo", "https://music.apple.com/us/song/glass-onion/1441133436"],
                "cover_song":[],
                "sampled_songs":[],
                "songwriters":[{"person_id": "d36547078b701635a7412...", 
                        "person_name":"Paul McCartney",
                        "person_roles": [{
                            "role_id": "9a96c96e78fac74e765876b...",
                            "role_name": "Songwriter"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}, {"person_id": "347a746e8c9606f78978fd...", 
                        "person_name":"John Lennon",
                        "person_roles": [{
                            "role_id": "96e96770c07b0707a07e078f078...",
                            "role_name": "Lyrics"}, {
                            "role_id": "9a96c96e78fac74e765876b...",
                            "role_name": "Songwriter"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}, {"person_id": "436a765c764e73567978b6979e97f97...", 
                        "person_name":"George Martin",
                        "person_roles": [{
                            "role_id": "24654d566f47e9780a9a68c9...",
                            "role_name": "String Arrangement"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}], 
                "producers": [{"person_id": "436a765c764e73567978b6979e97f97...", 
                        "person_name":"George Martin",
                        "person_roles": [{
                            "role_id": "c976b975aa254354665e9...",
                            "role_name": "Producer"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}
                ],    
                "groups": [{
                    "group_id": "875a968e0d079c90766544...", 
                    "group_name": "The Beatles",
                    "group_altnames":"The Fab Four",
                    "members": [
                        {"person_id": "347a746e8c9606f78978fd...", 
                        "person_name":"John Lennon",
                        "person_roles": [{
                            "role_id": "969e63c089a465...",
                            "role_name": "Lead Vocals"}, {
                            "role_id": "007697d63b680e6ac254365...",
                            "role_name": "Backing Vocals"}, {
                            "role_id": "53429f698e98a789c635...",
                            "role_name": "Acoustic Guitar" }
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                        {"person_id": "d36547078b701635a7412...", 
                        "person_name":"Paul McCartney",
                        "person_roles": [ {
                            "role_id": "7e4a648c57697089f2653a8796b...",
                            "role_name": "Bass Guitar" }, {
                            "role_id": "070f0786a078c08e7a0b7074325...",
                            "role_name": "Recorder" }, {
                            "role_id": "70a3654eb7654c67bbc...",
                            "role_name": "Piano" 
                        }], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                        {"person_id": "2c689b96a8960e79f0d...", 
                        "person_name":"George Harrison",
                        "person_roles": [ {
                            "role_id": "53429f698e98a789c635...",
                            "role_name": "Electric Guitar" }
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                        {"person_id": "a13248576c56746e89980d...", 
                        "person_name":"Ringo Starr",
                        "person_roles": [{
                            "role_id": "c745a1b27389e897468a654c8...",
                            "role_name": "Tambourine"}, {
                            "role_id": "a123456c234567890e9987...",
                            "role_name": "Drum Kit" 
                        }], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}
                    ]
                }],
                "guests": [
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"Chris Thomas",
                        "person_roles": [{
                            "role_id": "070f0786a078c08e7a0b7074325...",
                            "role_name": "Recorder"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}, 
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"Henry Datyner",
                        "person_roles": [{
                            "role_id": "3456c856f85a856c865e4...",
                            "role_name": "Violin"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"Eric Bowie",
                        "person_roles": [{
                            "role_id": "3456c856f85a856c865e4...",
                            "role_name": "Violin"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"Norman Lederman",
                        "person_roles": [{
                            "role_id": "3456c856f85a856c865e4...",
                            "role_name": "Violin"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}, 
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"Ronald Thomas",
                        "person_roles": [{
                            "role_id": "3456c856f85a856c865e4...",
                            "role_name": "Violin"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"John Underwood",
                        "person_roles": [{
                            "role_id": "79870c708f98ff78e780e7523352...",
                            "role_name": "Viola"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"Keith Cummings",
                        "person_roles": [{
                            "role_id": "79870c708f98ff78e780e7523352...",
                            "role_name": "Viola"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"Eldon Fox",
                        "person_roles": [{
                            "role_id": "5454f34c64364a3646e6634d6422...",
                            "role_name": "Cello"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"Reginald Kilby",
                        "person_roles": [{
                            "role_id": "5454f34c64364a3646e6634d6422...",
                            "role_name": "Cello"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}
                ]
            }
            ///, CONTINUED TRACK LISTING (elided from example but should be included in actual payload)
            ],
            
        },
        

        "tracklist": [
            {
            "track_id": "8d0b789a634ac54...",
            "disc_side": 1,
            "track_number": 1
        }, {
            "track_id": "b4354534d0778e98c68...",
            "disc_side": 1,
            "track_number": 2
        }, {
            "track_id": "c63b233ae432ccf8544....",
            "disc_side": 1,
            "track_number": 3
        }
        ///, CONTINUED TRACK LISTING (elided from example but should be included in actual payload)
        ]
    },
    "proofs": {
        "source_links": ["https://discogs.com/..."]
    },
    "sig": "SIG_K1_..."
}
```


## Storage Architecture

```
┌─────────────────────────────────────────────┐
│                Event Creation                │
│         (Canonical JSON + SHA-256)           │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
        ┌─────────────────┐
        │   Sign Event    │
        │  (EOS PrivKey)  │
        └────────┬────────┘
                 │
    ┌────────────┼────────────┬──────────────┬──────────────┐
    ▼            ▼            ▼              ▼              ▼
┌────────┐ ┌────────┐ ┌────────┐    ┌────────┐    ┌────────┐
│ Redis  │ │  IPFS  │ │   S3   │    │ Local  │    │Archive │
│ (Hot)  │ │(Decentr│ │  (CDN) │    │ Cache  │    │(Glacier│
└────────┘ └────────┘ └────────┘    └────────┘    └────────┘
    │            │            │              │              │
    └────────────┼────────────┴──────────────┴──────────────┘
                 │
                 ▼
        ┌─────────────────┐
        │ Min Redundancy  │
        │    Achieved?    │
        └────────┬────────┘
                 │
                 ▼
         ┌──────────────┐
         │ Anchor Hash  │
         │  On-Chain    │
         └──────────────┘
```