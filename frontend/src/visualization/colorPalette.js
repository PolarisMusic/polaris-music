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

        /**
         * Multiplier applied to every edge width, set by the viewport.
         *
         * The base weights below were picked for a handful of edges. A real
         * group pulls in dozens, and hyperline edges are drawn at full weight
         * however far the view is zoomed out, so the graph reads as a thicket
         * rather than a set of relationships. MusicGraph lowers this on
         * desktop and lowers it much further on a phone, where the same edges
         * are packed into a third of the width.
         *
         * 1 leaves the base weights untouched, which is what a consumer that
         * never sets it gets.
         */
        this.edgeWidthScale = 1;
        /** Memo for withOpacity, and the colours it could not parse. */
        this._opacityCache = new Map();
        this._warnedColors = new Set();
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
     * The same colour, carrying less of itself.
     *
     * Used to push everything that is not the current neighbourhood into the
     * background. Takes whatever the palette or the database produced — a
     * 3- or 6-digit hex, an rgb(), or an rgba() that already has an alpha, as
     * guest edges do — and multiplies the alpha rather than replacing it, so a
     * credit that was already half-strength ends up fainter than a membership
     * that was not.
     *
     * Memoised because this runs from onBeforePlotLine, which is once per edge
     * per frame: on a dense group that is several hundred string builds in
     * every animation step. The key space is the palette plus one colour per
     * person, so it is bounded in practice, and capped anyway.
     *
     * @param {string} color
     * @param {number} factor - 0..1
     * @returns {string} an rgba() string, or the input if it cannot be parsed
     */
    withOpacity(color, factor) {
        if (!color || factor >= 1) return color;

        const key = `${color}|${factor}`;
        const cached = this._opacityCache.get(key);
        if (cached) return cached;

        const parsed = this._parseColor(color);
        // Unparseable: hand back the original rather than paint something
        // arbitrary. A line at full strength is a worse outcome than a crash
        // only if it is silent, so say so once.
        if (!parsed) {
            if (!this._warnedColors.has(color)) {
                this._warnedColors.add(color);
                console.warn('withOpacity: unrecognised colour', color);
            }
            return color;
        }

        const { r, g, b, a } = parsed;
        const result = `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a * factor))})`;

        // Bounded so a pathological data set cannot grow this without limit.
        if (this._opacityCache.size > 512) this._opacityCache.clear();
        this._opacityCache.set(key, result);
        return result;
    }

    /**
     * @private
     * @param {string} color
     * @returns {{r: number, g: number, b: number, a: number}|null}
     */
    _parseColor(color) {
        const text = String(color).trim();

        const short = /^#([a-f\d])([a-f\d])([a-f\d])$/i.exec(text);
        if (short) {
            // #abc is #aabbcc, not #0a0b0c.
            return {
                r: parseInt(short[1] + short[1], 16),
                g: parseInt(short[2] + short[2], 16),
                b: parseInt(short[3] + short[3], 16),
                a: 1,
            };
        }

        const long = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(text);
        if (long) {
            return {
                r: parseInt(long[1], 16),
                g: parseInt(long[2], 16),
                b: parseInt(long[3], 16),
                a: 1,
            };
        }

        const functional = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(text);
        if (functional) {
            return {
                r: Number(functional[1]),
                g: Number(functional[2]),
                b: Number(functional[3]),
                a: functional[4] === undefined ? 1 : Number(functional[4]),
            };
        }

        return null;
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
        return this.getBaseEdgeWidth(relType) * this.edgeWidthScale;
    }

    /**
     * Edge width before the viewport's scale is applied, in pixels.
     *
     * Split out so the relative weights — which carry meaning, a membership
     * edge being heavier than a credit — stay in one place, and thinning the
     * whole graph is one number rather than six.
     *
     * @param {string} relType - Relationship type
     * @returns {number} Unscaled width in pixels
     */
    getBaseEdgeWidth(relType) {
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
