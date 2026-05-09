/**
 * PanController — owns the long-press pan gesture previously smeared
 * across MusicGraph: the PAN_HOLD_MS constant, the `_pan` state object,
 * and the four event handlers that turn a hold-then-drag into a canvas
 * translate.
 *
 * Replaces JIT's built-in panning (which fires on any mousedown-drag
 * and swallows quick node clicks). The flow:
 *   - mousedown  → arm a hold timer (default 900ms); record the start
 *                  position in canvas coordinates
 *   - hold fires → enter panning mode, mark the next click as one to
 *                  swallow (so mouseup-then-click on the underlying
 *                  node doesn't fire), add 'grabbing' class
 *   - mousemove  → translate the JIT canvas by the per-frame delta;
 *                  rAF-debounce the redraw + overlay reposition
 *   - mouseup    → cancel the hold timer; if panning was active,
 *                  remove 'grabbing' class
 *
 * Extracted from MusicGraph as the fourth pass of the J-series splits
 * (after InfoPanelRenderer, OverlayPositioner, FavoritesManager,
 * GraphDataLoader, DonutLoader). Behavior is unchanged — the
 * characterization tests in
 * `backend/test/visualization/panController.snapshot.test.js` lock
 * every state transition.
 *
 * Public state (read by MusicGraph for the click-suppress hand-off):
 *   pan.suppressNextClick   — set to true when a pan gesture started;
 *                             MusicGraph's onClick reads & resets this
 *                             to swallow the click that ends the gesture
 *
 * Public API:
 *   attach()              — register listeners on the JIT canvas
 *   eventToCanvasPos(e)   — translate DOM event → canvas coords
 *   onMouseDown(e)        — start gesture
 *   onMouseMove(e)        — drag while panning
 *   onMouseUp(e)          — end gesture
 *   consumeSuppressClick()— atomically read+reset suppressNextClick
 *
 * @module visualization/PanController
 */

export class PanController {
    /**
     * @param {Object} deps
     * @param {() => Object|null|undefined} deps.getCanvas - returns the JIT canvas object
     *   (must expose getElement(), getSize(), getPos(), translate(dx,dy,animate),
     *    and the translateOffsetX/Y + scaleOffsetX/Y properties)
     * @param {Object} deps.callbacks
     * @param {() => void} deps.callbacks.plot                  - request graph redraw
     * @param {() => void} deps.callbacks.updateOverlayPosition - re-anchor release-orbit overlay
     * @param {number} [deps.holdMs=900] - milliseconds to hold before pan begins
     */
    constructor({ getCanvas, callbacks, holdMs = 900 }) {
        this.getCanvas = getCanvas;
        this.callbacks = callbacks;
        this.holdMs = holdMs;

        this.pan = {
            isDown: false,
            isPanning: false,
            suppressNextClick: false,
            timer: null,
            lastPos: null,
            latestPos: null,
            raf: null
        };
    }

    /**
     * Wire up long-press panning on the canvas element.
     * Hold ~holdMs then drag to pan; quick clicks pass through to node selection.
     */
    attach() {
        const canvas = this.getCanvas();
        if (!canvas) return;
        const el = canvas.getElement();
        if (!el) return;

        el.addEventListener('mousedown', (e) => this.onMouseDown(e));
        el.addEventListener('mousemove', (e) => this.onMouseMove(e));
        window.addEventListener('mouseup', (e) => this.onMouseUp(e));
        el.addEventListener('mouseleave', (e) => this.onMouseUp(e));
    }

    /**
     * Translate a DOM mouse event to canvas (untransformed) coordinates.
     * Inverts the JIT canvas's translate + scale offsets.
     */
    eventToCanvasPos(e) {
        const canvas = this.getCanvas();
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

    onMouseDown(e) {
        if (e.button !== 0) return;
        this.pan.isDown = true;
        this.pan.isPanning = false;
        this.pan.suppressNextClick = false;

        const pos = this.eventToCanvasPos(e);
        this.pan.latestPos = pos;
        this.pan.lastPos = pos;

        clearTimeout(this.pan.timer);
        this.pan.timer = setTimeout(() => {
            if (!this.pan.isDown) return;
            this.pan.isPanning = true;
            this.pan.suppressNextClick = true;
            this.getCanvas().getElement().classList.add('grabbing');
        }, this.holdMs);
    }

    onMouseMove(e) {
        if (!this.pan.isDown) return;
        this.pan.latestPos = this.eventToCanvasPos(e);

        if (!this.pan.isPanning) return;

        e.preventDefault();
        e.stopPropagation();

        const pos = this.pan.latestPos;
        const last = this.pan.lastPos;
        const dx = pos.x - last.x;
        const dy = pos.y - last.y;

        if (dx === 0 && dy === 0) return;

        this.getCanvas().translate(dx, dy, true);
        this.pan.lastPos = pos;

        if (!this.pan.raf) {
            this.pan.raf = requestAnimationFrame(() => {
                this.callbacks.plot();
                this.callbacks.updateOverlayPosition();
                this.pan.raf = null;
            });
        }
    }

    onMouseUp(e) {
        if (!this.pan.isDown) return;

        clearTimeout(this.pan.timer);
        this.pan.timer = null;

        if (this.pan.isPanning) {
            this.getCanvas().getElement().classList.remove('grabbing');
            this.pan.isPanning = false;
        }

        this.pan.isDown = false;
    }

    /**
     * Read-and-reset the suppress-click flag. MusicGraph's JIT onClick
     * handler calls this to swallow the click that follows a pan gesture.
     * @returns {boolean} true if the next click should be swallowed
     */
    consumeSuppressClick() {
        if (this.pan.suppressNextClick) {
            this.pan.suppressNextClick = false;
            return true;
        }
        return false;
    }
}
