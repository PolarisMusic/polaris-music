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
import { LikeManager } from './LikeManager.js';
import { ClaimManager } from './ClaimManager.js';
import { ReleaseOrbitOverlay } from './ReleaseOrbitOverlay.js';

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
        this.likeManager = new LikeManager(this.walletManager, this.pathTracker);
        this.claimManager = new ClaimManager(this.walletManager);
        this.releaseOverlay = new ReleaseOrbitOverlay({
            api: this.api,
            onReleaseSelect: (details) => this._onOverlayReleaseSelect(details),
            onGuestClick: (personId) => this.navigateToNodeId(personId)
        });

        // State tracking
        this.hoveredNode = null;
        this.selectedNode = null;
        this.labelsVisible = true;
        this.historyPanelOpen = false;
        this.favoritesPanelOpen = false;
        this.curatePanelOpen = false;

        // On-chain favorites state
        this.chainFavorites = new Set();
        this.chainFavoritesLoaded = false;
        this.hashIndex = new Map();

        // Raw graph model for dynamic merging (populated in loadGraphData)
        this.rawGraph = null;

        // Poincaré distance threshold for showing full-name tooltip
        this.labelProximityThreshold = 0.64;

        // Long-press pan state (replaces JIT's built-in panning to prevent
        // micro-drags from swallowing node clicks)
        this.PAN_HOLD_MS = 900;
        this._pan = {
            isDown: false,
            isPanning: false,
            suppressNextClick: false,
            timer: null,
            lastPos: null,
            latestPos: null,
            raf: null
        };

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
                    if (this._pan && this._pan.suppressNextClick) {
                        this._pan.suppressNextClick = false;
                        return;
                    }
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
                    // Wheel zoom disabled (controls removed)
                }
            },

            // Animation settings
            duration: 700,
            transition: $jit.Trans.Quart.easeInOut,

            levelDistance: 100,

            // Navigation – panning disabled; replaced by long-press pan
            Navigation: {
                enable: true,
                panning: false,
                zooming: false
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

        this.setupLongPressPan();
        this._isolateInfoPanelScroll();
        window.addEventListener('resize', () => this._updateOverlayPosition());
        console.log('Hypertree initialized');
    }

    /**
     * Wire up long-press panning on the canvas element.
     * Hold ~900ms then drag to pan; quick clicks pass through to node selection.
     */
    setupLongPressPan() {
        if (!this.ht || !this.ht.canvas) return;
        const el = this.ht.canvas.getElement();
        if (!el) return;

        el.addEventListener('mousedown', (e) => this.onPanMouseDown(e));
        el.addEventListener('mousemove', (e) => this.onPanMouseMove(e));
        window.addEventListener('mouseup', (e) => this.onPanMouseUp(e));
        el.addEventListener('mouseleave', (e) => this.onPanMouseUp(e));
    }

    /**
     * Prevent wheel/touch events inside the info panel from reaching the graph canvas.
     */
    _isolateInfoPanelScroll() {
        const infoContent = document.getElementById('info-content');
        if (!infoContent) return;
        infoContent.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
        infoContent.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
    }

    eventToCanvasPos(e) {
        const canvas = this.ht.canvas;
        const s = canvas.getSize();
        const p = canvas.getPos();
        const ox = canvas.translateOffsetX;
        const oy = canvas.translateOffsetY;
        const sx = canvas.scaleOffsetX;
        const sy = canvas.scaleOffsetY;

        const pos = $jit.util.event.getPos(e, window);
        return {
            x: (pos.x - p.x - s.width / 2 - ox) * (1 / sx),
            y: (pos.y - p.y - s.height / 2 - oy) * (1 / sy)
        };
    }

    onPanMouseDown(e) {
        if (e.button !== 0) return;
        this._pan.isDown = true;
        this._pan.isPanning = false;
        this._pan.suppressNextClick = false;

        const pos = this.eventToCanvasPos(e);
        this._pan.latestPos = pos;
        this._pan.lastPos = pos;

        clearTimeout(this._pan.timer);
        this._pan.timer = setTimeout(() => {
            if (!this._pan.isDown) return;
            this._pan.isPanning = true;
            this._pan.suppressNextClick = true;
            this.ht.canvas.getElement().classList.add('grabbing');
        }, this.PAN_HOLD_MS);
    }

    onPanMouseMove(e) {
        if (!this._pan.isDown) return;
        this._pan.latestPos = this.eventToCanvasPos(e);

        if (!this._pan.isPanning) return;

        e.preventDefault();
        e.stopPropagation();

        const pos = this._pan.latestPos;
        const last = this._pan.lastPos;
        const dx = pos.x - last.x;
        const dy = pos.y - last.y;

        if (dx === 0 && dy === 0) return;

        this.ht.canvas.translate(dx, dy, true);
        this._pan.lastPos = pos;

        if (!this._pan.raf) {
            this._pan.raf = requestAnimationFrame(() => {
                this.ht.plot();
                this._updateOverlayPosition();
                this._pan.raf = null;
            });
        }
    }

    onPanMouseUp(e) {
        if (!this._pan.isDown) return;

        clearTimeout(this._pan.timer);
        this._pan.timer = null;

        if (this._pan.isPanning) {
            this.ht.canvas.getElement().classList.remove('grabbing');
            this._pan.isPanning = false;
        }

        this._pan.isDown = false;
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

        // Update favorite star state
        this.updateFavoriteButton();

        // Center on node
        this.ht.onClick(node.id, {
            onComplete: () => {
                this.updateInfoPanel(node);
                this._syncReleaseOverlay(node);
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
                this.renderGroupDetails(details, infoTitle, infoContent, nodeId);
            } else if (typeLower === 'person') {
                this.renderPersonDetails(details, infoTitle, infoContent, nodeId);
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
    renderGroupDetails(group, titleElement, contentElement, nodeId) {
        titleElement.textContent = group.name || group.group_name || 'Unknown Group';

        const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        let html = '';

        if (group.photo) {
            html += `<div class="info-photo"><img src="${esc(group.photo)}" alt="${esc(group.name)}" /></div>`;
        }
        html += this._editableRow('group', nodeId, 'photo', group.photo || '', 'Photo URL');

        const formed = group.formed_date || '';
        const disbanded = group.disbanded_date || 'present';
        if (formed) {
            html += `<p class="info-meta"><strong>Active:</strong> ${esc(formed)}\u2013${esc(disbanded)}</p>`;
        }

        // Show inferred active range from release dates when claimed dates are missing
        const inferFirst = group.inferred_first_release_date;
        const inferLast = group.inferred_last_release_date;
        if (inferFirst && !formed) {
            const inferRange = inferLast && inferLast !== inferFirst
                ? `${esc(inferFirst)}\u2013${esc(inferLast)}`
                : esc(inferFirst);
            html += `<p class="info-meta info-inferred"><strong>Active (from releases):</strong> ${inferRange}</p>`;
        }
        html += this._editableRow('group', nodeId, 'formed_date', formed, 'Formed');
        html += this._editableRow('group', nodeId, 'disbanded_date', group.disbanded_date || '', 'Disbanded');

        if (group.members && group.members.length > 0) {
            html += `<div class="info-section"><h4>Members</h4><ul class="info-list">`;
            group.members.forEach(member => {
                const role = member.role || '';
                html += `<li><strong>${esc(member.person)}</strong>${role ? ` - ${esc(role)}` : ''}</li>`;
            });
            html += `</ul></div>`;
        }

        if (group.bio || group.description) {
            html += `<div class="info-section"><h4>Biography</h4><p>${esc(group.bio || group.description)}</p></div>`;
        }
        html += this._editableRow('group', nodeId, 'bio', group.bio || group.description || '', 'Biography', true);

        if (group.trivia) {
            html += `<div class="info-section"><h4>Trivia</h4><p>${esc(group.trivia)}</p></div>`;
        }
        html += this._editableRow('group', nodeId, 'trivia', group.trivia || '', 'Trivia', true);

        contentElement.innerHTML = html;
        this._attachEditListeners(contentElement);
    }

    /**
     * Render Person details in info panel
     */
    renderPersonDetails(person, titleElement, contentElement, nodeId) {
        titleElement.textContent = person.name || person.person_name || 'Unknown Person';

        const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        let html = '';

        if (person.photo) {
            html += `<div class="info-photo"><img src="${esc(person.photo)}" alt="${esc(person.name)}" /></div>`;
        }
        html += this._editableRow('person', nodeId, 'photo', person.photo || '', 'Photo URL');

        const currentColor = person.color || '#888888';
        html += `<div class="info-color-row">
            <strong>Color:</strong>
            <span class="info-color-swatch" style="background:${esc(currentColor)}"></span>
            <span class="info-color-hex">${esc(currentColor)}</span>
            <input type="color" class="color-picker-input" data-node-id="${esc(nodeId)}" value="${esc(currentColor)}" title="Edit color" />
        </div>`;

        if (person.city) {
            html += `<p class="info-meta"><strong>Location:</strong> ${esc(person.city)}</p>`;
        }
        html += this._editableRow('person', nodeId, 'city', person.city || '', 'City');

        if (person.groups && person.groups.length > 0) {
            html += `<div class="info-section"><h4>Groups</h4><ul class="info-list">`;
            person.groups.forEach(group => {
                const role = group.role || '';
                html += `<li><strong>${esc(group.group)}</strong>${role ? ` - ${esc(role)}` : ''}</li>`;
            });
            html += `</ul></div>`;
        }

        if (person.bio) {
            html += `<div class="info-section"><h4>Biography</h4><p>${esc(person.bio)}</p></div>`;
        }
        html += this._editableRow('person', nodeId, 'bio', person.bio || '', 'Biography', true);

        if (person.trivia) {
            html += `<div class="info-section"><h4>Trivia</h4><p>${esc(person.trivia)}</p></div>`;
        }
        html += this._editableRow('person', nodeId, 'trivia', person.trivia || '', 'Trivia', true);

        contentElement.innerHTML = html;
        this._attachEditListeners(contentElement);
        this._attachColorPickerListeners(contentElement);
    }

    /**
     * Attach change listeners to color picker inputs.
     * On change, submits the new color via ClaimManager.
     * @private
     */
    _attachColorPickerListeners(container) {
        container.querySelectorAll('.color-picker-input').forEach(picker => {
            picker.addEventListener('change', async (e) => {
                const newColor = e.target.value;
                const pickerNodeId = picker.dataset.nodeId;
                try {
                    await this.claimManager.submitEdit('person', pickerNodeId, 'color', newColor);
                    // Update swatch and hex display immediately
                    const row = picker.closest('.info-color-row');
                    if (row) {
                        const swatch = row.querySelector('.info-color-swatch');
                        const hex = row.querySelector('.info-color-hex');
                        if (swatch) swatch.style.background = newColor;
                        if (hex) hex.textContent = newColor;
                    }
                    // Update the graph node color via JIT API for immediate visual feedback
                    if (this.selectedNode) {
                        this.selectedNode.setData('color', newColor);
                        if (this.ht) this.ht.plot();
                    }
                    // Patch rawGraph so merges don't revert the color
                    if (this.rawGraph && this.rawGraph.nodes) {
                        const rawNode = this.rawGraph.nodes.find(n => n.id === pickerNodeId);
                        if (rawNode) rawNode.color = newColor;
                    }
                } catch (error) {
                    console.error('Color edit failed:', error);
                    alert('Color edit failed: ' + error.message);
                }
            });
        });
    }

    // ========== Release orbit overlay integration ==========

    /**
     * Convert a JIT node's Poincaré position to viewport screen coordinates.
     * @param {Object} node - JIT graph node
     * @returns {{x: number, y: number, dim: number}} Screen position and visual radius
     */
    _getNodeScreenPos(node) {
        const canvas = this.ht.canvas;
        const size = canvas.getSize();
        const pos = canvas.getPos();
        const ox = canvas.translateOffsetX;
        const oy = canvas.translateOffsetY;
        const sx = canvas.scaleOffsetX;
        const sy = canvas.scaleOffsetY;

        const p = node.pos.getc();
        const sqNorm = p.squaredNorm();
        // $scale mutates in place, so use the result directly for screen calc
        const scaledX = p.x * node.scale;
        const scaledY = p.y * node.scale;

        const screenX = pos.x + size.width / 2 + ox + scaledX * sx;
        const screenY = pos.y + size.height / 2 + oy + scaledY * sy;

        // Compute visual dimension (same transform as node renderer)
        let dim = node.getData('dim') || 9;
        if (this.ht.config.Node.transform) {
            dim = dim * (1 - sqNorm);
        }

        return { x: screenX, y: screenY, dim };
    }

    /**
     * Show or hide the release orbit overlay based on node type.
     * @param {Object} node - Selected JIT graph node
     */
    async _syncReleaseOverlay(node) {
        const nodeType = (node.data.type || '').toLowerCase();

        if (nodeType !== 'group') {
            this.releaseOverlay.hide();
            return;
        }

        const groupId = node.data.group_id || node.id;
        const { x, y, dim } = this._getNodeScreenPos(node);

        // Account for donut ring outer radius
        const slices = node.getData('donutSlices');
        let visualRadius = dim;
        if (slices && slices.length > 0) {
            const gap = Math.max(2, dim * 0.20);
            const thickness = Math.max(3, dim * 0.45);
            visualRadius = dim + gap + thickness;
        }

        // Convert to overlay-relative coordinates (overlay is positioned inside viz-container)
        const vizContainer = document.getElementById('viz-container');
        const vizRect = vizContainer ? vizContainer.getBoundingClientRect() : { left: 0, top: 0 };
        const relX = x - vizRect.left;
        const relY = y - vizRect.top;

        await this.releaseOverlay.show(groupId, { x: relX, y: relY }, visualRadius);
    }

    /**
     * Update overlay position (called after graph re-render).
     */
    _updateOverlayPosition() {
        if (!this.releaseOverlay.visible || !this.selectedNode) return;
        const { x, y, dim } = this._getNodeScreenPos(this.selectedNode);

        const slices = this.selectedNode.getData('donutSlices');
        let visualRadius = dim;
        if (slices && slices.length > 0) {
            const gap = Math.max(2, dim * 0.20);
            const thickness = Math.max(3, dim * 0.45);
            visualRadius = dim + gap + thickness;
        }

        const vizContainer = document.getElementById('viz-container');
        const vizRect = vizContainer ? vizContainer.getBoundingClientRect() : { left: 0, top: 0 };
        const relX = x - vizRect.left;
        const relY = y - vizRect.top;

        this.releaseOverlay.updatePosition({ x: relX, y: relY }, visualRadius);
    }

    /**
     * Callback when a release is selected/deselected in the overlay.
     * @param {Object|null} releaseDetails - Full release data or null to restore group view
     */
    _onOverlayReleaseSelect(releaseDetails) {
        if (!releaseDetails) {
            // Restore group info panel
            if (this.selectedNode) {
                this.updateInfoPanel(this.selectedNode);
            }
            return;
        }

        this.showReleaseDetailsInInfoPanel(releaseDetails);
    }

    /**
     * Display release details in the info viewer (called from overlay).
     * @param {Object} release - Release details from API
     */
    showReleaseDetailsInInfoPanel(release) {
        const infoTitle = document.getElementById('info-title');
        const infoContent = document.getElementById('info-content');
        if (!infoTitle || !infoContent) return;

        this.renderReleaseDetails(release, infoTitle, infoContent);
    }

    /**
     * Render Release details in info panel
     */
    renderReleaseDetails(release, titleElement, contentElement) {
        titleElement.textContent = release.name || 'Unknown Release';

        const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        let html = '';

        if (release.album_art) {
            html += `<div class="info-photo"><img src="${esc(release.album_art)}" alt="${esc(release.name)}" /></div>`;
        }

        if (release.release_date) {
            html += `<p class="info-meta"><strong>Released:</strong> ${esc(release.release_date)}</p>`;
        }

        if (release.format) {
            html += `<p class="info-meta"><strong>Format:</strong> ${esc(release.format)}</p>`;
        }

        // Labels
        if (release.labels && release.labels.length > 0) {
            html += `<p class="info-meta"><strong>Label:</strong> ${release.labels.map(l => esc(l.label || l.name)).join(', ')}</p>`;
        }

        // Groups
        if (release.groups && release.groups.length > 0) {
            html += `<div class="info-section"><h4>Performed by</h4><ul class="info-list">`;
            release.groups.forEach(g => {
                html += `<li><strong>${esc(g.name)}</strong></li>`;
            });
            html += `</ul></div>`;
        }

        // Tracks
        if (release.tracks && release.tracks.length > 0) {
            html += `<div class="info-section"><h4>Tracks</h4><ol class="info-list info-tracklist">`;
            const sorted = [...release.tracks].sort((a, b) => {
                const da = (a.disc_number || 1);
                const db = (b.disc_number || 1);
                if (da !== db) return da - db;
                return (a.track_number || 0) - (b.track_number || 0);
            });
            sorted.forEach(t => {
                const side = t.side ? `${esc(t.side)}-` : '';
                const num = t.track_number ? `${side}${t.track_number}. ` : '';
                html += `<li>${num}${esc(t.track || t.title || 'Untitled')}</li>`;
            });
            html += `</ol></div>`;
        }

        // Guests
        if (release.guests && release.guests.length > 0) {
            html += `<div class="info-section"><h4>Guests</h4><ul class="info-list">`;
            release.guests.forEach(g => {
                const roles = g.roles && g.roles.length > 0 ? ` - ${g.roles.map(r => esc(r)).join(', ')}` : '';
                html += `<li><strong>${esc(g.name)}</strong>${roles}</li>`;
            });
            html += `</ul></div>`;
        }

        if (release.liner_notes) {
            html += `<div class="info-section"><h4>Liner Notes</h4><p>${esc(release.liner_notes)}</p></div>`;
        }

        contentElement.innerHTML = html;
    }

    /**
     * Build HTML for an editable property row with an edit button.
     * @private
     */
    _editableRow(nodeType, nodeId, field, currentValue, label, isTextarea = false) {
        const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        return `<button class="edit-btn" data-node-type="${esc(nodeType)}" data-node-id="${esc(nodeId)}" data-field="${esc(field)}" data-current-value="${esc(currentValue)}" data-textarea="${isTextarea}" title="Edit ${esc(label)}">&#9998; ${esc(label)}</button> `;
    }

    /**
     * Attach click listeners to .edit-btn buttons inside a container.
     * Opens an inline editor; on save, submits via ClaimManager.
     * @private
     */
    _attachEditListeners(container) {
        container.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const { nodeType, nodeId, field, currentValue, textarea } = btn.dataset;
                this._openInlineEditor(btn, nodeType, nodeId, field, currentValue, textarea === 'true');
            });
        });
    }

    /**
     * Replace an edit button with an inline editor (input or textarea).
     * @private
     */
    _openInlineEditor(btn, nodeType, nodeId, field, currentValue, useTextarea) {
        const wrapper = document.createElement('div');
        wrapper.className = 'inline-edit-wrapper';

        const input = document.createElement(useTextarea ? 'textarea' : 'input');
        input.className = 'inline-edit-input';
        input.value = currentValue;
        if (!useTextarea) input.type = 'text';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'inline-edit-save';
        saveBtn.textContent = 'Save';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'inline-edit-cancel';
        cancelBtn.textContent = 'Cancel';

        wrapper.appendChild(input);
        wrapper.appendChild(saveBtn);
        wrapper.appendChild(cancelBtn);

        btn.replaceWith(wrapper);
        input.focus();

        cancelBtn.addEventListener('click', () => {
            wrapper.replaceWith(btn);
            this._attachEditListeners(btn.parentElement);
        });

        saveBtn.addEventListener('click', async () => {
            const newValue = input.value;
            if (newValue === currentValue) {
                wrapper.replaceWith(btn);
                this._attachEditListeners(btn.parentElement);
                return;
            }

            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';

            try {
                await this.claimManager.submitEdit(nodeType, nodeId, field, newValue);

                // Re-fetch and re-render the panel
                if (this.selectedNode) {
                    await this.updateInfoPanel(this.selectedNode);
                }
            } catch (error) {
                console.error('Edit submission failed:', error);
                alert('Edit failed: ' + error.message);
                wrapper.replaceWith(btn);
                this._attachEditListeners(btn.parentElement);
            }
        });
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
            await this.rebuildHashIndexFromRawGraph();

            console.log('Graph rendered');
        } catch (error) {
            console.error('Failed to load graph data:', error);
        }
    }

    /**
     * Build a local checksum256 → {nodeId, name, type} index from the raw graph.
     * Used to map on-chain like hashes back to displayable node info.
     */
    async rebuildHashIndexFromRawGraph() {
        if (!this.rawGraph?.nodes || !this.likeManager) return;
        this.hashIndex.clear();

        const pairs = await Promise.all(this.rawGraph.nodes.map(async (n) => {
            const h = await this.likeManager.nodeIdToChecksum256(n.id);
            return [h, { nodeId: n.id, name: n.name, type: n.type }];
        }));

        for (const [h, meta] of pairs) this.hashIndex.set(h, meta);
    }

    // ========== View controls (wired from visualization.html) ==========

    /**
     * Center the view back to the root node
     */
    centerView() {
        if (!this.ht) return;
        this.releaseOverlay.hide();
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
     * Set Hypertree geometry offset (controls hyperbolic compactness).
     * @param {number} value - Offset in [0, 1)
     */
    setGeometryOffset(value) {
        if (!this.ht) return;
        this.ht.config.offset = value;

        const focusId = this.selectedNode?.id || this.ht.root;
        this.ht.refresh();
        if (focusId) {
            this.ht.onClick(focusId, {
                onComplete: () => this.updateInfoPanel(this.ht.graph.getNode(focusId))
            });
        } else {
            this.ht.plot();
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

    /**
     * Clear browse history and refresh the panel/count
     */
    clearHistory() {
        this.pathTracker.clearBrowseHistory();
        this.updateHistoryCount();
        if (this.historyPanelOpen) {
            this.renderHistoryPanel();
        }
    }

    // ========== Favorites / Like ==========

    /**
     * Update the star button to reflect on-chain like state for the selected node
     */
    async updateFavoriteButton() {
        const btn = document.getElementById('node-favorite');
        if (!btn) return;

        if (!this.selectedNode) {
            btn.textContent = '\u2606';
            btn.classList.remove('liked');
            return;
        }

        const hash = await this.likeManager.nodeIdToChecksum256(this.selectedNode.id);
        const liked = this.chainFavorites.has(hash);

        btn.textContent = liked ? '\u2605' : '\u2606';
        btn.classList.toggle('liked', liked);
    }

    /**
     * Like the currently selected node (requires wallet connection)
     */
    async likeSelectedNode() {
        if (!this.selectedNode) return;

        if (!this.walletManager?.isConnected()) {
            alert('Connect wallet to like nodes.');
            return;
        }

        if (!this.chainFavoritesLoaded) {
            await this.refreshFavoritesFromChain();
        }

        const node = this.selectedNode;
        const nodeHash = await this.likeManager.nodeIdToChecksum256(node.id);

        if (this.chainFavorites.has(nodeHash)) {
            return;
        }

        await this.likeManager.likeNode(node.id, { name: node.name, type: node.data?.type }, true);

        this.chainFavorites.add(nodeHash);
        this.chainFavoritesLoaded = true;
        this.updateFavoritesCount();
        await this.updateFavoriteButton();

        if (this.favoritesPanelOpen) await this.renderFavoritesPanel();
    }

    updateFavoritesCount() {
        const el = document.getElementById('favorites-count');
        if (el) el.textContent = String(this.chainFavorites.size);
    }

    async refreshFavoritesFromChain() {
        const rows = await this.likeManager.fetchAccountLikes(200);
        this.chainFavorites = new Set(rows.map(r => r.node_id));
        this.chainFavoritesLoaded = true;
        this.updateFavoritesCount();
        return rows;
    }

    toggleFavoritesPanel() {
        this.favoritesPanelOpen = !this.favoritesPanelOpen;
        const panel = document.getElementById('favorites-panel');
        if (!panel) return;

        if (this.favoritesPanelOpen) {
            panel.style.display = 'flex';
            this.renderFavoritesPanel();
        } else {
            panel.style.display = 'none';
        }
    }

    async renderFavoritesPanel() {
        const list = document.getElementById('favorites-list');
        if (!list) return;

        if (!this.walletManager?.isConnected()) {
            list.innerHTML = '<li class="history-empty">Login to see your favorites.</li>';
            return;
        }

        list.innerHTML = '<li class="history-empty">Loading favorites...</li>';

        try {
            const rows = await this.refreshFavoritesFromChain();

            if (!rows.length) {
                list.innerHTML = '<li class="history-empty">No favorites yet.</li>';
                return;
            }

            list.innerHTML = rows.map(r => {
                const meta = this.hashIndex.get(r.node_id);
                const name = meta?.name || (r.node_id.slice(0, 8) + '\u2026');
                const nodeId = meta?.nodeId || '';
                const type = (meta?.type || 'unknown').toLowerCase();

                const disabled = nodeId ? '' : ' style="opacity:0.6; cursor:not-allowed;" ';
                return `<li class="history-item" ${disabled} data-node-id="${this.escapeHtml(nodeId)}">
                    <span class="history-type-badge history-type-${type}">${type}</span>
                    <span class="history-name">${this.escapeHtml(name)}</span>
                    <span class="history-time"></span>
                </li>`;
            }).join('');

            list.querySelectorAll('.history-item').forEach(li => {
                const nodeId = li.dataset.nodeId;
                if (!nodeId) return;
                li.addEventListener('click', () => this.navigateToNodeId(nodeId));
            });
        } catch (error) {
            console.error('Failed to load favorites:', error);
            list.innerHTML = '<li class="history-empty">Failed to load favorites.</li>';
        }
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
        await this.rebuildHashIndexFromRawGraph();
    }

    // ========== Curate Panel ==========

    toggleCuratePanel() {
        this.curatePanelOpen = !this.curatePanelOpen;
        const panel = document.getElementById('curate-panel');
        if (!panel) return;

        if (this.curatePanelOpen) {
            panel.style.display = 'flex';
            this.renderCuratePanel();
        } else {
            panel.style.display = 'none';
        }
    }

    async renderCuratePanel() {
        const list = document.getElementById('curate-list');
        if (!list) return;

        list.innerHTML = '<div class="history-empty">Loading operations...</div>';

        try {
            const resp = await this.api.fetchCurateOperations({ limit: 50 });
            if (!resp.success || !resp.operations || resp.operations.length === 0) {
                list.innerHTML = '<div class="history-empty">No operations found.</div>';
                return;
            }

            list.innerHTML = '';
            for (const op of resp.operations) {
                list.appendChild(this._renderCurateRow(op));
            }
        } catch (e) {
            console.error('Failed to render curate panel:', e);
            list.innerHTML = '<div class="history-empty">Failed to load operations.</div>';
        }
    }

    _renderCurateRow(op) {
        const row = document.createElement('div');
        row.className = 'curate-row';

        // Event type label
        const typeNames = {
            21: 'Release', 30: 'Add Claim', 31: 'Edit Claim',
            40: 'Vote', 41: 'Like', 50: 'Finalize', 60: 'Merge'
        };
        const typeName = typeNames[op.type] || `Type ${op.type}`;

        // Summary text
        const summary = op.event_summary;
        let title = summary?.release_name || summary?.group_name || op.hash.substring(0, 12) + '...';

        // Time
        const ts = op.ts ? new Date(op.ts + 'Z') : null;
        const timeStr = ts ? ts.toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';

        // Tally
        const tally = op.tally || { up_weight: 0, down_weight: 0, up_voter_count: 0, down_voter_count: 0 };
        const netScore = tally.up_weight - tally.down_weight;

        // Status
        const statusClass = op.finalized ? 'curate-status--finalized' : '';
        const statusLabel = op.finalized ? 'Finalized' : 'Open';

        row.innerHTML = `
            <div class="curate-row__header">
                <span class="curate-type-badge curate-type-${op.type}">${typeName}</span>
                <span class="curate-row__title">${this._escapeHtml(title)}</span>
                <span class="curate-row__time">${timeStr}</span>
            </div>
            <div class="curate-row__author">by ${this._escapeHtml(op.author)}</div>
            <div class="curate-row__tally">
                <span class="curate-score ${netScore > 0 ? 'curate-score--positive' : netScore < 0 ? 'curate-score--negative' : ''}">
                    ${netScore > 0 ? '+' : ''}${netScore}
                </span>
                <span class="curate-voters">
                    <span class="curate-up">${tally.up_weight} (${tally.up_voter_count})</span>
                    /
                    <span class="curate-down">${tally.down_weight} (${tally.down_voter_count})</span>
                </span>
                <span class="curate-status ${statusClass}">${statusLabel}</span>
            </div>
            <div class="curate-row__actions"></div>
        `;

        // Vote buttons (only if not finalized and wallet connected)
        if (!op.finalized) {
            const actionsDiv = row.querySelector('.curate-row__actions');
            const upBtn = document.createElement('button');
            upBtn.className = 'curate-vote-btn curate-vote-up';
            upBtn.textContent = 'Upvote';
            upBtn.addEventListener('click', () => this._curateVote(op, 1, row));

            const downBtn = document.createElement('button');
            downBtn.className = 'curate-vote-btn curate-vote-down';
            downBtn.textContent = 'Downvote';
            downBtn.addEventListener('click', () => this._curateVote(op, -1, row));

            actionsDiv.appendChild(upBtn);
            actionsDiv.appendChild(downBtn);
        }

        return row;
    }

    async _curateVote(op, val, rowEl) {
        if (!this.walletManager?.isConnected()) {
            alert('Please connect your wallet to vote.');
            return;
        }

        const session = this.walletManager.getSessionInfo();
        const contractAccount = this.walletManager.config.contractAccount;

        try {
            // Disable buttons while voting
            const btns = rowEl.querySelectorAll('.curate-vote-btn');
            btns.forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });

            await this.walletManager.transact({
                account: contractAccount,
                name: 'vote',
                authorization: [{
                    actor: session.accountName,
                    permission: session.permission
                }],
                data: {
                    voter: session.accountName,
                    hash: op.hash,
                    val: val
                }
            });

            // Refetch tally from chain and update row
            await this._refreshCurateRow(op, rowEl);
        } catch (e) {
            console.error('Vote failed:', e);
            alert('Vote failed: ' + (e.message || e));
            // Re-enable buttons
            const btns = rowEl.querySelectorAll('.curate-vote-btn');
            btns.forEach(b => { b.disabled = false; b.style.opacity = '1'; });
        }
    }

    async _refreshCurateRow(op, rowEl) {
        try {
            const contractAccount = this.walletManager.config.contractAccount;
            const tallyResp = await this.walletManager.getTableRows({
                code: contractAccount,
                scope: contractAccount,
                table: 'votetally',
                lower_bound: String(op.anchor_id),
                upper_bound: String(op.anchor_id),
                limit: 1
            });

            if (tallyResp.rows && tallyResp.rows[0]) {
                const t = tallyResp.rows[0];
                op.tally = {
                    up_weight: parseInt(t.up_weight) || 0,
                    down_weight: parseInt(t.down_weight) || 0,
                    up_voter_count: parseInt(t.up_voter_count) || 0,
                    down_voter_count: parseInt(t.down_voter_count) || 0
                };
            }

            // Replace the row DOM
            const newRow = this._renderCurateRow(op);
            rowEl.replaceWith(newRow);
        } catch (e) {
            console.error('Failed to refresh tally:', e);
            // Re-enable buttons as fallback
            const btns = rowEl.querySelectorAll('.curate-vote-btn');
            btns.forEach(b => { b.disabled = false; b.style.opacity = '1'; });
        }
    }

    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Destroy the visualization and clean up
     */
    destroy() {
        this.releaseOverlay.hide();
        if (this.container) {
            this.container.innerHTML = '';
        }
    }
}

// Export singleton instance creator
export function createMusicGraph(containerId) {
    return new MusicGraph(containerId);
}
