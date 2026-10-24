/**
 * Re-rooting the hypertree without scrambling it.
 *
 * Two things were wanted and seemed to be opposites. Re-rooting the layout tree
 * on the selection puts that node's own neighbours near the middle, which is
 * the only way the view is any use — measured, a plain translation leaves a
 * band's members at 0.937 while strangers two hops away sit at 0.809. But
 * rebuilding rearranged the scene, and a scene that rearranges cannot be
 * followed, so navigation stopped feeling like movement.
 *
 * They are not opposites. What makes a rebuild unfollowable is not that nodes
 * move — a translation moves every node too, and reads perfectly well. It is
 * that they move *past each other*. JIT's computePositions (jit.js:11961) hands
 * each node's children slices of its wedge in adjacency order, starting at the
 * wedge's first edge, with no reference to where any of them currently are. The
 * ring around a node is dealt out afresh every time, so neighbours swap sides
 * and the eye has nothing to hold on to.
 *
 * Radius carries the information (depth in the tree). Angle carries almost
 * none — it is an artefact of adjacency order. So this computes exactly the
 * radii JIT would, and chooses the angles to agree with the layout already on
 * screen:
 *
 *   - Each node's children are laid out in the cyclic order they are already
 *     in, as seen from that node. Nobody crosses anybody.
 *   - The root's wedge is the whole circle, so its offset is free; it is set to
 *     the circular mean of where its children already are. That one choice
 *     orients the entire scene, which is why no separate rotation step is
 *     needed afterwards.
 *   - Every other node inherits its wedge from its parent, which has already
 *     been placed stably, so the wedge already points the right way.
 *
 * What is left is motion along rays: nodes slide in and out as their distance
 * from the selection changes, which is the thing that actually changed. That
 * reads as the neighbourhood opening up rather than as a reshuffle.
 *
 * Deliberately not a patch to jit.js. The vendored library is read in a dozen
 * places in this project and a local edit to it would be invisible to all of
 * them; this is called instead of ht.compute('end'), and uses the library's own
 * level distances and angular widths so the radii are identical to its.
 */

/** Wrap to (-pi, pi]. */
function wrapSigned(angle) {
    const twoPi = Math.PI * 2;
    let a = angle % twoPi;
    if (a > Math.PI) a -= twoPi;
    if (a <= -Math.PI) a += twoPi;
    return a;
}

/**
 * The direction from one node to another, in the layout currently on screen.
 *
 * Read from `pos` rather than from the positions being computed: the whole
 * point is to agree with what the viewer is looking at now.
 */
function currentBearing(from, to) {
    const a = from.pos.getc(true);
    const b = to.pos.getc(true);
    return Math.atan2(b.y - a.y, b.x - a.x);
}

/**
 * Circular mean of a set of angles.
 *
 * Averaging angles as numbers puts 359 degrees and 1 degree at 180. Returns 0
 * for an empty or exactly cancelling set, where no mean direction exists.
 */
function circularMean(angles) {
    let re = 0;
    let im = 0;
    for (const a of angles) {
        re += Math.cos(a);
        im += Math.sin(a);
    }
    if (re === 0 && im === 0) return 0;
    return Math.atan2(im, re);
}

/**
 * Lay the tree out around `ht.root`, writing to the 'end' positions.
 *
 * Caller is responsible for having set ht.root. Levels and angular widths are
 * recomputed here, exactly as Hypertree.compute does, so the radii match what
 * the library would have produced.
 *
 * @param {object} ht - the Hypertree
 * @param {object} graphUtil - $jit.Graph.Util, for eachBFS
 */
/**
 * The least share of the circle a selected node's neighbour is guaranteed,
 * as a fraction of an equal split.
 *
 * Half: with six neighbours each is promised 30 degrees and the remaining
 * half of the circle is still dealt out by subtree size, so a branch that
 * needs room still gets most of it.
 *
 * The number is a judgement about legibility rather than a derivation. What
 * is not a judgement is the direction: a neighbour of the node you are looking
 * at is the most important thing on screen, and no amount of room for a
 * distant subtree is worth rendering it invisible.
 */
const ROOT_MIN_SHARE = 0.5;

/**
 * How much of a node's wedge each child gets.
 *
 * Everywhere but the selection, that is proportional to subtree size, which is
 * what JIT does and is right: a branch with four hundred descendants needs room
 * for them, and the radii only work if siblings do not overlap.
 *
 * At the selection it is wrong, and visibly so. The first ring is the
 * neighbourhood the viewer asked to see, and `_treeAngularWidth` makes no
 * distinction between "this child is a leaf" and "this child is worth looking
 * at": a band's five members, all leaves, were sharing a couple of degrees
 * between them while one sibling with a large subtree took essentially the
 * whole circle. The members ended up bunched in a slot narrower than their own
 * labels — which is the complaint, and it is not a cosmetic one, because the
 * neighbours are the answer to the question the click asked.
 *
 * So each neighbour of the selection is floored at a fraction of an equal
 * split and the remainder is dealt proportionally. Shares stay monotone in
 * subtree size — a bigger branch still gets more — and they still sum to one,
 * so no wedge overflows and the no-crossing property is untouched: only the
 * widths change, never the order.
 *
 * @param {object[]} children - Already in their stable cyclic order.
 * @param {number} total - Sum of `_treeAngularWidth` over `children`.
 * @param {boolean} isRoot - Whether these are the selected node's own ring.
 * @returns {{child: object, share: number}[]} Shares summing to 1.
 */
function shares(children, total, isRoot) {
    const proportional = children.map((child) => ({
        child,
        share: child._treeAngularWidth / total,
    }));

    if (!isRoot || children.length < 2) return proportional;

    const floor = ROOT_MIN_SHARE / children.length;
    const remaining = 1 - floor * children.length;
    return proportional.map(({ child, share }) => ({
        child,
        share: floor + share * remaining,
    }));
}

export function computeStablePositions(ht, graphUtil) {
    const graph = ht.graph;
    const root = graph.getNode(ht.root);
    if (!root) return;

    graph.computeLevels(ht.root, 0, 'ignore');
    ht.computeAngularWidths(['end']);
    const getLength = ht.createLevelDistanceFunc();

    root.endPos.setp(0, 0);
    root.setData('span', Math.PI * 2, 'end');
    root.angleSpan = { begin: 0, end: Math.PI * 2 };

    graphUtil.eachBFS(graph, ht.root, (node) => {
        const children = [];
        node.eachSubnode((child) => {
            if (!child._flag) children.push(child);
        }, 'ignore');
        if (children.length === 0) return;

        const total = children.reduce((sum, c) => sum + c._treeAngularWidth, 0);
        if (!(total > 0)) return;

        const span = node.angleSpan.end - node.angleSpan.begin;

        // The radius every child of this node sits at. JIT reads the level
        // distance from the *parent* and hands it to the children (jit.js:11981
        // computes `len` from `elem`, then assigns it inside the child loop).
        // Reading it from the child instead puts everything one level too far
        // out — measured, one-hop neighbours landed at 0.832, which is exactly
        // the two-hop radius.
        const childRadius = getLength(node);

        // The direction each child is in right now. For the root that is a
        // bearing from the origin; for anyone else it is relative to the
        // parent's own current direction, so a wedge that straddles the 0/2pi
        // seam cannot split the ordering in half.
        const reference = node === root ? 0 : currentBearing(root, node);
        const bearings = new Map(
            children.map((c) => [c, wrapSigned(currentBearing(node, c) - reference)])
        );

        // Lay them out in the cyclic order they are already in. Nobody crosses
        // anybody, which is the property that makes the motion followable.
        children.sort((a, b) => bearings.get(a) - bearings.get(b));

        // Where each child would land, measured from the wedge's start.
        const offsets = [];
        let running = 0;
        for (const { child, share } of shares(children, total, node === root)) {
            const width = share * span;
            offsets.push({ child, begin: running, centre: running + width / 2, width });
            running += width;
        }

        // The root's wedge is the whole circle, so where its first child starts
        // is free — and it orients everything downstream. Put the fan where the
        // fan already is. Everyone else inherits a wedge that is already
        // pointing the right way, and must stay inside it.
        const start = node === root
            ? circularMean(offsets.map((o) => wrapSigned(bearings.get(o.child) - o.centre)))
            : node.angleSpan.begin;

        for (const { child, begin, centre, width } of offsets) {
            child.endPos.setp(start + centre, childRadius);
            child.setData('span', width, 'end');
            child.angleSpan = { begin: start + begin, end: start + begin + width };
        }
    }, 'ignore');
}
