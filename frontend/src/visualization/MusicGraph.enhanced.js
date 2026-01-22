/**
 * MusicGraph - Enhanced with PathTracker and LikeManager integration
 *
 * This file contains the additions needed for MusicGraph.js to support:
 * 1. Path tracking for user navigation
 * 2. Like functionality with blockchain integration
 * 3. Edge weighting based on traversal paths (ant colony optimization)
 * 4. Guest edges visualization (non-colored gray edges)
 *
 * INTEGRATION INSTRUCTIONS:
 * 1. Import PathTracker and LikeManager at top of MusicGraph.js
 * 2. Add to constructor: pathTracker, likeManager, selectedNode, walletManager
 * 3. Update handleNodeClick to track paths
 * 4. Update styleEdge to include path weighting and guest edges
 * 5. Update updateInfoPanel to show like button
 * 6. Add updateLikeButton, handleLikeClick, updateFavoritesCount methods
 * 7. Update loadGraphData to set start node and update favorites count
 */

// ===== STEP 1: Add to imports (top of file) =====
/*
import { PathTracker } from './PathTracker.js';
import LikeManager from './LikeManager.js';
*/

// ===== STEP 2: Replace constructor =====
/*
export class MusicGraph {
    constructor(containerId, walletManager = null) {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            throw new Error(`Container element #${containerId} not found`);
        }

        this.api = new GraphAPI();
        this.colorPalette = new ColorPalette();
        this.pathTracker = new PathTracker();

        // Initialize like manager (requires wallet)
        this.likeManager = null;
        this.walletManager = walletManager;
        if (walletManager) {
            this.likeManager = new LikeManager(walletManager, this.pathTracker);
        }

        // Cache for performance
        this.participationCache = new Map();
        this.rgraphInstances = new Map();

        // Current selected node (for like button)
        this.selectedNode = null;

        // Initialize the visualization
        this.initializeHypertree();
    }
*/

// ===== STEP 3: Update handleNodeClick =====
/*
    handleNodeClick(node) {
        console.log('Node clicked:', node.id, node.data);

        // Track path navigation
        this.pathTracker.visitNode(node.id);

        // Store selected node for like button
        this.selectedNode = node;

        // Center on node
        this.ht.onClick(node.id, {
            onComplete: () => {
                this.updateInfoPanel(node);
            }
        });
    }
*/

// ===== STEP 4: Update styleEdge to add path weighting and guest edges =====
/*
    styleEdge(adj) {
        if (!adj.nodeFrom || !adj.nodeTo) return;

        const fromType = adj.nodeFrom.data.type;
        const toType = adj.nodeTo.data.type;

        // Get path weight for this edge (ant colony optimization)
        const pathWeight = this.pathTracker.getEdgeWeight(adj.nodeFrom.id, adj.nodeTo.id);
        const weightMultiplier = pathWeight > 0 ? Math.min(1 + (pathWeight * 0.2), 3) : 1;

        // Person -> Group: use person's color
        if (fromType === 'Person' && toType === 'Group') {
            const color = this.colorPalette.getColor(adj.nodeFrom.id);
            adj.setData('color', color);
            adj.setData('lineWidth', this.colorPalette.getEdgeWidth('MEMBER_OF') * weightMultiplier);
        }

        // Group -> Track: green edges
        else if (fromType === 'Group' && toType === 'Track') {
            adj.setData('color', this.colorPalette.getEdgeColor('PERFORMED_ON'));
            adj.setData('lineWidth', this.colorPalette.getEdgeWidth('PERFORMED_ON') * weightMultiplier);
        }

        // Track -> Release: gray edges
        else if (fromType === 'Track' && toType === 'Release') {
            adj.setData('color', this.colorPalette.getEdgeColor('IN_RELEASE'));
            adj.setData('lineWidth', this.colorPalette.getEdgeWidth('IN_RELEASE') * weightMultiplier);
        }

        // Guest edges: non-colored (gray), thinner
        else if (adj.data && adj.data.type === 'GUEST_ON') {
            adj.setData('color', '#666666'); // Gray for guests
            adj.setData('lineWidth', this.colorPalette.getEdgeWidth('GUEST_ON') * weightMultiplier);
        }

        // Default edge styling with path weighting
        else {
            adj.setData('lineWidth', (adj.data.lineWidth || 1) * weightMultiplier);
        }
    }
*/

// ===== STEP 5: Update updateInfoPanel to include like button =====
/*
    async updateInfoPanel(node = null) {
        const infoTitle = document.getElementById('info-title');
        const infoContent = document.getElementById('info-content');
        const infoViewer = document.getElementById('info-viewer');
        const likeButton = document.getElementById('like-button');

        if (!infoTitle || !infoContent) return;

        if (!node) {
            infoTitle.textContent = 'Select a node';
            infoContent.innerHTML = '<p class="placeholder">Click on a Group or Person to see details</p>';
            if (likeButton) likeButton.style.display = 'none';
            return;
        }

        const type = node.data.type || 'Unknown';
        const nodeId = node.id;

        // Show loading state
        infoTitle.textContent = node.name || 'Loading...';
        infoContent.innerHTML = '<p>Loading details...</p>';

        // Make info viewer visible
        if (infoViewer) {
            infoViewer.style.display = 'block';
        }

        // Update like button state
        this.updateLikeButton(node);

        try {
            // Fetch detailed data from API
            const response = await this.api.fetchNodeDetails(nodeId, type);

            if (!response) {
                infoContent.innerHTML = '<p>No details available</p>';
                return;
            }

            // Extract data from API response wrapper
            const details = response.data || response;

            if (!details) {
                infoContent.innerHTML = '<p>No details available</p>';
                return;
            }

            // Build HTML based on node type
            if (type === 'group' || type === 'Group') {
                this.renderGroupDetails(details, infoTitle, infoContent);
            } else if (type === 'person' || type === 'Person') {
                this.renderPersonDetails(details, infoTitle, infoContent);
            } else {
                infoContent.innerHTML = `<p><strong>Type:</strong> ${type}</p>`;
            }
        } catch (error) {
            console.error('Error fetching node details:', error);
            infoContent.innerHTML = '<p>Error loading details</p>';
        }
    }
*/

// ===== STEP 6: Add new methods for like functionality =====
/*
    // Add these methods to MusicGraph class:

    updateLikeButton(node) {
        const likeButton = document.getElementById('like-button');
        if (!likeButton) return;

        const isLiked = this.pathTracker.isLiked(node.id);

        likeButton.style.display = 'block';
        likeButton.innerHTML = isLiked ? '❤️ Liked' : '🤍 Like';
        likeButton.className = isLiked ? 'btn-like liked' : 'btn-like';
        likeButton.onclick = () => this.handleLikeClick(node);
    }

    async handleLikeClick(node) {
        if (!this.likeManager) {
            console.warn('LikeManager not initialized (wallet required)');
            alert('Please connect your wallet to like nodes');
            return;
        }

        const likeButton = document.getElementById('like-button');
        if (likeButton) {
            likeButton.disabled = true;
            likeButton.innerHTML = '⏳ Processing...';
        }

        try {
            const result = await this.likeManager.toggleLike(node.id, {
                type: node.data.type,
                name: node.name
            });

            if (result.success) {
                // Update button state
                this.updateLikeButton(node);

                // Update favorites count
                this.updateFavoritesCount();

                // Refresh visualization to update edge weights
                this.refresh();

                console.log('Like toggled:', result);
            } else {
                console.error('Like toggle failed:', result.error);
                alert(`Failed to like node: ${result.error}`);
            }
        } catch (error) {
            console.error('Like error:', error);
            alert(`Error: ${error.message}`);
        } finally {
            if (likeButton) {
                likeButton.disabled = false;
                this.updateLikeButton(node);
            }
        }
    }

    updateFavoritesCount() {
        const favoritesCount = document.getElementById('favorites-count');
        if (favoritesCount) {
            favoritesCount.textContent = this.pathTracker.getAllLikes().length;
        }
    }
*/

// ===== STEP 7: Update loadGraphData to set start node =====
/*
    async loadGraphData() {
        try {
            console.log('Loading graph data...');
            const graphData = await this.api.fetchInitialGraph();

            console.log('Graph data loaded:', graphData);

            // Set start node for path tracking (root of graph)
            if (graphData && graphData.id) {
                this.pathTracker.setStartNode(graphData.id);
            }

            // Load into Hypertree
            this.ht.loadJSON(graphData);
            this.ht.refresh();

            // Update favorites count
            this.updateFavoritesCount();

            console.log('Graph rendered');
        } catch (error) {
            console.error('Failed to load graph data:', error);
        }
    }
*/

// ===== STEP 8: Update visualization.html to pass walletManager =====
/*
    // In visualization.html, change:
    const graph = new MusicGraph('infovis');

    // To:
    const graph = new MusicGraph('infovis', walletManager);
*/

export default {};
