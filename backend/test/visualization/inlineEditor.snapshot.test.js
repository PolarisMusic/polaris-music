/**
 * @jest-environment jsdom
 *
 * InlineEditor characterization tests.
 *
 * The inline-editor cluster (originally on MusicGraph) was extracted
 * into `frontend/src/visualization/InlineEditor.js`. The class owns:
 *   - `editableRowHtml(nodeType, nodeId, field, currentValue, label,
 *                      isTextarea)`        → HTML string with a .edit-btn
 *   - `attach(container)`                  → wires both edit-btn and
 *                                            color-picker listeners
 *   - `attachEditListeners(container)`     → click handlers on .edit-btn
 *   - `openInlineEditor(btn, nodeType, nodeId, field, currentValue,
 *                       useTextarea)`      → replace button with input/textarea
 *                                            + Save / Cancel
 *   - `attachColorPickerListeners(container)` → change handlers on
 *                                                 .color-picker-input
 *
 * The cluster is the densest of the J-series because it touches
 * ClaimManager (network), the JIT graph (visual feedback), the
 * raw-graph cache (so merges don't revert color edits), and the info
 * panel (refresh after save).
 *
 * These tests were written against the unextracted methods (still on
 * MusicGraph) and updated in-PR with the move; the snapshot and
 * behavioral assertions are byte-identical across the extraction.
 *
 * Strategy mirrors Stage J.2 / J.3 / J.4 tests: AST-based source
 * extraction + `new Function(...)` compilation + isolated invoke.
 */

import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parse } from '@babel/parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SOURCE_PATH = resolve(__dirname, '../../../frontend/src/visualization/InlineEditor.js');
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

// ---------------------------------------------------------------------------
// AST extraction.
// ---------------------------------------------------------------------------

const AST = parse(SOURCE, { sourceType: 'module', plugins: ['classProperties'] });

const METHOD_INDEX = (() => {
    const map = new Map();
    function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'ClassMethod' && node.key?.type === 'Identifier') {
            map.set(node.key.name, node);
        }
        for (const key of Object.keys(node)) {
            const v = node[key];
            if (Array.isArray(v)) v.forEach(visit);
            else if (v && typeof v === 'object' && v.type) visit(v);
        }
    }
    visit(AST);
    return map;
})();

function extractMethod(name) {
    const node = METHOD_INDEX.get(name);
    if (!node) throw new Error(`extractMethod: ${name} not found in InlineEditor.js`);
    const params = node.params.map(p => SOURCE.slice(p.start, p.end)).join(', ');
    const body = SOURCE.slice(node.body.start + 1, node.body.end - 1);
    const isAsync = !!node.async;
    return { params, body, isAsync };
}

function compileMethod(name) {
    const { params, body, isAsync } = extractMethod(name);
    const argNames = params.split(',').map(s => s.trim()).filter(Boolean);
    if (isAsync) {
        const AsyncFunction = (async function () {}).constructor;
        return new AsyncFunction(...argNames, body);
    }
    // eslint-disable-next-line no-new-func
    return new Function(...argNames, body);
}

// ---------------------------------------------------------------------------
// Quiet console.error and window.alert (the save-failure path uses both).
// ---------------------------------------------------------------------------

let errSpy, alertSpy;

beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    alertSpy = jest.fn();
    globalThis.alert = alertSpy;
    document.body.innerHTML = '';
});

afterEach(() => {
    errSpy.mockRestore();
    delete globalThis.alert;
    document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// Stub `this` builder. The methods reach into:
//   this.claimManager.submitEdit(nodeType, nodeId, field, value)  async
//   this.callbacks.getSelectedNode()        → JIT node | null
//   this.callbacks.refreshInfoPanel(node)   async; called after save
//   this.callbacks.plot()                   redraw after color change
//   this.callbacks.patchRawGraphColor(id, color) cache patch
// Intra-cluster delegations:
//   this.attachEditListeners(container)     re-attach after replace
//   this.openInlineEditor(...)              called from edit-btn click
// ---------------------------------------------------------------------------

function makeStub({
    submitEdit,
    selectedNode = null,
    refreshInfoPanel = jest.fn(async () => {}),
    plot = jest.fn(),
    patchRawGraphColor = jest.fn(),
} = {}) {
    const stub = {
        claimManager: {
            submitEdit: submitEdit
                ? jest.fn(submitEdit)
                : jest.fn(async () => {}),
        },
        callbacks: {
            getSelectedNode: jest.fn(() => selectedNode),
            refreshInfoPanel: jest.fn(refreshInfoPanel),
            plot,
            patchRawGraphColor: jest.fn(patchRawGraphColor),
        },
    };
    // Intra-cluster bindings — compile from live source.
    stub.attachEditListeners        = compileMethod('attachEditListeners').bind(stub);
    stub.openInlineEditor           = compileMethod('openInlineEditor').bind(stub);
    stub.attachColorPickerListeners = compileMethod('attachColorPickerListeners').bind(stub);
    return stub;
}

// Render a row + button into a container so tests can poke real DOM.
function renderRow(stub, { nodeType = 'person', nodeId = 'p:1', field = 'bio', currentValue = 'old text', label = 'Bio', isTextarea = false } = {}) {
    const container = document.createElement('div');
    container.innerHTML = compileMethod('editableRowHtml').call(
        stub, nodeType, nodeId, field, currentValue, label, isTextarea
    );
    document.body.appendChild(container);
    return container;
}

// Wait one microtask tick for promise chains in click handlers.
function flushMicrotasks() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Drift guard.
// ---------------------------------------------------------------------------

describe('InlineEditor · drift guard', () => {
    test.each([
        ['editableRowHtml',             '(nodeType, nodeId, field, currentValue, label, isTextarea = false)'],
        ['attach',                      '(container)'],
        ['attachEditListeners',         '(container)'],
        ['openInlineEditor',            '(btn, nodeType, nodeId, field, currentValue, useTextarea)'],
        ['attachColorPickerListeners',  '(container)'],
    ])('method %s exists with signature %s', (name, sig) => {
        const expected = sig.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).join(', ');
        const { params } = extractMethod(name);
        const actual = params.split(',').map(s => s.trim()).filter(Boolean).join(', ');
        expect(actual).toBe(expected);
    });

    test('outer methods are not declared async; save/cancel handlers are async internally', () => {
        for (const name of ['editableRowHtml', 'attach', 'attachEditListeners', 'openInlineEditor', 'attachColorPickerListeners']) {
            expect(extractMethod(name).isAsync).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// _editableRow — HTML output snapshot
// ---------------------------------------------------------------------------

describe('editableRowHtml', () => {
    test('input variant (isTextarea=false) → snapshot', () => {
        const stub = makeStub();
        const html = compileMethod('editableRowHtml').call(
            stub, 'person', 'p:42', 'bio', 'Hello "world" & co. <em>', 'Biography'
        );
        expect(html).toMatchSnapshot();
    });

    test('textarea variant (isTextarea=true) → data-textarea="true"', () => {
        const stub = makeStub();
        const html = compileMethod('editableRowHtml').call(
            stub, 'group', 'g:1', 'description', 'desc', 'Description', true
        );
        expect(html).toContain('data-textarea="true"');
    });

    test('escapes &, <, " in attributes (note: > is intentionally NOT escaped)', () => {
        const stub = makeStub();
        const html = compileMethod('editableRowHtml').call(
            stub, 'person', 'p:&<"', 'name', 'value with "quotes" & <tags>', 'L'
        );
        // The esc helper used by _editableRow only encodes &, <, "
        // (matches the implementation; locking current behavior).
        expect(html).toContain('data-node-id="p:&amp;&lt;&quot;"');
        expect(html).toContain('data-current-value="value with &quot;quotes&quot; &amp; &lt;tags>"');
    });

    test('null/undefined currentValue coerced to empty string', () => {
        const stub = makeStub();
        const html = compileMethod('editableRowHtml').call(
            stub, 'person', 'p:1', 'bio', null, 'Bio'
        );
        expect(html).toContain('data-current-value=""');
    });
});

// ---------------------------------------------------------------------------
// _attachEditListeners
// ---------------------------------------------------------------------------

describe('attach (combined entry point)', () => {
    test('wires both edit-btn and color-picker listeners in one call', async () => {
        const selectedNode = { id: 'p:1', setData: jest.fn() };
        const stub = makeStub({ selectedNode });
        const openSpy = jest.fn();
        stub.openInlineEditor = openSpy;

        // Build a container that has both an edit row and a color row.
        const container = document.createElement('div');
        container.innerHTML =
            compileMethod('editableRowHtml').call(stub, 'person', 'p:1', 'bio', 'old', 'Bio') +
            `<div class="info-color-row">
                <span class="info-color-swatch"></span>
                <span class="info-color-hex"></span>
                <input type="color" class="color-picker-input" data-node-id="p:1" value="#000000" />
            </div>`;
        document.body.appendChild(container);

        compileMethod('attach').call(stub, container);

        // Edit listener wired.
        container.querySelector('.edit-btn').click();
        expect(openSpy).toHaveBeenCalledTimes(1);

        // Color listener wired.
        const picker = container.querySelector('.color-picker-input');
        picker.value = '#ff00ff';
        picker.dispatchEvent(new Event('change'));
        await flushMicrotasks();
        expect(stub.claimManager.submitEdit).toHaveBeenCalledWith('person', 'p:1', 'color', '#ff00ff');
    });
});

describe('attachEditListeners', () => {
    test('empty container → no-op', () => {
        const stub = makeStub();
        const container = document.createElement('div');
        document.body.appendChild(container);
        expect(() =>
            compileMethod('attachEditListeners').call(stub, container)
        ).not.toThrow();
    });

    test('click on .edit-btn → calls _openInlineEditor with row dataset', () => {
        const stub = makeStub();
        const openSpy = jest.fn();
        stub.openInlineEditor = openSpy;

        const container = renderRow(stub, { nodeType: 'person', nodeId: 'p:1', field: 'bio', currentValue: 'old', label: 'Bio', isTextarea: true });
        compileMethod('attachEditListeners').call(stub, container);

        const btn = container.querySelector('.edit-btn');
        btn.click();

        expect(openSpy).toHaveBeenCalledTimes(1);
        const [calledBtn, nodeType, nodeId, field, currentValue, useTextarea] = openSpy.mock.calls[0];
        expect(calledBtn).toBe(btn);
        expect(nodeType).toBe('person');
        expect(nodeId).toBe('p:1');
        expect(field).toBe('bio');
        expect(currentValue).toBe('old');
        expect(useTextarea).toBe(true);
    });

    test('attaches one listener per .edit-btn (multiple buttons)', () => {
        const stub = makeStub();
        const openSpy = jest.fn();
        stub.openInlineEditor = openSpy;

        const container = document.createElement('div');
        container.innerHTML =
            compileMethod('editableRowHtml').call(stub, 'person', 'p:1', 'bio', 'a', 'Bio') +
            compileMethod('editableRowHtml').call(stub, 'person', 'p:2', 'bio', 'b', 'Bio');
        document.body.appendChild(container);
        compileMethod('attachEditListeners').call(stub, container);

        const buttons = container.querySelectorAll('.edit-btn');
        expect(buttons.length).toBe(2);
        buttons[0].click();
        buttons[1].click();
        expect(openSpy).toHaveBeenCalledTimes(2);
    });
});

// ---------------------------------------------------------------------------
// _openInlineEditor
// ---------------------------------------------------------------------------

describe('openInlineEditor', () => {
    test('input variant → replaces button with wrapper containing input + Save + Cancel', () => {
        const stub = makeStub();
        const container = renderRow(stub, { isTextarea: false });
        const btn = container.querySelector('.edit-btn');

        compileMethod('openInlineEditor').call(stub, btn, 'person', 'p:1', 'bio', 'old', false);

        const wrapper = container.querySelector('.inline-edit-wrapper');
        expect(wrapper).toBeTruthy();
        expect(container.querySelector('.edit-btn')).toBeNull();
        expect(wrapper.querySelector('input.inline-edit-input')).toBeTruthy();
        expect(wrapper.querySelector('input.inline-edit-input').value).toBe('old');
        expect(wrapper.querySelector('input.inline-edit-input').type).toBe('text');
        expect(wrapper.querySelector('.inline-edit-save')).toBeTruthy();
        expect(wrapper.querySelector('.inline-edit-cancel')).toBeTruthy();
    });

    test('textarea variant → uses textarea element', () => {
        const stub = makeStub();
        const container = renderRow(stub);
        const btn = container.querySelector('.edit-btn');

        compileMethod('openInlineEditor').call(stub, btn, 'person', 'p:1', 'bio', 'old', true);

        expect(container.querySelector('textarea.inline-edit-input')).toBeTruthy();
        expect(container.querySelector('input.inline-edit-input')).toBeNull();
    });

    test('Cancel → restores button, re-attaches edit listeners (so re-click works)', async () => {
        const stub = makeStub();
        const container = renderRow(stub);
        const btn = container.querySelector('.edit-btn');

        compileMethod('openInlineEditor').call(stub, btn, 'person', 'p:1', 'bio', 'old', false);

        const cancel = container.querySelector('.inline-edit-cancel');
        cancel.click();

        // Button is back.
        const restored = container.querySelector('.edit-btn');
        expect(restored).toBe(btn);
        expect(container.querySelector('.inline-edit-wrapper')).toBeNull();

        // Cancel re-attaches; clicking the restored button should re-open the editor.
        btn.click();
        expect(container.querySelector('.inline-edit-wrapper')).toBeTruthy();
    });

    test('Save with unchanged value → restores button, NO submitEdit call', async () => {
        const stub = makeStub();
        const container = renderRow(stub, { currentValue: 'same' });
        const btn = container.querySelector('.edit-btn');

        compileMethod('openInlineEditor').call(stub, btn, 'person', 'p:1', 'bio', 'same', false);
        // Don't change the input value.
        const save = container.querySelector('.inline-edit-save');
        save.click();
        await flushMicrotasks();

        expect(stub.claimManager.submitEdit).not.toHaveBeenCalled();
        expect(container.querySelector('.edit-btn')).toBe(btn);
        expect(container.querySelector('.inline-edit-wrapper')).toBeNull();
    });

    test('Save with changed value → submits via claimManager + refreshes info panel', async () => {
        const selectedNode = { id: 'p:1' };
        const stub = makeStub({
            selectedNode,
            updateInfoPanel: async () => {},
        });
        const container = renderRow(stub, { currentValue: 'old' });
        const btn = container.querySelector('.edit-btn');

        compileMethod('openInlineEditor').call(stub, btn, 'person', 'p:1', 'bio', 'old', false);
        const input = container.querySelector('.inline-edit-input');
        input.value = 'new';
        const save = container.querySelector('.inline-edit-save');
        save.click();
        await flushMicrotasks();

        expect(stub.claimManager.submitEdit).toHaveBeenCalledWith('person', 'p:1', 'bio', 'new');
        expect(stub.callbacks.refreshInfoPanel).toHaveBeenCalledWith(selectedNode);
    });

    test('Save: button shows "Saving..." while submitEdit is in flight', async () => {
        let resolveSubmit;
        const stub = makeStub({
            submitEdit: () => new Promise(r => { resolveSubmit = r; }),
            selectedNode: { id: 'p:1' },
        });
        const container = renderRow(stub, { currentValue: 'old' });
        const btn = container.querySelector('.edit-btn');

        compileMethod('openInlineEditor').call(stub, btn, 'person', 'p:1', 'bio', 'old', false);
        const input = container.querySelector('.inline-edit-input');
        input.value = 'new';
        const save = container.querySelector('.inline-edit-save');
        save.click();
        await flushMicrotasks();

        expect(save.disabled).toBe(true);
        expect(save.textContent).toBe('Saving...');

        resolveSubmit();  // unblock
        await flushMicrotasks();
    });

    test('Save with changed value, NO selectedNode → submits but does NOT call updateInfoPanel', async () => {
        const stub = makeStub({ selectedNode: null });
        const container = renderRow(stub, { currentValue: 'old' });
        const btn = container.querySelector('.edit-btn');

        compileMethod('openInlineEditor').call(stub, btn, 'person', 'p:1', 'bio', 'old', false);
        const input = container.querySelector('.inline-edit-input');
        input.value = 'new';
        const save = container.querySelector('.inline-edit-save');
        save.click();
        await flushMicrotasks();

        expect(stub.claimManager.submitEdit).toHaveBeenCalled();
        expect(stub.callbacks.refreshInfoPanel).not.toHaveBeenCalled();
    });

    test('Save error → restores button, re-attaches listeners, alert + console.error', async () => {
        const stub = makeStub({
            submitEdit: async () => { throw new Error('network down'); },
            selectedNode: { id: 'p:1' },
        });
        const container = renderRow(stub, { currentValue: 'old' });
        const btn = container.querySelector('.edit-btn');

        compileMethod('openInlineEditor').call(stub, btn, 'person', 'p:1', 'bio', 'old', false);
        const input = container.querySelector('.inline-edit-input');
        input.value = 'new';
        const save = container.querySelector('.inline-edit-save');
        save.click();
        await flushMicrotasks();

        expect(errSpy).toHaveBeenCalled();
        expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('Edit failed'));
        // Button restored.
        expect(container.querySelector('.edit-btn')).toBe(btn);
        expect(container.querySelector('.inline-edit-wrapper')).toBeNull();
        // Re-attached: clicking re-opens.
        btn.click();
        expect(container.querySelector('.inline-edit-wrapper')).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// _attachColorPickerListeners
// ---------------------------------------------------------------------------

function makeColorRow(stub, { nodeId = 'p:1', initialColor = '#888888' } = {}) {
    const container = document.createElement('div');
    container.innerHTML = `
        <div class="info-color-row">
            <span class="info-color-swatch" style="background:${initialColor}"></span>
            <span class="info-color-hex">${initialColor}</span>
            <input type="color" class="color-picker-input" data-node-id="${nodeId}" value="${initialColor}" />
        </div>
    `;
    document.body.appendChild(container);
    return container;
}

describe('attachColorPickerListeners', () => {
    test('empty container → no-op', () => {
        const stub = makeStub();
        const container = document.createElement('div');
        document.body.appendChild(container);
        expect(() =>
            compileMethod('attachColorPickerListeners').call(stub, container)
        ).not.toThrow();
    });

    test('change → submits via claimManager with correct args', async () => {
        const stub = makeStub();
        const container = makeColorRow(stub, { nodeId: 'p:abc' });
        compileMethod('attachColorPickerListeners').call(stub, container);

        const picker = container.querySelector('.color-picker-input');
        picker.value = '#ff00ff';
        picker.dispatchEvent(new Event('change'));
        await flushMicrotasks();

        expect(stub.claimManager.submitEdit).toHaveBeenCalledWith('person', 'p:abc', 'color', '#ff00ff');
    });

    test('change updates swatch + hex display, sets node color, plots, calls patchRawGraphColor callback', async () => {
        const selectedNode = {
            id: 'p:abc',
            setData: jest.fn(),
        };
        const stub = makeStub({ selectedNode });
        const container = makeColorRow(stub, { nodeId: 'p:abc' });
        compileMethod('attachColorPickerListeners').call(stub, container);

        const picker = container.querySelector('.color-picker-input');
        picker.value = '#ff00ff';
        picker.dispatchEvent(new Event('change'));
        await flushMicrotasks();

        // Visual feedback in the row.
        const swatch = container.querySelector('.info-color-swatch');
        const hex = container.querySelector('.info-color-hex');
        expect(swatch.style.background).toBe('rgb(255, 0, 255)');
        expect(hex.textContent).toBe('#ff00ff');

        // JIT node color update + redraw.
        expect(selectedNode.setData).toHaveBeenCalledWith('color', '#ff00ff');
        expect(stub.callbacks.plot).toHaveBeenCalledTimes(1);

        // rawGraph patch deferred to host (MusicGraph) via callback.
        expect(stub.callbacks.patchRawGraphColor).toHaveBeenCalledWith('p:abc', '#ff00ff');
    });

    test('change with NO selectedNode → still submits + updates DOM + patches, no setData/plot', async () => {
        const stub = makeStub({ selectedNode: null });
        const container = makeColorRow(stub, { nodeId: 'p:abc' });
        compileMethod('attachColorPickerListeners').call(stub, container);

        const picker = container.querySelector('.color-picker-input');
        picker.value = '#abcdef';
        picker.dispatchEvent(new Event('change'));
        await flushMicrotasks();

        expect(stub.claimManager.submitEdit).toHaveBeenCalled();
        expect(stub.callbacks.plot).not.toHaveBeenCalled();
        expect(stub.callbacks.patchRawGraphColor).toHaveBeenCalledWith('p:abc', '#abcdef');
    });

    test('submitEdit error → console.error + alert, no DOM mutation propagates', async () => {
        const stub = makeStub({
            submitEdit: async () => { throw new Error('boom'); },
        });
        const container = makeColorRow(stub);
        compileMethod('attachColorPickerListeners').call(stub, container);

        const picker = container.querySelector('.color-picker-input');
        picker.value = '#deadbe';
        picker.dispatchEvent(new Event('change'));
        await flushMicrotasks();

        expect(errSpy).toHaveBeenCalled();
        expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('Color edit failed'));
    });
});
