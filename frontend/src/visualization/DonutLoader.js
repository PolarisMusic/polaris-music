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
                trackCount: m.trackCount,
                trackPctOfGroupTracks: m.trackPctOfGroupTracks,
                weightNormalized: weightNormalized
            });

            angle += sliceAngle;
        }

        return slices;
    }

    /**
     * Pre-populate donut slice data on group nodes from a participation map
     * provided by the initial graph response. Avoids one HTTP request per
     * group during the first render pass.
     *
     * @param {Object|null|undefined} participation  groupId → { members: [...] }
     */
    prePopulateData(participation) {
        if (!participation) return;

        let prePopulated = 0;
        this.callbacks.eachNode(node => {
            const nodeType = (node.data.type || '').toLowerCase();
            if (nodeType !== 'group') return;

            const groupId = node.data.group_id || node.id;
            const pData = participation[groupId];
            if (!pData || !pData.members) return;

            const slices = this.computeSlices(pData.members);
            node.setData('donutSlices', slices);
            node.setData('donutStatus', 'ready');
            prePopulated++;
        });

        console.log(`Donut data pre-populated for ${prePopulated} groups`);

        if (prePopulated > 0) {
            this.callbacks.plot();
        }
    }
}
