/**
 * Graph API Client for Polaris Music Registry
 *
 * Handles communication with the backend API to fetch graph data.
 * Provides methods for retrieving nodes, relationships, and metadata.
 */

export class GraphAPI {
    constructor(baseUrl = null) {
        // Use env var or default to port 3000 (correct API port)
        // Previously defaulted to 3001 which caused silent fallback to mock data
        this.baseUrl = baseUrl || import.meta.env.VITE_API_URL || 'http://localhost:3000/api';
        this.cache = new Map();
        this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
        // Only use mock fallback when explicitly enabled
        this.useMockFallback = import.meta.env.VITE_USE_GRAPH_MOCK === 'true';
    }

    /**
     * Fetch initial graph data (Groups and Persons with MEMBER_OF relationships)
     * @returns {Promise<Object>} Graph data in JIT-compatible format
     */
    async fetchInitialGraph() {
        try {
            const response = await fetch(`${this.baseUrl}/graph/initial`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();

            // Diagnostic logging for initial graph
            if (data && data.nodes && data.edges) {
                const groups = data.nodes.filter(n => (n.type || '').toLowerCase() === 'group');
                const persons = data.nodes.filter(n => (n.type || '').toLowerCase() === 'person');
                console.log('Initial graph diagnostics:', {
                    totalNodes: data.nodes.length,
                    totalEdges: data.edges.length,
                    groups: groups.length,
                    persons: persons.length
                });
            }

            return this.transformToJIT(data);
        } catch (error) {
            console.error('Error fetching initial graph:', error);
            // Only use mock data if explicitly enabled (prevents silent failures)
            if (this.useMockFallback) {
                console.warn('Using mock graph data (VITE_USE_GRAPH_MOCK=true)');
                return this.getMockInitialGraph();
            }
            throw error;
        }
    }

    /**
     * Fetch initial graph as raw {nodes, edges} (not JIT-transformed).
     * Used when the caller needs to merge subgraphs before transforming.
     * @returns {Promise<Object>} Raw graph data {nodes, edges}
     */
    async fetchInitialGraphRaw() {
        try {
            const response = await fetch(`${this.baseUrl}/graph/initial`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            if (!data || !data.nodes || !data.edges) {
                return { nodes: [], edges: [] };
            }
            return { nodes: data.nodes, edges: data.edges };
        } catch (error) {
            console.error('Error fetching initial graph raw:', error);
            throw error;
        }
    }

    /**
     * Fetch a node's neighborhood subgraph (raw {nodes, edges}).
     * @param {string} nodeId - Canonical node ID
     * @returns {Promise<Object>} Raw graph data {nodes, edges}
     */
    async fetchNeighborhoodRaw(nodeId) {
        const response = await fetch(
            `${this.baseUrl}/graph/neighborhood/${encodeURIComponent(nodeId)}`
        );
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        if (!data || !data.nodes) {
            return { nodes: [], edges: [] };
        }
        return { nodes: data.nodes, edges: data.edges || [] };
    }

    /**
     * Merge two raw graph objects, deduplicating nodes by id and edges by source|target|type.
     * @param {Object} base - Base graph {nodes, edges}
     * @param {Object} add - Graph to merge in {nodes, edges}
     * @returns {Object} Merged graph {nodes, edges}
     */
    mergeRawGraph(base, add) {
        const nodeMap = new Map();
        const edgeSet = new Map();

        const addNodes = (arr) => {
            if (!arr) return;
            for (const n of arr) {
                if (n && n.id) nodeMap.set(n.id, n);
            }
        };

        const edgeKey = (e) => `${e.source}|${e.target}|${e.type || ''}`;
        const addEdges = (arr) => {
            if (!arr) return;
            for (const e of arr) {
                if (e && e.source && e.target) {
                    edgeSet.set(edgeKey(e), e);
                }
            }
        };

        addNodes(base && base.nodes);
        addNodes(add && add.nodes);
        addEdges(base && base.edges);
        addEdges(add && add.edges);

        return {
            nodes: Array.from(nodeMap.values()),
            edges: Array.from(edgeSet.values())
        };
    }

    /**
     * Fetch detailed information for a specific node
     * @param {string} nodeId - Node ID
     * @param {string} nodeType - Node type (Person, Group, Release, etc.)
     * @returns {Promise<Object>} Node details
     */
    async fetchNodeDetails(nodeId, nodeType) {
        const cacheKey = `${nodeType}:${nodeId}`;

        // Check cache
        if (this.cache.has(cacheKey)) {
            const cached = this.cache.get(cacheKey);
            if (Date.now() - cached.timestamp < this.cacheTimeout) {
                return cached.data;
            }
        }

        try {
            const endpoint = `${this.baseUrl}/${nodeType.toLowerCase()}/${nodeId}`;
            const response = await fetch(endpoint);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();

            // Cache result
            this.cache.set(cacheKey, {
                data,
                timestamp: Date.now()
            });

            return data;
        } catch (error) {
            console.error(`Error fetching ${nodeType} details:`, error);
            // Only use mock data if explicitly enabled
            if (this.useMockFallback) {
                return this.getMockNodeDetails(nodeId, nodeType);
            }
            return null;
        }
    }

    /**
     * Fetch releases for a group (for release orbit overlay)
     * @param {string} groupId - Group ID
     * @returns {Promise<Object>} { success, groupId, releases }
     */
    async fetchGroupReleases(groupId) {
        const cacheKey = `groupReleases:${groupId}`;
        if (this.cache.has(cacheKey)) {
            const cached = this.cache.get(cacheKey);
            if (Date.now() - cached.timestamp < this.cacheTimeout) return cached.data;
        }

        try {
            const response = await fetch(`${this.baseUrl}/group/${groupId}/releases`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            this.cache.set(cacheKey, { data, timestamp: Date.now() });
            return data;
        } catch (error) {
            console.error('Error fetching group releases:', error);
            return { success: false, releases: [] };
        }
    }

    /**
     * Fetch full release details (tracks, labels, groups, guests)
     * @param {string} releaseId - Release ID
     * @returns {Promise<Object>} Release details
     */
    async fetchReleaseDetails(releaseId) {
        const cacheKey = `releaseDetails:${releaseId}`;
        if (this.cache.has(cacheKey)) {
            const cached = this.cache.get(cacheKey);
            if (Date.now() - cached.timestamp < this.cacheTimeout) return cached.data;
        }

        try {
            const response = await fetch(`${this.baseUrl}/release/${releaseId}`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            this.cache.set(cacheKey, { data, timestamp: Date.now() });
            return data;
        } catch (error) {
            console.error('Error fetching release details:', error);
            return null;
        }
    }

    /**
     * Search for nodes via the unified REST endpoint.
     * @param {string} query - Search query
     * @param {string} type - Node type filter (optional)
     * @returns {Promise<Array>} Search results
     */
    async search(query, type = null) {
        try {
            const params = new URLSearchParams({ q: query });
            if (type) params.set('types', type);

            const response = await fetch(`${this.baseUrl}/search/nodes?${params}`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            return data.success ? data.results : [];
        } catch (error) {
            console.error('Error searching:', error);
            return [];
        }
    }

    /**
     * Find connected components in a raw {nodes, edges} graph.
     * Returns an array of Sets, each containing node IDs in one component.
     * @param {Object} data - { nodes: [{id, ...}], edges: [{source, target, ...}] }
     * @returns {Array<Set<string>>} Connected components
     */
    getConnectedComponents(data) {
        const adj = new Map();
        for (const node of data.nodes) {
            adj.set(node.id, []);
        }
        for (const edge of data.edges) {
            if (adj.has(edge.source) && adj.has(edge.target)) {
                adj.get(edge.source).push(edge.target);
                adj.get(edge.target).push(edge.source);
            }
        }

        const visited = new Set();
        const components = [];

        for (const nodeId of adj.keys()) {
            if (visited.has(nodeId)) continue;
            const component = new Set();
            const stack = [nodeId];
            while (stack.length > 0) {
                const current = stack.pop();
                if (visited.has(current)) continue;
                visited.add(current);
                component.add(current);
                for (const neighbor of (adj.get(current) || [])) {
                    if (!visited.has(neighbor)) {
                        stack.push(neighbor);
                    }
                }
            }
            components.push(component);
        }

        return components;
    }

    /**
     * Ensure the raw graph is connected for hypertree layout.
     * If the graph has multiple connected components, inject a synthetic
     * invisible root node connected to one representative group per component.
     * @param {Object} data - { nodes: [{id, type, ...}], edges: [{source, target, type, ...}] }
     * @returns {Object} Possibly augmented { nodes, edges } with synthetic root
     */
    ensureConnectedForHypertree(data) {
        if (!data || !data.nodes || data.nodes.length === 0) return data;

        const components = this.getConnectedComponents(data);
        const componentSizes = components.map(c => c.size);

        console.log('Initial raw graph components:', components.length, componentSizes);

        if (components.length <= 1) {
            console.log('Synthetic root injected:', false);
            return data;
        }

        // Build a lookup for node type by id
        const nodeTypeMap = new Map();
        for (const node of data.nodes) {
            nodeTypeMap.set(node.id, (node.type || '').toLowerCase());
        }

        // Create synthetic root
        const rootNode = {
            id: 'polaris:root:initial',
            name: '',
            type: 'root'
        };

        const syntheticEdges = [];
        for (const component of components) {
            // Pick one representative: prefer a group node, else first node
            let representative = null;
            for (const nodeId of component) {
                if (nodeTypeMap.get(nodeId) === 'group') {
                    representative = nodeId;
                    break;
                }
            }
            if (!representative) {
                representative = component.values().next().value;
            }
            syntheticEdges.push({
                source: 'polaris:root:initial',
                target: representative,
                type: 'ROOT'
            });
        }

        console.log('Synthetic root injected:', true);

        return {
            nodes: [...data.nodes, rootNode],
            edges: [...data.edges, ...syntheticEdges]
        };
    }

    /**
     * Transform Neo4j response to JIT-compatible format
     * @param {Object} data - Neo4j graph data {nodes, edges}
     * @returns {Array} JIT-compatible adjacency list
     */
    transformToJIT(data) {
        if (!data || !data.nodes || !data.edges) {
            console.warn('Invalid graph data format, using mock data');
            return this.getMockInitialGraph();
        }

        // Ensure graph connectivity for hypertree layout
        const connectedData = this.ensureConnectedForHypertree(data);

        // Create a map of node adjacencies
        const adjacencyMap = new Map();

        // Initialize adjacency lists for all nodes
        connectedData.nodes.forEach(node => {
            adjacencyMap.set(node.id, []);
        });

        // Build adjacency lists from edges
        connectedData.edges.forEach(edge => {
            // Add bidirectional edges for undirected graph visualization
            if (adjacencyMap.has(edge.source)) {
                adjacencyMap.get(edge.source).push({
                    nodeTo: edge.target,
                    data: {
                        weight: 1,
                        type: edge.type,
                        role: edge.role,
                        instruments: edge.instruments
                    }
                });
            }

            if (adjacencyMap.has(edge.target)) {
                adjacencyMap.get(edge.target).push({
                    nodeTo: edge.source,
                    data: {
                        weight: 1,
                        type: edge.type,
                        role: edge.role,
                        instruments: edge.instruments
                    }
                });
            }
        });

        // Type-based base radius: groups largest, persons next, then releases/tracks.
        // With transform:true these shrink toward edges, so groups need bigger base.
        const dimForType = (v) => {
            if (v === 'root') return 1;
            if (v === 'group') return 18;
            if (v === 'person') return 10;
            if (v === 'release') return 9;
            if (v === 'track') return 8;
            return 8;
        };

        // Transform nodes to JIT format with adjacencies
        const jitNodes = connectedData.nodes.map(node => ({
            id: node.id,
            name: node.name,
            data: {
                $dim: dimForType(node.type),
                $type: 'circle-hover',
                $color: node.color || undefined,  // DB-driven person color
                type: node.type,
                trackCount: node.trackCount || 0,
                photo: node.photo || null
            },
            adjacencies: adjacencyMap.get(node.id) || []
        }));

        return jitNodes;
    }

    /**
     * Get mock initial graph data for development
     * @returns {Object} Mock graph data
     */
    getMockInitialGraph() {
        return {
            id: "root",
            name: "Polaris Music Registry",
            data: {
                type: "root"
            },
            children: [
                {
                    id: "group-beatles",
                    name: "The Beatles",
                    data: {
                        type: "Group",
                        group_id: "875a968e0d079c90766544...",
                        group_name: "The Beatles",
                        group_altnames: ["The Fab Four"],
                        formed_date: "1960",
                        photo_url: null
                    },
                    children: [
                        {
                            id: "person-john",
                            name: "John Lennon",
                            data: {
                                type: "Person",
                                person_id: "347a746e8c9606f78978fd...",
                                person_name: "John Lennon",
                                participation_percent: 100.0,
                                photo_url: null,
                                city: "London"
                            },
                            children: []
                        },
                        {
                            id: "person-paul",
                            name: "Paul McCartney",
                            data: {
                                type: "Person",
                                person_id: "d36547078b701635a7412...",
                                person_name: "Paul McCartney",
                                participation_percent: 100.0,
                                photo_url: null,
                                city: "London"
                            },
                            children: []
                        },
                        {
                            id: "person-george",
                            name: "George Harrison",
                            data: {
                                type: "Person",
                                person_id: "2c689b96a8960e79f0d...",
                                person_name: "George Harrison",
                                participation_percent: 100.0,
                                photo_url: null,
                                city: "London"
                            },
                            children: []
                        },
                        {
                            id: "person-ringo",
                            name: "Ringo Starr",
                            data: {
                                type: "Person",
                                person_id: "8f9a7b6c5d4e3f2a1b0c...",
                                person_name: "Ringo Starr",
                                participation_percent: 75.0,
                                photo_url: null,
                                city: "Liverpool"
                            },
                            children: []
                        }
                    ]
                }
            ]
        };
    }

    /**
     * Get mock node details for development
     * @param {string} nodeId - Node ID
     * @param {string} nodeType - Node type
     * @returns {Object} Mock node details
     */
    getMockNodeDetails(nodeId, nodeType) {
        if (nodeType === 'Group' && nodeId === 'group-beatles') {
            return {
                group_id: "875a968e0d079c90766544...",
                group_name: "The Beatles",
                group_altnames: ["The Fab Four"],
                formed_date: "1960",
                disbanded_date: "1970",
                description: "The Beatles were an English rock band formed in Liverpool in 1960. The group, whose best-known line-up comprised John Lennon, Paul McCartney, George Harrison and Ringo Starr, are regarded as the most influential band of all time.",
                members: [
                    { name: "John Lennon", roles: ["Vocals", "Guitar"], participation: 100 },
                    { name: "Paul McCartney", roles: ["Vocals", "Bass"], participation: 100 },
                    { name: "George Harrison", roles: ["Guitar", "Vocals"], participation: 100 },
                    { name: "Ringo Starr", roles: ["Drums"], participation: 75 }
                ],
                release_count: 13
            };
        }

        if (nodeType === 'Person') {
            return {
                person_id: nodeId,
                person_name: "Mock Person",
                bio: "This is mock person data for development.",
                groups: [],
                tracks_count: 0
            };
        }

        return {
            id: nodeId,
            type: nodeType,
            name: "Mock Node",
            description: "Mock data for development"
        };
    }

    /**
     * Fetch group member participation data (track-based)
     * @param {string} groupId - Group ID
     * @returns {Promise<Object>} Participation data with members array
     */
    async fetchGroupParticipation(groupId) {
        const cacheKey = `groupParticipation:${groupId}`;
        if (this.cache.has(cacheKey)) {
            const cached = this.cache.get(cacheKey);
            if (Date.now() - cached.timestamp < this.cacheTimeout) return cached.data;
        }

        const resp = await fetch(`${this.baseUrl}/groups/${groupId}/participation`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        this.cache.set(cacheKey, { data, timestamp: Date.now() });
        return data;
    }

    /**
     * Fetch curate operations (anchored submissions with vote tallies)
     * @param {Object} [opts] - Query options
     * @param {number} [opts.limit=50]
     * @param {string} [opts.lower_bound]
     * @param {number} [opts.type] - Event type filter
     * @returns {Promise<Object>} { success, operations, more, next_key }
     */
    async fetchCurateOperations(opts = {}) {
        try {
            const params = new URLSearchParams();
            if (opts.limit) params.set('limit', String(opts.limit));
            if (opts.lower_bound) params.set('lower_bound', opts.lower_bound);
            if (opts.type !== undefined) params.set('type', String(opts.type));

            const qs = params.toString();
            const url = `${this.baseUrl}/curate/operations${qs ? '?' + qs : ''}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error('Error fetching curate operations:', error);
            return { success: false, operations: [], more: false };
        }
    }

    /**
     * Fetch full detail for a single curate operation.
     * @param {string} hash - Operation hash
     * @param {string} [viewer] - Viewer account name (to get viewer_vote)
     * @returns {Promise<Object>} Operation detail
     */
    async fetchOperationDetail(hash, viewer) {
        try {
            const params = new URLSearchParams();
            if (viewer) params.set('viewer', viewer);
            const qs = params.toString();
            const url = `${this.baseUrl}/curate/operations/${encodeURIComponent(hash)}${qs ? '?' + qs : ''}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error('Error fetching operation detail:', error);
            return { success: false };
        }
    }

    /**
     * Fetch playback queue for a given context.
     * @param {string} contextType - 'release', 'group', or 'person'
     * @param {string} contextId - Entity ID
     * @returns {Promise<Object>} { success, context, queue }
     */
    async fetchPlaybackQueue(contextType, contextId) {
        try {
            const params = new URLSearchParams({
                contextType,
                contextId
            });
            const url = `${this.baseUrl}/player/queue?${params}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error('Error fetching playback queue:', error);
            return { success: false, queue: [] };
        }
    }

    /**
     * Clear cache
     */
    clearCache() {
        this.cache.clear();
    }
}

// Export singleton instance
export const graphApi = new GraphAPI();
