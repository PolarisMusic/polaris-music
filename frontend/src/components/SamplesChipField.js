/**
 * SamplesChipField - Multi-select track search with chip display.
 *
 * Used for the "sampled tracks" field in the track form.
 * Each selected track appears as a chip; the hidden input stores
 * a JSON array of selected track IDs.
 */

import { searchNodes } from '../utils/searchClient.js';

const TYPE_COLORS = {
    Track: '#6a1b9a',
    Song: '#8e24aa'
};

export class SamplesChipField {
    /**
     * @param {Object} opts
     * @param {HTMLInputElement} opts.searchInput - Visible search input
     * @param {HTMLInputElement} opts.hiddenInput - Hidden input storing JSON array of IDs
     * @param {HTMLElement} opts.chipsContainer - Container for selected chips
     * @param {string[]} [opts.types] - Entity type filter
     */
    constructor({ searchInput, hiddenInput, chipsContainer, types = ['Track'] }) {
        this.searchInput = searchInput;
        this.hiddenInput = hiddenInput;
        this.chipsContainer = chipsContainer;
        this.types = types;
        this.selectedItems = []; // { id, display_name, type }
        this.results = [];
        this.activeIndex = -1;
        this._debounceTimer = null;

        this._build();
        this._attachEvents();
    }

    _build() {
        // Wrap search input for dropdown positioning
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'entity-lookup-wrapper';
        this.searchInput.parentNode.insertBefore(this.wrapper, this.searchInput);
        this.wrapper.appendChild(this.searchInput);

        this.dropdown = document.createElement('div');
        this.dropdown.className = 'entity-lookup-dropdown';
        this.dropdown.style.display = 'none';
        this.wrapper.appendChild(this.dropdown);
    }

    _attachEvents() {
        this.searchInput.addEventListener('input', () => this._onInput());
        this.searchInput.addEventListener('keydown', (e) => this._onKeydown(e));
        this.searchInput.addEventListener('focus', () => {
            if (this.results.length > 0) this.dropdown.style.display = 'block';
        });

        this._clickOutsideHandler = (e) => {
            if (!this.wrapper.contains(e.target)) {
                this.dropdown.style.display = 'none';
            }
        };
        document.addEventListener('click', this._clickOutsideHandler);
    }

    _onInput() {
        clearTimeout(this._debounceTimer);
        const q = this.searchInput.value.trim();
        if (q.length < 2) {
            this.results = [];
            this.dropdown.style.display = 'none';
            return;
        }
        this._debounceTimer = setTimeout(() => this._search(q), 200);
    }

    async _search(query) {
        try {
            const allResults = await searchNodes(query, { types: this.types, limit: 8 });
            // Filter out already-selected items
            const selectedIds = new Set(this.selectedItems.map(s => s.id));
            this.results = allResults.filter(r => !selectedIds.has(r.id));
            this.activeIndex = -1;
            this._renderDropdown();
        } catch (e) {
            console.error('SamplesChipField search error:', e);
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
            item.className = 'entity-lookup-item' + (idx === this.activeIndex ? ' entity-lookup-item--active' : '');

            const badge = document.createElement('span');
            badge.className = 'entity-lookup-type-badge';
            badge.textContent = result.type;
            badge.style.background = TYPE_COLORS[result.type] || '#555';

            const name = document.createElement('span');
            name.className = 'entity-lookup-name';
            name.textContent = result.display_name;

            item.appendChild(badge);
            item.appendChild(name);

            if (result.subtitle) {
                const sub = document.createElement('span');
                sub.className = 'entity-lookup-subtitle';
                sub.textContent = result.subtitle;
                item.appendChild(sub);
            }

            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this._addChip(result);
            });
            item.addEventListener('mouseenter', () => {
                this.activeIndex = idx;
                this._updateActive();
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
            if (this.activeIndex >= 0 && this.activeIndex < this.results.length) {
                e.preventDefault();
                this._addChip(this.results[this.activeIndex]);
            }
        } else if (e.key === 'Escape') {
            this.dropdown.style.display = 'none';
        }
    }

    _updateActive() {
        const items = this.dropdown.querySelectorAll('.entity-lookup-item');
        items.forEach((el, i) => {
            el.classList.toggle('entity-lookup-item--active', i === this.activeIndex);
        });
    }

    _addChip(result) {
        this.selectedItems.push({
            id: result.id,
            display_name: result.display_name,
            type: result.type
        });

        this._renderChips();
        this._syncHiddenInput();

        // Clear search
        this.searchInput.value = '';
        this.results = [];
        this.dropdown.style.display = 'none';
    }

    _removeChip(id) {
        this.selectedItems = this.selectedItems.filter(s => s.id !== id);
        this._renderChips();
        this._syncHiddenInput();
    }

    _renderChips() {
        this.chipsContainer.innerHTML = '';
        for (const item of this.selectedItems) {
            const chip = document.createElement('span');
            chip.className = 'samples-chip';

            const text = document.createElement('span');
            text.textContent = item.display_name;
            chip.appendChild(text);

            const idText = document.createElement('span');
            idText.className = 'samples-chip-id';
            idText.textContent = item.id.length > 16 ? item.id.substring(0, 16) + '...' : item.id;
            chip.appendChild(idText);

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'samples-chip-remove';
            removeBtn.textContent = '\u00d7';
            removeBtn.addEventListener('click', () => this._removeChip(item.id));
            chip.appendChild(removeBtn);

            this.chipsContainer.appendChild(chip);
        }
    }

    _syncHiddenInput() {
        this.hiddenInput.value = this.selectedItems.length > 0
            ? JSON.stringify(this.selectedItems.map(s => s.id))
            : '';
    }

    destroy() {
        document.removeEventListener('click', this._clickOutsideHandler);
        clearTimeout(this._debounceTimer);
    }
}
