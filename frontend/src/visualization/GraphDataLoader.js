/**
 * GraphDataLoader — owns the graph-data lifecycle: initial fetch,
 * neighborhood fetch + merge, and the checksum256 → node-meta index
 * the favorites panel reads.
 *
 * Extracted from MusicGraph (Stage J.2). The behavior contract is
 * pinned by `backend/test/visualization/graphDataLoader.snapshot.test.js`.
 *
 * Owned state:
 *   rawGraph                {nodes, edges} | null
 *   _initialParticipation   per-group donut data captured from the
 *                           first fetch; FavoritesManager doesn't read
 *                           this, but MusicGraph._prePopulateDonutData
 *                           reaches into `this.loader._initialParticipation`
 *                           to seed the donut slices on first render
 *   hashIndex               Map<checksum256, {nodeId, name, type}>
 *                           — passed in by MusicGraph and shared with
 *                           FavoritesManager. We mutate it in place
 *                           (clear + set) so the shared reference stays
 *                           stable across rebuilds.
 *
 * Public API:
 *   loadGraphData()                  — initial fetch + render + index rebuild
 *   rebuildHashIndexFromRawGraph()   — checksum256 mapping for current rawGraph
 *   ensureNodeInGraph(nodeId)        — neighborhood fetch + merge (caps at 500)
 *
 * @module visualization/GraphDataLoader
 */

export class GraphDataLoader {
    /**
     * @param {Object} deps
     * @param {Object} deps.api          - GraphAPI (fetchInitialGraphRaw,
     *                                     fetchNeighborhoodRaw, transformToJIT,
     *                                     mergeRawGraph)
     * @param {Object} deps.likeManager  - exposes nodeIdToChecksum256(id)
     * @param {Map}    deps.hashIndex    - shared with FavoritesManager
     * @param {Object} deps.callbacks
     * @param {(jit:Object)=>void} deps.callbacks.loadJSON
     *        Hand the transformed JIT data to the Hypertree.
     * @param {()=>void} deps.callbacks.refresh
     *        Tell the Hypertree to redraw.
     * @param {()=>void} deps.callbacks.syncZoomSlider
     *        UI side-effect on MusicGraph; runs once after initial load.
     * @param {()=>void} deps.callbacks.updateHistoryCount
     *        UI side-effect on MusicGraph; runs once after initial load.
     * @param {()=>void} deps.callbacks.prePopulateDonutData
     *        MusicGraph helper that reads `this._initialParticipation`
     *        off the loader and seeds donut slices on group nodes.
     */
    constructor({ api, likeManager, hashIndex, callbacks }) {
        this.api = api;
        this.likeManager = likeManager;
        this.hashIndex = hashIndex;
        this.callbacks = callbacks;

        this.rawGraph = null;
        this._initialParticipation = undefined;
    }

    async loadGraphData() {
        try {
            console.log('Loading graph data...');
            const raw = await this.api.fetchInitialGraphRaw();
            this.rawGraph = { nodes: raw.nodes, edges: raw.edges };

            // Store participation map for pre-populating donut data after render
            this._initialParticipation = raw.participation || {};

            console.log('Graph data loaded:', this.rawGraph);

            const jit = this.api.transformToJIT(this.rawGraph);
            this.callbacks.loadJSON(jit);
            this.callbacks.refresh();
            this.callbacks.syncZoomSlider();
            this.callbacks.updateHistoryCount();
            await this.rebuildHashIndexFromRawGraph();

            // Pre-populate donut slices from participation data bundled in the
            // initial response, so styleNode does not trigger per-group fetches.
            this.callbacks.prePopulateDonutData();

            console.log('Graph rendered');
        } catch (error) {
            console.error('Failed to load graph data:', error);
        }
    }

    /**
     * Build a local checksum256 → {nodeId, name, type} index from the raw graph.
     * Used to map on-chain like hashes back to displayable node info.
     *
     * Clears the existing Map in place rather than reassigning, so any
     * other module holding a reference to the same Map (FavoritesManager)
     * sees the rebuild without needing to re-acquire the reference.
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
        this.callbacks.loadJSON(jit);
        this.callbacks.refresh();
        await this.rebuildHashIndexFromRawGraph();
    }
}
