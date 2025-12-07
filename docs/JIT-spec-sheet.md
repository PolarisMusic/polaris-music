# JavaScript InfoVis Toolkit (JIT) – Documentation & Spec Sheet

## Overview of JIT

The JavaScript InfoVis Toolkit (JIT) is an open-source library for creating interactive data visualizations on the web. JIT provides a variety of ready-made visualization classes (trees, graphs, charts, etc.) and utilities to load data and render it on an HTML `<canvas>` element. The current stable release is v2.0.1. All JIT classes and methods are exposed under the global `$jit` namespace. 

Key features of JIT include: dynamic graph layouts (e.g. force-directed, hyperbolic), interactive tree visualizations with animations (expand/collapse, focus transitions), and basic chart types (pie, bar, area charts). JIT supports multiple rendering modes for labels (Canvas, HTML, or SVG) and comes with default mouse/touch event handling, tooltip support, node style animations on hover/click, and more (all configurable via options). 

In a typical usage, you create a JIT visualization by instantiating one of the  `$jit` classes (e.g. `$jit.Hypertree`, `$jit.RGraph`, `$jit.ST`, etc.), passing in a configuration object with options, then load your data (in JSON format) via `loadJSON()`, and finally call plotting methods like `refresh()` or `plot()` to render. The library handles canvas setup, layout computation, and interactive animations.

## JSON Data Format and Loading

JIT uses a JSON data structure to represent either a tree or a graph (network). All data nodes must have at least an `id` (unique identifier) and a `name` (display label). Additional custom attributes can be stored in a `data` object for each node. For hierarchical trees, each node has a `children` array listing its child nodes. For general graphs (arbitrary networks), each node has an `adjacencies` array instead of `children`. 

There are two supported graph formats:

- Simple Graph format: each node’s `adjacencies` is an array of strings (node IDs) representing edges to those other nodes.

- Extended Graph format: each entry in `adjacencies` is an object with a `nodeTo` property (the target node’s ID) and a `data` property for any edge-specific data (e.g. weights). This allows storing attributes for the edge itself.

### Example (Tree): A tree JSON has nested children:
```js
var treeJson = {
  "id": "root1",
  "name": "Root Node",
  "data": { /* custom node data */ },
  "children": [
    {
      "id": "child1",
      "name": "Child Node",
      "data": { /* ... */ },
      "children": [ /* ... */ ]
    },
    /* ... other children ... */
  ]
};
```
Example (Graph): A graph JSON is an array of node objects:
```js
var graphJson = [
  {
    "id": "node1",
    "name": "Node 1",
    "data": { /* ... */ },
    "adjacencies": [
      "node2", "node3"  // simple format: edges to node2 and node3
    ]
  },
  {
    "id": "node2",
    "name": "Node 2",
    "data": { /* ... */ },
    "adjacencies": [
      {"nodeTo": "node1", "data": {"weight": 5}},  // extended format edge with data
      {"nodeTo": "node3", "data": {"weight": 2}}
    ]
  },
  // ...other nodes...
];
```
When you have your JSON data ready, you load it into a visualization using the `loadJSON(json [, i])` method
. The optional second parameter `i` is used for graphs to specify which node index to treat as the root (or focal node). For example, `viz.loadJSON(graphJson, 0)` would load the graph and focus on the first node in the array. 

Customizing Data via $-prefixed properties: JIT reserves any data keys prefixed with `$` for special uses. If you include properties like `$foo` in a node’s or edge’s data, they can override global visualization settings on a per-element basis (provided the relevant option is marked `overridable: true` in the config, see “Options” below). For instance, `$color` in a node’s data overrides the node’s default color, and `$lineWidth` in an edge’s data overrides that edge’s width. In general, “adding dollar-prefixed properties that match the names of options defined in Options.Node will override the general value for that option” (per node) if `Node.overridable = true`. 

Likewise, “dollar-prefixed data properties will alter values set in Options.Edge” (per edge) if `Edge.overridable = true`. This mechanism lets you style individual nodes or edges (size, color, type, etc.) directly from the JSON. 

Some commonly used $-properties include: `$type` (to specify a node’s shape type), `$dim` (node dimension like radius), `$color`, `$alpha` (opacity), `$height`, `$width`, `$lineWidth` (edge width), `$direction` (for directed edges), `$label-*` (for label-specific overrides, e.g. `$label-size`), and so on. For radial layouts, `$angularWidth` can be used to allocate a proportion of angular space to a node (see “Radial layouts” below). JIT also allows canvas-specific overrides via `$canvas-` prefix for advanced uses (e.g. `$canvas-shadowBlur` to set a specific node’s shadow blur on canvas).

## Visualization Types (Classes)

JIT offers multiple visualization classes under $jit for different data displays. All of them share a similar API for loading data and common options, but each has a distinct layout or interaction style. Below is a list of main visualization classes and their purposes:
Tree/Graph Visualizations:

- $jit.ForceDirected – Force-directed layout for graphs. Uses a physics simulation (spring-force algorithm) to iteratively lay out nodes. Ideal for undirected networks. Supports incremental layout (`computeIncremental`) and animation of node positions.
- $jit.Hypertree – Hyperbolic tree/graph visualization (focus+context in the Poincaré disk). Displays a tree or graph in a hyperbolic plane, allowing magnification of the focused node and its neighbors while others appear toward the perimeter. Based on Lamping et al. hyperbolic browser idea. Useful for large hierarchies with interactive focus changes.
- $jit.ST (SpaceTree) – A traditional node-link SpaceTree with smooth animation for expanding/collapsing subtrees. Supports multiple orientations (top, left, right, bottom) and alignment options for the tree. Good for organizational charts or file trees.
- $jit.RGraph (Radial Graph) – Radial layout tree/graph with animated transitions. Nodes are placed in concentric circles by tree depth (or graph distance) around a center. Inspired by radial graph exploration research. Often used to create sunburst or pie-like visualizations when combined with custom drawing (see “Composing Visualizations” below).
- $jit.Sunburst – Radial space-filling tree visualization (sunburst diagram). Each node is drawn as an annular sector (donut slice) of a circle, with the root at the center and deeper levels outward. Good for representing hierarchies in a compact form (e.g. directory structures). Supports customization of angular widths and node heights per data.
- $jit.Icicle – Another space-filling hierarchy display, but uses Icicle (stacked rectangles) layout (like a linear sunburst). Shows hierarchical data with nested rectangles (root at top, children below). Useful for tree maps and such.
- $jit.TreeMap – Implements various treemap algorithms (Squarified, Strip, Slice-and-Dice) for visualizing hierarchical data in nested rectangles.
- $jit.AreaChart, $jit.BarChart, $jit.PieChart – Built-in simple chart visualizations for plotting numeric data. These are not for node-link structures but for conventional charts (they accept a different format of data). Note: These chart classes are distinct from using an RGraph to simulate a pie chart.

For completeness, other specialized visualizations included in JIT are $jit.Spacetree (ST) (alias of SpaceTree), $jit.TM (treemap base class), and helper classes for complex visualizations. Most of the above (except the static charts) implement a common interface for graph handling. 

Summary of some class descriptions:

- Hypertree: “A Hyperbolic Tree/Graph visualization” (focus+context on a hyperbolic disk).

- RGraph: “A radial graph visualization with advanced animations” (circular layout for graphs/trees).

- ST (SpaceTree): “A Tree layout with advanced contraction and expansion animations” (animated expandable tree).

- ForceDirected: “Lays graphs using a Force-Directed layout algorithm” (physics-based network layout).

- Sunburst: A radial space-filling tree (each node as an annular sector, often with size proportional to a value) – the JIT Sunburst allows linking nodes across rings (see Connected Sunburst demo).

- Icicle: An icicle diagram (space-filling hierarchy) similar to a vertical treemap.

Each visualization class typically inherits a base set of options (Canvas, Node, Edge, etc.) and defines its own defaults or additional options. For example, Hypertree by default uses `Edge.type = 'hyperline'` (curved hyperbolic edges), and SpaceTree uses `Node.type = 'rectangle'` by default for its node boxes.

### Notable Methods & Behavior

All visualizations share certain methods:
- `loadJSON(json[, i])`: Load the JSON data structure into the visualization (tree or graph). (As described above, `i` can set initial root for graphs).
- `refresh()`: Recompute node positions (if needed) and render the visualization afresh. Typically called after `loadJSON` for static layout; it ensures the canvas is cleared and all elements drawn.
- `plot()`: Render the visualization without recomputing layout (shortcut to the internal plotting routine). Often `refresh()` calls this internally.
- `onClick(nodeId[, options])`: For visualizations that support centering/focusing (e.g. Hypertree, RGraph, ST), `onClick` will animate the view to center on the specified node. You pass the target node’s id and optional parameters (like `{ hideLabels: false }` to keep labels visible during animation). This is commonly used in an `onCreateLabel` handler to make nodes clickable, as shown in many examples.
- `compute() / computePositions()`: Some visualizations (especially graphs like RGraph, ForceDirected, etc.) require an explicit compute step if not using `refresh()`. For example, after loading data into an RGraph, you call `rgraph.compute()` to calculate the node positions before plotting.
- `graph` property: After loading data, `viz.graph` gives access to the internal Graph structure (through which you can traverse nodes, find a node by id, etc.). Each node is a `Graph.Node` with properties like `id`, `name`, `data`, and `methods` to get its connections.
- `canvas` property: Provides access to the Canvas instance (for low-level drawing or to reuse canvases in composed visualizations).
Additionally, certain classes have specialized methods. For instance, SpaceTree (ST) supports `st.switchPosition(orientation, method[, onComplete])` to change tree orientation (e.g. left-to-right vs top-down) with or without animation. ForceDirected has `computeIncremental(opt)` for progressive layout computation to avoid blocking UI and an `animate()` to smoothly transition to computed end positions. These class-specific functions are detailed in the JIT docs for each visualization.

## Global Options and Configuration

When instantiating a visualization (e.g. `new $jit.Hypertree({ /* options */ })`), you pass an options object. Many option fields are common across visualizations. Below we document the major option categories and fields:

### Canvas & Initialization Options

- `injectInto` (string|HTMLElement, required): The ID of the container DOM element (e.g. a `<div>`) where the canvas will be injected. JIT will append its `<canvas>` (and associated label container if needed) to this element.
- `width`, `height` (number): Dimensions of the canvas in pixels. By default, if these are not specified, the canvas will size to its container’s offsetWidth/offsetHeight. You can provide explicit values to set a fixed size.
- `background` (object|boolean): By default `false`. If an object is provided, JIT will create an extra background canvas layer and draw on it according to the given styles or configuration. For example, setting `background: { CanvasStyles: { strokeStyle: '#555' }}` on an RGraph will draw concentric circle guidelines in the background. (Not all visualizations use a background layer, but RGraph and some charts do if configured.)
- `useCanvas` (false | object): Allows reusing an existing Canvas instance. By default false, meaning JIT creates a new canvas. If you have multiple visualizations to overlay, you can have one use the canvas of another by passing `useCanvas: otherViz.canvas`. This is crucial for composing visualizations (see next section).
- `withLabels` (boolean): Default `true`. If true, JIT will create a separate HTML/SVG container for text labels. Set this to false if you want absolutely no labels or plan to manage labels yourself. (In composed visualizations, inner viz often use `withLabels: false` to avoid conflicts.)
- `type`: Canvas context type – `'2D'` (default, normal Canvas) or `'3D'` for WebGL (if supported). JIT’s primary support is 2D.

## Nodes (Appearance & Shapes)

Node options control how nodes (graph vertices) are drawn. All visualizations that display nodes inherit Options.Node defaults. Key fields include:

- `Node.overridable` (boolean): Default `false`. Set to `true` if you plan to override node styling for individual nodes via $data properties in JSON (e.g. `$color`, `$type`). Must be true for per-node `$type` or other customizations to take effect.
- `Node.type` (string): The shape of the node. Default is `'circle'` in many visuals (some visuals override: e.g. SpaceTree default is rectangle). Built-in types include: `'circle'`, `'rectangle'`, `'square'`, `'ellipse'`, `'triangle'`, `'star'`. Each shape uses certain dimensions (see below). You can also register custom node types (see NodeType extension in a later section). If a node’s JSON `data` specifies `$type`, it will use that shape (overriding this default) as long as overridable is true.
- `Node.color` (string): Default node fill color (HTML color code). E.g. `"#ccb"` by default (a light gray). Supports any CSS color format. Individual nodes can override via `$color` in data if allowed.
- `Node.alpha` (number): Opacity from 0 (transparent) to 1 (opaque). Default is 1 (fully opaque). Can be overridden per node with `$alpha`.
- `Node.dim` (number): A generic size parameter (default 3) for certain shapes: for a circle this is the radius, for a square/triangle it’s half the side length (so the full square side = 2*dim), and for a star shape it might be treated as the side length. This is used only by circle, square, triangle, star shapes.
- `Node.height`, `Node.width` (number): Used by rectangle and ellipse node types. Default height=20, width=90. If your nodes have text labels inside, you might set these to accommodate. There are also `Node.autoHeight` and `Node.autoWidth` booleans (default false) which, if true, will automatically size the node’s bounding box to fit the label text (only for HTML/SVG labels).
- `Node.lineWidth` (number): Border line width for node shapes that are stroked (some shapes might be filled by default and use lineWidth for stroke outlines).
- `Node.transform` (boolean): Used only in Hypertree. Default is `true`, which means node positions will be transformed via the Möbius transformation for hyperbolic layout (making nodes appear smaller near edges of the disk). You typically leave this true for Hypertree; if set false, the nodes won’t scale with the hyperbolic transform (they’d all be same size).
- `Node.align` (string): Only for SpaceTree (ST). Can be `"center"`, `"left"`, or `"right"` (default center) to align child subtrees under their parent. This affects horizontal layout when node sizes vary.
- `Node.angularWidth` (number): Only for radial layouts (RGraph, Sunburst). A relative weight specifying how much angular space the node’s subtree takes in the layout. By default 1 for all nodes, meaning equal spacing, but if you set, say, one node’s `$angularWidth` larger, it gets a proportionally larger slice of the circle. (Sunburst uses this extensively – in the Connected Sunburst demo, nodes have `$angularWidth` and `$height` customized).
- `Node.span` (number): Also for radial layouts. Similar to angularWidth; it defines the angle span for a node. (In practice, JIT computes the layout such that either `angularWidth` or `span` influences the final angle. These are advanced parameters; typically you set `$angularWidth` in data rather than adjusting span directly.)
- `Node.CanvasStyles` (object): An object of raw canvas context properties to apply for node rendering. For example, you can specify `CanvasStyles: { shadowColor: "#ccc", shadowBlur: 10 }` to give nodes a shadow. This is applied globally to all nodes (unless overridden per node via `$canvas-*` properties as noted above).
- Built-in Node Shapes: By default, nodes are drawn using simple primitives via an internal `nodeHelper`. For example, a circle node calls the canvas arc API (centered at the node position with radius = dim); rectangles and others similarly. Each shape has an internal `contains` method for interactive hit-testing (so JIT knows if a mouse click was inside a given node). The built-in shapes are enumerated above (`circle`, `square`, etc.), and each is rendered as expected (ellipse uses width/height, triangle is an isosceles triangle of given base/height, star is a concave decagon shape). If needed, you can create custom shapes – see Custom Node Types below.

## Edges (Connections)

Edge options (`Options.Edge`) determine how connections between nodes (graph edges or tree parent-child links) are drawn. Main fields:
- `Edge.overridable` (boolean): Default false. Set true to allow per-edge customization via $ properties in adjacencies’ data (e.g. an edge data with $color or $lineWidth will override the default if this is true).
- `Edge.type` (string): Default `'line'` (straight line segments). Built-in edge types include:
  - `'line'` – straight line between nodes.
  - `'arrow'` – a directed edge drawn as a line with an arrowhead at the target end. The arrow size is influenced by the Edge.dim parameter (see below).
  - `'hyperline'` – hyperbolic arc used by Hypertree (curved lines drawn within the Poincaré disk).
  - Curved edges: JIT also supports quadratic and bezier curves. These are specified by composite names, e.g., `'quadratic:begin'`, `'quadratic:middle'`, `'quadratic:end'` (curve with one control point at the beginning, middle, or end of the line), or `'bezier'` for a cubic bezier (if implemented). For example, the SpaceTree demo uses `Edge.type = 'quadratic:begin'` to draw gently curved connectors. (Under the hood, these use the `Edge.dim` as curve control offset).
Note: The default edge type can vary by visualization; e.g., Hypertree sets default to `'hyperline'` (since it’s required for proper distortion), and some tree visuals might default to straight `'line'`.
- `Edge.color` (string): Default edge color (hex or CSS color). Default is `"#ccb"` (light gray). Edges can be styled per connection with `$color` in adjacency data if allowed.
- `Edge.lineWidth` (number): Default line width = 1 pixel. Represents stroke width of lines or borders of arrows. Can override per-edge via `$lineWidth`.
- `Edge.dim `(number): Default 15. This is an extra length/size parameter used by certain edge types:
  - For `'arrow'`, `dim` is typically the length of the arrowhead (in pixels).
  - For `'quadratic'` or `'bezier'` curves, `dim` might control the curve offset or shape diameter (e.g., how “curved” the line is).
  - It may also be used by other complex edge renderings if any.
- `Edge.alpha` (number): Opacity of edges (0 to 1). Default 1 (opaque).
- `Edge.epsilon` (number): Default 7. This is only relevant if enabling edge mouse events (see Events). It defines a fuzzy hit-test radius for edges. When `enableForEdges` is true (in Events), JIT will consider a mouse near an edge within `epsilon` pixels as “over” that edge.
- `Edge.CanvasStyles`: Similar to Node’s, allows custom canvas context settings for edges (e.g. dashed lines via `lineDash` if supported, or shadow for edges).
All edges are drawn as either solid strokes or filled shapes (arrows). JIT’s internal `edgeHelper` handles basic drawing: `line.render(from, to, canvas), arrow.render(from, to, dim, swap, canvas)` (where swap indicates direction), `hyperline.render(from, to, R, canvas)` (Hyperline uses a complex math to draw an arc within radius R). The curved edges (quadratic, bezier) are implemented by the plotting engine using the given control points and likely rely on the built-in Canvas quadraticCurveTo()/bezierCurveTo functions. If needed, you can also create custom edge types via `EdgeTypes.implement` (similar to NodeTypes).

## Labels (Text Labels)

Label options (`Options.Label`) control how node labels (text) are rendered and styled. JIT supports three label types:
- `Label.type`: `'HTML'` (default), `'SVG'`, or `'Native'`.
  - HTML: Each label is an HTML `<div>` absolutely positioned over the canvas. This allows rich styling via CSS, but too many labels can be slower. When using HTML labels, JIT will create a container `<div>` inside your `injectInto` element to hold all label DIVs.
  - SVG: Similar to HTML in that labels are DOM elements, but uses SVG `<text>` elements appended to an SVG container for the labels. Allows vector text (better scaling) and CSS styling.
  - Native: Labels are drawn on the canvas directly using the Canvas text API (no separate DOM elements). This can be faster for many labels, but styling options are limited (no hypertext or line breaks, etc., only one font style).
  - The default `'auto'` in some contexts will choose HTML or Native depending on browser capabilities, but generally you should set it explicitly if needed. In the JIT demos, it often checks a flag like `nativeTextSupport` to decide between Native and SVG.
- `Label.size` (number): Font size in pixels (default 10). Only applies for Native labels. For HTML/SVG labels, you would set font-size via CSS instead (JIT will add a CSS class to each label, see below).
- `Label.family` (string): Font family (default `'sans-serif'`). (Native only; for DOM labels, use CSS).
- `Label.style` (string): Font style – `'italic'` or `'bold'` or empty for normal. (Native only; for DOM, use CSS or element class.)
- `Label.color` (string): Text color (default `#fff`, white). (Native only; DOM labels use CSS.)
- `Label.textAlign` and `Label.textBaseline`: Alignment for canvas text. Default `'center'` and `'alphabetic'` respectively. These roughly correspond to CSS text-align and vertical alignment but for canvas drawing context. (Only for Native labels.)
- `Label.overridable`: Similar to Node/Edge, if `true`, allows per-node label overrides via `$label-*` properties in data. For instance, a node can have `$label-size` or `$label-color` in its data to tweak its own label style.
Styling HTML/SVG Labels: When using HTML or SVG labels, JIT will create DOM elements for each node’s label. Each such element gets an id corresponding to the node id, and a CSS class (by default “node” or similar). You can style them via external CSS if needed (e.g. setting `.node { font-size: 12px; font-family: Arial; }`). Additionally, you can adjust label content or style dynamically in the controller callbacks (onCreateLabel/onPlaceLabel). For example, in many JIT demos:
- `onCreateLabel(domElement, node)` is used to set the label text (`domElement.innerHTML = node.name`) and to attach events or additional styling. If Label type is HTML/SVG, you could also set a CSS class or style here.
- `onPlaceLabel(domElement, node)` is called whenever a label is (re)positioned, which happens after each plot or animation step. This is often used to adjust label positions or hide/show based on node state. For example, one common pattern is to center labels by adjusting the left position by half the label width (since default positioning might be top-left). E.g.:
  ```js
  onPlaceLabel: function(label, node) {
    var style = label.style;
    style.left = (parseInt(style.left) - label.offsetWidth/2) + "px";
  }
  ```
  which recenters an HTML label horizontally. In the Sunburst example, onPlaceLabel also changes font size/color for labels at certain depths and ensures the label is visible (display != 'none').
Important: If using Native labels, the styling must be done via the Label options (size, family, color) or via `onBeforePlotNode` controller to set custom context font for specific nodes. With HTML/SVG labels, more complex styling (multi-line text, different fonts per node, etc.) is possible by manipulating the DOM element in onCreateLabel.

## Animation & Interaction Options

JIT provides a set of options for animations (Options.Fx), event handling (Options.Events), interactive controls (Options.Navigation), and additional UI like tooltips (Options.Tips). We highlight the most commonly used:
- transition (in some visualizations’ config or under Fx): The animation transition type/easing. JIT has an $jit.Trans object with easing functions (e.g. $jit.Trans.Linear, $jit.Trans.Quart.easeIn, $jit.Trans.Back.easeOut, etc.). You can set transition: $jit.Trans.Back.easeOut for a bouncy animation, for example. Default is usually linear or sine.
- duration: Animation duration in milliseconds (default often ~250 or 500ms; Hypertree’s default was changed to 1500ms). You can set e.g. duration: 1000 for 1 second animations.
- fps: Frames per second for the animation (default ~40). Higher fps means smoother but potentially more CPU usage.
- hover/click highlight via NodeStyles: JIT can automatically animate node style changes on hover or selection. The Options.NodeStyles config allows enabling this feature. For example:
  ```js
  NodeStyles: {
    enable: true,
    type: 'Native',
    stylesHover: { dim: 30, color: "#f77" },
    stylesClick: { color: "#33dddd" },
    duration: 600
  }
  ```
  would smoothly enlarge a node to dim=30 and change color on mouse over, and change to a teal color when clicked (and keep it until another is selected). The `type` here, like Events, decides whether to attach to canvas or DOM labels (use `"Native"` if using native or auto). If `stylesHover` or `stylesClick` is set to an object of Node options (same keys as Node, e.g. `color`, `dim`, etc.), those will be tweened on hover/click. If set to `false`, that state is disabled. Note: you must also have `Events.enable` on to get these interactions (and not override the event handlers).
- `Navigation`: Enables panning/zooming interactions (useful especially for ForceDirected or large graphs):
  - `Navigation.enable: true` to turn on nav support.
  - `Navigation.panning`: can be `true` for drag-to-pan, or `'avoid nodes'` to allow dragging empty space to pan but not when clicking a node (to avoid conflict with node dragging).
  - `Navigation.zooming`: set a numeric value (e.g. 20) to enable mouse wheel zoom; the number adjusts zoom sensitivity. With zooming enabled, scrolling the mouse wheel over the canvas will zoom in/out centered on the cursor.
- `Events`: Low-level event handling. By default, each visualization has an internal controller that manages events like onClick (centering a node) if you haven’t overridden it. To handle custom interactions:
  - Set `Events.enable: true` to activate event tracking for nodes. With this on, JIT will listen for mouse/touch events on the canvas or label elements.
  - `Events.type`: `'auto'` (default) will attach events to HTML/SVG labels if those are used, otherwise to the canvas itself. You can force `'Native'` to always use canvas events or `'HTML'` to always use DOM events.
  - There are numerous event callbacks: `onClick(node, eventInfo, e)`, `onRightClick`, `onMouseMove`, `onMouseEnter`, `onMouseLeave`, `onDragStart`, `onDragMove`, `onDragEnd`, `onDragCancel`, `onTouchStart/Move/End/Cancel`, and `onMouseWheel`. Each is optional; provide a function if you need to handle that event. The node argument will be the `Graph.Node` under the cursor (or being dragged, etc.), or `false` if none. The `eventInfo` provides helpers like `getPos()` (mouse position relative to canvas). The raw DOM event is also passed as `e`.
  - Example: to change cursor on hover, you could do:
  ```js
  onMouseEnter: function(node, evtInfo, e) {
    if(node) $jit.id('infovis').style.cursor = 'pointer';
  },
  onMouseLeave: function(node, evtInfo, e) {
    $jit.id('infovis').style.cursor = '';
  }
  ```
  Or to define a custom click behavior, use `onClick` and within it you have access to the node clicked. (If you use the built-in centering via calling `viz.onClick(node.id)`, you might call that in your handler or override entirely.)
  - Edge events: If you set `enableForEdges: true`, the same callbacks will fire for edges too (with the `node` argument being a Graph.Adjacence object for edges). In your handler you can detect if `node.nodeFrom` exists to tell it's an edge. Remember to set a proper `Edge.epsilon` for easier edge hovering.
- `Tips`: Built-in tooltip system for node hover. To enable, set `Tips.enable: true`. You can specify:
  - `Tips.type` (`'auto'`/`'Native'`/`'HTML'`): similar to Events, decides whether tooltip events are attached to canvas or DOM labels. Default `auto` (follows label type).
  - `Tips.offsetX`, `Tips.offsetY`: pixel offsets for the tooltip’s position relative to cursor (defaults 20px right and down).
  - `Tips.onShow(tip, node)` callback: define how to populate the tooltip. `tip` is the HTML `<div>` element that will be shown (with CSS class “tip”), and `node` is the node (or edge) being hovered. For example:
  ```js
  Tips: {
    enable: true,
    onShow: function(tip, node) {
      // e.g., display node name and some data
      tip.innerHTML = "<b>" + node.name + "</b><br>" + node.data.info;
    }
  }
  ```
  - `Tips.onHide()` if needed to cleanup after hiding (often not used, as the tip div is hidden automatically).
  - JIT will create a single tooltip div (with class "tip") and reuse it for all tips. You can style it via CSS (e.g., a light background, border, etc.). Note: the toolkit does not supply default styling; you must define the CSS for `.tip` if you enable Tips (otherwise it may just be plain text on transparent background).
  - Tooltips require `Events.enable` true internally, so enable Tips implies events are on.

## Controller Callbacks (onCreateLabel, onBeforePlot, etc.)

JIT’s Options.Controller provides a set of callback hooks at different stages of computation and drawing. These are usually passed in the same options object. Common controller callbacks include:
- `onBeforeCompute(node)` – called right before the visualization begins computing positions/layout for a new operation (e.g. before an animation or loading new data). It receives the node that’s about to be centered or otherwise acted on. In demos, this is used to display a “loading” message or log which node is being centered.
- `onAfterCompute()` – called after all computations and animations have completed. E.g., you might use this to update some UI with final state.
- `onCreateLabel(domElement, node)` – as discussed, called once for each label when it is first created. Use this to initialize label content and event handlers. You receive the DOM element (or SVG element) for the label and the corresponding node.
- `onPlaceLabel(domElement, node)` – called every time a label is placed or repositioned (which can be many times during an animation or on refresh). Use this to update label styling/position dynamically. The DOM element’s left/top will already be set by JIT when this is called, so you often adjust from there. For SVG, you might adjust the text element attributes.
- `onBeforePlotNode(node)`, `onAfterPlotNode(node)` – called for each node right before/after it’s drawn. This is useful for applying per-node styles during rendering. For example, you could check `if(node.selected) { node.setData('color','#f00'); }` in onBeforePlotNode to highlight the currently selected node. (The example in docs uses `node.selected` to change color).
- `onBeforePlotLine(adj)`, `onAfterPlotLine(adj)` – similar, for each edge (Graph.Adjacence) before/after drawing. For example, to randomly vary line widths or colors, you could do so here, or to highlight edges connecting selected nodes as in the example.
- `request(nodeId, level, onComplete)` – used in hybrid situations where you want to load data on demand (e.g. not all children pre-loaded). This callback is invoked when an empty node (one with no children in current dataset) is clicked/expanded and JIT expects you to fetch its subtree. You need to handle retrieving additional JSON for that node and then call `onComplete.onComplete(newJSON)` with the data. JIT will then integrate that new subtree and render it. The parameters: `nodeId` is the id of node to load, `level` is how many levels of descendants to load (based on `levelsToShow` option, typically). This is used in SpaceTree and TreeMap when using their request mode (dynamic loading). If you are not using incremental loading, you can ignore this. By default `request` is `false` (no dynamic loading).
You can provide any subset of these controller functions in the options. They are very powerful for customizing behavior without modifying JIT’s core code.

## Creating Custom Node/Edge Types and Composite Visualizations

One of the advanced features of JIT is the ability to extend the rendering to create composite visualizations – for example, nodes that contain sub-visualizations (charts within nodes), or entirely new shapes.

### Implementing Custom Node Types

All visualization classes have a static object `Viz.Plot.NodeTypes` and `Viz.Plot.EdgeTypes` where `Viz` is the class (e.g. `$jit.RGraph.Plot.NodeTypes`). You can add new types by calling the `implement` method with a name and rendering functions. For example:
```js
$jit.RGraph.Plot.NodeTypes.implement({
  'mySpecialType': {
    'render': function(node, canvas) {
       // custom drawing using canvas context
       var ctx = canvas.getCtx();
       // ... draw something at node.pos ...
    },
    'contains': function(node, pos) {
       // optional: define hit test for interactivity
       // return true if the point 'pos' lies within the node’s shape
    }
  }
});
```
This will make `'mySpecialType'` a valid `Node.type`. You can then use it by setting `Node.type:'mySpecialType'` globally or `$type:'mySpecialType'` on specific nodes. 

JIT’s demos provide great references for custom types. For instance, the “Implementing Node Types” example defines custom node renderers to draw pie chart slices as nodes of an RGraph. Specifically, it adds a `'nodepie'` type that draws an arc (slice) corresponding to the portion of the circle that node represents:
```js
$jit.RGraph.Plot.NodeTypes.implement({
  'nodepie': {
    'render': function(node, canvas) {
       var ctx = canvas.getCtx();
       var span = node.angleSpan, begin = span.begin, end = span.end;
       var polarNode = node.pos.getp(true);  // node position in polar coords
       // Compute slice endpoints in Cartesian coords:
       var polar = new $jit.Polar(polarNode.rho, begin), p1 = polar.getc(true);
       polar.theta = end;
       var p2 = polar.getc(true);
       // Draw slice
       ctx.beginPath();
       ctx.moveTo(0, 0);
       ctx.lineTo(p1.x, p1.y);
       ctx.lineTo(p2.x, p2.y);
       ctx.arc(0, 0, polarNode.rho, end, begin, true);
       ctx.fill();
    }
  }
});
```
This draws a filled pie slice from angle begin to end (using the node’s precomputed `angleSpan` provided by RGraph). Each child node in an RGraph has an angleSpan that, combined with `$angularWidth` values, determines its slice size. With this custom `'nodepie'`, the RGraph can visually represent each node as a slice of a pie chart. 

Another example: the “shortnodepie” custom type draws a donut ring segment (an annular slice) by drawing two arcs (outer and inner) and connecting them. In the code, it uses `polar.rho` and `polar.rho + ldist` (where ldist = levelDistance) to get inner and outer radius coordinates, drawing an outer arc and an inner arc to make a donut sector. This was used to create a donut chart appearance (two concentric radii for slices). 

You can similarly implement any shape – e.g., a star with more points, a custom image, etc. Within the `render` function, you have access to `this.nodeHelper` which contains helpers to draw basic shapes easily (circle, rectangle, etc.). For hit-testing, implement `contains(node, pos)` to return true if `pos` (an `{x,y}` object) lies inside the node’s area; otherwise JIT won’t know how to detect clicks on it. 

For custom Edge types, the approach is similar via `Viz.Plot.EdgeTypes.implement({ ... })`. If you want, for example, a dashed line edge, you could implement a render that uses `ctx.setLineDash([...])` and then calls the base line draw.

## Composing Visualizations (Using One Visualization as a Node in Another)

A powerful pattern is embedding one visualization inside another. The JIT supports this by letting multiple visualizations share the same canvas and by using custom node types that trigger the drawing of a secondary visualization. This is how you can create compound visualizations like nodes that are pie charts. Key steps:

1. Create the inner visualization (e.g., a small RGraph that will serve as a pie/donut chart). Initialize it with its own data and do not attach it to the DOM separately – instead, you can inject it into the same container or even a dummy container, but the critical part is to set:
  - `withLabels: false` (we usually don’t want a separate set of labels for the inner viz).
  - `clearCanvas: false` (so that when the inner viz draws, it doesn’t clear the canvas).
  - Possibly a smaller `levelDistance` so it fits in a node.
  - And ensure Node types in the inner viz are appropriate (like `'nodepie'` or `'shortnodepie'` as above) to draw its pieces.
  You will call `innerViz.loadJSON(innerData)` and then `innerViz.compute()` (to prepare its layout). You typically do not call `innerViz.plot()` yet (you’ll call it later through the outer viz’s node renderer).
2. Configure the outer visualization to use the same canvas and a custom node type:
  - Set `useCanvas: innerViz.canvas` in the outer viz’s options. This ensures both visualizations draw on the same `<canvas>` element. The inner viz now effectively acts like an off-screen painter that we can invoke.
  - Define a custom Node type in the outer viz’s `Plot.NodeTypes` that, in its render function, draws the inner visualization at the node’s position. For example:
  ```js
  $jit.Hypertree.Plot.NodeTypes.implement({
    'piechart': {
      'render': function(node, canvas) {
         var ctx = canvas.getCtx();
         var pos = node.pos.getc(true);    // get node position in canvas coords
         ctx.save();
         ctx.translate(pos.x, pos.y);
         innerViz.plot();    // draw the inner visualization at (0,0)
         ctx.restore();
      },
      'contains': function(node, pos) {
         // define if needed, perhaps treat the entire bounding box of the pie as clickable
      }
    }
  });
  ```
  In the JIT Composing Visualizations example, they do exactly this: they create a custom node type `'piechart'` whose render function translates to the node’s position and calls `pie.plot()` (where `pie` is an RGraph instance). Because `pie.clearCanvas` was false, calling `pie.plot()` will draw the pie without wiping the whole canvas, thus drawing on top of whatever else is on the canvas. The `ctx.save()/ctx.restore()` ensures the translation doesn’t affect other drawing.
  - Now, for any node in the outer visualization that should display a pie chart, you can set that node’s `$type: 'piechart'` in its data. Alternatively, set the outer `Node.type` default to `'piechart'` if all nodes will be charts. In practice, you might have a mix – some nodes normal, some chart – so you would use `Node.overridable = true` and mark specific nodes.
  - If the outer visualization uses labels, you might want to hide labels for those chart-nodes (since the chart might include its own text). You could either not create labels for them by condition in onCreateLabel, or simply leave their name blank so no text shows.
3. Data synchronization: The inner visualization (pie chart) can either be static (same data drawn for every node that uses it), or you could maintain multiple inner visualizations. In the simplest case, one inner chart instance can be reused to draw the same chart at multiple nodes (as in the demo, where they used one pie RGraph with data and drew it at multiple outer RGraph nodes). This works if each node’s chart is supposed to be identical. If each node needs different chart data, you might need to either update the innerViz’s data before drawing each time (which could be complex), or instantiate multiple inner visualizations. A simpler approach is to encode the chart values into the node’s own data and then have the custom render draw something based on node’s data. For instance, you could implement a node type that reads node.data.values and draws a mini-chart using canvas commands directly (without a full second viz). But using an RGraph internally is convenient for complex charts.

In the JIT Composing Visualizations 2 demo, they show a SpaceTree with some nodes drawn as pie charts. They created one inner RGraph (`pie`) with data (a small pie) and used a custom `ST.Plot.NodeTypes.piechart` that calls `pie.plot()` at the node position. They also created two custom node shapes for the inner RGraph (`shortnodepie` as mentioned for donut slices). The result is a tree where each node is a donut chart showing some breakdown, and edges connect them in a hierarchy. 

When composing, be mindful of canvas layering: If two visualizations share a canvas, calling `outerViz.refresh()` will clear the canvas by default, wiping out any drawn inner charts. To avoid this, you have a couple options:
- Set `outerViz.config.clearCanvas = false` as well, so that replotting outer doesn’t blank the canvas (but then you must manage clearing intelligently, possibly only clearing portions).
- Or, more typically, you don’t call refresh on the inner viz at all except when its data changes. The inner viz’s plot is invoked inside the outer’s render routine, after the outer has drawn its elements (or as part of it). The outer viz can clear normally at start of each frame, then draw its pieces (which include calling inner plot per node).
In practice, the approach in the JIT examples is: initialize inner viz (pie) and compute it; then create outer viz with `useCanvas` and custom node type that calls `pie.plot()`; then load data into outer and call outer.refresh(). During outer.refresh, each time a node of type 'piechart' is drawn, it calls `pie.plot()` which draws the pie on the same canvas. Because clearCanvas was false for pie, it doesn’t clear what outer drew. Because outer does clear canvas at the start of refresh, each frame is clean. So it works out nicely: every frame, outer clears and redraws all nodes (some of which invoke pie.draw). Thus the composed charts move/animate with the nodes.

To summarize, composing visualizations involves reusing the canvas (`useCanvas`) and a custom node renderer that calls another visualization’s `plot()`. This technique can be used to embed any visualization inside another (e.g., you could put a BarChart inside nodes of a TreeMap, etc.), as long as you handle sizing and coordinate transforms appropriately. It’s a powerful way to avoid “hallucinating” unsupported features – instead you actually combine real features of JIT to achieve complex visuals.

## Conclusion

The JavaScript InfoVis Toolkit is a feature-rich library. By using the documented API and patterns above, an LLM or developer can construct complex interactive diagrams without guessing undocumented behavior. Key points to remember:
- Data format: Understand tree vs graph JSON structure and use `loadJSON` appropriately. Use $-properties to override visuals per element (enable overridables).
- Options: Leverage global options (Node, Edge, Label, etc.) to control appearance. Set overridable flags when using per-node/edge styling. Use appropriate label type for your needs (Native vs HTML).
- Callbacks: Use controller events (onCreateLabel, onPlaceLabel, onBeforePlot, etc.) to inject custom logic at rendering time. This is safer than trying to manipulate DOM/canvas outside the JIT pipeline.
- Interactivity: Enable Events and Tips as needed and handle event callbacks to implement custom UI interactions beyond the default centering on click. Navigation can provide pan/zoom for large graphs.
- Extensibility: For special shapes or composite nodes, use NodeTypes/EdgeTypes extension. Combine visualizations by sharing canvases and custom render logic.

Following this spec sheet as a solid reference to generate correct JIT code without hallucinating nonexistent API. Always align code with these documented capabilities and the examples given, and any creative combination should be grounded in the described mechanisms.
