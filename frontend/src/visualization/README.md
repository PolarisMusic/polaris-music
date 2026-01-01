# Polaris Music Registry - Visualization Features

## Overview

The Polaris Music Registry uses JavaScript InfoVis Toolkit (JIT) to provide an interactive hyperbolic tree visualization of the music graph. The visualization includes advanced features like path tracking, "like" functionality with blockchain integration, and ant colony optimization-inspired edge weighting.

## Features

### 1. Hyperbolic Tree Visualization (Hypertree)

- **Groups** are displayed with embedded RGraph visualizations showing member participation
- **Persons** connect to Groups with unique colors for easy identification
- **Releases** and **Tracks** are shown with appropriate visual styling
- Smooth animations and transitions between nodes

### 2. Path Tracking (`PathTracker.js`)

Tracks user navigation through the graph from a starting node to the currently viewed node.

**Key Features**:
- Records the sequence of nodes visited during exploration
- Stores path data when user "likes" a node
- Calculates edge weights based on traversal frequency (ant colony optimization)
- Persists liked paths to localStorage for session continuity

**Usage**:
```javascript
import { PathTracker } from './PathTracker.js';

const tracker = new PathTracker();

// Set starting point
tracker.setStartNode('root-node-id');

// Track navigation
tracker.visitNode('person-john');
tracker.visitNode('group-beatles');

// Get current path
const path = tracker.getCurrentPath();
// Returns: ['root-node-id', 'person-john', 'group-beatles']

// Record a like with path
tracker.recordLike('group-beatles', {
    type: 'Group',
    name: 'The Beatles'
});

// Get edge weights for visualization
const weights = tracker.getEdgeWeights();
```

**Ant Colony Optimization**:
- Edges that are part of more "liked" paths are drawn thicker
- Mimics how ants find optimal paths to food sources
- Helps users discover popular navigation routes

### 3. Like Management (`LikeManager.js`)

Integrates with WalletManager to submit likes to the blockchain smart contract.

**Key Features**:
- Local like storage with path data
- Blockchain submission via `polaris::like` action
- Queue system for offline likes
- Success/error callbacks

**Usage**:
```javascript
import LikeManager from './LikeManager.js';

const likeManager = new LikeManager(walletManager, pathTracker);

// Like a node (local + blockchain)
await likeManager.likeNode('group-beatles', {
    type: 'Group',
    name: 'The Beatles'
});

// Unlike a node (local only - blockchain is immutable)
await likeManager.unlikeNode('group-beatles');

// Submit queued likes when wallet connects
await likeManager.submitPendingLikes();

// Get statistics
console.log(likeManager.getPendingCount());
```

### 4. Color Palette System (`colorPalette.js`)

Manages consistent color assignments for Persons and relationship types.

**Features**:
- 16-color palette optimized for dark backgrounds
- Deterministic color assignment based on person ID
- Relationship-specific edge colors and widths

**Relationship Colors**:
- `MEMBER_OF`: Person's unique color (colored edge)
- `PERFORMED_ON`: Green (#6BC47D)
- `GUEST_ON`: Gray (#666666) - non-colored for guests
- `IN_RELEASE`: Gray (#666666)
- `ORIGIN`: Dark gray (#444444)

**Edge Widths**:
- `MEMBER_OF`: 3px (thick)
- `PERFORMED_ON`: 2px (medium)
- `GUEST_ON`: 1.5px (thin)
- `IN_RELEASE`: 1px (thin)

### 5. Graph API Client (`graphApi.js`)

Handles communication with the backend API to fetch graph data.

**Endpoints**:
- `GET /api/graph/initial` - Initial graph structure
- `GET /api/:type/:id` - Node details (Group, Person, etc.)
- `GET /api/group/:id/participation` - Member participation data for RGraph
- `GET /api/search?q=query` - Search functionality

**Caching**:
- 5-minute cache for node details
- Reduces API calls during exploration

### 6. Main Visualization (`MusicGraph.js`)

Orchestrates all components and handles user interactions.

**Integration Points**:
```javascript
// Initialization
const graph = new MusicGraph('container-id', walletManager);

// Load data
await graph.loadGraphData();

// Programmatic navigation
graph.handleNodeClick(node);

// Get statistics
graph.pathTracker.getStatistics();
```

## Integration Guide

### Setting Up the Visualization

1. **HTML Structure**:
```html
<div id="infovis"></div>

<div id="info-viewer">
    <div class="info-header">
        <h2 id="info-title">Select a node</h2>
        <button id="like-button" class="btn-like">🤍 Like</button>
    </div>
    <div id="info-content"></div>
</div>
```

2. **JavaScript Initialization**:
```javascript
import { MusicGraph } from './src/visualization/MusicGraph.js';
import { WalletManager } from './src/wallet/WalletManager.js';

// Initialize wallet for blockchain features
const walletManager = new WalletManager();

// Initialize visualization (pass wallet for like functionality)
const graph = new MusicGraph('infovis', walletManager);

// Load graph data
await graph.loadGraphData();
```

3. **Wallet Connection**:
```javascript
// Connect wallet
const accountInfo = await walletManager.connect();

// Like functionality now enabled
```

### Customizing Edge Weights

The edge weight algorithm can be tuned in `MusicGraph.styleEdge()`:

```javascript
const pathWeight = this.pathTracker.getEdgeWeight(from, to);

// Current formula: weight increases by 20% per traversal, max 3x
const multiplier = pathWeight > 0
    ? Math.min(1 + (pathWeight * 0.2), 3)
    : 1;

// Apply to line width
adj.setData('lineWidth', baseWidth * multiplier);
```

## Blockchain Integration

### Smart Contract Action: `like`

When a user likes a node, the following action is submitted to the blockchain:

```cpp
ACTION like(
    name account,           // User account
    checksum256 node_id,    // Liked node ID (hash)
    vector<checksum256> node_path  // Navigation path (max 20 nodes)
);
```

**Data Stored On-Chain**:
- Account that liked the node
- Node ID that was liked
- Path taken to reach the node (for analytics)
- Timestamp (automatic via block time)

**Off-Chain Storage**:
- Full node metadata (type, name, etc.)
- Complete path (no 20-node limit)
- User annotations (future feature)

### Like Rewards

Likes may earn token rewards based on the emission formula (see smart contract docs).

## Performance Considerations

### Caching Strategy

1. **Participation Data**: Cached per group to avoid repeated API calls
2. **Node Details**: 5-minute cache for frequently viewed nodes
3. **Liked Paths**: Persisted to localStorage (survives page reloads)

### Optimization Tips

- Limit path length to 100 nodes (prevents memory bloat)
- Lazy-load RGraph visualizations (only render when visible)
- Batch blockchain submissions (submit multiple likes together)
- Use requestAnimationFrame for smooth animations

## Troubleshooting

### Like Button Not Working

1. **Check wallet connection**:
```javascript
if (!walletManager.isConnected()) {
    console.error('Wallet not connected');
}
```

2. **Check LikeManager initialization**:
```javascript
if (!graph.likeManager) {
    console.error('LikeManager not initialized - pass walletManager to MusicGraph');
}
```

3. **Check console for errors**:
- Look for blockchain transaction failures
- Verify smart contract is deployed

### Path Tracking Not Working

1. **Verify start node is set**:
```javascript
console.log(graph.pathTracker.startNode);
// Should not be null
```

2. **Check localStorage permissions**:
```javascript
try {
    localStorage.setItem('test', 'test');
    localStorage.removeItem('test');
} catch (e) {
    console.error('localStorage blocked');
}
```

### Edges Not Weighted

1. **Check liked paths exist**:
```javascript
console.log(graph.pathTracker.getAllLikes());
// Should return array of likes
```

2. **Force refresh**:
```javascript
graph.refresh();
```

## Future Enhancements

- [ ] Multi-path visualization (show multiple routes to a node)
- [ ] Heat map mode (color edges by traversal frequency)
- [ ] Path replay animation (animate user's journey)
- [ ] Social features (see what others have liked)
- [ ] Path recommendations (suggest unexplored areas)
- [ ] Export visualization as image/video

## Development

### Adding a New Relationship Type

1. Add color to `colorPalette.js`:
```javascript
getEdgeColor(relType, personId) {
    case 'NEW_RELATIONSHIP':
        return '#FF5733'; // Custom color
}
```

2. Add to `MusicGraph.styleEdge()`:
```javascript
else if (fromType === 'NodeA' && toType === 'NodeB') {
    adj.setData('color', this.colorPalette.getEdgeColor('NEW_RELATIONSHIP'));
}
```

### Testing

```bash
# Serve locally
npm run dev

# Open browser
http://localhost:5173/visualization.html

# Check console for logs
```

## API Reference

See individual file documentation:
- [PathTracker.js](./PathTracker.js) - Path tracking system
- [LikeManager.js](./LikeManager.js) - Blockchain like integration
- [colorPalette.js](./colorPalette.js) - Color management
- [graphApi.js](./graphApi.js) - Backend API client
- [MusicGraph.js](./MusicGraph.js) - Main visualization class

## License

MIT License - see LICENSE file for details
