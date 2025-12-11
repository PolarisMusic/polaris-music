# Visualization Implementation Plan

## Overview

This document provides a comprehensive implementation plan for the Polaris Music Registry frontend visualization using the JavaScript InfoVis Toolkit (JIT). The visualization displays music data as an interactive graph with Groups, Persons, and Releases as primary visual entities.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Node Type Specifications](#node-type-specifications)
3. [Edge Specifications](#edge-specifications)
4. [JIT Configuration](#jit-configuration)
5. [Custom Node Renderers](#custom-node-renderers)
6. [Interaction Behaviors](#interaction-behaviors)
7. [UI Components](#ui-components)
8. [Data Flow](#data-flow)
9. [Implementation Phases](#implementation-phases)

---

## Architecture Overview

### Technology Stack
- **Visualization Library**: JavaScript InfoVis Toolkit (JIT) v2.0.1
- **Primary Visualization**: Hypertree (for main graph navigation with hyperbolic focus)
- **Secondary Visualization**: RGraph (embedded within Group nodes for member participation)
- **Backend Data Source**: Neo4j Graph Database via REST API
- **Blockchain Integration**: WharfKit for wallet connection and event submission

### Visual Hierarchy
```
Root (Featured Node)
  |
  +-- Group (Band/Artist)
  |     |
  |     +-- Person (Member) -- colored edges
  |     |
  |     +-- Release (Album) -- shown on click
  |           |
  |           +-- Guest (semicircular arrangement)
  |           |
  |           +-- Track (in Info Viewer)
  |                 |
  |                 +-- Song (composition)
  |
  +-- Label (Record Label)
        |
        +-- City (Location)
```

---

## Node Type Specifications

### 1. Group Node

**Visual Representation:**
- Circular container (200x200px) containing:
  - Center: Group photo (120x120px circular)
  - Surrounding: Donut chart showing member participation percentages
  - Label: Group name below or overlaid on center

**Donut Chart Properties:**
| Property | Description |
|----------|-------------|
| Segments | One per group member |
| Segment Color | Matches member's assigned color (consistent across visualization) |
| Segment Size | Proportional to member's participation % (tracks played/total tracks) |
| Inner Radius | 65px (to frame the photo) |
| Outer Radius | 95px |

**JIT Node Configuration:**
```javascript
{
  id: "group_<group_id>",
  name: "<group_name>",
  data: {
    $type: "custom:group",
    $dim: 100,
    type: "Group",
    photo: "<url_to_group_photo>",
    memberCount: <number>,
    participationData: [
      { personId, personName, percentage, color }
    ]
  },
  children: [] // Populated dynamically with Releases on click
}
```

**State Behaviors:**
| State | Visual Change |
|-------|---------------|
| Default | Standard rendering |
| Hover | Scale 1.05x, highlight glow |
| Selected | Releases appear radially, donut segments become interactive |
| Focused (Hypertree center) | Maximum size, full detail |

---

### 2. Person Node

**Visual Representation:**
- Circular node (80x80px) containing:
  - Photo (60x60px circular) or default avatar icon
  - Name label (below, 10px font)
  - Border color matches person's assigned color

**Color Assignment:**
- Each Person is assigned a unique color from the palette
- Color persists across all visualizations and edges
- Color used for:
  - Node border
  - Edges to Groups (MEMBER_OF relationships)
  - Donut chart segments in Group nodes
  - Guest indicators on Releases

**JIT Node Configuration:**
```javascript
{
  id: "person_<person_id>",
  name: "<person_name>",
  data: {
    $type: "custom:person",
    $dim: 40,
    $color: "<assigned_hex_color>",
    type: "Person",
    photo: "<url_to_photo>",
    primaryInstrument: "<instrument>",
    groups: ["<group_id_1>", "<group_id_2>"] // For edge coloring
  },
  children: []
}
```

**State Behaviors:**
| State | Visual Change |
|-------|---------------|
| Default | Standard rendering |
| Hover | Scale 1.15x, all edges to Groups highlighted with person's color |
| Selected | Info Viewer shows full biography, Groups list highlighted |

---

### 3. Release Node

**Visual Representation:**
- Square container (initially collapsed: 20x20px, expanded: 120x140px)
- Contains:
  - Album artwork (100x100px when expanded)
  - Release name (11px, truncated with ellipsis)
  - Release date (9px, gray)
- Border color: Category-specific (default #E74C3C)

**Display Behavior:**
- **Hidden by default** until parent Group is selected
- Arranged **radially** around selected Group node
- **Square shape** differentiates from circular Person nodes

**JIT Node Configuration:**
```javascript
{
  id: "release_<release_id>",
  name: "<release_name>",
  data: {
    $type: "custom:release",
    $dim: 10, // Collapsed size
    $angularWidth: 30, // Degrees of arc around parent
    type: "Release",
    albumArt: "<url_to_artwork>",
    releaseDate: "YYYY-MM-DD",
    format: ["LP", "CD", "Digital"],
    labelId: "<label_id>",
    trackCount: <number>,
    expanded: false
  },
  children: [] // Guest nodes, populated on expansion
}
```

**State Behaviors:**
| State | Visual Change |
|-------|---------------|
| Hidden | Not rendered (parent Group not selected) |
| Visible | Small square (20x20px) positioned radially |
| Hover | Tooltip shows release name and date |
| Expanded/Selected | Full size (120x140px) with artwork, guests appear semicircularly |

---

### 4. Guest Node

**Visual Representation:**
- Small circle (30x30px diameter)
- Fill color: Person's assigned color
- No photo (to differentiate from Member Persons)
- Label on hover only

**Display Behavior:**
- **Hidden by default** until parent Release is expanded
- Arranged **semicircularly** around the expanded Release artwork
- Positioned on the side opposite the parent Group

**JIT Node Configuration:**
```javascript
{
  id: "guest_<person_id>_<release_id>",
  name: "<person_name>",
  data: {
    $type: "custom:guest",
    $dim: 15,
    $color: "<person_assigned_color>",
    type: "Guest",
    personId: "<person_id>",
    role: "<role_description>",
    instrument: "<instrument>",
    trackIds: ["<track_id_1>"] // Tracks they appear on
  },
  children: []
}
```

**State Behaviors:**
| State | Visual Change |
|-------|---------------|
| Hidden | Not rendered (parent Release not expanded) |
| Visible | Small colored circle |
| Hover | Tooltip shows name, role, instrument |
| Click | Info Viewer shows Person details (visualization unchanged) |

---

### 5. Label Node (Optional Display)

**Visual Representation:**
- Rounded rectangle (100x60px)
- Label logo or text
- Subdued colors (gray tones)

**Display Behavior:**
- Shown as secondary connections from Releases
- Lower visual priority than Groups/Persons

**JIT Node Configuration:**
```javascript
{
  id: "label_<label_id>",
  name: "<label_name>",
  data: {
    $type: "custom:label",
    $dim: 30,
    type: "Label",
    logo: "<url_to_logo>",
    cityId: "<city_id>"
  },
  children: []
}
```

---

### 6. Track/Song Nodes (Info Viewer Only)

Tracks and Songs are **NOT rendered in the graph visualization**. They appear only in the **Info Viewer** panel when a Release is selected.

**Info Viewer Display:**
```
Track List:
  1. Custard Pie          [4:13]  >
  2. The Rover            [5:36]  >
  3. In My Time Of Dying [11:04]  >
  ...

Clicking a track shows:
- Credits (performers, producer, engineer)
- Samples used
- Lyrics excerpt
- Link to full song entry
```

---

## Edge Specifications

### Edge Types and Styling

| Relationship | Visual Style | Color Logic |
|--------------|--------------|-------------|
| MEMBER_OF (Person -> Group) | Thick line (3px) | Person's assigned color |
| PERFORMED_ON (Group -> Release) | Medium line (2px) | Green (#2ECC71) |
| GUEST_ON (Guest -> Release) | Thin line (1.5px) | Person's assigned color |
| RELEASED (Label -> Release) | Dashed line (1px) | Gray (#888) |
| ORIGIN (Any -> City) | Dotted line (1px) | Light gray (#AAA) |

### Edge Configuration
```javascript
Edge: {
  lineWidth: 2,
  color: '#088',
  overridable: true,
  type: 'line', // or 'bezier' for curved edges

  // Custom rendering in onBeforePlotLine
  onBeforePlotLine: (adj) => {
    const fromType = adj.nodeFrom.data.type;
    const toType = adj.nodeTo.data.type;

    if (fromType === 'Person' && toType === 'Group') {
      adj.data.$color = adj.nodeFrom.data.$color;
      adj.data.$lineWidth = 3;
    }
    // ... other relationship types
  }
}
```

---

## JIT Configuration

### Main Hypertree Configuration

```javascript
const hypertree = new $jit.Hypertree({
  // Container
  injectInto: 'graph-container',
  width: containerWidth,
  height: containerHeight,

  // Node defaults
  Node: {
    dim: 9,
    color: '#888',
    overridable: true,
    type: 'circle'
  },

  // Edge defaults
  Edge: {
    lineWidth: 2,
    color: '#088',
    overridable: true
  },

  // Labels
  Label: {
    type: 'HTML',
    size: 12
  },

  // Animation
  duration: 700,
  transition: $jit.Trans.Quart.easeInOut,

  // Navigation
  Navigation: {
    enable: true,
    panning: true,
    zooming: 20
  },

  // Events
  Events: {
    enable: true,
    type: 'HTML',
    onClick: handleNodeClick,
    onRightClick: handleContextMenu,
    onMouseEnter: handleNodeHover,
    onMouseLeave: handleNodeLeave
  },

  // Controller callbacks
  onCreateLabel: customLabelRenderer,
  onPlaceLabel: customLabelPositioner,
  onBeforePlotNode: nodePreRenderHook,
  onAfterPlotNode: nodePostRenderHook,
  onBeforePlotLine: edgePreRenderHook
});
```

### Embedded RGraph Configuration (for Group Nodes)

```javascript
function createGroupRGraph(containerId, groupData) {
  return new $jit.RGraph({
    injectInto: containerId,
    width: 200,
    height: 200,

    Node: {
      dim: 8,
      color: '#EEE',
      overridable: true
    },

    Edge: {
      color: '#CCC',
      lineWidth: 1
    },

    // Disable interaction (controlled by parent)
    Events: {
      enable: false
    },

    levelDistance: 50,

    // No animation on embedded graphs
    duration: 0
  });
}
```

---

## Custom Node Renderers

### Implementation Pattern

```javascript
// Register custom node types
$jit.Hypertree.Plot.NodeTypes.implement({
  'custom:group': {
    render: function(node, canvas) {
      const ctx = canvas.getCtx();
      const pos = node.pos.getc(true);

      // Draw donut chart
      drawDonutChart(ctx, pos, node.data.participationData);

      // Draw center photo
      drawCircularImage(ctx, pos, node.data.photo, 60);
    },
    contains: function(node, pos) {
      const npos = node.pos.getc(true);
      const dim = node.getData('dim');
      return isWithinCircle(npos, pos, dim);
    }
  },

  'custom:person': {
    render: function(node, canvas) {
      const ctx = canvas.getCtx();
      const pos = node.pos.getc(true);
      const color = node.getData('$color');

      // Draw colored border
      drawCircle(ctx, pos, 40, color, 3);

      // Draw photo
      drawCircularImage(ctx, pos, node.data.photo, 30);
    },
    contains: function(node, pos) {
      const npos = node.pos.getc(true);
      return isWithinCircle(npos, pos, 40);
    }
  },

  'custom:release': {
    render: function(node, canvas) {
      const ctx = canvas.getCtx();
      const pos = node.pos.getc(true);
      const expanded = node.getData('expanded');

      if (expanded) {
        // Draw full album artwork
        drawRectWithImage(ctx, pos, node.data.albumArt, 120, 140);
      } else {
        // Draw small square
        drawSquare(ctx, pos, 20, '#E74C3C');
      }
    },
    contains: function(node, pos) {
      const npos = node.pos.getc(true);
      const expanded = node.getData('expanded');
      const size = expanded ? 60 : 10;
      return isWithinSquare(npos, pos, size);
    }
  },

  'custom:guest': {
    render: function(node, canvas) {
      const ctx = canvas.getCtx();
      const pos = node.pos.getc(true);
      const color = node.getData('$color');

      // Simple filled circle
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 15, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    },
    contains: function(node, pos) {
      const npos = node.pos.getc(true);
      return isWithinCircle(npos, pos, 15);
    }
  }
});
```

### Donut Chart Renderer

```javascript
function drawDonutChart(ctx, center, participationData) {
  const innerRadius = 65;
  const outerRadius = 95;
  let startAngle = -Math.PI / 2; // Start at top

  participationData.forEach(member => {
    const sliceAngle = (member.percentage / 100) * Math.PI * 2;
    const endAngle = startAngle + sliceAngle;

    // Draw arc segment
    ctx.beginPath();
    ctx.arc(center.x, center.y, outerRadius, startAngle, endAngle);
    ctx.arc(center.x, center.y, innerRadius, endAngle, startAngle, true);
    ctx.closePath();

    ctx.fillStyle = member.color;
    ctx.fill();

    // Draw segment border
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();

    startAngle = endAngle;
  });
}
```

---

## Interaction Behaviors

### Click Handlers

```javascript
const interactionHandlers = {

  // Group click: Show releases radially
  onGroupClick: async (node) => {
    // Fetch releases for this group
    const releases = await api.getGroupReleases(node.id);

    // Add release nodes as children
    releases.forEach((release, index) => {
      const angle = (index / releases.length) * Math.PI * 2;
      addReleaseNode(node.id, release, angle);
    });

    // Center on group
    hypertree.onClick(node.id, { duration: 800 });

    // Update info viewer
    infoViewer.showGroup(node.data);
  },

  // Release click: Expand and show guests
  onReleaseClick: async (node) => {
    // Toggle expanded state
    const expanded = !node.getData('expanded');
    node.setData('expanded', expanded);

    if (expanded) {
      // Fetch and display guests
      const guests = await api.getReleaseGuests(node.id);
      arrangeGuestsSemicircularly(node, guests);

      // Update info viewer with track list
      infoViewer.showRelease(node.data);
    }

    hypertree.plot();
  },

  // Person click: Highlight connections
  onPersonClick: (node) => {
    // Highlight all edges to groups
    highlightPersonEdges(node.id, node.data.$color);

    // Show in info viewer
    infoViewer.showPerson(node.data);
  },

  // Guest click: Show in info viewer only (no navigation)
  onGuestClick: async (node) => {
    const personData = await api.getPerson(node.data.personId);
    infoViewer.showPerson(personData);
    // Visualization unchanged
  }
};
```

### Hover Behaviors

```javascript
const hoverHandlers = {

  onNodeEnter: (node, event) => {
    switch (node.data.type) {
      case 'Person':
        // Highlight all edges to their groups
        node.data.groups.forEach(groupId => {
          highlightEdge(node.id, groupId, node.data.$color);
        });
        break;

      case 'Release':
        // Show tooltip with name and date
        showTooltip(event, `${node.name}\n${node.data.releaseDate}`);
        break;

      case 'Guest':
        // Show role tooltip
        showTooltip(event, `${node.name}\n${node.data.role}`);
        break;
    }
  },

  onNodeLeave: (node) => {
    clearHighlights();
    hideTooltip();
  }
};
```

### Context Menu

```javascript
function showContextMenu(node, event) {
  const menuItems = [
    { label: 'View Details', action: () => viewDetails(node) },
    { label: 'Add Claim', action: () => addClaim(node) },
    { label: 'Vote', action: () => vote(node) },
    { label: 'Stake', action: () => stake(node) },
    { label: 'Discuss', action: () => discuss(node) }
  ];

  // Type-specific items
  if (node.data.type === 'Group') {
    menuItems.push({ label: 'Add Member', action: () => addMember(node) });
    menuItems.push({ label: 'View Timeline', action: () => viewTimeline(node) });
  }

  renderContextMenu(event.pageX, event.pageY, menuItems);
}
```

---

## UI Components

### 1. Top Bar

```
+------------------------------------------------------------------+
| [Avatar] username | 1023 | [Star] 6 | [Snowflake] 45 |           |
|                          Favorites    History                     |
+------------------------------------------------------------------+
```

**Components:**

| Element | Description | Action |
|---------|-------------|--------|
| Avatar + Username | Current logged-in account | Opens dropdown: Account (balances link), Activity (blockchain explorer) |
| Token Count | Display of user's token balance | Part of account dropdown |
| Favorites (Star) | Count of "liked" nodes | Opens favorites list panel |
| History (Snowflake) | Session browsing history count | Opens history list panel |

**Implementation:**
```javascript
class TopBar {
  constructor(container) {
    this.account = null;
    this.favorites = [];
    this.history = [];
  }

  async connectWallet() {
    // WharfKit integration
    const session = await Session.login({...});
    this.account = session.actor;
    this.render();
  }

  showFavoritesList() {
    // Display modal with clickable favorite nodes
    const modal = new FavoritesModal(this.favorites);
    modal.onSelect = (nodeId) => {
      hypertree.onClick(nodeId);
    };
  }

  showHistory() {
    // Display session browsing history
    // Note: Published anonymized on-chain using ant trail mimicry
    const modal = new HistoryModal(this.history);
    modal.onSelect = (nodeId) => {
      hypertree.onClick(nodeId);
    };
  }
}
```

### 2. Info Viewer (Right Panel)

```
+------------------------+
| [< Back]  [Search] [>] |
|                        |
| +--------------------+ |
| |   Album Artwork    | |
| |                    | |
| +--------------------+ |
|                        |
| [bc] [>] Physical...   |
| Feb 24 1975   Hampshire|
|                        |
| 1. Custard Pie         |
| 2. The Rover           |
| 3. In My Time Of...    |
| ...                    |
|                        |
| Groups:                |
| Led Zeppelin           |
|                        |
| Members/Guests:        |
| Jimmy Page, Robert...  |
|                        |
| Associated Labels:     |
| Atlantic Records       |
|                        |
| Biography:             |
| Physical Graffiti is...|
|                        |
| Trivia:                |
| The band decided to... |
+------------------------+
```

**Dynamic Content Based on Selection:**

| Selection | Display Content |
|-----------|-----------------|
| Group | Photo, bio, current members, releases list, origin city |
| Person | Photo, bio, groups list, instrument, discography |
| Release | Artwork, track list, credits, label, date, location |
| Track (from list) | Credits, samples, lyrics, link to song |
| Song | Title, writers, lyrics, all recordings |

### 3. Bottom Button Bar

```
+------------------------------------------------------------------+
| [Submit a Project] [Info/Contact] [Merch/Albums]     [Help]      |
+------------------------------------------------------------------+
```

**Button Actions:**

| Button | Action |
|--------|--------|
| Submit a Project | Opens submission form modal (or links to `/submit` page) |
| Info/Contact | Links to `http://www.ursapolarisrecords.com/polaris` |
| Merch/Albums | Links to `http://www.ursapolarisrecords.com/album-artwork-1` |
| Help | Opens modal with Reddit and GitHub links |

**Help Modal Content:**
```
+---------------------------+
|          Help             |
+---------------------------+
| [Reddit Logo]             |
| Join the discussion       |
| reddit.com/r/polarismusic |
|                           |
| [GitHub Logo]             |
| Submit an Issue           |
| github.com/PolarisMusic/  |
|   polaris-music           |
+---------------------------+
```

### 4. Music Player

```
+---------------------------+
|    [Progress Bar]         |
| [<<] [>] [>>]             |
+---------------------------+
```

**Implementation:**
- Embedded streaming player (Spotify, Tidal, etc.)
- Selectable source based on availability
- Links to `listen_links` from Track data

### 5. Zoom Slider

```
[Magnifier] ----o-------- [+]
```

**Implementation:**
- Uses JIT's built-in Navigation.zooming
- Slider range: 1-100 (maps to JIT zoom levels)
- Position: Top-left corner of visualization

---

## Data Flow

### API Endpoints Required

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/graph/initial` | GET | Fetch initial graph centered on featured node |
| `/api/graph/node/:id` | GET | Fetch single node with adjacencies |
| `/api/groups/:id/releases` | GET | Fetch releases for a group |
| `/api/groups/:id/participation` | GET | Fetch member participation data |
| `/api/releases/:id/guests` | GET | Fetch guest performers for release |
| `/api/releases/:id/tracks` | GET | Fetch track listing with details |
| `/api/persons/:id` | GET | Fetch person biography and groups |
| `/api/search` | GET | Search nodes by name |

### Data Transformation

```javascript
// Transform Neo4j response to JIT format
function transformToJitFormat(neo4jData) {
  const nodes = new Map();

  // Process nodes with type-specific configuration
  neo4jData.nodes.forEach(record => {
    const node = {
      id: record.id,
      name: record.properties.name,
      data: {
        $type: `custom:${record.labels[0].toLowerCase()}`,
        $dim: getNodeDimension(record.labels[0]),
        $color: record.properties.color || assignColor(record.id),
        type: record.labels[0],
        ...record.properties
      },
      children: []
    };
    nodes.set(node.id, node);
  });

  // Build hierarchy from relationships
  neo4jData.relationships.forEach(rel => {
    const parent = nodes.get(rel.start);
    const child = nodes.get(rel.end);
    if (parent && child) {
      parent.children.push(child);
    }
  });

  // Return tree rooted at featured node
  return nodes.get(neo4jData.featuredId);
}
```

### State Management

```javascript
class VisualizationState {
  constructor() {
    this.selectedNode = null;
    this.expandedReleases = new Set();
    this.highlightedEdges = new Set();
    this.colorAssignments = new Map();
    this.favorites = new Set();
    this.history = [];
  }

  selectNode(nodeId) {
    this.selectedNode = nodeId;
    this.addToHistory(nodeId);
    this.emit('selection-changed', nodeId);
  }

  toggleReleaseExpansion(releaseId) {
    if (this.expandedReleases.has(releaseId)) {
      this.expandedReleases.delete(releaseId);
    } else {
      this.expandedReleases.add(releaseId);
    }
    this.emit('expansion-changed', releaseId);
  }

  assignColor(personId) {
    if (!this.colorAssignments.has(personId)) {
      const index = this.colorAssignments.size;
      const color = COLOR_PALETTE[index % COLOR_PALETTE.length];
      this.colorAssignments.set(personId, color);
    }
    return this.colorAssignments.get(personId);
  }
}
```

---

## Implementation Phases

### Phase 1: Core Visualization Setup
**Goal:** Basic Hypertree with Groups and Persons

**Tasks:**
1. Set up JIT library and canvas container
2. Implement custom Group node renderer (without donut chart)
3. Implement custom Person node renderer
4. Configure edge coloring for MEMBER_OF relationships
5. Implement basic click-to-center navigation
6. Connect to API for initial data load

**Deliverables:**
- Working Hypertree with Group and Person nodes
- Colored edges between Persons and Groups
- Click navigation to center nodes

---

### Phase 2: Group Donut Chart & Participation
**Goal:** Member participation visualization

**Tasks:**
1. Create API endpoint for participation calculation
2. Implement donut chart canvas drawing
3. Integrate RGraph or custom polar visualization
4. Add percentage labels around donut
5. Sync donut segment colors with Person node colors

**Deliverables:**
- Group nodes display member participation donut charts
- Colors consistent between donut segments and Person nodes

---

### Phase 3: Release Node Expansion
**Goal:** Releases appear on Group selection

**Tasks:**
1. Implement Release node renderer (collapsed/expanded states)
2. Create radial positioning algorithm for Releases around Groups
3. Add hover tooltips for collapsed Releases
4. Implement expansion animation
5. Display album artwork in expanded state

**Deliverables:**
- Releases appear radially when Group is selected
- Releases expand to show artwork on click

---

### Phase 4: Guest Display
**Goal:** Guest performers on expanded Releases

**Tasks:**
1. Implement Guest node renderer
2. Create semicircular positioning around expanded Releases
3. Add hover tooltips with role information
4. Connect Guest clicks to Info Viewer

**Deliverables:**
- Guests appear semicircularly around expanded Releases
- Guest information displays on hover/click

---

### Phase 5: Info Viewer Integration
**Goal:** Full right panel with dynamic content

**Tasks:**
1. Build Info Viewer component structure
2. Implement view templates for each node type
3. Add track list display with clickable items
4. Implement Track -> Song navigation
5. Add play button integration with streaming links

**Deliverables:**
- Info Viewer displays appropriate content for all node types
- Track list interactive with credits and lyrics

---

### Phase 6: Top Bar & User Features
**Goal:** Account, Favorites, History

**Tasks:**
1. Integrate WharfKit wallet connection
2. Implement account dropdown with blockchain explorer links
3. Build Favorites system with persistence
4. Implement History tracking
5. Add ant trail mimicry for anonymous history publishing

**Deliverables:**
- Working wallet connection
- Favorites and History functional

---

### Phase 7: Bottom Bar & Utilities
**Goal:** Action buttons and music player

**Tasks:**
1. Implement Submit a Project form/link
2. Add external links for Info/Contact and Merch
3. Build Help modal with Reddit/GitHub links
4. Integrate embedded music player
5. Implement zoom slider with JIT Navigation

**Deliverables:**
- All bottom bar buttons functional
- Music player integrated
- Zoom control working

---

### Phase 8: Polish & Performance
**Goal:** Production-ready visualization

**Tasks:**
1. Optimize rendering for large graphs (lazy loading, culling)
2. Add loading states and error handling
3. Implement responsive layout
4. Add keyboard navigation
5. Performance testing and optimization
6. Accessibility improvements

**Deliverables:**
- Smooth performance with large datasets
- Full keyboard navigation
- Production-ready UI

---

## Appendix: Color Palette

```javascript
const COLOR_PALETTE = [
  '#FF6B6B', // Coral Red
  '#4ECDC4', // Turquoise
  '#45B7D1', // Sky Blue
  '#96CEB4', // Sage Green
  '#FFEAA7', // Soft Yellow
  '#DDA0DD', // Plum
  '#98D8C8', // Mint
  '#F7DC6F', // Mustard
  '#FF8CC3', // Pink
  '#A8E6CF', // Light Green
  '#FFD3B6', // Peach
  '#FFAAA5', // Salmon
  '#C9B1FF', // Lavender
  '#85E3FF', // Aqua
  '#B4F8C8', // Pale Green
  '#FFE5B4'  // Papaya
];
```

---

## Appendix: File Structure

```
frontend/
  src/
    visualization/
      MusicGraph.js           # Main visualization class
      nodeRenderers/
        GroupNode.js          # Group with donut chart
        PersonNode.js         # Person with photo
        ReleaseNode.js        # Collapsible release
        GuestNode.js          # Guest indicator
      utils/
        donutChart.js         # Donut chart drawing
        radialLayout.js       # Radial positioning
        colorManager.js       # Color assignment
      state/
        VisualizationState.js # State management
    components/
      TopBar.js               # Account, favorites, history
      InfoViewer.js           # Right panel
      BottomBar.js            # Action buttons
      MusicPlayer.js          # Streaming player
      ZoomSlider.js           # Zoom control
    api/
      graphApi.js             # API client
    styles/
      music-graph.css         # Visualization styles
      components.css          # UI component styles
```

---

## References

- [JIT Documentation](https://philogb.github.io/jit/static/v20/Docs/files/Core/Core-js.html)
- [JIT Demos](https://philogb.github.io/jit/demos.html)
- [JIT GitHub Repository](https://github.com/philogb/jit)
- [Graph Database Schema](./02-graph-database-schema.md)
- [Graph Example Spec Sheet](./graph-example-spec-sheet.md)
