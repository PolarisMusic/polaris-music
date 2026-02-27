/**
 * MusicGraph - JIT Hypertree visualization for Polaris Music Registry
 *
 * Main visualization using JIT Hypertree for exploring the music graph.
 * Groups display donut rings showing member participation by release count.
 * Person->Group relationships use unique colors for visual distinction.
 *
 * Label strategy:
 *   - Initials are rendered inside every circle on the canvas (always visible)
 *   - Full-name tooltip shown only when node is selected, hovered, or near center
 *   - "Near center" uses Poincaré disk distance (squaredNorm < threshold)
 */

import { GraphAPI } from './graphApi.js';
import { ColorPalette } from './colorPalette.js';
import { PathTracker } from './PathTracker.js';

export class MusicGraph {
    constructor(containerId, walletManager) {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            throw new Error(`Container element #${containerId} not found`);
        }

        this.api = new GraphAPI();
        this.colorPalette = new ColorPalette();
        this.walletManager = walletManager || null;
        this.pathTracker = new PathTracker();

        // State tracking
        this.hoveredNode = null;
        this.selectedNode = null;
        this.labelsVisible = true;
        this.historyPanelOpen = false;

        // Raw graph model for dynamic merging (populated in loadGraphData)
        this.rawGraph = null;

        // Poincaré distance threshold for showing full-name tooltip
        this.labelProximityThreshold = 0.40;

        // Initialize the visualization
        this.initializeHypertree();
    }

    /**
     * Register custom Hypertree node types: circle-hover and group-donut
     */
    registerNodeTypes() {
        $jit.Hypertree.Plot.NodeTypes.implement({
            /**
             * circle-hover: standard circle with hover/selection outline
             * and initials drawn inside.
             */
            'circle-hover': {
                'render': function(node, canvas) {
                    var nconfig = this.node,
                        dim = node.getData('dim'),
                        p = node.pos.getc();
                    dim = nconfig.transform ? dim * (1 - p.squaredNorm()) : dim;
                    p.$scale(node.scale);
                    if (dim > 0.2) {
                        var ctx = canvas.getCtx();
                        var color = node.getData('color') || '#888';

                        // Fill circle
                        ctx.beginPath();
                        ctx.arc(p.x, p.y, dim, 0, Math.PI * 2, false);
                        ctx.fillStyle = color;
                        ctx.fill();

                        // Hover/selection outline
                        var isHovered = node.getData('isHovered');
                        var isSelected = node.getData('isSelected');
                        if (isSelected) {
                            ctx.strokeStyle = '#fff';
                            ctx.lineWidth = 2.5;
                            ctx.stroke();
                        } else if (isHovered) {
                            ctx.strokeStyle = 'rgba(255,255,255,0.6)';
                            ctx.lineWidth = 1.5;
                            ctx.stroke();
                        }

                        // Draw initials inside circle
                        if (dim > 3) {
                            var name = node.name || '';
                            var words = name.split(/\s+/).filter(Boolean);
                            var initials = words.map(function(w) { return w[0] || ''; }).join('').substring(0, 3);
                            var fontSize = Math.max(6, Math.min(dim * 0.8, 14));
                            ctx.font = 'bold ' + fontSize + 'px sans-serif';
                            ctx.fillStyle = '#fff';
                            ctx.textAlign = 'center';
                            ctx.textBaseline = 'middle';
                            ctx.fillText(initials, p.x, p.y);
                        }
                    }
                },
                'contains': function(node, pos) {
                    var dim = node.getData('dim'),
                        npos = node.pos.getc().$scale(node.scale);
                    return this.nodeHelper.circle.contains(npos, pos, dim);
                }
            },

            /**
             * group-donut: circle with donut ring segments representing
             * member participation (release counts). Slices are drawn
             * between innerR and outerR using the shortnodepie approach.
             */
            'group-donut': {
                'render': function(node, canvas) {
                    var nconfig = this.node,
                        dim = node.getData('dim'),
                        p = node.pos.getc();
                    dim = nconfig.transform ? dim * (1 - p.squaredNorm()) : dim;
                    p.$scale(node.scale);
                    if (dim > 0.2) {
                        var ctx = canvas.getCtx();
                        var color = node.getData('color') || '#888';

                        // Fill base circle
                        ctx.beginPath();
                        ctx.arc(p.x, p.y, dim, 0, Math.PI * 2, false);
                        ctx.fillStyle = color;
                        ctx.fill();

                        // Draw donut slices if data is loaded
                        var slices = node.getData('donutSlices');
                        if (slices && slices.length > 0) {
                            var gap = Math.max(2, dim * 0.20);
                            var thickness = Math.max(3, dim * 0.45);
                            var innerR = dim + gap;
                            var outerR = innerR + thickness;

                            for (var i = 0; i < slices.length; i++) {
                                var s = slices[i];
                                // Donut segment: outer arc forward, inner arc backward, close
                                ctx.beginPath();
                                ctx.arc(p.x, p.y, outerR, s.begin, s.end, false);
                                ctx.arc(p.x, p.y, innerR, s.end, s.begin, true);
                                ctx.closePath();
                                ctx.fillStyle = s.color;
                                ctx.fill();

                                // Subtle separator stroke
                                ctx.strokeStyle = 'rgba(0,0,0,0.3)';
                                ctx.lineWidth = 0.5;
                                ctx.stroke();
                            }
                        }

                        // Hover/selection outline around outerR (or dim if no slices)
                        var isHovered = node.getData('isHovered');
                        var isSelected = node.getData('isSelected');
                        var hasSlices = slices && slices.length > 0;
                        var outlineR = hasSlices
                            ? (dim + Math.max(2, dim * 0.20) + Math.max(3, dim * 0.45))
                            : dim;

                        if (isSelected) {
                            ctx.beginPath();
                            ctx.arc(p.x, p.y, outlineR + 1, 0, Math.PI * 2, false);
                            ctx.strokeStyle = '#fff';
                            ctx.lineWidth = 2.5;
                            ctx.stroke();
                        } else if (isHovered) {
                            ctx.beginPath();
                            ctx.arc(p.x, p.y, outlineR + 1, 0, Math.PI * 2, false);
                            ctx.strokeStyle = 'rgba(255,255,255,0.6)';
                            ctx.lineWidth = 1.5;
                            ctx.stroke();
                        }

                        // Draw initials inside base circle
                        if (dim > 3) {
                            var name = node.name || '';
                            var words = name.split(/\s+/).filter(Boolean);
                            var initials = words.map(function(w) { return w[0] || ''; }).join('').substring(0, 3);
                            var fontSize = Math.max(6, Math.min(dim * 0.8, 14));
                            ctx.font = 'bold ' + fontSize + 'px sans-serif';
                            ctx.fillStyle = '#fff';
                            ctx.textAlign = 'center';
                            ctx.textBaseline = 'middle';
                            ctx.fillText(initials, p.x, p.y);
                        }
                    }
                },
                'contains': function(node, pos) {
                    var dim = node.getData('dim'),
                        npos = node.pos.getc().$scale(node.scale);
                    // Hit area includes donut ring when slices are present
                    var slices = node.getData('donutSlices');
                    if (slices && slices.length > 0) {
                        var gap = Math.max(2, dim * 0.20);
                        var thickness = Math.max(3, dim * 0.45);
                        var outerR = dim + gap + thickness;
                        return this.nodeHelper.circle.contains(npos, pos, outerR);
                    }
                    return this.nodeHelper.circle.contains(npos, pos, dim);
                }
            }
        });
    }

    /**
     * Initialize JIT Hypertree visualization
     */
    initializeHypertree() {
        if (typeof $jit === 'undefined') {
            console.error('JIT library not loaded');
            return;
        }

        // Register custom node types before creating the Hypertree
        this.registerNodeTypes();

        this.ht = new $jit.Hypertree({
            injectInto: this.container.id,

            width: this.container.offsetWidth,
            height: this.container.offsetHeight,

            // Node configuration
            Node: {
                overridable: true,
                type: 'circle-hover',  // default to hover-aware circle
                dim: 9,
                color: '#f00',
                transform: true   // distance-based scaling in Poincaré disk
            },

            // Edge configuration
            Edge: {
                overridable: true,
                type: 'hyperline',
                lineWidth: 2,
                color: '#088'
            },

            // Label configuration - lightweight HTML tooltips
            Label: {
                type: 'HTML',
                size: 10,
                family: 'sans-serif',
                color: '#fff'
            },

            // Event handling
            Events: {
                enable: true,
                type: 'Native',

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
                },

                onMouseWheel: (delta, e) => {
                    // Let JIT apply zoom first, then sync slider
                    setTimeout(() => this.syncZoomSlider(), 0);
                }
            },

            // Animation settings
            duration: 700,
            transition: $jit.Trans.Quart.easeInOut,

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
     * Create lightweight tooltip label for a node.
     * Full name is shown conditionally (hover, selected, near center).
     * Initials are drawn on canvas by the node type renderer.
     */
    createNodeLabel(domElement, node) {
        domElement.innerHTML = '';
        domElement.className = 'node-tooltip-label';

        const name = node.name || '';
        const nodeType = (node.data.type || '').toLowerCase();

        const tooltip = document.createElement('div');
        tooltip.className = 'node-name-tooltip';
        tooltip.textContent = name;

        domElement.appendChild(tooltip);

        // Labels are non-interactive - clicks pass through to canvas nodes
        domElement.style.pointerEvents = 'none';
    }

    /**
     * Position and conditionally show/hide the full-name tooltip.
     *
     * Show when: node is selected, hovered, or near center of the Poincaré disk.
     * "Near center" = pos.squaredNorm() < threshold.
     */
    placeNodeLabel(domElement, node) {
        const style = domElement.style;
        const left = parseInt(style.left) || 0;
        const top = parseInt(style.top) || 0;
        const w = domElement.offsetWidth;

        const nodeRadius = node.getData('dim') || 10;

        // Center label horizontally, position below node
        style.left = (left - w / 2) + 'px';
        style.top = (top + nodeRadius + 4) + 'px';

        if (!this.labelsVisible) {
            style.display = 'none';
            return;
        }

        // Show tooltip only when selected or near center of the Poincaré disk.
        // Hover alone does NOT trigger tooltip (prevents edge-node clutter,
        // especially since JIT hit-testing isn't transform-scaled).
        const isSelected = node.getData('isSelected');
        const sqNorm = node.pos.getc().squaredNorm();
        const isNearCenter = sqNorm < this.labelProximityThreshold;

        if (isSelected || isNearCenter) {
            style.display = '';
        } else {
            style.display = 'none';
        }
    }

    /**
     * Style nodes before rendering. Assigns node types and triggers
     * lazy loading of donut participation data for group nodes.
     */
    styleNode(node) {
        if (!node.data) return;

        // Apply color/dim from data
        if (node.data.$color) {
            node.setData('color', node.data.$color);
        }
        if (node.data.$dim) {
            node.setData('dim', node.data.$dim);
        }

        const nodeType = (node.data.type || '').toLowerCase();

        // Group nodes use the group-donut renderer
        if (nodeType === 'group') {
            node.setData('type', 'group-donut');

            // Lazy-load participation data (only once)
            const donutStatus = node.getData('donutStatus');
            if (!donutStatus) {
                node.setData('donutStatus', 'loading');
                this.loadDonutData(node);
            }
        } else {
            // All other nodes use circle-hover
            node.setData('type', 'circle-hover');
        }
    }

    /**
     * Lazy-load participation data for a group node and attach donut slices.
     * Non-blocking: fires and forgets, triggers redraw on completion.
     */
    async loadDonutData(node) {
        const groupId = node.data.group_id || node.id;
        try {
            const data = await this.api.fetchGroupParticipation(groupId);
            const slices = this.computeDonutSlices(data.members || []);
            node.setData('donutSlices', slices);
            node.setData('donutStatus', 'ready');
            // Trigger redraw so the ring appears
            if (this.ht) {
                this.ht.plot();
            }
        } catch (error) {
            console.error(`Failed to load donut data for ${groupId}:`, error);
            node.setData('donutStatus', 'error');
        }
    }

    /**
     * Compute donut slice angles from backend member participation data.
     *
     * @param {Array} members - Backend members array (personId, personName, releaseCount, releasePctOfGroupReleases)
     * @returns {Array} Slice descriptors with begin/end angles, color, and metadata
     */
    computeDonutSlices(members) {
        if (!members || members.length === 0) return [];

        // Sanitise weights: coerce to finite non-negative numbers
        const weights = members.map(m => {
            const v = Number(m.releaseCount ?? 0);
            return Number.isFinite(v) && v > 0 ? v : 0;
        });

        let totalWeight = weights.reduce((a, b) => a + b, 0);

        // Fallback: if all weights are 0 but members exist, draw equal slices
        const useEqualSlices = totalWeight <= 0;
        if (useEqualSlices) {
            totalWeight = members.length; // each member gets weight = 1
        }

        // Sort descending by weight (stable by index for equal slices)
        const indexed = members.map((m, i) => ({ m, w: useEqualSlices ? 1 : weights[i], i }));
        indexed.sort((a, b) => b.w - a.w || a.i - b.i);

        const slices = [];
        let angle = -Math.PI / 2; // Start at top

        for (const { m, w } of indexed) {
            const weightNormalized = w / totalWeight;
            const sliceAngle = weightNormalized * 2 * Math.PI;

            slices.push({
                begin: angle,
                end: angle + sliceAngle,
                color: m.color || this.colorPalette.getColor(m.personId),
                personId: m.personId,
                personName: m.personName,
                releaseCount: m.releaseCount,
                releasePctOfGroupReleases: m.releasePctOfGroupReleases,
                weightNormalized: weightNormalized
            });

            angle += sliceAngle;
        }

        return slices;
    }

    /**
     * Style edges before rendering
     */
    styleEdge(adj) {
        if (!adj.nodeFrom || !adj.nodeTo) return;

        const fromType = (adj.nodeFrom.data.type || '').toLowerCase();
        const toType = (adj.nodeTo.data.type || '').toLowerCase();

        // MEMBER_OF edges: find the person endpoint, use its DB color
        if ((fromType === 'person' && toType === 'group') ||
            (fromType === 'group' && toType === 'person')) {
            const personNode = fromType === 'person' ? adj.nodeFrom : adj.nodeTo;
            // Prefer DB-stored color on the node, fall back to palette
            const color =
                personNode.getData('color') ||
                personNode.data.$color ||
                this.colorPalette.getColor(personNode.id);
            adj.setData('color', color);
            adj.setData('lineWidth', this.colorPalette.getEdgeWidth('MEMBER_OF'));
        }
        // Group -> Track: green edges
        else if ((fromType === 'group' && toType === 'track') ||
                 (fromType === 'track' && toType === 'group')) {
            adj.setData('color', this.colorPalette.getEdgeColor('PERFORMED_ON'));
            adj.setData('lineWidth', this.colorPalette.getEdgeWidth('PERFORMED_ON'));
        }
        // Track -> Release: gray edges
        else if ((fromType === 'track' && toType === 'release') ||
                 (fromType === 'release' && toType === 'track')) {
            adj.setData('color', this.colorPalette.getEdgeColor('IN_RELEASE'));
            adj.setData('lineWidth', this.colorPalette.getEdgeWidth('IN_RELEASE'));
        }
    }

    /**
     * Handle node click - center on node and select it
     */
    handleNodeClick(node) {
        console.log('Node clicked:', node.id, node.data);

        // Clear previous selection
        if (this.selectedNode && this.selectedNode.id !== node.id) {
            this.selectedNode.setData('isSelected', false);
        }

        // Set new selection
        node.setData('isSelected', true);
        this.selectedNode = node;

        // Record in browse history
        this.pathTracker.visitNode(node.id, {
            name: node.name,
            type: node.data && node.data.type
        });
        this.updateHistoryCount();
        if (this.historyPanelOpen) {
            this.renderHistoryPanel();
        }

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
    }

    /**
     * Handle node hover - set visual state and trigger redraw
     */
    handleNodeHover(node, isEntering) {
        if (isEntering) {
            // Clear previous hover
            if (this.hoveredNode && this.hoveredNode.id !== node.id) {
                this.hoveredNode.setData('isHovered', false);
            }
            node.setData('isHovered', true);
            this.hoveredNode = node;
            this.container.style.cursor = 'pointer';
        } else {
            node.setData('isHovered', false);
            if (this.hoveredNode && this.hoveredNode.id === node.id) {
                this.hoveredNode = null;
            }
            this.container.style.cursor = 'default';
        }

        // Redraw to show hover state
        if (this.ht) {
            this.ht.plot();
        }
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

        infoTitle.textContent = node.name || 'Loading...';
        infoContent.innerHTML = '<p>Loading details...</p>';

        if (infoViewer) {
            infoViewer.style.display = 'block';
        }

        try {
            const response = await this.api.fetchNodeDetails(nodeId, type);

            if (!response) {
                infoContent.innerHTML = '<p>No details available</p>';
                return;
            }

            const details = response.data || response;

            if (!details) {
                infoContent.innerHTML = '<p>No details available</p>';
                return;
            }

            const typeLower = type.toLowerCase();
            if (typeLower === 'group') {
                this.renderGroupDetails(details, infoTitle, infoContent);
            } else if (typeLower === 'person') {
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

        if (group.photo) {
            html += `<div class="info-photo"><img src="${group.photo}" alt="${group.name}" /></div>`;
        }

        const formed = group.formed_date || '';
        const disbanded = group.disbanded_date || 'present';
        if (formed) {
            html += `<p class="info-meta"><strong>Active:</strong> ${formed}\u2013${disbanded}</p>`;
        }

        if (group.members && group.members.length > 0) {
            html += `<div class="info-section"><h4>Members</h4><ul class="info-list">`;
            group.members.forEach(member => {
                const role = member.role || '';
                html += `<li><strong>${member.person}</strong>${role ? ` - ${role}` : ''}</li>`;
            });
            html += `</ul></div>`;
        }

        if (group.bio || group.description) {
            html += `<div class="info-section"><h4>Biography</h4><p>${group.bio || group.description}</p></div>`;
        }

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

        if (person.photo) {
            html += `<div class="info-photo"><img src="${person.photo}" alt="${person.name}" /></div>`;
        }

        if (person.city) {
            html += `<p class="info-meta"><strong>Location:</strong> ${person.city}</p>`;
        }

        if (person.groups && person.groups.length > 0) {
            html += `<div class="info-section"><h4>Groups</h4><ul class="info-list">`;
            person.groups.forEach(group => {
                const role = group.role || '';
                html += `<li><strong>${group.group}</strong>${role ? ` - ${role}` : ''}</li>`;
            });
            html += `</ul></div>`;
        }

        if (person.bio) {
            html += `<div class="info-section"><h4>Biography</h4><p>${person.bio}</p></div>`;
        }

        if (person.trivia) {
            html += `<div class="info-section"><h4>Trivia</h4><p>${person.trivia}</p></div>`;
        }

        contentElement.innerHTML = html;
    }

    /**
     * Load graph data from API.
     * Stores raw {nodes, edges} for later dynamic merging, then transforms to JIT.
     */
    async loadGraphData() {
        try {
            console.log('Loading graph data...');
            this.rawGraph = await this.api.fetchInitialGraphRaw();

            console.log('Graph data loaded:', this.rawGraph);

            const jit = this.api.transformToJIT(this.rawGraph);
            this.ht.loadJSON(jit);
            this.ht.refresh();
            this.syncZoomSlider();
            this.updateHistoryCount();

            console.log('Graph rendered');
        } catch (error) {
            console.error('Failed to load graph data:', error);
        }
    }

    // ========== View controls (wired from visualization.html) ==========

    /**
     * Center the view back to the root node
     */
    centerView() {
        if (!this.ht) return;
        const root = this.ht.root;
        if (root) {
            this.ht.onClick(root, {
                onComplete: () => {
                    console.log('View centered');
                }
            });
        }
    }

    /**
     * Toggle full-name label visibility
     */
    toggleLabels() {
        this.labelsVisible = !this.labelsVisible;
        if (this.ht) {
            this.ht.plot();
        }
    }

    /**
     * Set zoom level
     * @param {number} value - Zoom factor (0.5 to 2.0)
     */
    setZoom(value) {
        if (!this.ht || !this.ht.canvas) return;

        const canvas = this.ht.canvas;

        // Absolute zoom (JIT handles ratio internally)
        canvas.setZoom(value, value, true); // disablePlot=true (we plot once below)
        this.ht.plot();

        this.syncZoomSlider(); // keep UI consistent
    }

    /**
     * Sync the zoom slider UI element with the current canvas zoom level.
     * Called after programmatic zoom changes and mouse wheel zoom.
     */
    syncZoomSlider() {
        if (!this.ht || !this.ht.canvas) return;
        const slider = document.getElementById('zoom-slider');
        if (!slider) return;

        const z = this.ht.canvas.getZoom().x; // Complex(x,y), use x
        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);

        // Clamp in case wheel zoom exceeds slider range
        const clamped = Math.max(min, Math.min(max, z));
        slider.value = String(clamped);
    }

    /**
     * Refresh the visualization
     */
    refresh() {
        if (this.ht) {
            this.ht.refresh();
        }
    }

    // ========== History panel ==========

    /**
     * Update the history count badge in the top bar
     */
    updateHistoryCount() {
        const el = document.getElementById('history-count');
        if (el) {
            el.textContent = String(this.pathTracker.getBrowseHistory().length);
        }
    }

    /**
     * Toggle the history panel open/closed
     */
    toggleHistoryPanel() {
        this.historyPanelOpen = !this.historyPanelOpen;
        const panel = document.getElementById('history-panel');
        if (!panel) return;

        if (this.historyPanelOpen) {
            panel.style.display = 'flex';
            this.renderHistoryPanel();
        } else {
            panel.style.display = 'none';
        }
    }

    /**
     * Render the history panel list from browse history data
     */
    renderHistoryPanel() {
        const list = document.getElementById('history-list');
        if (!list) return;

        const history = this.pathTracker.getBrowseHistory();
        if (history.length === 0) {
            list.innerHTML = '<li class="history-empty">No history yet</li>';
            return;
        }

        list.innerHTML = history.map(item => {
            const typeLabel = (item.type || 'unknown').toLowerCase();
            const time = new Date(item.timestamp);
            const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const name = this.escapeHtml(item.name || 'Unknown');
            return `<li class="history-item" data-node-id="${this.escapeHtml(item.nodeId)}" data-node-type="${this.escapeHtml(typeLabel)}">
                <span class="history-type-badge history-type-${typeLabel}">${typeLabel}</span>
                <span class="history-name">${name}</span>
                <span class="history-time">${timeStr}</span>
            </li>`;
        }).join('');

        // Attach click handlers
        list.querySelectorAll('.history-item').forEach(li => {
            li.addEventListener('click', () => {
                const nodeId = li.dataset.nodeId;
                this.navigateToNodeId(nodeId);
            });
        });
    }

    /**
     * Escape HTML to prevent XSS in dynamic content
     * @param {string} str
     * @returns {string}
     */
    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ========== Missing-node navigation ==========

    /**
     * Navigate to a node by ID, loading its neighborhood if missing from the graph.
     * @param {string} nodeId
     */
    async navigateToNodeId(nodeId) {
        if (!this.ht) return;

        // Try to find node in current graph
        let node = this.ht.graph.getNode(nodeId);
        if (node) {
            this.handleNodeClick(node);
            return;
        }

        // Node missing — fetch neighborhood, merge, reload
        console.log('Node not in graph, fetching neighborhood:', nodeId);
        try {
            await this.ensureNodeInGraph(nodeId);
            node = this.ht.graph.getNode(nodeId);
            if (node) {
                this.handleNodeClick(node);
            } else {
                console.warn('Node still missing after neighborhood fetch:', nodeId);
            }
        } catch (error) {
            console.error('Failed to load neighborhood for node:', nodeId, error);
        }
    }

    /**
     * Fetch a node's neighborhood subgraph and merge it into the current graph.
     * Reloads the Hypertree from the merged raw data.
     * @param {string} nodeId
     */
    async ensureNodeInGraph(nodeId) {
        const sub = await this.api.fetchNeighborhoodRaw(nodeId);
        if (!sub || !sub.nodes || sub.nodes.length === 0) {
            console.warn('Neighborhood returned no data for:', nodeId);
            return;
        }

        this.rawGraph = this.api.mergeRawGraph(this.rawGraph, sub);

        // Cap graph size to prevent runaway growth
        if (this.rawGraph.nodes.length > 500) {
            console.log('Graph exceeds 500 nodes, replacing with neighborhood only');
            this.rawGraph = sub;
        }

        const jit = this.api.transformToJIT(this.rawGraph);
        this.ht.loadJSON(jit);
        this.ht.refresh();
    }

    /**
     * Destroy the visualization and clean up
     */
    destroy() {
        if (this.container) {
            this.container.innerHTML = '';
        }
    }
}

// Export singleton instance creator
export function createMusicGraph(containerId) {
    return new MusicGraph(containerId);
}
