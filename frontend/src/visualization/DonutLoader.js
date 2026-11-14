/**
 * DonutLoader — owns the donut-fetch cluster previously smeared across
 * MusicGraph: the concurrency-limited queue, the active-load counter,
 * the cached stats, and the five methods that fill in `donutSlices`
 * data on group nodes for the canvas renderer.
 *
 * Extracted from MusicGraph as the third pass of the J-series splits
 * (after InfoPanelRenderer, OverlayPositioner, FavoritesManager,
 * GraphDataLoader). Behavior is unchanged — the characterization tests
 * in `backend/test/visualization/donutLoader.snapshot.test.js` lock
 * the angle/color output of `computeSlices` plus the queue/stats
 * side effects of every other method.
 *
 * Public state:
 *   queue          Array of JIT nodes waiting for participation data
 *   activeLoads    in-flight fetch count
 *   maxConcurrent  ceiling for activeLoads (default 4)
 *   stats          { started, succeeded, failed } running totals
 *
 * Public API:
 *   enqueue(node)                  push + drain
 *   processQueue()                 drain up to maxConcurrent
 *   loadSingle(node)        async  fetch participation, set donutSlices
 *   computeSlices(members)         pure: members → slice descriptors
 *   prePopulateData(participation) seed donut data without HTTP fetches
 *
 * @module visualization/DonutLoader
 */

export class DonutLoader {
    /**
     * @param {Object} deps
     * @param {Object} deps.api                       - GraphAPI; exposes fetchGroupParticipation(groupId)
     * @param {Object} deps.colorPalette              - ColorPalette; exposes getColor(personId)
     * @param {number} [deps.maxConcurrent=4]         - concurrent fetch ceiling
     * @param {Object} deps.callbacks
     * @param {() => void} deps.callbacks.plot        - request graph redraw after data changes
     * @param {(cb: (node:any) => void) => void} deps.callbacks.eachNode - iterate JIT graph nodes
     */
    constructor({ api, colorPalette, maxConcurrent = 4, callbacks }) {
        this.api = api;
        this.colorPalette = colorPalette;
        this.callbacks = callbacks;

        this.queue = [];
        this.activeLoads = 0;
        this.maxConcurrent = maxConcurrent;
        this.stats = { started: 0, succeeded: 0, failed: 0 };
    }

    /**
     * Enqueue a group node for donut data loading via the concurrency-limited queue.
     * Prevents thundering-herd when many group nodes need participation data.
     */
    enqueue(node) {
        this.queue.push(node);
        this.processQueue();
    }

    /**
     * Process the donut fetch queue, respecting the concurrency limit.
     */
    processQueue() {
        while (this.queue.length > 0 && this.activeLoads < this.maxConcurrent) {
            const node = this.queue.shift();
            this.activeLoads++;
            this.stats.started++;
            this.loadSingle(node);
        }
    }

    /**
     * Load participation data for a single group node.
     * Called by the queue processor; decrements active count on completion.
     */
    async loadSingle(node) {
        const groupId = node.data.group_id || node.id;

        // Settled while it sat in the queue. enqueue() starts work
        // immediately, so anything that fills a donut after that point can
        // still find entries already waiting on a fetch they do not need.
        if (node.getData('donutStatus') === 'ready') {
            this.activeLoads--;
            this.processQueue();
            return;
        }

        try {
            const data = await this.api.fetchGroupParticipation(groupId);
            const slices = this.computeSlices(data.members || []);
            node.setData('donutSlices', slices);
            node.setData('donutStatus', 'ready');
            this.stats.succeeded++;
            this.callbacks.plot();
        } catch (error) {
            console.error(`Failed to load donut data for ${groupId}:`, error);
            node.setData('donutStatus', 'error');
            this.stats.failed++;
        } finally {
            this.activeLoads--;
            this.processQueue();
            if (this.activeLoads === 0 && this.queue.length === 0) {
                console.log('Donut load stats:', { ...this.stats });
            }
        }
    }

    /**
     * Compute donut slice angles from backend member participation data.
     *
     * @param {Array} members - Backend members array (personId, personName, trackCount, trackPctOfGroupTracks)
     * @returns {Array} Slice descriptors with begin/end angles, color, and metadata
     */
    computeSlices(members) {
        if (!members || members.length === 0) return [];

        // Sanitise weights: coerce to finite non-negative numbers
        const weights = members.map(m => {
            const v = Number(m.trackCount ?? 0);
            return Number.isFinite(v) && v > 0 ? v : 0;
        });

        let totalWeight = weights.reduce((a, b) => a + b, 0);

        // Fallback: if all weights are 0 but members exist, draw equal slices
        const useEqualSlices = totalWeight <= 0;
        if (useEqualSlices) {
            totalWeight = members.length; // each member gets weight = 1
        }

        // Sort descending by weight, breaking ties on person id.
        //
        // The tie-break used to be the member's index in the incoming array,
        // which is the order the rows happened to arrive in. That is not a
        // property of the band: the two sources disagree about it, because
        // neither orders its results. The initial graph load collects
        // participation rows with `collect(DISTINCT {...})` in
        // api/routes/graph.js, and the per-group refetch runs a separate query
        // in calculateGroupMemberParticipation; Cypher guarantees an order in
        // neither case.
        //
        // Ties are the normal case, not an edge case: a four-piece that played
        // every track has four members all weighted 12. So the same donut came
        // out with its slices in a different rotation depending on which source
        // last populated it — same sizes, same colours, different positions,
        // which reads as the ring changing colour.
        //
        // person id is stable, unique, and independent of arrival order. The
        // index remains as a last resort for rows with no id at all.
        const indexed = members.map((m, i) => ({ m, w: useEqualSlices ? 1 : weights[i], i }));
        indexed.sort((a, b) => {
            if (b.w !== a.w) return b.w - a.w;
            const idA = String(a.m.personId ?? '');
            const idB = String(b.m.personId ?? '');
            if (idA !== idB) return idA < idB ? -1 : 1;
            return a.i - b.i;
        });

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
                trackCount: m.trackCount,
                trackPctOfGroupTracks: m.trackPctOfGroupTracks,
                weightNormalized: weightNormalized
            });

            angle += sliceAngle;
        }

        return slices;
    }

    /**
     * Settle every group node's donut from the participation map the initial
     * graph response already carried, so the first render pass fetches
     * nothing.
     *
     * **Every** group, not only the ones with rows. The map is built from
     * `(Person)-[:MEMBER_OF]->(Group)`, so a group nobody is a member of has
     * no entry — and leaving its donutStatus unset is what sent styleNode to
     * the network for it. Fetching tells us the same nothing one round trip
     * later, so an absent entry settles as an empty ring here.
     *
     * Must run before the first plot. styleNode enqueues on sight of a group
     * with no status, and enqueue starts the HTTP immediately — marking the
     * node ready afterwards does not call anything back.
     *
     * @param {Object|null|undefined} participation  groupId → { members: [...] }
     * @param {{redraw?: boolean}} [options] - redraw false before the first
     *        refresh, which draws anyway and has no layout to plot against yet.
     */
    prePopulateData(participation, { redraw = true } = {}) {
        const map = participation || {};
        let withMembers = 0;
        let empty = 0;

        this.callbacks.eachNode(node => {
            const nodeType = (node.data.type || '').toLowerCase();
            if (nodeType !== 'group') return;
            if (node.getData('donutStatus') === 'ready') return;

            const groupId = node.data.group_id || node.id;
            const pData = map[groupId];
            const members = pData && Array.isArray(pData.members) ? pData.members : [];

            node.setData('donutSlices', this.computeSlices(members));
            node.setData('donutStatus', 'ready');
            if (members.length > 0) withMembers++; else empty++;
        });

        console.log(`Donut data settled for ${withMembers + empty} groups `
            + `(${withMembers} with members, ${empty} empty)`);

        if (redraw && withMembers + empty > 0) {
            this.callbacks.plot();
        }
    }
}
