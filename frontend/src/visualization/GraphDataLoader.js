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
 *                           this, but DonutLoader.prePopulateData is
 *                           handed `this.loader._initialParticipation`
 *                           by MusicGraph to seed slices on first render
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

/**
 * How long the opening draw may hold up the first paint.
 *
 * The sponsored fetch starts with the graph fetch, so in the ordinary case it
 * has already resolved by the time this is consulted and the grace is never
 * spent. It exists for a chain that is slow or down, where the graph must still
 * appear.
 */
const SPONSORED_GRACE_MS = 600;

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
        /*
         * How long the opening draw may hold up the first paint. An instance
         * field rather than a bare constant because the loader's tests compile
         * method bodies out of this file and run them against a stub, where a
         * module-level binding is not in scope.
         */
        this.sponsoredGraceMs = SPONSORED_GRACE_MS;
    }

    /**
     * Open on this period's drawn node, if there is one.
     *
     * Runs on every fresh load rather than only the first visit: the draw is
     * the same for everyone in the period, so there is nothing to remember
     * about a returning visitor and no cookie to set.
     *
     * Called before the first paint, with the id already in hand, so the
     * hypertree is built around the drawn node and it is simply *there*. It
     * used to run afterwards, which meant the graph appeared centred on
     * whichever node the layout happened to pick and then visibly travelled to
     * the drawn one — an opening journey from an arbitrary band that said
     * nothing, every single load.
     *
     * Silent on every failure path. A node that is not in the loaded subgraph
     * is treated the same as no node at all — the initial graph holds groups
     * and their members, which is exactly the eligible set, but a draw taken
     * against a newer graph than the one this client fetched could still name
     * something absent.
     *
     * @param {string|null} sponsoredId
     * @returns {boolean} whether the root was moved
     */
    openOnSponsoredNode(sponsoredId) {
        if (!sponsoredId) return false;

        const node = this.callbacks.getNode?.(sponsoredId);
        if (!node) {
            console.log('Sponsored node is not in the loaded graph, keeping the default root');
            return false;
        }

        this.callbacks.setRoot?.(sponsoredId);
        return true;
    }

    /**
     * The drawn node's id, if it arrives in time to open on.
     *
     * Started alongside the graph fetch and waited for only as long as it takes
     * the graph itself to arrive, plus a short grace. The draw is worth opening
     * on; it is not worth holding a blank screen for. Past the grace the load
     * continues without it, which is the behaviour this had before the draw was
     * part of the opening at all.
     *
     * @param {Promise<{id?: string}>} pending
     * @returns {Promise<string|null>}
     */
    async _sponsoredIdIfPrompt(pending) {
        let timer;
        const grace = new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), this.sponsoredGraceMs);
        });
        try {
            const winner = await Promise.race([pending, grace]);
            return winner?.id ?? null;
        } catch (error) {
            console.warn('Could not read the sponsored node:', error.message);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    async loadGraphData() {
        try {
            console.log('Loading graph data...');
            // Both requests go out together: the draw is needed before the
            // first paint, and fetching it after the graph would add its round
            // trip to the time the visitor spends looking at nothing.
            const pendingSponsored = this.api.fetchSponsoredNode()
                .catch((error) => {
                    console.warn('Could not fetch the sponsored node:', error.message);
                    return null;
                });
            const raw = await this.api.fetchInitialGraphRaw();
            this.rawGraph = { nodes: raw.nodes, edges: raw.edges };

            // Store participation map for pre-populating donut data after render
            this._initialParticipation = raw.participation || {};

            console.log('Graph data loaded:', this.rawGraph);

            const jit = this.api.transformToJIT(this.rawGraph);
            this.callbacks.loadJSON(jit);

            // Before refresh(), which is what builds the layout: setting the
            // root after it would draw one view and then replace it.
            const sponsoredId = await this._sponsoredIdIfPrompt(pendingSponsored);
            this.openOnSponsoredNode(sponsoredId);

            this.callbacks.refresh();
            this.callbacks.syncZoomSlider();
            this.callbacks.updateHistoryCount();
            await this.rebuildHashIndexFromRawGraph();

            // Pre-populate donut slices from participation data bundled in the
            // initial response, so styleNode does not trigger per-group fetches.
            this.callbacks.prePopulateDonutData();

            console.log('Graph rendered');

            // Select it, now that it is drawn: the node is already at the
            // centre, so this fills the details and marks it without moving
            // anything. A draw that missed the grace above still gets here —
            // it travels, as it used to, which is the right fallback for a
            // slow chain and the wrong default for every load.
            if (sponsoredId) {
                const node = this.callbacks.getNode?.(sponsoredId);
                if (node) this.callbacks.selectNode?.(node);
            } else {
                const late = await pendingSponsored;
                if (late?.id) {
                    const node = this.callbacks.getNode?.(late.id);
                    if (node) this.callbacks.selectNode?.(node);
                }
            }
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
