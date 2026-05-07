/**
 * OverlayPositioner — positioning glue for the ReleaseOrbitOverlay.
 *
 * Extracted from MusicGraph (Stage J.2). The ReleaseOrbitOverlay class
 * itself owns the overlay's DOM and animations; this module owns the
 * tiny but duplicated math that translates "selected JIT node" into
 * "screen coords + visual radius" the overlay needs.
 *
 * The two duplicated radius computations on MusicGraph (visualRadius
 * for the bare-dim case vs. the donut-ring case) are now consolidated
 * into one helper, `computeVisualRadius(dim, donutSlices)`, which the
 * cross-method regression-guard test in Stage J.2 already pins.
 *
 * Public API:
 *   syncReleaseOverlay(node)    — show on group nodes, hide otherwise
 *   updateOverlayPosition()     — re-anchor after re-render
 *
 * Behaviour contract: the snapshot tests in
 * `backend/test/visualization/overlayPositioner.snapshot.test.js`
 * lock the call arguments to releaseOverlay.show/hide/updatePosition
 * and the visualRadius math.
 *
 * @module visualization/OverlayPositioner
 */

export class OverlayPositioner {
    /**
     * @param {Object} deps
     * @param {Object} deps.releaseOverlay    - the ReleaseOrbitOverlay instance
     *                                          (owned by MusicGraph; we just
     *                                          drive its show/hide/update API)
     * @param {Object} deps.callbacks
     * @param {(node: Object) => {x: number, y: number, dim: number}}
     *        deps.callbacks.getNodeScreenPos
     *        Project a JIT node to canvas-screen coords + display radius.
     *        Lives on MusicGraph because it's tightly coupled to the
     *        Hypertree's transform pipeline.
     * @param {() => Object|null} deps.callbacks.getSelectedNode
     *        Return the currently selected JIT node (or null).
     */
    constructor({ releaseOverlay, callbacks }) {
        this.releaseOverlay = releaseOverlay;
        this.callbacks = callbacks;
    }

    /**
     * Compute the visualRadius for the overlay anchor point, accounting
     * for the donut ring drawn around group nodes.
     *
     * Original duplicated math (in `_syncReleaseOverlay` and
     * `_updateOverlayPosition`):
     *   gap       = max(2, dim * 0.20)
     *   thickness = max(3, dim * 0.45)
     *   radius    = dim + gap + thickness
     *
     * @param {number} dim          - JIT node display radius
     * @param {Array|null|undefined} donutSlices - if non-empty, add the ring
     * @returns {number}
     */
    computeVisualRadius(dim, donutSlices) {
        if (!donutSlices || donutSlices.length === 0) return dim;
        const gap = Math.max(2, dim * 0.20);
        const thickness = Math.max(3, dim * 0.45);
        return dim + gap + thickness;
    }

    /**
     * Translate canvas-relative coords into overlay-relative coords.
     * The overlay div is positioned inside #viz-container, so we need
     * to subtract its bounding-rect offset. If the container is missing
     * (jsdom / unmounted), fall back to (0, 0).
     */
    _toOverlayCoords(x, y) {
        const vizContainer = document.getElementById('viz-container');
        const vizRect = vizContainer ? vizContainer.getBoundingClientRect() : { left: 0, top: 0 };
        return { x: x - vizRect.left, y: y - vizRect.top };
    }

    /**
     * Show or hide the release orbit overlay based on node type.
     * @param {Object} node - Selected JIT graph node
     */
    async syncReleaseOverlay(node) {
        const nodeType = (node.data.type || '').toLowerCase();

        if (nodeType !== 'group') {
            this.releaseOverlay.hide();
            return;
        }

        const groupId = node.data.group_id || node.id;
        const { x, y, dim } = this.callbacks.getNodeScreenPos(node);
        const visualRadius = this.computeVisualRadius(dim, node.getData('donutSlices'));
        const { x: relX, y: relY } = this._toOverlayCoords(x, y);

        await this.releaseOverlay.show(groupId, { x: relX, y: relY }, visualRadius);
    }

    /**
     * Update overlay position (called after graph re-render).
     */
    updateOverlayPosition() {
        const selectedNode = this.callbacks.getSelectedNode();
        if (!this.releaseOverlay.visible || !selectedNode) return;

        const { x, y, dim } = this.callbacks.getNodeScreenPos(selectedNode);
        const visualRadius = this.computeVisualRadius(dim, selectedNode.getData('donutSlices'));
        const { x: relX, y: relY } = this._toOverlayCoords(x, y);

        this.releaseOverlay.updatePosition({ x: relX, y: relY }, visualRadius);
    }
}
