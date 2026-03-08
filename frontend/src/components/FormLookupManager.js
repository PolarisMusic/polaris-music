/**
 * FormLookupManager - Binds EntityLookupField instances to dynamic form rows.
 *
 * Because the release form is dynamic (rows are added/removed at runtime),
 * this manager scans for lookup-enabled fields and attaches EntityLookupField
 * instances. It uses a MutationObserver to handle dynamically added rows.
 *
 * Field mapping:
 *   data-lookup-type attribute on hidden ID inputs determines which entity
 *   types to search for. The visible text input is the sibling before the
 *   hidden input.
 */

import { EntityLookupField } from './EntityLookupField.js';
import { SamplesChipField } from './SamplesChipField.js';

// Maps data-lookup-type values to search type filters
const LOOKUP_TYPE_MAP = {
    'Release': ['Release'],
    'Label': ['Label'],
    'Group': ['Group'],
    'Person': ['Person'],
    'Song': ['Song'],
    'Track': ['Track'],
    'City': ['City']
};

export class FormLookupManager {
    /**
     * @param {HTMLElement} formRoot - The form element or container to observe
     */
    constructor(formRoot) {
        this.formRoot = formRoot;
        this._boundFields = new WeakSet();
        this._instances = [];

        // Initial scan
        this._scanAndBind();

        // Observe for dynamically added form rows
        this._observer = new MutationObserver((mutations) => {
            let needsScan = false;
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    needsScan = true;
                    break;
                }
            }
            if (needsScan) {
                // Debounce slightly to batch multiple additions
                clearTimeout(this._scanTimer);
                this._scanTimer = setTimeout(() => this._scanAndBind(), 50);
            }
        });

        this._observer.observe(formRoot, { childList: true, subtree: true });
    }

    /**
     * Scan the form for hidden inputs with data-lookup-type and bind
     * EntityLookupField instances to their paired visible inputs.
     * Also scans for samples chip containers.
     */
    _scanAndBind() {
        // Bind single-entity lookup fields
        const hiddenInputs = this.formRoot.querySelectorAll('input[data-lookup-type]');

        for (const hiddenInput of hiddenInputs) {
            if (this._boundFields.has(hiddenInput)) continue;

            const lookupType = hiddenInput.dataset.lookupType;
            const types = LOOKUP_TYPE_MAP[lookupType] || [lookupType];

            // Find the paired visible input
            const pairedInputName = hiddenInput.dataset.lookupPair;
            let visibleInput = null;

            if (pairedInputName) {
                visibleInput = this.formRoot.querySelector(`[name="${pairedInputName}"]`);
            }

            // Fallback: previous sibling input
            if (!visibleInput) {
                let prev = hiddenInput.previousElementSibling;
                while (prev && prev.tagName !== 'INPUT') {
                    prev = prev.previousElementSibling;
                }
                visibleInput = prev;
            }

            if (!visibleInput) continue;

            const instance = new EntityLookupField({
                input: visibleInput,
                hiddenInput: hiddenInput,
                types
            });

            this._boundFields.add(hiddenInput);
            this._instances.push(instance);
        }

        // Bind multi-select samples chip fields
        const samplesContainers = this.formRoot.querySelectorAll('.samples-chips-container');
        for (const container of samplesContainers) {
            if (this._boundFields.has(container)) continue;

            const trackIndex = container.dataset.track;
            const searchInput = this.formRoot.querySelector(`[name="track-samples-search-${trackIndex}"]`);
            const hiddenInput = this.formRoot.querySelector(`[name="track-samples-${trackIndex}"]`);

            if (!searchInput || !hiddenInput) continue;

            const instance = new SamplesChipField({
                searchInput,
                hiddenInput,
                chipsContainer: container,
                types: ['Track']
            });

            this._boundFields.add(container);
            this._instances.push(instance);
        }
    }

    /** Destroy all instances and stop observing */
    destroy() {
        this._observer.disconnect();
        clearTimeout(this._scanTimer);
        for (const instance of this._instances) {
            instance.destroy();
        }
        this._instances = [];
    }
}
