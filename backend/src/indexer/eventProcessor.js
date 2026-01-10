/**
 * @fileoverview Event Processor for Polaris Music Registry
 *
 * Processes blockchain events into the graph database:
 * 1. Polls blockchain for new anchored events
 * 2. Fetches event data from storage (IPFS/S3/Redis)
 * 3. Processes events into Neo4j graph database
 * 4. Handles different event types with specific handlers
 *
 * Event Flow:
 * Blockchain � Fetch from Storage � Validate � Process � Update Graph
 *
 * @module indexer/eventProcessor
 */

import crypto from 'crypto';
import { Api, JsonRpc } from 'eosjs';
import { JsSignatureProvider } from 'eosjs/dist/eosjs-jssig.js';
import fetch from 'node-fetch';
import MusicGraphDatabase from '../graph/schema.js';
import EventStore from '../storage/eventStore.js';

/**
 * Event types from smart contract
 */
const EVENT_TYPES = {
    CREATE_RELEASE_BUNDLE: 21,
    MINT_ENTITY: 22,           // Create canonical entity
    RESOLVE_ID: 23,            // Map provisional/external ID to canonical
    ADD_CLAIM: 30,
    EDIT_CLAIM: 31,
    VOTE: 40,
    LIKE: 41,
    FINALIZE: 50,
    MERGE_ENTITY: 60           // Merge duplicate entities (renamed from MERGE_NODE)
};

/**
 * Safe mapping of entity types to Neo4j node labels
 * This prevents Cypher injection by providing an explicit whitelist
 */
const NODE_LABELS = {
    'person': 'Person',
    'group': 'Group',
    'song': 'Song',
    'track': 'Track',
    'release': 'Release',
    'master': 'Master',
    'label': 'Label',
    'city': 'City'
};

/**
 * Mapping from entity type to the entity-specific ID field required by Neo4j constraints.
 * These fields are required by uniqueness constraints in the schema (e.g., REQUIRE p.person_id IS UNIQUE).
 * When creating nodes via MINT_ENTITY, we must set both 'id' (universal) and the entity-specific field.
 */
const ENTITY_ID_FIELD = {
    'person': 'person_id',
    'group': 'group_id',
    'song': 'song_id',
    'track': 'track_id',
    'release': 'release_id',
    'master': 'master_id',
    'label': 'label_id',
    'city': 'city_id'
};

/**
 * Event Processor that syncs blockchain events to graph database
 */
class EventProcessor {
    /**
     * Create a new event processor
     *
     * INJECTION MODE (for API server ingestion):
     * @param {Object} config.db - Pre-initialized MusicGraphDatabase instance
     * @param {Object} config.store - Pre-initialized EventStore instance
     *
     * NORMAL MODE (for standalone processor):
     * @param {Object} config.blockchain - Blockchain configuration
     * @param {string} config.blockchain.rpcUrl - EOS RPC endpoint
     * @param {string} config.blockchain.contractAccount - Contract account name
     * @param {number} [config.blockchain.pollInterval] - Polling interval in ms (default: 5000)
     * @param {Object} config.database - Graph database config
     * @param {Object} config.storage - Event storage config
     * @param {number} [config.startBlock] - Block to start processing from
     */
    constructor(config) {
        this.config = config;

        // Detect injection mode: if db and store are already provided, use them directly
        const injectionMode = !!(config.db && config.store);
        this.blockchainEnabled = !injectionMode;

        if (injectionMode) {
            // INJECTION MODE: Use pre-initialized instances (API server mode)
            this.db = config.db;
            this.store = config.store;
            this.rpc = null;
            this.contractAccount = null;
            this.pollInterval = null;
            this.lastProcessedBlock = 0;
            this.currentBlock = 0;
            console.log('EventProcessor initialized in injection mode (blockchain disabled)');
        } else {
            // NORMAL MODE: Initialize from config (standalone processor mode)
            if (!config.blockchain?.rpcUrl) {
                throw new Error('EventProcessor requires either {db, store} or {blockchain, database, storage}');
            }

            // Initialize blockchain RPC
            this.rpc = new JsonRpc(config.blockchain.rpcUrl, { fetch });
            this.contractAccount = config.blockchain.contractAccount || 'polaris';
            this.pollInterval = config.blockchain.pollInterval || 5000;

            // Initialize database and storage
            this.db = new MusicGraphDatabase(config.database);
            this.store = new EventStore(config.storage);

            // Processing state
            this.lastProcessedBlock = config.startBlock || 0;
            this.currentBlock = 0;
        }

        // Common state (both modes)
        this.isRunning = false;

        // Statistics
        this.stats = {
            blocksProcessed: 0,
            eventsProcessed: 0,
            eventsByType: {},
            errors: 0,
            lastError: null,
            startTime: null,
            lastProcessedTime: null
        };

        // Event handlers by type (needed in both modes)
        this.eventHandlers = {
            [EVENT_TYPES.CREATE_RELEASE_BUNDLE]: this.handleReleaseBundle.bind(this),
            [EVENT_TYPES.MINT_ENTITY]: this.handleMintEntity.bind(this),
            [EVENT_TYPES.RESOLVE_ID]: this.handleResolveId.bind(this),
            [EVENT_TYPES.ADD_CLAIM]: this.handleAddClaim.bind(this),
            [EVENT_TYPES.EDIT_CLAIM]: this.handleEditClaim.bind(this),
            [EVENT_TYPES.VOTE]: this.handleVote.bind(this),
            [EVENT_TYPES.LIKE]: this.handleLike.bind(this),
            [EVENT_TYPES.FINALIZE]: this.handleFinalize.bind(this),
            [EVENT_TYPES.MERGE_ENTITY]: this.handleMergeEntity.bind(this)
        };
    }

    /**
     * Start the event processor
     * Continuously polls blockchain and processes events
     *
     * @returns {Promise<void>}
     */
    async start() {
        if (!this.blockchainEnabled) {
            throw new Error(
                'EventProcessor.start() requires blockchain configuration. ' +
                'This instance was created in injection mode (for API server ingestion). ' +
                'Use backend/src/indexer/runProcessor.js for blockchain event processing.'
            );
        }

        if (this.isRunning) {
            console.warn('Event processor already running');
            return;
        }

        console.log('=� Starting Event Processor...');

        // Test connections
        const dbConnected = await this.db.testConnection();
        if (!dbConnected) {
            throw new Error('Failed to connect to database');
        }
        console.log(' Database connected');

        const storageStatus = await this.store.testConnectivity();
        console.log(' Storage status:', storageStatus);

        // Get current blockchain head
        const info = await this.rpc.get_info();
        this.currentBlock = info.head_block_num;
        console.log(` Blockchain head: block ${this.currentBlock}`);

        // If no start block specified, start from recent history
        if (this.lastProcessedBlock === 0) {
            this.lastProcessedBlock = Math.max(0, this.currentBlock - 1000);
            console.log(`Starting from block ${this.lastProcessedBlock}`);
        }

        this.isRunning = true;
        this.stats.startTime = new Date();

        // Start processing loop
        this.processLoop();

        console.log(`\n Event Processor started`);
        console.log(`  Contract: ${this.contractAccount}`);
        console.log(`  Poll interval: ${this.pollInterval}ms`);
        console.log(`  Processing from block: ${this.lastProcessedBlock}\n`);
    }

    /**
     * Stop the event processor
     *
     * @returns {Promise<void>}
     */
    async stop() {
        console.log('\nStopping Event Processor...');
        this.isRunning = false;

        // Wait for current operation to complete
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Close connections
        await this.db.close();
        await this.store.close();

        console.log(' Event Processor stopped');
    }

    /**
     * Main processing loop
     * Continuously polls blockchain and processes new events
     *
     * NOTE: Not available in injection mode.
     *
     * @private
     */
    async processLoop() {
        if (!this.blockchainEnabled) {
            throw new Error('processLoop() not available in injection mode');
        }

        while (this.isRunning) {
            try {
                // Get latest block info
                const info = await this.rpc.get_info();
                this.currentBlock = info.head_block_num;

                // Process any new blocks
                if (this.lastProcessedBlock < this.currentBlock) {
                    await this.processBlockRange(
                        this.lastProcessedBlock + 1,
                        this.currentBlock
                    );
                }

                // Wait before next poll
                await new Promise(resolve => setTimeout(resolve, this.pollInterval));

            } catch (error) {
                console.error('Error in process loop:', error.message);
                this.stats.errors++;
                this.stats.lastError = error.message;

                // Wait longer on error
                await new Promise(resolve => setTimeout(resolve, this.pollInterval * 2));
            }
        }
    }

    /**
     * Process a range of blocks for events
     *
     * NOTE: Not available in injection mode.
     *
     * @private
     * @param {number} fromBlock - Start block (inclusive)
     * @param {number} toBlock - End block (inclusive)
     */
    async processBlockRange(fromBlock, toBlock) {
        if (!this.blockchainEnabled) {
            throw new Error('processBlockRange() not available in injection mode');
        }

        console.log(`Processing blocks ${fromBlock} to ${toBlock}...`);

        // Process in chunks to avoid overwhelming the system
        const chunkSize = 100;

        for (let start = fromBlock; start <= toBlock; start += chunkSize) {
            const end = Math.min(start + chunkSize - 1, toBlock);

            try {
                // Get actions from blockchain for this range
                const actions = await this.getActionsInRange(start, end);

                // Process each action
                for (const action of actions) {
                    await this.processAction(action);
                }

                this.lastProcessedBlock = end;
                this.stats.blocksProcessed += (end - start + 1);
                this.stats.lastProcessedTime = new Date();

            } catch (error) {
                console.error(`Error processing blocks ${start}-${end}:`, error.message);
                this.stats.errors++;
                this.stats.lastError = error.message;

                // Continue with next chunk despite error
            }
        }
    }

    /**
     * Get actions from blockchain in a block range
     *
     * NOTE: Not available in injection mode.
     *
     * @private
     * @param {number} fromBlock - Start block
     * @param {number} toBlock - End block
     * @returns {Promise<Array>} Array of actions
     */
    async getActionsInRange(fromBlock, toBlock) {
        if (!this.blockchainEnabled) {
            throw new Error('getActionsInRange() not available in injection mode');
        }

        try {
            // Use get_actions API with filters
            const response = await this.rpc.history_get_actions(
                this.contractAccount,
                fromBlock,
                toBlock - fromBlock + 1
            );

            // Filter for 'put' actions (event anchoring)
            return response.actions.filter(action =>
                action.action_trace.act.account === this.contractAccount &&
                action.action_trace.act.name === 'put'
            );

        } catch (error) {
            // Fallback: get blocks individually if history plugin unavailable
            console.warn('History API unavailable, using fallback method');
            return this.getActionsInRangeFallback(fromBlock, toBlock);
        }
    }

    /**
     * Fallback method to get actions by fetching individual blocks
     *
     * NOTE: Not available in injection mode.
     *
     * @private
     * @param {number} fromBlock - Start block
     * @param {number} toBlock - End block
     * @returns {Promise<Array>} Array of actions
     */
    async getActionsInRangeFallback(fromBlock, toBlock) {
        if (!this.blockchainEnabled) {
            throw new Error('getActionsInRangeFallback() not available in injection mode');
        }

        const actions = [];

        for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
            try {
                const block = await this.rpc.get_block(blockNum);

                // Check transactions in block
                for (const transaction of block.transactions || []) {
                    if (transaction.trx && transaction.trx.transaction) {
                        const trx = transaction.trx.transaction;

                        // Check actions in transaction
                        for (const action of trx.actions || []) {
                            if (action.account === this.contractAccount &&
                                action.name === 'put') {
                                actions.push({
                                    action_trace: {
                                        act: action,
                                        block_num: blockNum,
                                        block_time: block.timestamp
                                    }
                                });
                            }
                        }
                    }
                }
            } catch (error) {
                console.warn(`Failed to fetch block ${blockNum}:`, error.message);
            }
        }

        return actions;
    }

    /**
     * Process a single blockchain action
     *
     * @private
     * @param {Object} action - Blockchain action
     */
    async processAction(action) {
        try {
            const act = action.action_trace.act;
            const data = act.data;

            console.log(`\nProcessing event: ${data.hash.substring(0, 12)}...`);
            console.log(`  Type: ${data.type}`);
            console.log(`  Author: ${data.author}`);
            console.log(`  Block: ${action.action_trace.block_num}`);

            // Fetch event data from storage
            const event = await this.store.retrieveEvent(data.hash);

            // Verify hash matches
            const computedHash = this.store.calculateHash(event);
            if (computedHash !== data.hash) {
                throw new Error(`Hash mismatch: expected ${data.hash}, got ${computedHash}`);
            }

            // Process event based on type
            const handler = this.eventHandlers[data.type];
            if (!handler) {
                console.warn(`No handler for event type ${data.type}`);
                return;
            }

            await handler(event, data);

            // Update statistics
            this.stats.eventsProcessed++;
            this.stats.eventsByType[data.type] = (this.stats.eventsByType[data.type] || 0) + 1;

            console.log(` Event processed successfully`);

        } catch (error) {
            console.error('Failed to process action:', error.message);
            this.stats.errors++;
            this.stats.lastError = error.message;

            // Don't throw - continue processing other events
        }
    }

    /**
     * Handle CREATE_RELEASE_BUNDLE event
     *
     * @private
     * @param {Object} event - Event data
     * @param {Object} actionData - Blockchain action data
     */
    async handleReleaseBundle(event, actionData) {
        // Use correct release_name field with fallbacks
        const releaseTitle =
            event?.body?.release?.release_name ||
            event?.body?.release?.name ||
            event?.body?.release_name ||
            'Unknown';
        console.log(`  Processing release bundle: ${releaseTitle}`);

        const result = await this.db.processReleaseBundle(
            actionData.hash,
            event.body,
            actionData.author  // Use chain account as submitter-of-record
        );

        console.log(`   Created: ${result.stats.groups_created} groups, ${result.stats.tracks_created} tracks`);
    }

    /**
     * Handle ADD_CLAIM event
     *
     * @private
     * @param {Object} event - Event data
     * @param {Object} actionData - Blockchain action data
     */
    async handleAddClaim(event, actionData) {
        console.log(`  Adding claim to ${event.body.node?.type} ${event.body.node?.id}`);

        await this.db.processAddClaim(
            actionData.hash,
            event.body,
            actionData.author  // Use chain account as submitter-of-record
        );

        console.log(`   Claim added`);
    }

    /**
     * Handle EDIT_CLAIM event
     *
     * @private
     * @param {Object} event - Event data
     * @param {Object} actionData - Blockchain action data
     */
    async handleEditClaim(event, actionData) {
        console.log(`  Editing claim: ${event.body.claim_id}`);

        // Similar to ADD_CLAIM but modifies existing claim
        await this.db.processAddClaim(
            actionData.hash,
            event.body,
            actionData.author  // Use chain account as submitter-of-record
        );

        console.log(`   Claim edited`);
    }

    /**
     * Handle VOTE event
     *
     * @private
     * @param {Object} event - Event data
     * @param {Object} actionData - Blockchain action data
     */
    async handleVote(event, actionData) {
        console.log(`  Recording vote on ${event.body.target_hash}`);

        // Vote data is stored on blockchain, not in graph
        // Could optionally record vote metadata in graph for analytics

        console.log(`   Vote recorded`);
    }

    /**
     * Handle LIKE event
     *
     * @private
     * @param {Object} event - Event data
     * @param {Object} actionData - Blockchain action data
     */
    async handleLike(event, actionData) {
        console.log(`  Recording like on ${event.body.node_id}`);

        // Like data with path tracking (planned feature)
        // Store in graph for visualization weighting

        console.log(`   Like recorded`);
    }

    /**
     * Handle FINALIZE event
     *
     * @private
     * @param {Object} event - Event data
     * @param {Object} actionData - Blockchain action data
     */
    async handleFinalize(event, actionData) {
        console.log(`  Finalizing event ${event.body.target_hash}`);

        // Finalization triggers reward distribution on blockchain
        // Could update entity status in graph (provisional � canonical)

        console.log(`   Finalized`);
    }

    /**
     * Handle MINT_ENTITY event
     * Creates a new canonical entity with stable ID
     *
     * Event body structure:
     * {
     *   entity_type: "person" | "group" | "song" | "track" | "release" | "master" | "label",
     *   canonical_id: "polaris:{type}:{uuid}",  // optional, generated if not provided
     *   initial_claims: [{ property: string, value: any, confidence: number }],
     *   provenance: {
     *     source: "manual" | "import" | "ai_suggested",
     *     submitter: string,
     *     evidence: string
     *   }
     * }
     *
     * @private
     * @param {Object} event - Event data
     * @param {Object} actionData - Blockchain action data
     */
    async handleMintEntity(event, actionData) {
        const { entity_type, canonical_id, initial_claims = [], provenance = {} } = event.body;

        console.log(`  Minting canonical ${entity_type}: ${canonical_id || '(auto-generated)'}`);

        const session = this.db.driver.session();
        try {
            // Import the identity service
            const { IdentityService, EntityType } = await import('../identity/idService.js');

            // Validate entity type
            if (!Object.values(EntityType).includes(entity_type)) {
                throw new Error(`Invalid entity_type: ${entity_type}`);
            }

            // Use provided canonical ID or generate new one
            const cid = canonical_id || IdentityService.mintCanonicalId(entity_type);

            // Verify it's a valid canonical ID
            if (!IdentityService.isCanonical(cid)) {
                throw new Error(`Invalid canonical ID: ${cid}`);
            }

            console.log(`    Creating entity: ${cid}`);

            // Get safe node label from whitelist mapping (prevents Cypher injection)
            const nodeLabel = NODE_LABELS[entity_type];
            if (!nodeLabel) {
                throw new Error(`No node label mapping for entity_type: ${entity_type}`);
            }

            // Get entity-specific ID field required by Neo4j constraints
            const idField = ENTITY_ID_FIELD[entity_type];
            if (!idField) {
                throw new Error(`No ID field mapping for entity_type: ${entity_type}`);
            }

            // Create the entity node with minimal fields (idempotent via MERGE)
            // CRITICAL: Must set both 'id' (universal) and entity-specific field (person_id, group_id, etc.)
            // to satisfy Neo4j uniqueness constraints (e.g., REQUIRE p.person_id IS UNIQUE)
            // Uses MERGE to handle replays: if entity exists, do nothing (idempotent)
            const entityResult = await session.run(
                `MERGE (n:${nodeLabel} {id: $id})
                ON CREATE SET
                    n.${idField} = $id,
                    n.status = 'ACTIVE',
                    n.created_at = datetime(),
                    n.created_by = $createdBy,
                    n.creation_source = $source,
                    n.event_hash = $eventHash
                ON MATCH SET
                    n.last_seen_at = datetime()
                RETURN n.id as id, n.created_at as created_at`,
                {
                    id: cid,
                    createdBy: provenance.submitter || actionData.author,
                    source: provenance.source || 'manual',
                    eventHash: actionData.hash
                }
            );

            // Add initial claims if provided
            // Claims use deterministic IDs to handle replays idempotently
            for (let i = 0; i < initial_claims.length; i++) {
                const claim = initial_claims[i];

                // Generate deterministic claim ID from event hash + index
                // This ensures replaying the same event produces the same claim IDs
                const claimIdInput = `${actionData.hash}:mint_claim:${i}`;
                const claimId = crypto.createHash('sha256').update(claimIdInput).digest('hex');

                await session.run(
                    `MATCH (n {id: $entityId})
                     MERGE (c:Claim {claim_id: $claimId})
                     ON CREATE SET
                         c.property = $property,
                         c.value = $value,
                         c.confidence = $confidence,
                         c.created_at = datetime(),
                         c.created_by = $submitter,
                         c.event_hash = $eventHash
                     MERGE (c)-[:CLAIMS_ABOUT]->(n)`,
                    {
                        entityId: cid,
                        claimId: claimId,
                        property: claim.property,
                        value: JSON.stringify(claim.value),
                        confidence: claim.confidence || 1.0,
                        submitter: provenance.submitter || actionData.author,
                        eventHash: actionData.hash
                    }
                );
            }

            // Check if entity was newly created or already existed
            const wasCreated = entityResult.records[0]?.get('created_at') !== null;
            const action = wasCreated ? 'Created' : 'Found existing';
            console.log(`   ${action} ${entity_type} ${cid.substring(0, 24)}... with ${initial_claims.length} claims`);

        } catch (error) {
            console.error(`   Failed to mint entity:`, error.message);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Handle RESOLVE_ID event
     * Maps a provisional or external ID to a canonical ID
     *
     * Event body structure:
     * {
     *   subject_id: string,      // provisional (prov:type:hash) or external (source:type:id)
     *   canonical_id: string,    // canonical ID to resolve to (polaris:type:uuid)
     *   method: "manual" | "import" | "ai_suggested" | "authority_source",
     *   confidence: number,      // 0-1, default 1.0
     *   evidence: string | object
     * }
     *
     * @private
     * @param {Object} event - Event data
     * @param {Object} actionData - Blockchain action data
     */
    async handleResolveId(event, actionData) {
        const {
            subject_id,
            canonical_id,
            method = 'manual',
            confidence = 1.0,
            evidence = ''
        } = event.body;

        console.log(`  Resolving ID: ${subject_id} -> ${canonical_id}`);

        const session = this.db.driver.session();
        try {
            // Import identity modules
            const { IdentityService, IDKind } = await import('../identity/idService.js');
            const { MergeOperations } = await import('../graph/merge.js');

            // Parse both IDs
            const subjectParsed = IdentityService.parseId(subject_id);
            const canonicalParsed = IdentityService.parseId(canonical_id);

            // Validate canonical ID
            if (!IdentityService.isCanonical(canonical_id)) {
                throw new Error(`Target must be canonical ID, got: ${canonical_id}`);
            }

            // Validate subject is not canonical
            if (subjectParsed.kind === IDKind.CANONICAL) {
                throw new Error(`Subject must be provisional or external, not canonical. Use MERGE_ENTITY for canonical->canonical.`);
            }

            console.log(`    Subject kind: ${subjectParsed.kind}`);

            // Handle based on subject ID kind
            if (subjectParsed.kind === IDKind.EXTERNAL) {
                // Create IdentityMap entry
                await MergeOperations.createIdentityMapping(session, {
                    source: subjectParsed.source,
                    externalType: subjectParsed.externalType,
                    externalId: subjectParsed.externalId,
                    canonicalId: canonical_id,
                    confidence,
                    submitter: actionData.author,
                    evidence: typeof evidence === 'object' ? JSON.stringify(evidence) : evidence
                });

                console.log(`   Created IdentityMap: ${subject_id} -> ${canonical_id}`);
            }

            if (subjectParsed.kind === IDKind.PROVISIONAL) {
                // Create ALIAS_OF relationship
                // Pass metadata so alias node gets created even if provisional node doesn't exist yet
                await MergeOperations.createAlias(session, subject_id, canonical_id, {
                    createdBy: actionData.author,
                    aliasKind: 'provisional',
                    method
                });

                console.log(`   Created alias: ${subject_id} -> ${canonical_id}`);
            }

        } catch (error) {
            console.error(`   Failed to resolve ID:`, error.message);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Handle MERGE_ENTITY event
     * Merges duplicate entities while preserving all data
     * Replaces the old MERGE_NODE handler with identity-aware implementation
     *
     * Event body structure:
     * {
     *   survivor_id: string,      // Canonical ID to keep (polaris:type:uuid)
     *   absorbed_ids: string[],   // IDs to merge into survivor (canonical or provisional)
     *   evidence: string,
     *   submitter: string,
     *   strategy: {
     *     rewire_edges: boolean,
     *     move_claims: boolean,
     *     tombstone_absorbed: boolean
     *   }
     * }
     *
     * @private
     * @param {Object} event - Event data
     * @param {Object} actionData - Blockchain action data
     */
    async handleMergeEntity(event, actionData) {
        const {
            survivor_id,
            absorbed_ids,
            evidence = '',
            submitter,
            strategy = {}
        } = event.body;

        console.log(`  Merging ${absorbed_ids.length} entities into ${survivor_id}`);

        const session = this.db.driver.session();
        try {
            // Import merge operations
            const { MergeOperations } = await import('../graph/merge.js');
            const { IdentityService } = await import('../identity/idService.js');

            // Validate survivor is canonical
            if (!IdentityService.isCanonical(survivor_id)) {
                throw new Error(`Survivor must be canonical ID, got: ${survivor_id}`);
            }

            // Execute merge with full provenance
            const stats = await MergeOperations.mergeEntities(
                session,
                survivor_id,
                absorbed_ids,
                {
                    submitter: submitter || actionData.author,
                    eventHash: actionData.hash,
                    evidence,
                    rewireEdges: strategy.rewire_edges !== false,  // default true
                    moveClaims: strategy.move_claims !== false     // default true
                }
            );

            console.log(`   Merged ${stats.absorbedCount} entities:`);
            console.log(`      - Rewired ${stats.edgesRewired} edges`);
            console.log(`      - Moved ${stats.claimsMoved} claims`);
            console.log(`      - Created ${stats.tombstonesCreated} tombstones`);

        } catch (error) {
            console.error(`   Merge failed:`, error.message);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Get processor statistics
     *
     * @returns {Object} Statistics object
     */
    getStats() {
        const uptime = this.stats.startTime
            ? Date.now() - this.stats.startTime.getTime()
            : 0;

        return {
            ...this.stats,
            isRunning: this.isRunning,
            currentBlock: this.currentBlock,
            lastProcessedBlock: this.lastProcessedBlock,
            blocksBehind: this.currentBlock - this.lastProcessedBlock,
            uptime: uptime,
            uptimeFormatted: this.formatUptime(uptime),
            eventsPerSecond: uptime > 0
                ? (this.stats.eventsProcessed / (uptime / 1000)).toFixed(2)
                : '0'
        };
    }

    /**
     * Format uptime in human-readable format
     *
     * @private
     * @param {number} ms - Uptime in milliseconds
     * @returns {string} Formatted uptime
     */
    formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    /**
     * Reprocess events from a specific block
     * Useful for recovering from errors or testing
     *
     * @param {number} fromBlock - Block to start reprocessing from
     */
    async reprocessFrom(fromBlock) {
        console.log(`Reprocessing from block ${fromBlock}...`);
        this.lastProcessedBlock = fromBlock - 1;
    }
}

export default EventProcessor;
