/**
 * MusicGraph - JIT Hypertree visualization for Polaris Music Registry
 *
 * Main visualization using JIT Hypertree for exploring the music graph.
 * Groups display donut rings showing member participation by track count.
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
import { InfoPanelRenderer } from './InfoPanelRenderer.js';
import { OverlayPositioner } from './OverlayPositioner.js';
import { FavoritesManager } from './FavoritesManager.js';
import { GraphDataLoader } from './GraphDataLoader.js';
import { DonutLoader } from './DonutLoader.js';
import { PanController } from './PanController.js';
import { InlineEditor } from './InlineEditor.js';
import { api as backendApi } from '../utils/api.js';

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
        this.infoPanel = new InfoPanelRenderer({
            attachNavLinkListeners: (container) => this._attachNavLinkListeners(container),
            navigateToRelease: (releaseId) => this._navigateToRelease(releaseId),
            selectCurateOperation: (op) => this._selectCurateOperation(op),
            voteFromDetail: (op, val) => this._curateVoteFromDetail(op, val)
        });
        this.overlayPositioner = new OverlayPositioner({
            releaseOverlay: this.releaseOverlay,
            callbacks: {
                getNodeScreenPos: (node) => this._getNodeScreenPos(node),
                getSelectedNode: () => this.selectedNode,
            },
        });

        // hashIndex: shared with FavoritesManager (read) and the loader
        // (clears+repopulates). Map ref stays stable across rebuilds.
        this.hashIndex = new Map();

        this.favorites = new FavoritesManager({
            walletManager: this.walletManager,
            likeManager: this.likeManager,
            hashIndex: this.hashIndex,
            callbacks: {
                escapeHtml: (s) => this.escapeHtml(s),
                navigate: (nodeId) => this.navigateToNodeId(nodeId),
            },
        });

        // State tracking
        this.hoveredNode = null;
        this.selectedNode = null;
        this.labelsVisible = true;
        this.historyPanelOpen = false;
        this.curatePanelOpen = false;

        // Concurrency-limited donut fetch queue (for on-demand loading).
        // `this.ht` is set by initializeHypertree() below; the callbacks
        // close over `this`, so they read the live reference at call time.
        this.donut = new DonutLoader({
            api: this.api,
            colorPalette: this.colorPalette,
            callbacks: {
                plot: () => this.ht?.plot(),
                eachNode: (cb) => this.ht?.graph?.eachNode(cb),
            },
        });

        // Image cache for node photos (keyed by URL)
        this._imageCache = new Map();

        // Poincaré distance threshold for showing full-name tooltip
        this.labelProximityThreshold = 0.64;

        // Hover tooltip timer (500ms delay before showing label on edge nodes)
        this._hoverTooltipTimer = null;

        // Long-press pan state (replaces JIT's built-in panning to prevent
        // micro-drags from swallowing node clicks). The getCanvas callback
        // resolves lazily — `this.ht` isn't set until initializeHypertree().
        this.panController = new PanController({
            getCanvas: () => this.ht?.canvas,
            callbacks: {
                plot: () => this.ht?.plot(),
                updateOverlayPosition: () => this.overlayPositioner.updateOverlayPosition(),
            },
        });

        // Inline editor (edit-button + color-picker flows). All callbacks
        // resolve lazily — `this.ht` and `this.loader` are set later.
        this.inlineEditor = new InlineEditor({
            claimManager: this.claimManager,
            callbacks: {
                getSelectedNode: () => this.selectedNode,
                refreshInfoPanel: (node) => this.updateInfoPanel(node),
                plot: () => this.ht?.plot(),
                patchRawGraphColor: (nodeId, color) => {
                    const raw = this.loader?.rawGraph;
                    if (!raw || !raw.nodes) return;
                    const rawNode = raw.nodes.find(n => n.id === nodeId);
                    if (rawNode) rawNode.color = color;
                },
            },
        });

        // Initialize the visualization
        this.initializeHypertree();

        // GraphDataLoader needs `this.ht` (set by initializeHypertree above)
        // so it must be constructed AFTER it.
        this.loader = new GraphDataLoader({
            api: this.api,
            likeManager: this.likeManager,
            hashIndex: this.hashIndex,
            callbacks: {
                loadJSON: (jit) => this.ht.loadJSON(jit),
                refresh: () => this.ht.refresh(),
                syncZoomSlider: () => this.syncZoomSlider(),
                updateHistoryCount: () => this.updateHistoryCount(),
                prePopulateDonutData: () => this.donut.prePopulateData(this.loader._initialParticipation),
            },
        });
    }

    /**
     * Get a cached Image for a URL, starting the load if needed.
     * Returns the Image if loaded, or null if still loading/failed.
     */
    _getCachedImage(url) {
        if (!url) return null;
        const entry = this._imageCache.get(url);
        if (entry) return entry.loaded ? entry.img : null; // covers loading and failed

        const img = new Image();
        // Skip crossOrigin to avoid CORS failures on servers that don't
        // send Access-Control-Allow-Origin. Without it we can still draw
        // the image (canvas becomes "tainted" but we don't read pixels).
        const record = { img, loaded: false };
        this._imageCache.set(url, record);
        img.onload = () => {
            record.loaded = true;
            if (this.ht) this.ht.plot();
        };
        img.onerror = () => {
            // Mark as permanently failed so we don't retry every render
            record.failed = true;
        };
        img.src = url;
        return null;
    }

    /**
     * Register custom Hypertree node types: circle-hover and group-donut
     */
    registerNodeTypes() {
        const musicGraph = this;
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
             * member participation (track counts). Slices are drawn
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

                        // Draw group photo inside circle if available
                        var photoUrl = node.data.photo;
                        if (photoUrl && dim > 3) {
                            var img = musicGraph._getCachedImage(photoUrl);
                            if (img) {
                                ctx.save();
                                ctx.beginPath();
                                ctx.arc(p.x, p.y, dim, 0, Math.PI * 2, false);
                                ctx.clip();
                                // Draw image centered and covering the circle
                                var size = dim * 2;
                                ctx.drawImage(img, p.x - dim, p.y - dim, size, size);
                                ctx.restore();
                            }
                        }

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

                        // Draw initials inside base circle (skip if photo is loaded)
                        var hasPhoto = photoUrl && musicGraph._imageCache.has(photoUrl) && musicGraph._imageCache.get(photoUrl).loaded;
                        if (dim > 3 && !hasPhoto) {
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
                    if (this.panController.consumeSuppressClick()) {
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

        this.panController.attach();
        this._isolateInfoPanelScroll();
        this._setupResizeObserver();
        window.addEventListener('resize', () => this._handleCanvasResize());
        requestAnimationFrame(() => this._handleCanvasResize());
        console.log('Hypertree initialized');
    }

    /**
     * Prevent wheel/touch events inside the info panel from reaching the graph canvas.
     * Attaches to the whole #info-viewer so scrolling over the header also works,
     * then forwards wheel deltas into the .info-content scroll container.
     */
    _isolateInfoPanelScroll() {
        // No-op. JIT listens for wheel events on the canvas element, not the
        // info panel. Native scrolling happens on #info-scroll without JS.
    }

    /**
     * Resize the JIT canvas to match the current container dimensions.
     * Called when the layout changes (e.g. mini-player appearing) so that
     * click hit-testing stays aligned with the visual node positions.
     */
    _handleCanvasResize() {
        if (!this.ht || !this.ht.canvas || !this.container) return;
        // Don't resize before graph data is loaded (no root node yet)
        if (!this.ht.graph || !this.ht.graph.getNode(this.ht.root)) return;

        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
        if (!width || !height) return;

        if (typeof this.ht.canvas.resize === 'function') {
            this.ht.canvas.resize(width, height);
        }

        this.ht.plot();
        this.overlayPositioner.updateOverlayPosition();
    }

    /**
     * Observe the graph container for size changes and re-sync the canvas.
     */
    _setupResizeObserver() {
        if (typeof ResizeObserver === 'undefined' || !this.container) return;

        this._resizeObserver = new ResizeObserver(() => {
            this._handleCanvasResize();
        });

        this._resizeObserver.observe(this.container);
    }

    /**
     * Create lightweight tooltip label for a node.
     * Full name is shown conditionally (hover, selected, near center).
     * Initials are drawn on canvas by the node type renderer.
     */
    createNodeLabel(domElement, node) {
        domElement.innerHTML = '';
        domElement.className = 'node-tooltip-label';

        const nodeType = (node.data.type || '').toLowerCase();

        // Hide label for synthetic root node
        if (nodeType === 'root') {
            domElement.style.display = 'none';
            return;
        }

        const name = node.name || '';

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
        // Hide label for synthetic root node
        if ((node.data.type || '').toLowerCase() === 'root') {
            domElement.style.display = 'none';
            return;
        }

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

        // Show tooltip when: selected, near center, or after 500ms hover delay.
        const isSelected = node.getData('isSelected');
        const sqNorm = node.pos.getc().squaredNorm();
        const isNearCenter = sqNorm < this.labelProximityThreshold;
        const hoverTooltip = node.getData('hoverTooltip');

        if (isSelected || isNearCenter || hoverTooltip) {
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

        const nodeType = (node.data.type || '').toLowerCase();

        // Synthetic root: invisible, minimal size, no donut
        if (nodeType === 'root') {
            node.setData('type', 'circle-hover');
            node.setData('dim', 1);
            node.setData('color', 'rgba(0,0,0,0)');
            return;
        }

        // Apply color/dim from data
        if (node.data.$color) {
            node.setData('color', node.data.$color);
        }
        if (node.data.$dim) {
            node.setData('dim', node.data.$dim);
        }

        // Group nodes use the group-donut renderer
        if (nodeType === 'group') {
            node.setData('type', 'group-donut');

            // Lazy-load participation data (only once) via concurrency-limited queue
            const donutStatus = node.getData('donutStatus');
            if (!donutStatus) {
                node.setData('donutStatus', 'loading');
                this.donut.enqueue(node);
            }
        } else {
            // All other nodes use circle-hover
            node.setData('type', 'circle-hover');
        }
    }

    /**
     * Style edges before rendering
     */
    styleEdge(adj) {
        if (!adj.nodeFrom || !adj.nodeTo) return;

        // Hide synthetic ROOT edges (invisible connectors for layout only)
        const edgeType = adj.data?.type || '';
        if (edgeType === 'ROOT') {
            adj.setData('color', 'rgba(0,0,0,0)');
            adj.setData('lineWidth', 0.01);
            return;
        }

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
        // Ignore clicks on synthetic root node
        if ((node.data.type || '').toLowerCase() === 'root') return;

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

        // Load mini-player queue based on node type
        this._loadPlayerQueue(node);

        // Hide release overlay immediately so tiles don't float during animation
        this.releaseOverlay.hide();

        // Center on node
        this.ht.onClick(node.id, {
            onComplete: () => {
                this.updateInfoPanel(node);
                this.overlayPositioner.syncReleaseOverlay(node);
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
                this.hoveredNode.setData('hoverTooltip', false);
            }
            node.setData('isHovered', true);
            this.hoveredNode = node;
            this.container.style.cursor = 'pointer';

            // Start 500ms timer to show tooltip for nodes near the edge
            clearTimeout(this._hoverTooltipTimer);
            this._hoverTooltipTimer = setTimeout(() => {
                if (this.hoveredNode && this.hoveredNode.id === node.id) {
                    node.setData('hoverTooltip', true);
                    if (this.ht) this.ht.plot();
                }
            }, 500);
        } else {
            clearTimeout(this._hoverTooltipTimer);
            node.setData('isHovered', false);
            node.setData('hoverTooltip', false);
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

        // Skip detail fetch for synthetic root node
        if ((node.data.type || '').toLowerCase() === 'root') {
            infoTitle.textContent = 'Select a node';
            infoContent.innerHTML = '<p class="placeholder">Click on a Group or Person to see details</p>';
            return;
        }

        const type = node.data.type || 'Unknown';
        const nodeId = node.id;

        infoTitle.textContent = node.name || 'Loading...';
        infoContent.innerHTML = '<p>Loading details...</p>';

        if (infoViewer) {
            infoViewer.style.removeProperty('display');
            infoViewer.classList.add('open');
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
        html += this.inlineEditor.editableRowHtml('group', nodeId, 'photo', group.photo || '', 'Photo URL');

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
        html += this.inlineEditor.editableRowHtml('group', nodeId, 'formed_date', formed, 'Formed');
        html += this.inlineEditor.editableRowHtml('group', nodeId, 'disbanded_date', group.disbanded_date || '', 'Disbanded');

        if (group.members && group.members.length > 0) {
            html += `<div class="info-section"><h4>Members</h4><ul class="info-list">`;
            group.members.forEach(member => {
                const role = member.role || '';
                const personId = member.person_id || '';
                if (personId) {
                    html += `<li><a href="#" class="info-nav-link" data-node-id="${esc(personId)}"><strong>${esc(member.person)}</strong></a>${role ? ` - ${esc(role)}` : ''}</li>`;
                } else {
                    html += `<li><strong>${esc(member.person)}</strong>${role ? ` - ${esc(role)}` : ''}</li>`;
                }
            });
            html += `</ul></div>`;
        }

        if (group.bio || group.description) {
            html += `<div class="info-section"><h4>Biography</h4><p>${esc(group.bio || group.description)}</p></div>`;
        }
        html += this.inlineEditor.editableRowHtml('group', nodeId, 'bio', group.bio || group.description || '', 'Biography', true);

        if (group.trivia) {
            html += `<div class="info-section"><h4>Trivia</h4><p>${esc(group.trivia)}</p></div>`;
        }
        html += this.inlineEditor.editableRowHtml('group', nodeId, 'trivia', group.trivia || '', 'Trivia', true);

        contentElement.innerHTML = html;
        this.inlineEditor.attach(contentElement);
        this._attachNavLinkListeners(contentElement);
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
        html += this.inlineEditor.editableRowHtml('person', nodeId, 'photo', person.photo || '', 'Photo URL');

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
        html += this.inlineEditor.editableRowHtml('person', nodeId, 'city', person.city || '', 'City');

        if (person.groups && person.groups.length > 0) {
            html += `<div class="info-section"><h4>Groups</h4><ul class="info-list">`;
            person.groups.forEach(group => {
                const role = group.role || '';
                const groupId = group.group_id || '';
                if (groupId) {
                    html += `<li><a href="#" class="info-nav-link" data-node-id="${esc(groupId)}"><strong>${esc(group.group)}</strong></a>${role ? ` - ${esc(role)}` : ''}</li>`;
                } else {
                    html += `<li><strong>${esc(group.group)}</strong>${role ? ` - ${esc(role)}` : ''}</li>`;
                }
            });
            html += `</ul></div>`;
        }

        if (person.bio) {
            html += `<div class="info-section"><h4>Biography</h4><p>${esc(person.bio)}</p></div>`;
        }
        html += this.inlineEditor.editableRowHtml('person', nodeId, 'bio', person.bio || '', 'Biography', true);

        if (person.trivia) {
            html += `<div class="info-section"><h4>Trivia</h4><p>${esc(person.trivia)}</p></div>`;
        }
        html += this.inlineEditor.editableRowHtml('person', nodeId, 'trivia', person.trivia || '', 'Trivia', true);

        contentElement.innerHTML = html;
        this.inlineEditor.attach(contentElement);
        this._attachNavLinkListeners(contentElement);
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
     * Attach click listeners to .info-nav-link elements inside a container.
     * Navigates the graph to the linked node when clicked.
     * @private
     */
    _attachNavLinkListeners(container) {
        container.querySelectorAll('.info-nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const nodeId = link.dataset.nodeId;
                if (nodeId) {
                    this.navigateToNodeId(nodeId);
                }
            });
        });
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
        const liked = this.favorites.chainFavorites.has(hash);

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

        // Pre-load favorites if not yet loaded, but don't block the like
        // action if the preload fails (e.g., contract not deployed yet)
        if (!this.favorites.chainFavoritesLoaded) {
            try {
                await this.favorites.refreshFavoritesFromChain();
            } catch (err) {
                console.warn('Favorites preload failed (continuing with like):', err.message);
            }
        }

        const node = this.selectedNode;
        const nodeHash = await this.likeManager.nodeIdToChecksum256(node.id);

        if (this.favorites.chainFavorites.has(nodeHash)) {
            return;
        }

        await this.likeManager.likeNode(node.id, { name: node.name, type: node.data?.type }, true);

        this.favorites.chainFavorites.add(nodeHash);
        this.favorites.chainFavoritesLoaded = true;
        this.favorites.updateFavoritesCount();
        await this.updateFavoriteButton();

        if (this.favorites.favoritesPanelOpen) await this.favorites.renderFavoritesPanel();
    }

    // ========== Search result navigation ==========

    /**
     * Handle selection of a search result with type-specific behavior.
     * - Person/Group: navigate to the node in the graph (default behavior)
     * - Release: navigate to the performing group and show the release in the orbit overlay
     * - Track: find the release containing the track, then behave like Release
     * - Song: display song details (songwriters, lyrics, releases) in the info panel only
     * @param {Object} result - Search result { id, type, display_name, ... }
     */
    async navigateToSearchResult(result) {
        const type = (result.type || '').toLowerCase();

        if (type === 'song') {
            await this._showSongInInfoPanel(result.id);
            return;
        }

        if (type === 'release') {
            await this._navigateToRelease(result.id);
            return;
        }

        if (type === 'track') {
            await this._navigateToTrack(result.id);
            return;
        }

        // Person, Group, Label, City — default graph navigation
        this.navigateToNodeId(result.id);
    }

    /**
     * Navigate to the group that performed a release, then auto-select
     * the release in the orbit overlay.
     * @param {string} releaseId
     */
    async _navigateToRelease(releaseId) {
        try {
            // Fetch release details to find the performing group
            const resp = await this.api.fetchReleaseDetails(releaseId);
            const release = resp && resp.data ? resp.data : null;
            if (!release) {
                console.warn('Release not found:', releaseId);
                return;
            }

            const groups = release.groups || [];
            if (groups.length === 0) {
                console.warn('No groups found for release:', releaseId);
                // Fall back to showing release details in info panel
                this.showReleaseDetailsInInfoPanel(release);
                return;
            }

            // Navigate to the first group
            const groupId = groups[0].group_id;
            await this._navigateToGroupAndSelectRelease(groupId, releaseId, release);
        } catch (error) {
            console.error('Failed to navigate to release:', releaseId, error);
        }
    }

    /**
     * Navigate to a track by finding its release, then behaving like release navigation.
     * @param {string} trackId
     */
    async _navigateToTrack(trackId) {
        try {
            const resp = await this.api.fetchNodeDetails(trackId, 'Track');
            const track = resp && resp.data ? resp.data : null;
            if (!track) {
                console.warn('Track not found:', trackId);
                return;
            }

            const releases = track.releases || [];
            if (releases.length === 0) {
                console.warn('No releases found for track:', trackId);
                return;
            }

            // Navigate to the first release
            await this._navigateToRelease(releases[0].release_id);
        } catch (error) {
            console.error('Failed to navigate to track:', trackId, error);
        }
    }

    /**
     * Navigate to a group node and then auto-select a release in the orbit overlay.
     * @param {string} groupId
     * @param {string} releaseId
     * @param {Object} releaseDetails - Pre-fetched release details
     */
    async _navigateToGroupAndSelectRelease(groupId, releaseId, releaseDetails) {
        if (!this.ht) return;

        // Ensure the group node is in the graph
        let node = this.ht.graph.getNode(groupId);
        if (!node) {
            await this.loader.ensureNodeInGraph(groupId);
            node = this.ht.graph.getNode(groupId);
        }
        if (!node) {
            console.warn('Group node not found after fetch:', groupId);
            return;
        }

        // Select and center on the group node
        if (this.selectedNode && this.selectedNode.id !== node.id) {
            this.selectedNode.setData('isSelected', false);
        }
        node.setData('isSelected', true);
        this.selectedNode = node;

        this.pathTracker.visitNode(node.id, {
            name: node.name,
            type: node.data && node.data.type
        });
        this.updateHistoryCount();
        if (this.historyPanelOpen) {
            this.renderHistoryPanel();
        }
        this.updateFavoriteButton();
        this._loadPlayerQueue(node);
        this.releaseOverlay.hide();

        this.ht.onClick(node.id, {
            onComplete: async () => {
                // Show the release orbit overlay
                await this.overlayPositioner.syncReleaseOverlay(node);

                // Auto-select the target release in the overlay
                this.releaseOverlay.selectRelease(releaseId, releaseDetails);

                // Show release details in info panel
                this.showReleaseDetailsInInfoPanel(releaseDetails);
            }
        });
    }

    /**
     * Show song details in the info panel without changing the graph visualization.
     * Displays: songwriters, lyrics, and a clickable list of releases.
     * @param {string} songId
     */
    async _showSongInInfoPanel(songId) {
        const infoTitle = document.getElementById('info-title');
        const infoContent = document.getElementById('info-content');
        const infoViewer = document.getElementById('info-viewer');
        if (!infoTitle || !infoContent) return;

        infoTitle.textContent = 'Loading...';
        infoContent.innerHTML = '<p>Loading song details...</p>';
        if (infoViewer) {
            infoViewer.style.removeProperty('display');
            infoViewer.classList.add('open');
        }

        try {
            const resp = await this.api.fetchNodeDetails(songId, 'Song');
            const song = resp && resp.data ? resp.data : null;
            if (!song) {
                infoContent.innerHTML = '<p>Song not found</p>';
                return;
            }

            this.infoPanel.renderSongDetails(song, infoTitle, infoContent);
        } catch (error) {
            console.error('Failed to load song details:', error);
            infoContent.innerHTML = '<p>Error loading song details</p>';
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
            await this.loader.ensureNodeInGraph(nodeId);
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

    // ========== Mini Player Queue Loading ==========

    /**
     * Load a playback queue into the mini-player based on node type.
     * Does not autoplay.
     */
    _loadPlayerQueue(node) {
        if (!this.miniPlayer) return;

        const nodeType = node.data && node.data.type;
        // Skip synthetic root node
        if ((nodeType || '').toLowerCase() === 'root') return;
        const nodeId = node.id;

        if (nodeType === 'release' || (nodeId && nodeId.includes(':release:'))) {
            this.miniPlayer.loadQueue('release', nodeId);
        } else if (nodeType === 'group' || (nodeId && nodeId.includes(':group:'))) {
            this.miniPlayer.loadQueue('group', nodeId);
        } else if (nodeType === 'person' || (nodeId && nodeId.includes(':person:'))) {
            this.miniPlayer.loadQueue('person', nodeId);
        }
        // For other node types (track, song, etc.), don't load a queue
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

            this._curateOperations = resp.operations;
            list.innerHTML = '';
            for (const op of resp.operations) {
                list.appendChild(this.infoPanel.renderCurateRow(op));
            }
        } catch (e) {
            console.error('Failed to render curate panel:', e);
            list.innerHTML = '<div class="history-empty">Failed to load operations.</div>';
        }
    }

    async _selectCurateOperation(op) {
        // Highlight selected row
        const list = document.getElementById('curate-list');
        if (list) {
            list.querySelectorAll('.curate-row').forEach(r => r.classList.remove('curate-row--selected'));
            const selectedRow = list.querySelector(`[data-hash="${op.hash}"]`);
            if (selectedRow) selectedRow.classList.add('curate-row--selected');
        }

        const detail = document.getElementById('curate-detail');
        if (!detail) return;

        detail.innerHTML = '<div class="curate-detail-empty"><p>Loading...</p></div>';

        try {
            const viewer = this.walletManager?.isConnected() ? this.walletManager.getSessionInfo().accountName : null;
            const resp = await this.api.fetchOperationDetail(op.hash, viewer);

            if (!resp.success) {
                detail.innerHTML = '<div class="curate-detail-empty"><p>Failed to load operation detail.</p></div>';
                return;
            }

            this.infoPanel.renderCurateDetail(detail, resp, op);
        } catch (e) {
            console.error('Failed to load operation detail:', e);
            detail.innerHTML = '<div class="curate-detail-empty"><p>Error loading detail.</p></div>';
        }
    }

    async _curateVoteFromDetail(op, val) {
        if (!this.walletManager?.isConnected()) {
            alert('Please connect your wallet to vote.');
            return;
        }

        const session = this.walletManager.getSessionInfo();
        const contractAccount = this.walletManager.config.contractAccount;

        try {
            await this.walletManager.transact({
                account: contractAccount,
                name: 'vote',
                authorization: [{
                    actor: session.accountName,
                    permission: session.permission
                }],
                data: {
                    voter: session.accountName,
                    tx_hash: op.hash,
                    val: val
                }
            });

            // Refresh the detail view and the feed row
            await this._selectCurateOperation(op);

            // Also update the feed row tally
            await this._refreshCurateRowTally(op);
        } catch (e) {
            console.error('Vote failed:', e);
            alert('Vote failed: ' + (e.message || e));
        }
    }

    async _refreshCurateRowTally(op) {
        try {
            // Use backend chain reader to avoid CSP/CORS issues
            // from direct browser-to-chain RPC calls
            const tally = await backendApi.getVoteTally(op.anchor_id);

            if (tally) {
                op.tally = {
                    up_weight: parseInt(tally.up_weight) || 0,
                    down_weight: parseInt(tally.down_weight) || 0,
                    up_voter_count: parseInt(tally.up_voter_count) || 0,
                    down_voter_count: parseInt(tally.down_voter_count) || 0
                };
            }

            // Replace the feed row
            const list = document.getElementById('curate-list');
            const oldRow = list?.querySelector(`[data-hash="${op.hash}"]`);
            if (oldRow) {
                const newRow = this.infoPanel.renderCurateRow(op);
                newRow.classList.add('curate-row--selected');
                oldRow.replaceWith(newRow);
            }
        } catch (e) {
            console.error('Failed to refresh tally:', e);
        }
    }

    /**
     * Destroy the visualization and clean up
     */
    destroy() {
        this.releaseOverlay.hide();
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this.container) {
            this.container.innerHTML = '';
        }
    }
}

// Export singleton instance creator
export function createMusicGraph(containerId) {
    return new MusicGraph(containerId);
}
