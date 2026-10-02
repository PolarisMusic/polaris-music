/**
 * Navigating along an edge.
 *
 * The complaint this answers is that the graph is hard to get around: you can
 * see that the selected node is connected to something, but the only way to go
 * there is to find the far node and hit a 9-pixel circle, which at the rim of
 * the disk is most of the difficulty of using the thing.
 *
 * So the edges become the control. Hovering one that touches the current node
 * highlights it and names where it goes; clicking it goes there. Without hover
 * — a phone — the first tap does the highlighting and a second tap on the same
 * edge travels, because a tap that both reveals and commits is a tap you cannot
 * take back.
 *
 * Only edges incident to the current node are live. Every other line on screen
 * stays inert: a graph where any of several hundred arcs might be the one under
 * your finger is not more navigable, it is a minefield.
 *
 * @module visualization/EdgeNavigator
 */

import { arcSense, arcThroughTwoPoints, pickEdge } from './edgePicking.js';

/**
 * How near the pointer has to be, in pixels.
 *
 * The touch figure is not the mouse figure: a fingertip covers something like
 * 8mm of glass and lands with no cursor to aim by, and these arcs are drawn at
 * barely a pixel on a phone.
 */
export const PICK_RADIUS_MOUSE_PX = 12;
export const PICK_RADIUS_TOUCH_PX = 24;

/**
 * Extra pixels around a node within which edges stand aside.
 *
 * Every live edge has an endpoint *on* the current node, so without this the
 * node you are standing on is covered by its own edges: tapping it would
 * measure a distance of nearly zero to one of them and travel away from the
 * place you just tapped. Nodes win, and by a margin, because a node is the
 * smaller target and the one a person is more likely to be aiming at.
 */
export const NODE_PRIORITY_MARGIN_PX = 6;

/** Highlight colour and weight — bright enough to read against any edge colour. */
export const HIGHLIGHT_COLOR = '#ffffff';
export const HIGHLIGHT_WIDTH_MULTIPLIER = 3;
export const HIGHLIGHT_MIN_WIDTH = 2.5;

/** Does this device have a pointer that can hover? */
export function canHover(win = window) {
    return !!win.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches;
}

export class EdgeNavigator {
    /**
     * @param {object} deps
     * @param {() => object} deps.getHypertree
     * @param {() => object|null} deps.getAnchorNode - the node whose edges are live
     * @param {object} deps.callbacks
     * @param {(nodeId: string) => void} deps.callbacks.navigate
     * @param {() => void} deps.callbacks.plot
     * @param {() => boolean} [deps.callbacks.shouldSuppress] - true while panning
     * @param {Window} [deps.win]
     */
    constructor({ getHypertree, getAnchorNode, callbacks, win = window }) {
        this.getHypertree = getHypertree;
        this.getAnchorNode = getAnchorNode;
        this.callbacks = callbacks;
        this.win = win;

        /** Edge currently highlighted, by `${fromId}|${toId}`. */
        this.highlightedId = null;
        /** On a touch device, the edge a second tap would travel. */
        this.armedId = null;

        this._label = null;
        this._listeners = [];
    }

    /** Wire up the canvas. Safe to call once the hypertree exists. */
    attach() {
        const element = this.getHypertree?.()?.canvas?.getElement?.();
        if (!element) return false;

        const on = (target, type, handler, options) => {
            target.addEventListener(type, handler, options);
            this._listeners.push(() => target.removeEventListener(type, handler, options));
        };

        on(element, 'mousemove', (e) => this.handlePointerMove(e), { passive: true });
        on(element, 'mouseleave', () => this.clear(), { passive: true });
        // JIT does not listen for 'click' at all — it calls its own onClick
        // from a 'mouseup' handler (jit.js:2013, 2195), which fires first and
        // cannot be cancelled from here. So this is not a race with node
        // selection and stopPropagation below does not win one: what keeps a
        // tap on a node from being read as a tap on its edge is nodeUnderPointer,
        // and nothing else. Capture only keeps the edge ahead of other DOM
        // listeners on the way up.
        on(element, 'click', (e) => this.handleClick(e), true);

        this.element = element;
        return true;
    }

    /** Remove every listener and any highlight. */
    detach() {
        this.clear();
        for (const off of this._listeners) off();
        this._listeners = [];
    }

    /**
     * The edges that are live right now: those touching the anchor node.
     *
     * @returns {Array<{id: string, adj: object, from: object, to: object, other: object}>}
     */
    candidates() {
        const anchor = this.getAnchorNode?.();
        if (!anchor) return [];

        const live = [];
        anchor.eachAdjacency?.((adj) => {
            // ROOT edges are the synthetic connectors that hold the layout
            // together; they are drawn transparent and must not be clickable.
            if ((adj.data?.type || '') === 'ROOT') return;

            const other = adj.nodeFrom.id === anchor.id ? adj.nodeTo : adj.nodeFrom;
            if ((other.data?.type || '').toLowerCase() === 'root') return;

            live.push({
                id: edgeId(adj),
                adj,
                from: adj.nodeFrom.pos.getc(),
                to: adj.nodeTo.pos.getc(),
                other,
            });
        });

        return live;
    }

    /**
     * Turn a viewport point into normalised Poincaré coordinates.
     *
     * The inverse of what the renderer does: centre of the canvas, plus the
     * pan translation, plus the position scaled by the disk radius and the
     * zoom. Measured off `getBoundingClientRect` rather than JIT's `getPos`
     * so it stays right under page scroll.
     *
     * @param {number} clientX
     * @param {number} clientY
     * @returns {{x: number, y: number}|null}
     */
    pointerToDisk(clientX, clientY) {
        const ht = this.getHypertree?.();
        const canvas = ht?.canvas;
        const element = canvas?.getElement?.();
        if (!element || typeof ht.getRadius !== 'function') return null;

        const radius = ht.getRadius();
        const scaleX = canvas.scaleOffsetX || 1;
        const scaleY = canvas.scaleOffsetY || 1;
        if (!radius || !scaleX || !scaleY) return null;

        const rect = element.getBoundingClientRect();
        // The canvas backing store can differ from its CSS box; the renderer
        // works in backing-store units, so the pointer has to be converted into
        // them before anything else.
        const toBackingX = (canvas.getSize?.().width || rect.width) / rect.width;
        const toBackingY = (canvas.getSize?.().height || rect.height) / rect.height;

        const localX = (clientX - rect.left) * toBackingX - (canvas.getSize?.().width || rect.width) / 2;
        const localY = (clientY - rect.top) * toBackingY - (canvas.getSize?.().height || rect.height) / 2;

        return {
            x: (localX - (canvas.translateOffsetX || 0) * scaleX) / scaleX / radius,
            y: (localY - (canvas.translateOffsetY || 0) * scaleY) / scaleY / radius,
        };
    }

    /**
     * Viewport coordinates for a normalised disk point.
     *
     * The forward direction of pointerToDisk, and the two have to stay each
     * other's inverse — they are the only places this projection is written
     * down outside the renderer.
     *
     * @param {{x: number, y: number}} point - normalised disk coordinates
     * @returns {{x: number, y: number}|null}
     */
    diskToViewport(point) {
        const ht = this.getHypertree?.();
        const canvas = ht?.canvas;
        const element = canvas?.getElement?.();
        if (!element || typeof ht.getRadius !== 'function') return null;

        const rect = element.getBoundingClientRect();
        const size = canvas.getSize?.() || { width: rect.width, height: rect.height };
        const radius = ht.getRadius();
        const scaleX = canvas.scaleOffsetX || 1;
        const scaleY = canvas.scaleOffsetY || 1;

        const backingX = point.x * radius * scaleX + (canvas.translateOffsetX || 0) * scaleX + size.width / 2;
        const backingY = point.y * radius * scaleY + (canvas.translateOffsetY || 0) * scaleY + size.height / 2;

        return {
            x: rect.left + backingX * (rect.width / size.width),
            y: rect.top + backingY * (rect.height / size.height),
        };
    }

    /**
     * The midpoint of the arc an edge is drawn as, in disk coordinates.
     *
     * Halfway along the *drawn* curve, not halfway between the endpoints: on a
     * long edge near the rim those are a long way apart, and the useful place
     * to put a label is on the line.
     *
     * @param {{from: {x: number, y: number}, to: {x: number, y: number}}} edge
     * @returns {{x: number, y: number}}
     */
    midpointOf(edge) {
        const arc = arcThroughTwoPoints(edge.from, edge.to);
        if (!arc) {
            return {
                x: (edge.from.x + edge.to.x) / 2,
                y: (edge.from.y + edge.to.y) / 2,
            };
        }

        const TAU = Math.PI * 2;
        const wrap = (value) => ((value % TAU) + TAU) % TAU;
        const begin = Math.atan2(edge.to.y - arc.y, edge.to.x - arc.x);
        const end = Math.atan2(edge.from.y - arc.y, edge.from.x - arc.x);
        const counterclockwise = arcSense(begin, end);
        const span = counterclockwise ? wrap(begin - end) : wrap(end - begin);
        const angle = counterclockwise ? begin - span / 2 : begin + span / 2;

        return {
            x: arc.x + arc.radius * Math.cos(angle),
            y: arc.y + arc.radius * Math.sin(angle),
        };
    }

    /**
     * Whether a node is under the point, in which case edges stand aside.
     *
     * Measured against the radius the renderer actually drew: `dim` shrinks
     * with distance from the centre when `Node.transform` is on, so a rim node
     * is a far smaller target than a central one and a fixed radius here would
     * block edges around nodes that are barely visible.
     *
     * @param {number} clientX
     * @param {number} clientY
     * @returns {boolean}
     */
    nodeUnderPointer(clientX, clientY) {
        const ht = this.getHypertree?.();
        const graph = ht?.graph;
        if (!graph?.eachNode) return false;

        const transform = ht.config?.Node?.transform !== false;
        const defaultDim = ht.config?.Node?.dim || 9;
        let found = false;

        graph.eachNode((node) => {
            if (found) return;

            const position = node.pos?.getc?.();
            if (!position) return;

            const screen = this.diskToViewport(position);
            if (!screen) return;

            let dim = node.getData?.('dim') ?? defaultDim;
            if (transform) {
                dim *= 1 - (position.x * position.x + position.y * position.y);
            }

            const reach = Math.max(dim, 0) + NODE_PRIORITY_MARGIN_PX;
            if (Math.hypot(clientX - screen.x, clientY - screen.y) <= reach) found = true;
        });

        return found;
    }

    /**
     * The edge under a viewport point, or null.
     *
     * @param {number} clientX
     * @param {number} clientY
     * @returns {{id: string, adj: object, other: object}|null}
     */
    pickAt(clientX, clientY) {
        if (this.nodeUnderPointer(clientX, clientY)) return null;

        const point = this.pointerToDisk(clientX, clientY);
        if (!point) return null;

        const live = this.candidates();
        if (live.length === 0) return null;

        const ht = this.getHypertree();
        const canvas = ht.canvas;
        const radius = ht.getRadius();
        const pixels = canHover(this.win) ? PICK_RADIUS_MOUSE_PX : PICK_RADIUS_TOUCH_PX;
        // The threshold is quoted in pixels but the geometry is in disk units,
        // and the conversion moves with the zoom: a fixed disk-space tolerance
        // would be a huge target zoomed in and an unhittable one zoomed out.
        const maxDistance = pixels / (radius * (canvas.scaleOffsetX || 1));

        const hit = pickEdge(live, point, maxDistance);
        if (!hit) return null;

        return live.find((candidate) => candidate.id === hit.id) || null;
    }

    /** @param {MouseEvent} event */
    handlePointerMove(event) {
        if (this.callbacks.shouldSuppress?.()) return;

        const hit = this.pickAt(event.clientX, event.clientY);
        if (!hit) {
            this.clear();
            return;
        }
        if (hit.id === this.highlightedId) {
            this._positionLabel(event.clientX, event.clientY);
            return;
        }

        this.clear();
        this._highlight(hit);
        this._positionLabel(event.clientX, event.clientY);
    }

    /**
     * A click on the canvas.
     *
     * @param {MouseEvent} event
     * @returns {boolean} true when the click was consumed by an edge
     */
    handleClick(event) {
        if (this.callbacks.shouldSuppress?.()) return false;

        const hit = this.pickAt(event.clientX, event.clientY);
        if (!hit) {
            this.clear();
            return false;
        }

        // With a hovering pointer the edge is already highlighted and named, so
        // the click is unambiguous and travels. Without one, the first tap is
        // what reveals where the edge goes, and only the second commits.
        if (!canHover(this.win) && this.armedId !== hit.id) {
            this.clear();
            this._highlight(hit);
            this.armedId = hit.id;
            // A finger covers the point it taps, so the label goes on the arc
            // rather than at the touch.
            const onArc = this.diskToViewport(this.midpointOf(hit));
            if (onArc) this._positionLabel(onArc.x, onArc.y);
            else this._positionLabel(event.clientX, event.clientY);
            event.stopPropagation();
            event.preventDefault();
            return true;
        }

        // Shields the click from document-level listeners; JIT has already had
        // its mouseup and found no node, so there is nothing to cancel there.
        event.stopPropagation();
        event.preventDefault();
        this.clear();
        this.callbacks.navigate(hit.other.id);
        return true;
    }

    /**
     * Whether this adjacency is the highlighted one.
     *
     * The navigator does not paint. It could not: the graph restyles every edge
     * from the palette on every plot (`onBeforePlotLine`), so a colour written
     * here survives exactly until the next frame — which is the same frame,
     * because highlighting ends in a plot. So the renderer asks instead, and
     * the highlight outlives any number of re-plots.
     *
     * @param {object} adj
     * @returns {boolean}
     */
    isHighlighted(adj) {
        return !!this.highlightedId && this.highlightedId === edgeId(adj);
    }

    /**
     * How a highlighted edge should be drawn, given its own weight.
     *
     * @param {number} baseWidth - the width the palette chose
     * @returns {{color: string, lineWidth: number}}
     */
    highlightStyle(baseWidth) {
        return {
            color: HIGHLIGHT_COLOR,
            lineWidth: Math.max(HIGHLIGHT_MIN_WIDTH, (baseWidth || 1) * HIGHLIGHT_WIDTH_MULTIPLIER),
        };
    }

    /** Drop any highlight and label. Called on selection change and re-layout. */
    clear() {
        const had = this.highlightedId !== null;
        this.highlightedId = null;
        this.armedId = null;
        this.element?.classList.remove('edge-hover');
        this._hideLabel();
        // Only when something changed: a mousemove across empty canvas calls
        // this on every pixel, and a plot per pixel is a frozen graph.
        if (had) this.callbacks.plot();
    }

    /** @private */
    _highlight(hit) {
        this.highlightedId = hit.id;
        // Says "this is clickable" before the click, which is the whole point
        // of highlighting it in the first place.
        this.element?.classList.add('edge-hover');
        this.callbacks.plot();
        this._showLabel(hit);
    }

    /** @private */
    _showLabel(hit) {
        const element = this._ensureLabel();
        const name = hit.other.name || hit.other.id;
        const relation = describeRelation(hit.adj);

        element.replaceChildren();
        const nameEl = document.createElement('span');
        nameEl.className = 'edge-label-name';
        nameEl.textContent = name;
        element.appendChild(nameEl);

        if (relation) {
            const relEl = document.createElement('span');
            relEl.className = 'edge-label-relation';
            relEl.textContent = relation;
            element.appendChild(relEl);
        }
        element.hidden = false;
    }

    /** @private */
    _positionLabel(clientX, clientY) {
        if (!this._label || this._label.hidden) return;
        // Offset up and right of the pointer so the arc under it stays visible.
        this._label.style.left = `${clientX + 14}px`;
        this._label.style.top = `${clientY - 10}px`;
    }

    /** @private */
    _hideLabel() {
        if (this._label) this._label.hidden = true;
    }

    /** @private */
    _ensureLabel() {
        if (!this._label) {
            this._label = document.createElement('div');
            this._label.className = 'edge-label';
            this._label.hidden = true;
            document.body.appendChild(this._label);
        }
        return this._label;
    }
}

/** A stable identity for an adjacency, independent of direction. */
export function edgeId(adj) {
    const a = adj.nodeFrom.id;
    const b = adj.nodeTo.id;
    return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * What to call the relationship, in words rather than schema case.
 *
 * @param {object} adj
 * @returns {string}
 */
export function describeRelation(adj) {
    const type = adj.data?.type || adj.getData?.('type') || '';
    const role = adj.data?.role || adj.getData?.('role') || '';

    const label = {
        MEMBER_OF: 'member',
        GUEST_ON: 'guest',
        PERFORMED_ON: 'performed on',
        IN_RELEASE: 'on release',
        RECORDING_OF: 'recording of',
        WROTE: 'wrote',
        SAMPLES: 'samples',
        RELEASED: 'released',
    }[type] || type.toLowerCase().replace(/_/g, ' ');

    // The role is the useful half for a band member — "drums" says more than
    // "member" does.
    if (role && label) return `${label} · ${role}`;
    return role || label;
}
