/**
 * EntityLookupField - Entity-binding autocomplete for the release submission form.
 *
 * Manages a visible text input + hidden canonical ID input pair.
 * When the user selects an existing entity from search results, the hidden ID
 * is populated. If the user edits the text after selection, the ID is cleared
 * (stale-ID prevention).
 *
 * Usage:
 *   new EntityLookupField({
 *       input: document.querySelector('[name="group-name-0-0"]'),
 *       hiddenInput: document.querySelector('[name="group-id-0-0"]'),
 *       types: ['Group'],
 *       onBind: (entity) => { ... },   // called on select or clear
 *   });
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

export class EntityLookupField {
    /**
     * @param {Object} opts
     * @param {HTMLInputElement} opts.input - Visible text input
     * @param {HTMLInputElement} opts.hiddenInput - Hidden ID input
     * @param {string[]} [opts.types] - Entity type filter
     * @param {Function} [opts.onBind] - Callback when entity is bound/unbound
     */
    constructor({ input, hiddenInput, types = [], onBind = null }) {
        this.input = input;
        this.hiddenInput = hiddenInput;
        this.types = types;
        this.onBind = onBind;

        this.results = [];
        this.activeIndex = -1;
        this.selectedEntity = null;
        this._debounceTimer = null;
        this._boundText = ''; // text at time of selection

        this._build();
        this._attachEvents();
    }

    _build() {
        // Wrap input in a relative container for dropdown positioning
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'entity-lookup-wrapper';
        this.input.parentNode.insertBefore(this.wrapper, this.input);
        this.wrapper.appendChild(this.input);

        // Dropdown
        this.dropdown = document.createElement('div');
        this.dropdown.className = 'entity-lookup-dropdown';
        this.dropdown.style.display = 'none';
        this.wrapper.appendChild(this.dropdown);

        // Badge (shown when entity is bound)
        this.badge = document.createElement('div');
        this.badge.className = 'entity-lookup-badge';
        this.badge.style.display = 'none';
        this.wrapper.appendChild(this.badge);
    }

    _attachEvents() {
        this.input.addEventListener('input', () => this._onInput());
        this.input.addEventListener('keydown', (e) => this._onKeydown(e));
        this.input.addEventListener('focus', () => {
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
        // Stale-ID clearing: if text changed after selection, clear the binding
        if (this.selectedEntity && this.input.value !== this._boundText) {
            this._clearBinding();
        }

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
            this.results = await searchNodes(query, { types: this.types, limit: 8 });
            this.activeIndex = -1;
            this._renderDropdown();
        } catch (e) {
            console.error('EntityLookupField search error:', e);
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

            // Show ID in muted text
            if (result.id) {
                const idSpan = document.createElement('span');
                idSpan.className = 'entity-lookup-id';
                idSpan.textContent = result.id.length > 20 ? result.id.substring(0, 20) + '...' : result.id;
                item.appendChild(idSpan);
            }

            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this._select(result);
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
                this._select(this.results[this.activeIndex]);
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

    _select(result) {
        this.selectedEntity = result;
        this._boundText = result.display_name;
        this.input.value = result.display_name;
        this.hiddenInput.value = result.id;
        this.dropdown.style.display = 'none';
        this.results = [];

        this._showBadge(result);

        if (this.onBind) this.onBind(result);
    }

    _clearBinding() {
        this.selectedEntity = null;
        this._boundText = '';
        this.hiddenInput.value = '';
        this._hideBadge();

        if (this.onBind) this.onBind(null);
    }

    _showBadge(entity) {
        const typeLabel = entity.type;
        const idShort = entity.id.length > 24 ? entity.id.substring(0, 24) + '...' : entity.id;
        this.badge.innerHTML = '';

        const text = document.createElement('span');
        text.textContent = `Using existing ${typeLabel}`;
        this.badge.appendChild(text);

        const idEl = document.createElement('span');
        idEl.className = 'entity-lookup-badge-id';
        idEl.textContent = idShort;
        this.badge.appendChild(idEl);

        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'entity-lookup-badge-clear';
        clearBtn.textContent = '\u00d7';
        clearBtn.title = 'Clear selection';
        clearBtn.addEventListener('click', () => {
            this._clearBinding();
        });
        this.badge.appendChild(clearBtn);

        this.badge.style.display = 'flex';
    }

    _hideBadge() {
        this.badge.style.display = 'none';
        this.badge.innerHTML = '';
    }

    /** Programmatically set a binding (e.g. from Discogs import reconciliation) */
    bind(entity) {
        if (!entity || !entity.id) {
            this._clearBinding();
            return;
        }
        this._select(entity);
    }

    /** Tear down event listeners */
    destroy() {
        document.removeEventListener('click', this._clickOutsideHandler);
        clearTimeout(this._debounceTimer);
    }
}
