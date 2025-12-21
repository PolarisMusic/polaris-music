/**
 * MusicGraph - JIT Hypertree visualization for Polaris Music Registry
 *
 * Main visualization using JIT Hypertree for exploring the music graph.
 * Groups are displayed with embedded RGraph visualizations showing member participation.
 * Person->Group relationships use unique colors for visual distinction.
 */

import { GraphAPI } from './graphApi.js';
import { ColorPalette } from './colorPalette.js';

export class MusicGraph {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            throw new Error(`Container element #${containerId} not found`);
        }

        this.api = new GraphAPI();
        this.colorPalette = new ColorPalette();

        // Cache for performance
        this.participationCache = new Map();
        this.rgraphInstances = new Map();

        // Initialize the visualization
        this.initializeHypertree();
    }

    /**
     * Initialize JIT Hypertree visualization
     */
    initializeHypertree() {
        // Check if $jit is available
        if (typeof $jit === 'undefined') {
            console.error('JIT library not loaded');
            return;
        }

        this.ht = new $jit.Hypertree({
            // Canvas container
            injectInto: this.container.id,

            // Canvas dimensions
            width: this.container.offsetWidth,
            height: this.container.offsetHeight,

            // Node configuration
            Node: {
                overridable: true,
                type: 'circle',
                dim: 9,
                color: '#f00'
            },

            // Edge configuration
            Edge: {
                overridable: true,
                type: 'hyperline',
                lineWidth: 2,
                color: '#088'
            },

            // Label configuration
            Label: {
                type: 'HTML',
                size: 10,
                family: 'sans-serif',
                color: '#fff'
            },

            // Event handling
            Events: {
                enable: true,
                type: 'Native', // Use native canvas events for clicking nodes

                onClick: (node, eventInfo, e) => {
                    if (node) {
                        this.handleNodeClick(node);
                    }
                },

                onRightClick: (node, eventInfo, e) => {
                    if (node) {
                        e.preventDefault();
                        this.handleNodeRightClick(node, e);
                    }
                },

                onMouseEnter: (node, eventInfo, e) => {
                    if (node) {
                        this.handleNodeHover(node, true);
                    }
                },

                onMouseLeave: (node, eventInfo, e) => {
                    if (node) {
                        this.handleNodeHover(node, false);
                    }
                }
            },

            // Animation settings
            duration: 700,
            transition: $jit.Trans.Quart.easeInOut,

            // Hyperbolic tree settings
            levelDistance: 100,

            // Navigation
            Navigation: {
                enable: true,
                panning: 'avoid nodes',
                zooming: 20
            },

            // Controller callbacks
            onCreateLabel: (domElement, node) => {
                this.createNodeLabel(domElement, node);
            },

            onPlaceLabel: (domElement, node) => {
                this.placeNodeLabel(domElement, node);
            },

            onBeforePlotNode: (node) => {
                this.styleNode(node);
            },

            onBeforePlotLine: (adj) => {
                this.styleEdge(adj);
            },

            onComplete: () => {
                console.log('Graph rendering complete');
                this.updateInfoPanel();
            }
        });

        console.log('Hypertree initialized');
    }

    /**
     * Create label for a node based on its type
     */
    createNodeLabel(domElement, node) {
        domElement.innerHTML = '';
        domElement.className = 'node-label';

        const nodeType = node.data.type || 'unknown';

        switch (nodeType) {
            case 'Group':
                this.createGroupLabel(domElement, node);
                break;
            case 'Person':
                this.createPersonLabel(domElement, node);
                break;
            case 'Release':
                this.createReleaseLabel(domElement, node);
                break;
            case 'Track':
                this.createTrackLabel(domElement, node);
                break;
            default:
                this.createDefaultLabel(domElement, node);
        }

        // Labels are non-interactive - clicks pass through to canvas nodes
        domElement.style.pointerEvents = 'none';
    }

    /**
     * Create Group node with RGraph visualization
     */
    createGroupLabel(domElement, node) {
        const container = document.createElement('div');
        container.className = 'group-node';
        container.style.position = 'relative';
        container.style.width = '160px';
        container.style.height = '160px';

        // Canvas for RGraph
        const canvasId = `rgraph-${node.id}`;
        const canvas = document.createElement('div');
        canvas.id = canvasId;
        canvas.style.width = '160px';
        canvas.style.height = '160px';
        container.appendChild(canvas);

        // Group name overlay
        const label = document.createElement('div');
        label.className = 'group-name-label';
        label.textContent = node.name;
        label.style.position = 'absolute';
        label.style.top = '50%';
        label.style.left = '50%';
        label.style.transform = 'translate(-50%, -50%)';
        label.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
        label.style.color = 'white';
        label.style.padding = '6px 12px';
        label.style.borderRadius = '4px';
        label.style.fontSize = '12px';
        label.style.fontWeight = 'bold';
        label.style.textAlign = 'center';
        label.style.maxWidth = '100px';
        label.style.pointerEvents = 'none';
        container.appendChild(label);

        domElement.appendChild(container);

        // Render RGraph after DOM is ready
        setTimeout(() => {
            this.renderGroupRGraph(canvasId, node);
        }, 50);
    }

    /**
     * Render RGraph showing group member participation
     */
    async renderGroupRGraph(containerId, groupNode) {
        const groupId = groupNode.data.group_id || groupNode.id;

        // Check cache
        let participationData = this.participationCache.get(groupId);

        if (!participationData) {
            try {
                const response = await fetch(`http://localhost:3000/api/groups/${groupId}/participation`);
                if (response.ok) {
                    const result = await response.json();
                    participationData = result.members || [];
                    this.participationCache.set(groupId, participationData);
                }
            } catch (error) {
                console.error('Failed to load participation data:', error);
                // Use mock data if available from node
                participationData = this.getMockParticipationData(groupNode);
            }
        }

        if (!participationData || participationData.length === 0) {
            return;
        }

        // Create RGraph
        const rgraph = new $jit.RGraph({
            injectInto: containerId,
            width: 160,
            height: 160,

            Node: {
                overridable: true,
                dim: 6,
                color: '#EEE'
            },

            Edge: {
                color: '#CCC',
                lineWidth: 1
            },

            Events: {
                enable: false
            },

            Label: {
                type: 'HTML',
                size: 8
            },

            onCreateLabel: (domElement, node) => {
                if (node.id === groupId) {
                    domElement.innerHTML = '';
                } else {
                    const names = node.name.split(' ');
                    const initials = names.map(n => n[0]).join('');
                    domElement.innerHTML = initials;
                    domElement.style.fontSize = '9px';
                    domElement.style.fontWeight = 'bold';
                }
            },

            levelDistance: 40
        });

        // Transform data to RGraph format
        const graphData = {
            id: groupId,
            name: '',
            data: {
                '$type': 'circle',
                '$dim': 10,
                '$color': '#333'
            },
            children: participationData.map((member, index) => ({
                id: member.personId,
                name: member.personName,
                data: {
                    '$dim': Math.max(4, Math.sqrt(member.participationPercentage || 50) * 2),
                    '$color': this.colorPalette.getColor(member.personId),
                    '$angularWidth': (member.participationPercentage || 50) / 100
                }
            }))
        };

        // Load and render
        rgraph.loadJSON(graphData);
        rgraph.compute('end');
        rgraph.fx.animate({
            modes: ['polar'],
            duration: 500
        });

        // Store instance
        this.rgraphInstances.set(containerId, rgraph);
    }

    /**
     * Get mock participation data for groups without API data
     */
    getMockParticipationData(groupNode) {
        // Extract from children if available
        const children = groupNode.children || [];
        if (children.length === 0) return [];

        return children
            .filter(child => child.data && child.data.type === 'Person')
            .map(child => ({
                personId: child.id,
                personName: child.name,
                participationPercentage: child.data.participation_percent || 25
            }));
    }

    /**
     * Create Person node label
     */
    createPersonLabel(domElement, node) {
        const container = document.createElement('div');
        container.className = 'person-node';
        container.style.padding = '4px 8px';
        container.style.backgroundColor = 'rgba(0, 0, 0, 0.6)'; // Semi-transparent background
        container.style.color = 'white';
        container.style.borderRadius = '12px';
        container.style.fontSize = '11px';
        container.style.fontWeight = 'bold';
        container.style.textAlign = 'center';
        container.style.minWidth = '60px';
        container.style.textShadow = '1px 1px 2px rgba(0, 0, 0, 0.8), -1px -1px 2px rgba(0, 0, 0, 0.8)'; // Text outline effect
        container.textContent = node.name;

        domElement.appendChild(container);
    }

    /**
     * Create Release node label
     */
    createReleaseLabel(domElement, node) {
        const container = document.createElement('div');
        container.className = 'release-node';
        container.style.padding = '6px 10px';
        container.style.backgroundColor = '#27ae60';
        container.style.color = 'white';
        container.style.borderRadius = '4px';
        container.style.fontSize = '10px';
        container.style.textAlign = 'center';
        container.style.maxWidth = '120px';
        container.textContent = node.name;

        domElement.appendChild(container);
    }

    /**
     * Create Track node label
     */
    createTrackLabel(domElement, node) {
        const container = document.createElement('div');
        container.className = 'track-node';
        container.style.padding = '4px 8px';
        container.style.backgroundColor = '#3498db';
        container.style.color = 'white';
        container.style.borderRadius = '3px';
        container.style.fontSize = '9px';
        container.style.textAlign = 'center';
        container.style.maxWidth = '100px';
        container.textContent = node.name;

        domElement.appendChild(container);
    }

    /**
     * Create default node label
     */
    createDefaultLabel(domElement, node) {
        const container = document.createElement('div');
        container.className = 'default-node';
        container.style.padding = '6px';
        container.style.backgroundColor = '#7f8c8d';
        container.style.color = 'white';
        container.style.borderRadius = '3px';
        container.style.fontSize = '10px';
        container.textContent = node.name;

        domElement.appendChild(container);
    }

    /**
     * Position node labels near bottom of node circle
     */
    placeNodeLabel(domElement, node) {
        const style = domElement.style;
        const left = parseInt(style.left) || 0;
        const top = parseInt(style.top) || 0;
        const w = domElement.offsetWidth;
        const h = domElement.offsetHeight;

        // Get node radius from $dim property (node size in pixels)
        const nodeRadius = node.data.$dim || 15;

        // Position label below the node circle
        // Center horizontally, offset vertically by node radius + spacing
        style.left = (left - w / 2) + 'px';
        style.top = (top + nodeRadius + 5) + 'px'; // 5px spacing below circle
        style.display = '';
    }

    /**
     * Style nodes before rendering
     */
    styleNode(node) {
        // Apply node-specific styling based on type
        if (!node.data) return;

        // Use color from data if available
        if (node.data.$color) {
            node.setData('color', node.data.$color);
        }

        if (node.data.$dim) {
            node.setData('dim', node.data.$dim);
        }
    }

    /**
     * Style edges before rendering
     */
    styleEdge(adj) {
        if (!adj.nodeFrom || !adj.nodeTo) return;

        const fromType = adj.nodeFrom.data.type;
        const toType = adj.nodeTo.data.type;

        // Person -> Group: use person's color
        if (fromType === 'Person' && toType === 'Group') {
            const color = this.colorPalette.getColor(adj.nodeFrom.id);
            adj.setData('color', color);
            adj.setData('lineWidth', this.colorPalette.getEdgeWidth('MEMBER_OF'));
        }

        // Group -> Track: green edges
        else if (fromType === 'Group' && toType === 'Track') {
            adj.setData('color', this.colorPalette.getEdgeColor('PERFORMED_ON'));
            adj.setData('lineWidth', this.colorPalette.getEdgeWidth('PERFORMED_ON'));
        }

        // Track -> Release: gray edges
        else if (fromType === 'Track' && toType === 'Release') {
            adj.setData('color', this.colorPalette.getEdgeColor('IN_RELEASE'));
            adj.setData('lineWidth', this.colorPalette.getEdgeWidth('IN_RELEASE'));
        }
    }

    /**
     * Handle node click
     */
    handleNodeClick(node) {
        console.log('Node clicked:', node.id, node.data);

        // Center on node
        this.ht.onClick(node.id, {
            onComplete: () => {
                this.updateInfoPanel(node);
            }
        });
    }

    /**
     * Handle node right-click
     */
    handleNodeRightClick(node, event) {
        console.log('Node right-clicked:', node.id);
        // TODO: Show context menu
    }

    /**
     * Handle node hover
     */
    handleNodeHover(node, isEntering) {
        if (isEntering) {
            // Show tooltip or highlight
            this.showTooltip(node);
        } else {
            // Hide tooltip
            this.hideTooltip();
        }
    }

    /**
     * Show tooltip for node
     */
    showTooltip(node) {
        // TODO: Implement tooltip display
        console.log('Show tooltip for:', node.name);
    }

    /**
     * Hide tooltip
     */
    hideTooltip() {
        // TODO: Implement tooltip hiding
    }

    /**
     * Update info panel with node details
     */
    async updateInfoPanel(node = null) {
        const infoTitle = document.getElementById('info-title');
        const infoContent = document.getElementById('info-content');
        const infoViewer = document.getElementById('info-viewer');

        if (!infoTitle || !infoContent) return;

        if (!node) {
            infoTitle.textContent = 'Select a node';
            infoContent.innerHTML = '<p class="placeholder">Click on a Group or Person to see details</p>';
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

        try {
            // Fetch detailed data from API
            const details = await this.api.fetchNodeDetails(nodeId, type);

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

    /**
     * Render Group details in info panel
     */
    renderGroupDetails(group, titleElement, contentElement) {
        titleElement.textContent = group.name || group.group_name || 'Unknown Group';

        let html = '';

        // Photo
        if (group.photo) {
            html += `<div class="info-photo"><img src="${group.photo}" alt="${group.name}" /></div>`;
        }

        // Active dates and location
        const formed = group.formed_date || '';
        const disbanded = group.disbanded_date || 'present';
        if (formed) {
            html += `<p class="info-meta"><strong>Active:</strong> ${formed}–${disbanded}</p>`;
        }

        // Members section
        if (group.members && group.members.length > 0) {
            html += `<div class="info-section"><h4>Members</h4><ul class="info-list">`;
            group.members.forEach(member => {
                const roles = member.roles ? member.roles.join(', ') : '';
                html += `<li><strong>${member.name}</strong>${roles ? ` - ${roles}` : ''}</li>`;
            });
            html += `</ul></div>`;
        }

        // Bio section
        if (group.bio || group.description) {
            html += `<div class="info-section"><h4>Biography</h4><p>${group.bio || group.description}</p></div>`;
        }

        // Trivia section
        if (group.trivia) {
            html += `<div class="info-section"><h4>Trivia</h4><p>${group.trivia}</p></div>`;
        }

        contentElement.innerHTML = html;
    }

    /**
     * Render Person details in info panel
     */
    renderPersonDetails(person, titleElement, contentElement) {
        titleElement.textContent = person.name || person.person_name || 'Unknown Person';

        let html = '';

        // Photo
        if (person.photo) {
            html += `<div class="info-photo"><img src="${person.photo}" alt="${person.name}" /></div>`;
        }

        // Location
        if (person.city) {
            html += `<p class="info-meta"><strong>Location:</strong> ${person.city}</p>`;
        }

        // Groups section
        if (person.groups && person.groups.length > 0) {
            html += `<div class="info-section"><h4>Groups</h4><ul class="info-list">`;
            person.groups.forEach(group => {
                const role = group.role || '';
                html += `<li><strong>${group.name}</strong>${role ? ` - ${role}` : ''}</li>`;
            });
            html += `</ul></div>`;
        }

        // Bio section
        if (person.bio) {
            html += `<div class="info-section"><h4>Biography</h4><p>${person.bio}</p></div>`;
        }

        // Trivia section
        if (person.trivia) {
            html += `<div class="info-section"><h4>Trivia</h4><p>${person.trivia}</p></div>`;
        }

        contentElement.innerHTML = html;
    }

    /**
     * Load graph data from API
     */
    async loadGraphData() {
        try {
            console.log('Loading graph data...');
            const graphData = await this.api.fetchInitialGraph();

            console.log('Graph data loaded:', graphData);

            // Load into Hypertree
            this.ht.loadJSON(graphData);
            this.ht.refresh();

            console.log('Graph rendered');
        } catch (error) {
            console.error('Failed to load graph data:', error);
        }
    }

    /**
     * Refresh the visualization
     */
    refresh() {
        if (this.ht) {
            this.ht.refresh();
        }
    }

    /**
     * Destroy the visualization and clean up
     */
    destroy() {
        // Clean up RGraph instances
        this.rgraphInstances.forEach(rgraph => {
            if (rgraph.canvas) {
                rgraph.canvas.clear();
            }
        });
        this.rgraphInstances.clear();

        // Clear caches
        this.participationCache.clear();

        // Clear container
        if (this.container) {
            this.container.innerHTML = '';
        }
    }
}

// Export singleton instance creator
export function createMusicGraph(containerId) {
    return new MusicGraph(containerId);
}
