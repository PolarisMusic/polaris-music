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

/**
 * Show a bound entity's existing aliases beside the name that found it.
 *
 * Binding to somebody already in the registry and leaving the box empty read
 * as "this person has no other names" when the truth was that nobody had
 * looked. Worse, submitting from there sent nothing, so a node's aliases were
 * invisible to the next submitter and got retyped or lost.
 *
 * Only fills an empty box: what the submitter typed is theirs, and the
 * aliases being added are additive anyway — a name already on the node is
 * discarded server-side rather than stored twice.
 *
 * @param {HTMLInputElement} nameInput - The visible name field.
 * @param {{alt_names?: string[]}|null} result - The bound entity, or null on unbind.
 */
export function fillAliasBox(nameInput, result) {
    const aliasName = String(nameInput?.name ?? '').replace(/-name-/, '-altnames-');
    if (!aliasName || aliasName === nameInput?.name) return;

    const box = nameInput.closest('form, body')?.querySelector(`[name="${aliasName}"]`);
    if (!box || box.value.trim()) return;

    const aliases = Array.isArray(result?.alt_names) ? result.alt_names : [];
    if (aliases.length === 0) return;

    box.value = aliases.join(', ');
    // So a disclosure holding it opens: an alias filled in behind a closed
    // summary is one nobody reads and everybody re-types.
    box.closest('details')?.setAttribute('open', '');
}

export class FormLookupManager {
    /**
     * @param {HTMLElement} formRoot - The form element or container to observe
     */
    constructor(formRoot) {
        this.formRoot = formRoot;
        this._boundFields = new WeakSet();
        // Keyed by the hidden input so callers can reach an instance to bind
        // it programmatically (the Discogs import does this). A Map rather
        // than the previous plain array because instances also have to be
        // found again to destroy them when their row is removed.
        this._instances = new Map();

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
                types,
                onBind: (result) => fillAliasBox(visibleInput, result),
            });

            this._boundFields.add(hiddenInput);
            this._instances.set(hiddenInput, instance);
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
            this._instances.set(container, instance);
        }

        this._reapDetached();
    }

    /**
     * Drop instances whose element has left the document.
     *
     * The Discogs import clears every container with innerHTML = '', which
     * removes the rows but not the document-level click listeners each
     * EntityLookupField registers. Without this, re-importing repeatedly
     * accumulates listeners over detached nodes.
     *
     * @private
     */
    _reapDetached() {
        for (const [element, instance] of this._instances) {
            if (element.isConnected) continue;
            instance.destroy();
            this._instances.delete(element);
        }
    }

    /**
     * Get the lookup field bound to a hidden input, for programmatic binding.
     *
     * @param {HTMLInputElement} hiddenInput
     * @returns {import('./EntityLookupField.js').EntityLookupField|undefined}
     */
    getInstance(hiddenInput) {
        return this._instances.get(hiddenInput);
    }

    /** Destroy all instances and stop observing */
    destroy() {
        this._observer.disconnect();
        clearTimeout(this._scanTimer);
        for (const instance of this._instances.values()) {
            instance.destroy();
        }
        this._instances.clear();
    }
}
