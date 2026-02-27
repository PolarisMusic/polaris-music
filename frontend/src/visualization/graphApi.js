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
     * Fetch releases for a group
     * @param {string} groupId - Group ID
     * @returns {Promise<Array>} Array of releases
     */
    async fetchGroupReleases(groupId) {
        try {
            const response = await fetch(`${this.baseUrl}/group/${groupId}/releases`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            console.error('Error fetching group releases:', error);
            return [];
        }
    }

    /**
     * Search for nodes
     * @param {string} query - Search query
     * @param {string} type - Node type filter (optional)
     * @returns {Promise<Array>} Search results
     */
    async search(query, type = null) {
        try {
            const params = new URLSearchParams({ q: query });
            if (type) params.append('type', type);

            const response = await fetch(`${this.baseUrl}/search?${params}`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            console.error('Error searching:', error);
            return [];
        }
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

        // Create a map of node adjacencies
        const adjacencyMap = new Map();

        // Initialize adjacency lists for all nodes
        data.nodes.forEach(node => {
            adjacencyMap.set(node.id, []);
        });

        // Build adjacency lists from edges
        data.edges.forEach(edge => {
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
            if (v === 'group') return 18;
            if (v === 'person') return 10;
            if (v === 'release') return 9;
            if (v === 'track') return 8;
            return 8;
        };

        // Transform nodes to JIT format with adjacencies
        const jitNodes = data.nodes.map(node => ({
            id: node.id,
            name: node.name,
            data: {
                $dim: dimForType(node.type),
                $type: 'circle-hover',
                $color: node.color || undefined,  // DB-driven person color
                type: node.type,
                trackCount: node.trackCount || 0
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
     * Fetch group member participation data (release-based)
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
     * Clear cache
     */
    clearCache() {
        this.cache.clear();
    }
}

// Export singleton instance
export const graphApi = new GraphAPI();
