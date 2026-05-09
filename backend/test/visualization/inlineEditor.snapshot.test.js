/**
 * @jest-environment jsdom
 *
 * Inline editor characterization tests (precursor to InlineEditor extraction).
 *
 * The inline-editor cluster currently lives on MusicGraph and owns:
 *   - `_editableRow(nodeType, nodeId, field, currentValue, label, isTextarea)`
 *                                         → HTML string with a .edit-btn
 *   - `_attachEditListeners(container)`   → click handlers on .edit-btn
 *   - `_openInlineEditor(btn, nodeType, nodeId, field, currentValue,
 *                        useTextarea)`    → replace button with input/textarea
 *                                            + Save / Cancel
 *   - `_attachColorPickerListeners(container)` → change handlers on
 *                                                .color-picker-input
 *
 * The cluster is the densest of the three remaining MusicGraph clusters
 * because it touches ClaimManager (network), the JIT graph (visual
 * feedback), the raw-graph cache (so merges don't revert color edits),
 * and the info panel (refresh after save).
 *
 * These tests lock current behavior so the upcoming extraction into
 * `InlineEditor.js` can be verified as a no-op move. The next PR
 * updates the source path and (likely) renames `_attachEditListeners` →
 * `attachEditListeners` etc.; assertions stay byte-identical.
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
const SOURCE_PATH = resolve(__dirname, '../../../frontend/src/visualization/MusicGraph.js');
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
    if (!node) throw new Error(`extractMethod: ${name} not found in MusicGraph.js`);
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
//   this.selectedNode                       JIT node | null
//   this.updateInfoPanel(node)              async; called after save
//   this.ht.plot()                          redraw after color change
//   this.loader.rawGraph                    {nodes:[{id,color,...}]} | null
// Intra-cluster delegations:
//   this._attachEditListeners(container)    re-attach after replace
//   this._openInlineEditor(...)             called from edit-btn click
// ---------------------------------------------------------------------------

function makeStub({
    submitEdit,
    selectedNode = null,
    updateInfoPanel = jest.fn(async () => {}),
    plot = jest.fn(),
    rawGraph = null,
} = {}) {
    const stub = {
        claimManager: {
            submitEdit: submitEdit
                ? jest.fn(submitEdit)
                : jest.fn(async () => {}),
        },
        selectedNode,
        updateInfoPanel: jest.fn(updateInfoPanel),
        ht: { plot },
        loader: { rawGraph },
    };
    // Intra-cluster bindings — compile from live source.
    stub._attachEditListeners        = compileMethod('_attachEditListeners').bind(stub);
    stub._openInlineEditor           = compileMethod('_openInlineEditor').bind(stub);
    stub._attachColorPickerListeners = compileMethod('_attachColorPickerListeners').bind(stub);
    return stub;
}

// Render a row + button into a container so tests can poke real DOM.
function renderRow(stub, { nodeType = 'person', nodeId = 'p:1', field = 'bio', currentValue = 'old text', label = 'Bio', isTextarea = false } = {}) {
    const container = document.createElement('div');
    container.innerHTML = compileMethod('_editableRow').call(
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

describe('Inline editor · drift guard', () => {
    test.each([
        ['_editableRow',                '(nodeType, nodeId, field, currentValue, label, isTextarea = false)'],
        ['_attachEditListeners',        '(container)'],
        ['_openInlineEditor',           '(btn, nodeType, nodeId, field, currentValue, useTextarea)'],
        ['_attachColorPickerListeners', '(container)'],
    ])('method %s exists with signature %s', (name, sig) => {
        const expected = sig.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).join(', ');
        const { params } = extractMethod(name);
        const actual = params.split(',').map(s => s.trim()).filter(Boolean).join(', ');
        expect(actual).toBe(expected);
    });

    test('only _openInlineEditor is non-async at the outer signature; save/cancel handlers are async internally', () => {
        // None of the four outer methods are declared async — async is in
        // the click handlers they install.
        for (const name of ['_editableRow', '_attachEditListeners', '_openInlineEditor', '_attachColorPickerListeners']) {
            expect(extractMethod(name).isAsync).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// _editableRow — HTML output snapshot
// ---------------------------------------------------------------------------

describe('_editableRow', () => {
    test('input variant (isTextarea=false) → snapshot', () => {
        const stub = makeStub();
        const html = compileMethod('_editableRow').call(
            stub, 'person', 'p:42', 'bio', 'Hello "world" & co. <em>', 'Biography'
        );
        expect(html).toMatchSnapshot();
    });

    test('textarea variant (isTextarea=true) → data-textarea="true"', () => {
        const stub = makeStub();
        const html = compileMethod('_editableRow').call(
            stub, 'group', 'g:1', 'description', 'desc', 'Description', true
        );
        expect(html).toContain('data-textarea="true"');
    });

    test('escapes &, <, " in attributes (note: > is intentionally NOT escaped)', () => {
        const stub = makeStub();
        const html = compileMethod('_editableRow').call(
            stub, 'person', 'p:&<"', 'name', 'value with "quotes" & <tags>', 'L'
        );
        // The esc helper used by _editableRow only encodes &, <, "
        // (matches the implementation; locking current behavior).
        expect(html).toContain('data-node-id="p:&amp;&lt;&quot;"');
        expect(html).toContain('data-current-value="value with &quot;quotes&quot; &amp; &lt;tags>"');
    });

    test('null/undefined currentValue coerced to empty string', () => {
        const stub = makeStub();
        const html = compileMethod('_editableRow').call(
            stub, 'person', 'p:1', 'bio', null, 'Bio'
        );
        expect(html).toContain('data-current-value=""');
    });
});

// ---------------------------------------------------------------------------
// _attachEditListeners
// ---------------------------------------------------------------------------

describe('_attachEditListeners', () => {
    test('empty container → no-op', () => {
        const stub = makeStub();
        const container = document.createElement('div');
        document.body.appendChild(container);
        expect(() =>
            compileMethod('_attachEditListeners').call(stub, container)
        ).not.toThrow();
    });

    test('click on .edit-btn → calls _openInlineEditor with row dataset', () => {
        const stub = makeStub();
        const openSpy = jest.fn();
        stub._openInlineEditor = openSpy;

        const container = renderRow(stub, { nodeType: 'person', nodeId: 'p:1', field: 'bio', currentValue: 'old', label: 'Bio', isTextarea: true });
        compileMethod('_attachEditListeners').call(stub, container);

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
        stub._openInlineEditor = openSpy;

        const container = document.createElement('div');
        container.innerHTML =
            compileMethod('_editableRow').call(stub, 'person', 'p:1', 'bio', 'a', 'Bio') +
            compileMethod('_editableRow').call(stub, 'person', 'p:2', 'bio', 'b', 'Bio');
        document.body.appendChild(container);
        compileMethod('_attachEditListeners').call(stub, container);

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

describe('_openInlineEditor', () => {
    test('input variant → replaces button with wrapper containing input + Save + Cancel', () => {
        const stub = makeStub();
        const container = renderRow(stub, { isTextarea: false });
        const btn = container.querySelector('.edit-btn');

        compileMethod('_openInlineEditor').call(stub, btn, 'person', 'p:1', 'bio', 'old', false);

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

        compileMethod('_openInlineEditor').call(stub, btn, 'person', 'p:1', 'bio', 'old', true);

        expect(container.querySelector('textarea.inline-edit-input')).toBeTruthy();
        expect(container.querySelector('input.inline-edit-input')).toBeNull();
    });

    test('Cancel → restores button, re-attaches edit listeners (so re-click works)', async () => {
        const stub = makeStub();
        const container = renderRow(stub);
        const btn = container.querySelector('.edit-btn');

        compileMethod('_openInlineEditor').call(stub, btn, 'person', 'p:1', 'bio', 'old', false);

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

        compileMethod('_openInlineEditor').call(stub, btn, 'person', 'p:1', 'bio', 'same', false);
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

        compileMethod('_openInlineEditor').call(stub, btn, 'person', 'p:1', 'bio', 'old', false);
        const input = container.querySelector('.inline-edit-input');
        input.value = 'new';
        const save = container.querySelector('.inline-edit-save');
        save.click();
        await flushMicrotasks();

        expect(stub.claimManager.submitEdit).toHaveBeenCalledWith('person', 'p:1', 'bio', 'new');
        expect(stub.updateInfoPanel).toHaveBeenCalledWith(selectedNode);
    });

    test('Save: button shows "Saving..." while submitEdit is in flight', async () => {
        let resolveSubmit;
        const stub = makeStub({
            submitEdit: () => new Promise(r => { resolveSubmit = r; }),
            selectedNode: { id: 'p:1' },
        });
        const container = renderRow(stub, { currentValue: 'old' });
        const btn = container.querySelector('.edit-btn');

        compileMethod('_openInlineEditor').call(stub, btn, 'person', 'p:1', 'bio', 'old', false);
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

        compileMethod('_openInlineEditor').call(stub, btn, 'person', 'p:1', 'bio', 'old', false);
        const input = container.querySelector('.inline-edit-input');
        input.value = 'new';
        const save = container.querySelector('.inline-edit-save');
        save.click();
        await flushMicrotasks();

        expect(stub.claimManager.submitEdit).toHaveBeenCalled();
        expect(stub.updateInfoPanel).not.toHaveBeenCalled();
    });

    test('Save error → restores button, re-attaches listeners, alert + console.error', async () => {
        const stub = makeStub({
            submitEdit: async () => { throw new Error('network down'); },
            selectedNode: { id: 'p:1' },
        });
        const container = renderRow(stub, { currentValue: 'old' });
        const btn = container.querySelector('.edit-btn');

        compileMethod('_openInlineEditor').call(stub, btn, 'person', 'p:1', 'bio', 'old', false);
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

describe('_attachColorPickerListeners', () => {
    test('empty container → no-op', () => {
        const stub = makeStub();
        const container = document.createElement('div');
        document.body.appendChild(container);
        expect(() =>
            compileMethod('_attachColorPickerListeners').call(stub, container)
        ).not.toThrow();
    });

    test('change → submits via claimManager with correct args', async () => {
        const stub = makeStub();
        const container = makeColorRow(stub, { nodeId: 'p:abc' });
        compileMethod('_attachColorPickerListeners').call(stub, container);

        const picker = container.querySelector('.color-picker-input');
        picker.value = '#ff00ff';
        picker.dispatchEvent(new Event('change'));
        await flushMicrotasks();

        expect(stub.claimManager.submitEdit).toHaveBeenCalledWith('person', 'p:abc', 'color', '#ff00ff');
    });

    test('change updates swatch + hex display, sets node color, plots, patches rawGraph', async () => {
        const selectedNode = {
            id: 'p:abc',
            setData: jest.fn(),
        };
        const rawGraph = {
            nodes: [{ id: 'p:abc', color: '#888888' }, { id: 'p:other', color: '#000' }],
        };
        const stub = makeStub({ selectedNode, rawGraph });
        const container = makeColorRow(stub, { nodeId: 'p:abc' });
        compileMethod('_attachColorPickerListeners').call(stub, container);

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
        expect(stub.ht.plot).toHaveBeenCalledTimes(1);

        // rawGraph patched in place — only the matching node mutates.
        expect(rawGraph.nodes[0].color).toBe('#ff00ff');
        expect(rawGraph.nodes[1].color).toBe('#000');
    });

    test('change with NO selectedNode → still submits + updates DOM, no setData/plot', async () => {
        const rawGraph = { nodes: [{ id: 'p:abc', color: '#888' }] };
        const stub = makeStub({ selectedNode: null, rawGraph });
        const container = makeColorRow(stub, { nodeId: 'p:abc' });
        compileMethod('_attachColorPickerListeners').call(stub, container);

        const picker = container.querySelector('.color-picker-input');
        picker.value = '#abcdef';
        picker.dispatchEvent(new Event('change'));
        await flushMicrotasks();

        expect(stub.claimManager.submitEdit).toHaveBeenCalled();
        expect(stub.ht.plot).not.toHaveBeenCalled();
        expect(rawGraph.nodes[0].color).toBe('#abcdef');
    });

    test('change with rawGraph=null → does not throw, no patch', async () => {
        const stub = makeStub({ rawGraph: null });
        const container = makeColorRow(stub);
        compileMethod('_attachColorPickerListeners').call(stub, container);

        const picker = container.querySelector('.color-picker-input');
        picker.value = '#aaaaaa';
        picker.dispatchEvent(new Event('change'));
        await flushMicrotasks();

        expect(stub.claimManager.submitEdit).toHaveBeenCalled();
    });

    test('change with rawGraph that lacks the node → does not throw, no patch', async () => {
        const rawGraph = { nodes: [{ id: 'p:other', color: '#000' }] };
        const stub = makeStub({ rawGraph });
        const container = makeColorRow(stub, { nodeId: 'p:abc' });
        compileMethod('_attachColorPickerListeners').call(stub, container);

        const picker = container.querySelector('.color-picker-input');
        picker.value = '#aaaaaa';
        picker.dispatchEvent(new Event('change'));
        await flushMicrotasks();

        expect(stub.claimManager.submitEdit).toHaveBeenCalled();
        expect(rawGraph.nodes[0].color).toBe('#000'); // unchanged
    });

    test('submitEdit error → console.error + alert, no DOM mutation propagates', async () => {
        const stub = makeStub({
            submitEdit: async () => { throw new Error('boom'); },
        });
        const container = makeColorRow(stub);
        compileMethod('_attachColorPickerListeners').call(stub, container);

        const picker = container.querySelector('.color-picker-input');
        picker.value = '#deadbe';
        picker.dispatchEvent(new Event('change'));
        await flushMicrotasks();

        expect(errSpy).toHaveBeenCalled();
        expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('Color edit failed'));
    });
});
