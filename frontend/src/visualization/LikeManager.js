/**
 * LikeManager - Handles blockchain submission of likes
 *
 * Integrates with WalletManager to submit likes to the blockchain
 * via the polaris smart contract's like(account, node_id, node_path) action.
 */

import { CONTRACT_ACCOUNT } from '../config/chain.js';

export class LikeManager {
    constructor(walletManager, pathTracker) {
        this.walletManager = walletManager;
        this.pathTracker = pathTracker;

        // Queue for pending blockchain submissions
        this.pendingSubmissions = [];

        // Submission status callbacks
        this.callbacks = {
            onSuccess: [],
            onError: []
        };
    }

    /**
     * Like a node (local + blockchain)
     * @param {string} nodeId - Node ID
     * @param {Object} nodeData - Node metadata
     * @param {boolean} submitToBlockchain - Whether to submit to blockchain immediately
     * @returns {Promise<Object>} Like result
     */
    async likeNode(nodeId, nodeData = {}, submitToBlockchain = true) {
        try {
            // Record like locally with path
            const likeRecord = this.pathTracker.recordLike(nodeId, nodeData);

            // Submit squashed path to blockchain (loop-free traversal)
            const pathForChain = likeRecord.pathSquashed || likeRecord.path;
            if (submitToBlockchain && this.walletManager.isConnected()) {
                await this.submitToBlockchain(nodeId, pathForChain);
            } else if (submitToBlockchain) {
                // Queue for later submission
                this.queueSubmission(nodeId, pathForChain);
                console.log('Like queued for blockchain submission (wallet not connected)');
            }

            return {
                success: true,
                liked: true,
                nodeId,
                path: likeRecord.path
            };
        } catch (error) {
            console.error('Failed to like node:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Unlike a node
     * @param {string} nodeId - Node ID
     * @returns {Promise<Object>} Unlike result
     */
    async unlikeNode(nodeId) {
        try {
            // Remove local like
            const removed = this.pathTracker.removeLike(nodeId);

            // Note: Blockchain likes are immutable (cannot be removed)
            // Only local UI state is updated

            return {
                success: true,
                liked: false,
                nodeId
            };
        } catch (error) {
            console.error('Failed to unlike node:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Toggle like state
     * @param {string} nodeId - Node ID
     * @param {Object} nodeData - Node metadata
     * @returns {Promise<Object>} Toggle result
     */
    async toggleLike(nodeId, nodeData = {}) {
        if (this.pathTracker.isLiked(nodeId)) {
            return await this.unlikeNode(nodeId);
        } else {
            return await this.likeNode(nodeId, nodeData);
        }
    }

    /**
     * Submit like to blockchain
     * @param {string} nodeId - Node ID (checksum256 hash)
     * @param {Array<string>} nodePath - Path of node IDs
     * @returns {Promise<Object>} Transaction result
     */
    async submitToBlockchain(nodeId, nodePath) {
        if (!this.walletManager.isConnected()) {
            throw new Error('Wallet not connected');
        }

        try {
            console.log('Submitting like to blockchain:', nodeId, nodePath);

            // Convert path to checksum256 array (truncate if too long)
            const maxPathLength = 20; // Blockchain limit
            const truncatedPath = [];
            for (const id of nodePath.slice(-maxPathLength)) {
                truncatedPath.push(await this.nodeIdToChecksum256(id));
            }

            const nodeHash = await this.nodeIdToChecksum256(nodeId);
            const actor = this.walletManager.session.actor.toString();

            // Use the contract's dedicated like(account, node_id, node_path) action.
            // This is a separate action from put() — it records node likes directly.
            const action = {
                account: CONTRACT_ACCOUNT,
                name: 'like',
                authorization: [{
                    actor: this.walletManager.session.actor,
                    permission: this.walletManager.session.permission
                }],
                data: {
                    account: actor,
                    node_id: nodeHash,
                    node_path: truncatedPath
                }
            };

            // Submit transaction
            const result = await this.walletManager.transact(action);

            console.log('Like submitted to blockchain:', result);

            // Emit success callback
            this.emit('onSuccess', { nodeId, result });

            return {
                success: true,
                transactionId: result.response?.transaction_id || null,
                nodeId
            };
        } catch (error) {
            console.error('Blockchain submission failed:', error);

            // Emit error callback
            this.emit('onError', { nodeId, error });

            throw error;
        }
    }

    /**
     * Convert node ID to checksum256 format
     * Always returns a Promise so callers can consistently await the result.
     * @param {string} nodeId - Node ID
     * @returns {Promise<string>} Checksum256 hex string
     */
    async nodeIdToChecksum256(nodeId) {
        // If already in checksum256 format (64 hex characters), return as-is
        if (/^[a-f0-9]{64}$/i.test(nodeId)) {
            return nodeId.toLowerCase();
        }

        // Use Web Crypto API for SHA-256 hashing
        return this.sha256(nodeId);
    }

    /**
     * SHA-256 hash a string (async)
     * @param {string} str - String to hash
     * @returns {Promise<string>} Hex hash
     */
    async sha256(str) {
        const encoder = new TextEncoder();
        const data = encoder.encode(str);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Queue a like for later blockchain submission
     * @param {string} nodeId - Node ID
     * @param {Array<string>} nodePath - Path
     */
    queueSubmission(nodeId, nodePath) {
        this.pendingSubmissions.push({ nodeId, nodePath, timestamp: Date.now() });

        // Persist to localStorage
        try {
            localStorage.setItem('polaris_pending_likes', JSON.stringify(this.pendingSubmissions));
        } catch (error) {
            console.error('Failed to save pending submissions:', error);
        }
    }

    /**
     * Submit all pending likes to blockchain
     * @returns {Promise<Array<Object>>} Results
     */
    async submitPendingLikes() {
        if (!this.walletManager.isConnected()) {
            throw new Error('Wallet not connected');
        }

        const results = [];

        for (const submission of this.pendingSubmissions) {
            try {
                const result = await this.submitToBlockchain(submission.nodeId, submission.nodePath);
                results.push({ ...result, nodeId: submission.nodeId });
            } catch (error) {
                results.push({
                    success: false,
                    nodeId: submission.nodeId,
                    error: error.message
                });
            }
        }

        // Clear pending queue on success
        this.pendingSubmissions = [];
        localStorage.removeItem('polaris_pending_likes');

        return results;
    }

    /**
     * Load pending submissions from storage
     */
    loadPendingSubmissions() {
        try {
            const stored = localStorage.getItem('polaris_pending_likes');
            if (stored) {
                this.pendingSubmissions = JSON.parse(stored);
                console.log(`Loaded ${this.pendingSubmissions.length} pending like submissions`);
            }
        } catch (error) {
            console.error('Failed to load pending submissions:', error);
        }
    }

    /**
     * Get number of pending submissions
     * @returns {number} Count
     */
    getPendingCount() {
        return this.pendingSubmissions.length;
    }

    /**
     * Register callback
     * @param {string} event - Event name (onSuccess, onError)
     * @param {Function} callback - Callback function
     */
    on(event, callback) {
        if (this.callbacks[event]) {
            this.callbacks[event].push(callback);
        }
    }

    /**
     * Emit event to callbacks
     * @param {string} event - Event name
     * @param {*} data - Event data
     */
    emit(event, data) {
        if (this.callbacks[event]) {
            this.callbacks[event].forEach(cb => cb(data));
        }
    }
}

// Export class (requires instantiation with dependencies)
export default LikeManager;
