/**
 * NodeSearchBox - Reusable autocomplete search component for graph nodes.
 *
 * Usage:
 *   const box = new NodeSearchBox({
 *       container: document.getElementById('search-container'),
 *       types: ['Person', 'Group'],  // optional label filter
 *       placeholder: 'Search...',
 *       onSelect: (result) => { ... }
 *   });
 *
 * Result shape passed to onSelect:
 *   { id, type, display_name, subtitle, image, color, score }
 */

import { searchNodes } from '../utils/searchClient.js';

const TYPE_COLORS = {
    Person: '#1565c0',
    Group: '#2e7d32',
    Release: '#e65100',
    Track: '#6a1b9a',
    Song: '#8e24aa',
    Label: '#795548',
    City: '#00695c'
};

export class NodeSearchBox {
    constructor({ container, types = [], placeholder = 'Search nodes...', onSelect }) {
        this.types = types;
        this.onSelect = onSelect;
        this.results = [];
        this.activeIndex = -1;
        this._debounceTimer = null;
        this._hoverTooltipTimer = null;

        // Build DOM
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'node-search-box';

        this.input = document.createElement('input');
        this.input.type = 'text';
        this.input.className = 'node-search-input';
        this.input.placeholder = placeholder;
        this.input.autocomplete = 'off';

        this.dropdown = document.createElement('div');
        this.dropdown.className = 'node-search-dropdown';
        this.dropdown.style.display = 'none';

        this.tooltip = document.createElement('div');
        this.tooltip.className = 'node-search-tooltip';
        this.tooltip.style.display = 'none';

        this.wrapper.appendChild(this.input);
        this.wrapper.appendChild(this.dropdown);
        this.wrapper.appendChild(this.tooltip);
        container.appendChild(this.wrapper);

        // Events
        this.input.addEventListener('input', () => this._onInput());
        this.input.addEventListener('keydown', (e) => this._onKeydown(e));
        this.input.addEventListener('focus', () => {
            if (this.results.length > 0) this.dropdown.style.display = 'block';
        });
        document.addEventListener('click', (e) => {
            if (!this.wrapper.contains(e.target)) {
                this.dropdown.style.display = 'none';
            }
        });
    }

    _onInput() {
        clearTimeout(this._debounceTimer);
        const q = this.input.value.trim();
        if (q.length < 2) {
            this.results = [];
            this.dropdown.style.display = 'none';
            return;
        }
        this._debounceTimer = setTimeout(() => this._search(q), 200);
    }

    async _search(query) {
        try {
            this.results = await searchNodes(query, { types: this.types, limit: 10 });
            this.activeIndex = -1;
            this._renderDropdown();
        } catch (e) {
            console.error('Search error:', e);
        }
    }

    _renderDropdown() {
        if (this.results.length === 0) {
            this.dropdown.style.display = 'none';
            return;
        }

        this.dropdown.innerHTML = '';
        this.results.forEach((result, idx) => {
            const item = document.createElement('div');
            item.className = 'node-search-item' + (idx === this.activeIndex ? ' node-search-item--active' : '');

            const badge = document.createElement('span');
            badge.className = 'node-search-badge';
            badge.textContent = result.type;
            badge.style.background = TYPE_COLORS[result.type] || '#555';

            const name = document.createElement('span');
            name.className = 'node-search-name';
            name.textContent = result.display_name;

            item.appendChild(badge);
            item.appendChild(name);

            if (result.subtitle) {
                const sub = document.createElement('span');
                sub.className = 'node-search-subtitle';
                sub.textContent = result.subtitle;
                item.appendChild(sub);
            }

            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this._select(result);
            });
            item.addEventListener('mouseenter', () => {
                this.activeIndex = idx;
                this._updateActive();
                clearTimeout(this._hoverTooltipTimer);
                this._hoverTooltipTimer = setTimeout(() => {
                    this._showResultTooltip(item, result);
                }, 500);
            });
            item.addEventListener('mouseleave', () => {
                clearTimeout(this._hoverTooltipTimer);
                this._hideResultTooltip();
            });

            this.dropdown.appendChild(item);
        });

        this.dropdown.style.display = 'block';
    }

    _onKeydown(e) {
        if (this.results.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.activeIndex = Math.min(this.activeIndex + 1, this.results.length - 1);
            this._updateActive();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.activeIndex = Math.max(this.activeIndex - 1, 0);
            this._updateActive();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (this.activeIndex >= 0 && this.activeIndex < this.results.length) {
                this._select(this.results[this.activeIndex]);
            }
        } else if (e.key === 'Escape') {
            this.dropdown.style.display = 'none';
        }
    }

    _updateActive() {
        const items = this.dropdown.querySelectorAll('.node-search-item');
        items.forEach((el, i) => {
            el.classList.toggle('node-search-item--active', i === this.activeIndex);
        });
    }

    _select(result) {
        this.input.value = result.display_name;
        this.dropdown.style.display = 'none';
        if (this.onSelect) this.onSelect(result);
    }

    _showResultTooltip(itemEl, result) {
        const name = result.display_name || '';
        const subtitle = result.subtitle ? ` — ${result.subtitle}` : '';
        this.tooltip.textContent = name + subtitle;

        // Position to the right of the dropdown
        const dropdownRect = this.dropdown.getBoundingClientRect();
        const itemRect = itemEl.getBoundingClientRect();
        this.tooltip.style.top = (itemRect.top - dropdownRect.top + this.dropdown.scrollTop) + 'px';
        this.tooltip.style.display = '';
    }

    _hideResultTooltip() {
        this.tooltip.style.display = 'none';
    }

    clear() {
        this.input.value = '';
        this.results = [];
        this.dropdown.style.display = 'none';
        this._hideResultTooltip();
    }
}
