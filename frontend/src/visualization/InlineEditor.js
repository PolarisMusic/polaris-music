/**
 * InlineEditor — owns the inline editing UI previously smeared across
 * MusicGraph: the .edit-btn HTML helper, the click→input/textarea
 * replacement flow, and the color-picker submission flow. All edits
 * are submitted through ClaimManager.
 *
 * Extracted from MusicGraph as the fifth (final) pass of the J-series
 * splits (after InfoPanelRenderer, OverlayPositioner, FavoritesManager,
 * GraphDataLoader, DonutLoader, PanController). Behavior is unchanged
 * — the characterization tests in
 * `backend/test/visualization/inlineEditor.snapshot.test.js` lock the
 * HTML output of editableRowHtml plus every interaction state.
 *
 * Public API:
 *   editableRowHtml(nodeType, nodeId, field, currentValue, label,
 *                   isTextarea = false)
 *                                    → HTML string with a .edit-btn,
 *                                      embedded in info panels
 *
 *   attach(container)                → wire up both .edit-btn click
 *                                      and .color-picker-input change
 *                                      listeners on the given DOM root
 *
 * Implementation methods (private; tests reach in via source-extract):
 *   attachEditListeners(container)
 *   openInlineEditor(btn, nodeType, nodeId, field, currentValue,
 *                    useTextarea)
 *   attachColorPickerListeners(container)
 *
 * @module visualization/InlineEditor
 */

export class InlineEditor {
    /**
     * @param {Object} deps
     * @param {Object} deps.claimManager  - exposes submitEdit(nodeType, nodeId, field, value)
     * @param {Object} deps.callbacks
     * @param {() => Object|null} deps.callbacks.getSelectedNode      - JIT node currently selected
     * @param {(node: Object) => Promise<void>} deps.callbacks.refreshInfoPanel - re-render after save
     * @param {() => void} deps.callbacks.plot                        - request graph redraw
     * @param {(nodeId: string, color: string) => void} deps.callbacks.patchRawGraphColor
     *                                                                - persist the new color in the cached
     *                                                                  raw graph so merges don't revert it
     */
    constructor({ claimManager, callbacks }) {
        this.claimManager = claimManager;
        this.callbacks = callbacks;
    }

    /**
     * Build HTML for an editable property row with an edit button.
     */
    editableRowHtml(nodeType, nodeId, field, currentValue, label, isTextarea = false) {
        const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        return `<button class="edit-btn" data-node-type="${esc(nodeType)}" data-node-id="${esc(nodeId)}" data-field="${esc(field)}" data-current-value="${esc(currentValue)}" data-textarea="${isTextarea}" title="Edit ${esc(label)}">&#9998; ${esc(label)}</button> `;
    }

    /**
     * Attach both edit-button and color-picker listeners to a container.
     * Single entry point so info-panel renderers don't need to call two
     * separate methods.
     */
    attach(container) {
        this.attachEditListeners(container);
        this.attachColorPickerListeners(container);
    }

    /**
     * Attach click listeners to .edit-btn buttons inside a container.
     * Opens an inline editor; on save, submits via ClaimManager.
     */
    attachEditListeners(container) {
        container.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const { nodeType, nodeId, field, currentValue, textarea } = btn.dataset;
                this.openInlineEditor(btn, nodeType, nodeId, field, currentValue, textarea === 'true');
            });
        });
    }

    /**
     * Replace an edit button with an inline editor (input or textarea).
     */
    openInlineEditor(btn, nodeType, nodeId, field, currentValue, useTextarea) {
        const wrapper = document.createElement('div');
        wrapper.className = 'inline-edit-wrapper';

        const input = document.createElement(useTextarea ? 'textarea' : 'input');
        input.className = 'inline-edit-input';
        input.value = currentValue;
        if (!useTextarea) input.type = 'text';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'inline-edit-save';
        saveBtn.textContent = 'Save';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'inline-edit-cancel';
        cancelBtn.textContent = 'Cancel';

        wrapper.appendChild(input);
        wrapper.appendChild(saveBtn);
        wrapper.appendChild(cancelBtn);

        btn.replaceWith(wrapper);
        input.focus();

        cancelBtn.addEventListener('click', () => {
            wrapper.replaceWith(btn);
            this.attachEditListeners(btn.parentElement);
        });

        saveBtn.addEventListener('click', async () => {
            const newValue = input.value;
            if (newValue === currentValue) {
                wrapper.replaceWith(btn);
                this.attachEditListeners(btn.parentElement);
                return;
            }

            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';

            try {
                await this.claimManager.submitEdit(nodeType, nodeId, field, newValue);

                const selected = this.callbacks.getSelectedNode();
                if (selected) {
                    await this.callbacks.refreshInfoPanel(selected);
                }
            } catch (error) {
                console.error('Edit submission failed:', error);
                alert('Edit failed: ' + error.message);
                wrapper.replaceWith(btn);
                this.attachEditListeners(btn.parentElement);
            }
        });
    }

    /**
     * Attach change listeners to color picker inputs.
     * On change, submits the new color via ClaimManager.
     */
    attachColorPickerListeners(container) {
        container.querySelectorAll('.color-picker-input').forEach(picker => {
            picker.addEventListener('change', async (e) => {
                const newColor = e.target.value;
                const pickerNodeId = picker.dataset.nodeId;
                try {
                    await this.claimManager.submitEdit('person', pickerNodeId, 'color', newColor);
                    // Update swatch and hex display immediately
                    const row = picker.closest('.info-color-row');
                    if (row) {
                        const swatch = row.querySelector('.info-color-swatch');
                        const hex = row.querySelector('.info-color-hex');
                        if (swatch) swatch.style.background = newColor;
                        if (hex) hex.textContent = newColor;
                    }
                    // Update the graph node color via JIT API for immediate visual feedback
                    const selected = this.callbacks.getSelectedNode();
                    if (selected) {
                        selected.setData('color', newColor);
                        this.callbacks.plot();
                    }
                    // Patch rawGraph so merges don't revert the color
                    this.callbacks.patchRawGraphColor(pickerNodeId, newColor);
                } catch (error) {
                    console.error('Color edit failed:', error);
                    alert('Color edit failed: ' + error.message);
                }
            });
        });
    }
}
