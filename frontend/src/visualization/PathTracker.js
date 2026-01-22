/**
 * PathTracker - Tracks user navigation paths through the music graph
 *
 * Implements path tracking for the "like" feature, recording the route taken
 * from a starting node (home/search result) to the liked node.
 * Paths are used to weight edges mimicking ant colony optimization.
 */

export class PathTracker {
    constructor() {
        // Current navigation path (stack of node IDs)
        this.currentPath = [];

        // Starting node for current session
        this.startNode = null;

        // Liked paths history {nodeId: {path: [], timestamp: number}}
        this.likedPaths = new Map();

        // Load liked paths from localStorage
        this.loadFromStorage();
    }

    /**
     * Set the starting node for path tracking
     * @param {string} nodeId - Starting node ID
     */
    setStartNode(nodeId) {
        this.startNode = nodeId;
        this.currentPath = [nodeId];
        console.log('Path tracking started from:', nodeId);
    }

    /**
     * Record a node visit
     * @param {string} nodeId - Visited node ID
     */
    visitNode(nodeId) {
        if (!this.startNode) {
            // Auto-set start node if not set
            this.setStartNode(nodeId);
            return;
        }

        // Don't add if it's the same as the last node
        if (this.currentPath.length > 0 &&
            this.currentPath[this.currentPath.length - 1] === nodeId) {
            return;
        }

        // Add to path
        this.currentPath.push(nodeId);

        // Keep path reasonable length (max 100 nodes)
        if (this.currentPath.length > 100) {
            this.currentPath.shift();
        }

        console.log('Path updated:', this.currentPath);
    }

    /**
     * Get current navigation path
     * @returns {Array<string>} Array of node IDs
     */
    getCurrentPath() {
        return [...this.currentPath];
    }

    /**
     * Record a "like" with the current path
     * @param {string} nodeId - Liked node ID
     * @param {Object} metadata - Additional metadata (type, name, etc.)
     * @returns {Object} Like record
     */
    recordLike(nodeId, metadata = {}) {
        const likeRecord = {
            nodeId,
            path: this.getCurrentPath(),
            startNode: this.startNode,
            timestamp: Date.now(),
            metadata: {
                type: metadata.type || 'unknown',
                name: metadata.name || 'unknown',
                ...metadata
            }
        };

        // Store in memory
        this.likedPaths.set(nodeId, likeRecord);

        // Persist to localStorage
        this.saveToStorage();

        console.log('Like recorded:', likeRecord);
        return likeRecord;
    }

    /**
     * Check if a node is liked
     * @param {string} nodeId - Node ID
     * @returns {boolean} True if liked
     */
    isLiked(nodeId) {
        return this.likedPaths.has(nodeId);
    }

    /**
     * Get like record for a node
     * @param {string} nodeId - Node ID
     * @returns {Object|null} Like record or null
     */
    getLike(nodeId) {
        return this.likedPaths.get(nodeId) || null;
    }

    /**
     * Remove a like
     * @param {string} nodeId - Node ID
     * @returns {boolean} True if removed
     */
    removeLike(nodeId) {
        const removed = this.likedPaths.delete(nodeId);
        if (removed) {
            this.saveToStorage();
            console.log('Like removed:', nodeId);
        }
        return removed;
    }

    /**
     * Get all liked paths
     * @returns {Array<Object>} Array of like records
     */
    getAllLikes() {
        return Array.from(this.likedPaths.values());
    }

    /**
     * Get edge weights based on like paths (ant colony optimization)
     * @returns {Map<string, number>} Map of edge -> weight
     */
    getEdgeWeights() {
        const edgeWeights = new Map();

        // Process each liked path
        this.likedPaths.forEach(likeRecord => {
            const path = likeRecord.path;

            // Iterate through consecutive pairs in path
            for (let i = 0; i < path.length - 1; i++) {
                const from = path[i];
                const to = path[i + 1];
                const edgeKey = `${from}->${to}`;

                // Increment weight for this edge
                const currentWeight = edgeWeights.get(edgeKey) || 0;
                edgeWeights.set(edgeKey, currentWeight + 1);

                // Also increment reverse direction (undirected graph)
                const reverseKey = `${to}->${from}`;
                const reverseWeight = edgeWeights.get(reverseKey) || 0;
                edgeWeights.set(reverseKey, reverseWeight + 1);
            }
        });

        return edgeWeights;
    }

    /**
     * Get weight for a specific edge
     * @param {string} from - Source node ID
     * @param {string} to - Target node ID
     * @returns {number} Edge weight (0 if not traversed)
     */
    getEdgeWeight(from, to) {
        const edgeKey = `${from}->${to}`;
        const weights = this.getEdgeWeights();
        return weights.get(edgeKey) || 0;
    }

    /**
     * Clear current path (for new session)
     */
    clearCurrentPath() {
        this.currentPath = [];
        this.startNode = null;
        console.log('Path cleared');
    }

    /**
     * Clear all liked paths
     */
    clearAllLikes() {
        this.likedPaths.clear();
        localStorage.removeItem('polaris_liked_paths');
        console.log('All likes cleared');
    }

    /**
     * Save liked paths to localStorage
     */
    saveToStorage() {
        try {
            const data = {
                likes: Array.from(this.likedPaths.entries()),
                version: 1
            };
            localStorage.setItem('polaris_liked_paths', JSON.stringify(data));
        } catch (error) {
            console.error('Failed to save likes to storage:', error);
        }
    }

    /**
     * Load liked paths from localStorage
     */
    loadFromStorage() {
        try {
            const stored = localStorage.getItem('polaris_liked_paths');
            if (stored) {
                const data = JSON.parse(stored);
                if (data.version === 1 && Array.isArray(data.likes)) {
                    this.likedPaths = new Map(data.likes);
                    console.log(`Loaded ${this.likedPaths.size} likes from storage`);
                }
            }
        } catch (error) {
            console.error('Failed to load likes from storage:', error);
        }
    }

    /**
     * Export likes data for blockchain submission
     * @returns {Array<Object>} Array of like records formatted for blockchain
     */
    exportForBlockchain() {
        return this.getAllLikes().map(like => ({
            node_id: like.nodeId,
            node_path: like.path,
            timestamp: like.timestamp,
            metadata: like.metadata
        }));
    }

    /**
     * Get statistics about liked paths
     * @returns {Object} Statistics
     */
    getStatistics() {
        const likes = this.getAllLikes();
        const edgeWeights = this.getEdgeWeights();

        return {
            totalLikes: likes.length,
            avgPathLength: likes.length > 0
                ? likes.reduce((sum, like) => sum + like.path.length, 0) / likes.length
                : 0,
            totalEdgesTraversed: edgeWeights.size,
            mostTraveledEdge: this.getMostTraveledEdge(edgeWeights),
            likesByType: this.groupLikesByType(likes)
        };
    }

    /**
     * Get the most traveled edge
     * @param {Map<string, number>} edgeWeights - Edge weights map
     * @returns {Object|null} Most traveled edge
     */
    getMostTraveledEdge(edgeWeights) {
        let maxWeight = 0;
        let maxEdge = null;

        edgeWeights.forEach((weight, edge) => {
            if (weight > maxWeight) {
                maxWeight = weight;
                maxEdge = edge;
            }
        });

        return maxEdge ? { edge: maxEdge, weight: maxWeight } : null;
    }

    /**
     * Group likes by node type
     * @param {Array<Object>} likes - Array of like records
     * @returns {Object} Likes grouped by type
     */
    groupLikesByType(likes) {
        const byType = {};

        likes.forEach(like => {
            const type = like.metadata.type || 'unknown';
            if (!byType[type]) {
                byType[type] = 0;
            }
            byType[type]++;
        });

        return byType;
    }
}

// Export singleton instance
export const pathTracker = new PathTracker();
