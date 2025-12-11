/**
 * Color Palette System for Polaris Music Registry
 *
 * Manages consistent color assignments for Persons across all visualizations.
 * Uses a 16-color palette with deterministic assignment based on person IDs.
 */

export class ColorPalette {
    constructor() {
        // 16-color palette optimized for dark backgrounds
        this.colors = [
            '#4A90E2', // Blue
            '#E94B3C', // Red
            '#6BC47D', // Green
            '#F39C12', // Orange
            '#9B59B6', // Purple
            '#1ABC9C', // Teal
            '#E74C3C', // Crimson
            '#3498DB', // Sky Blue
            '#2ECC71', // Emerald
            '#F1C40F', // Yellow
            '#E67E22', // Carrot
            '#9B59B6', // Amethyst
            '#16A085', // Green Sea
            '#C0392B', // Pomegranate
            '#2980B9', // Belize Hole
            '#27AE60', // Nephritis
        ];

        // Track assigned colors
        this.assignments = new Map(); // person_id -> color
        this.nextColorIndex = 0;
    }

    /**
     * Get or assign a color for a person
     * @param {string} personId - Person's unique ID
     * @returns {string} Hex color code
     */
    getColor(personId) {
        if (!personId) {
            return '#888888'; // Default gray for unknown
        }

        // Return existing assignment
        if (this.assignments.has(personId)) {
            return this.assignments.get(personId);
        }

        // Assign new color deterministically
        const color = this.assignColor(personId);
        return color;
    }

    /**
     * Assign a color to a person using deterministic algorithm
     * @param {string} personId - Person's unique ID
     * @returns {string} Hex color code
     */
    assignColor(personId) {
        // Use simple hash of person ID to get consistent color index
        const hash = this.simpleHash(personId);
        const colorIndex = hash % this.colors.length;
        const color = this.colors[colorIndex];

        this.assignments.set(personId, color);
        return color;
    }

    /**
     * Simple string hash function
     * @param {string} str - String to hash
     * @returns {number} Hash value
     */
    simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash);
    }

    /**
     * Get color with alpha transparency
     * @param {string} personId - Person's unique ID
     * @param {number} alpha - Alpha value (0-1)
     * @returns {string} RGBA color
     */
    getColorWithAlpha(personId, alpha = 0.7) {
        const color = this.getColor(personId);
        const rgb = this.hexToRgb(color);
        return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
    }

    /**
     * Convert hex color to RGB
     * @param {string} hex - Hex color code
     * @returns {object} RGB object {r, g, b}
     */
    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : { r: 136, g: 136, b: 136 };
    }

    /**
     * Get all assigned colors
     * @returns {Map} Map of person_id -> color
     */
    getAssignments() {
        return new Map(this.assignments);
    }

    /**
     * Clear all assignments
     */
    clear() {
        this.assignments.clear();
        this.nextColorIndex = 0;
    }

    /**
     * Get edge color for a relationship
     * @param {string} relType - Relationship type
     * @param {string} personId - Person ID (for colored relationships)
     * @returns {string} Color code
     */
    getEdgeColor(relType, personId = null) {
        switch (relType) {
            case 'MEMBER_OF':
                return personId ? this.getColor(personId) : '#888888';
            case 'PERFORMED_ON':
                return '#6BC47D'; // Green
            case 'GUEST_ON':
                return personId ? this.getColorWithAlpha(personId, 0.5) : '#888888';
            case 'RELEASED':
                return '#666666'; // Gray
            case 'ORIGIN':
                return '#444444'; // Light gray
            default:
                return '#888888';
        }
    }

    /**
     * Get edge width for a relationship type
     * @param {string} relType - Relationship type
     * @returns {number} Width in pixels
     */
    getEdgeWidth(relType) {
        switch (relType) {
            case 'MEMBER_OF':
                return 3;
            case 'PERFORMED_ON':
                return 2;
            case 'GUEST_ON':
                return 1.5;
            case 'RELEASED':
                return 1;
            case 'ORIGIN':
                return 1;
            default:
                return 1;
        }
    }

    /**
     * Get edge style for a relationship type
     * @param {string} relType - Relationship type
     * @returns {string} Style ('solid', 'dashed', 'dotted')
     */
    getEdgeStyle(relType) {
        switch (relType) {
            case 'RELEASED':
                return 'dashed';
            case 'ORIGIN':
                return 'dotted';
            default:
                return 'solid';
        }
    }
}

// Export singleton instance
export const colorPalette = new ColorPalette();
