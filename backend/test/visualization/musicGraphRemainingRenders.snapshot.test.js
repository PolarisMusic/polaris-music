/**
 * @jest-environment jsdom
 *
 * Stage K — Characterization snapshots for the three info-panel render
 * methods originally on MusicGraph and now extracted into InfoPanelRenderer.
 *
 * Locks the DOM output of `renderGroupDetails`, `renderPersonDetails`,
 * and `renderReleaseDetails`. Tests were written against the unextracted
 * methods on MusicGraph (PR-K1) and updated in PR-K2 to point at
 * InfoPanelRenderer.js. The methods were also DOM-builder migrated as
 * part of K2 (consistent with PR-L's InfoPanelRenderer rewrite); the
 * snapshots updated for whitespace text-node normalization, all tag/
 * attribute/text content byte-identical.
 *
 * The group/person renderers call:
 *   this.inlineEditor.editableRowHtml(...)        → HTML fragment string
 *                                                   (inserted via insertAdjacentHTML)
 *   this.inlineEditor.attach(container)
 *   this.callbacks.attachNavLinkListeners(container)
 *
 * The release renderer doesn't touch inlineEditor or nav-link listeners
 * (no editable fields, no nav links).
 */

import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parse } from '@babel/parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SOURCE_PATH = resolve(__dirname, '../../../frontend/src/visualization/InfoPanelRenderer.js');
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
    if (!node) throw new Error(`extractMethod: ${name} not found in InfoPanelRenderer.js`);
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
// Stub builder. The render methods reach into:
//   this.inlineEditor.editableRowHtml(type, id, field, value, label, isTextarea?)
//                                              → HTML string for an edit button
//   this.inlineEditor.attach(container)        → no-op in tests (spied)
//   this.callbacks.attachNavLinkListeners(container) → no-op in tests (spied)
//   this._el(tag, attrs, ...children)          → DOM-builder helper (compiled
//                                               from live source)
//   this._appendEditableRow(parent, ...args)   → insertAdjacentHTML wrapper
//                                               around editableRowHtml (compiled)
//
// editableRowHtml stub returns a deterministic placeholder so snapshots
// don't churn against InlineEditor's exact HTML format. The placeholder
// records the call args, which is what the integration actually depends
// on (the renderer trusts InlineEditor to produce sane edit buttons).
// ---------------------------------------------------------------------------

function makeStub() {
    const editorCalls = [];
    const stub = {
        inlineEditor: {
            editableRowHtml: jest.fn((type, id, field, value, label, isTextarea = false) => {
                editorCalls.push({ type, id, field, value, label, isTextarea });
                return `[edit:${type}/${id}/${field}]`;
            }),
            attach: jest.fn(),
        },
        callbacks: {
            attachNavLinkListeners: jest.fn(),
        },
        // Visible inspection points for tests that don't snapshot.
        _editorCalls: editorCalls,
    };
    // Intra-cluster bindings — compile from live source so any drift in
    // _el / _appendEditableRow flows through to the snapshot layer.
    stub._el = compileMethod('_el').bind(stub);
    stub._appendEditableRow = compileMethod('_appendEditableRow').bind(stub);
    return stub;
}

function makeContainer() {
    document.body.innerHTML = '';
    const titleElement = document.createElement('h2');
    const contentElement = document.createElement('div');
    document.body.appendChild(titleElement);
    document.body.appendChild(contentElement);
    return { titleElement, contentElement };
}

afterEach(() => { document.body.innerHTML = ''; });

// ---------------------------------------------------------------------------
// Drift guard.
// ---------------------------------------------------------------------------

describe('Stage K · drift guard', () => {
    test.each([
        ['renderGroupDetails',   '(group, titleElement, contentElement, nodeId)'],
        ['renderPersonDetails',  '(person, titleElement, contentElement, nodeId)'],
        ['renderReleaseDetails', '(release, titleElement, contentElement)'],
    ])('method %s exists with signature %s', (name, sig) => {
        const expected = sig.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).join(', ');
        const { params } = extractMethod(name);
        const actual = params.split(',').map(s => s.trim()).filter(Boolean).join(', ');
        expect(actual).toBe(expected);
    });

    test('none of the three are async', () => {
        for (const name of ['renderGroupDetails', 'renderPersonDetails', 'renderReleaseDetails']) {
            expect(extractMethod(name).isAsync).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// renderGroupDetails
// ---------------------------------------------------------------------------

describe('Stage K · renderGroupDetails', () => {
    test('full group with photo, dates, members, bio, trivia → snapshot', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        const group = {
            name: 'The Beatles',
            photo: 'https://example.com/beatles.jpg',
            formed_date: '1960',
            disbanded_date: '1970',
            members: [
                { person: 'John Lennon', person_id: 'p:lennon', role: 'Vocals, Guitar' },
                { person: 'Paul McCartney', person_id: 'p:mccartney', role: 'Vocals, Bass' },
                { person: 'Anonymous & Co.' /* no person_id, has &amp; in name */ },
            ],
            bio: 'English rock band formed in <Liverpool>',
            trivia: 'Best-selling music act of all time',
        };
        compileMethod('renderGroupDetails').call(stub, group, titleElement, contentElement, 'g:beatles');

        expect(titleElement.textContent).toBe('The Beatles');
        expect(contentElement.innerHTML).toMatchSnapshot();

        // Sanity: editor + nav-link wiring fired exactly once each.
        expect(stub.inlineEditor.attach).toHaveBeenCalledWith(contentElement);
        expect(stub.callbacks.attachNavLinkListeners).toHaveBeenCalledWith(contentElement);

        // editableRowHtml was called for: photo, formed_date, disbanded_date, bio, trivia (5 times)
        expect(stub._editorCalls.map(c => c.field)).toEqual([
            'photo', 'formed_date', 'disbanded_date', 'bio', 'trivia'
        ]);
        expect(stub._editorCalls[3].isTextarea).toBe(true); // bio
        expect(stub._editorCalls[4].isTextarea).toBe(true); // trivia
    });

    test('minimal group (only name) → snapshot', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        compileMethod('renderGroupDetails').call(
            stub, { name: 'Solo Project' }, titleElement, contentElement, 'g:solo'
        );

        expect(titleElement.textContent).toBe('Solo Project');
        expect(contentElement.innerHTML).toMatchSnapshot();
    });

    test('falls back to group_name when name absent', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        compileMethod('renderGroupDetails').call(
            stub, { group_name: 'From group_name' }, titleElement, contentElement, 'g:1'
        );
        expect(titleElement.textContent).toBe('From group_name');
    });

    test('falls back to "Unknown Group" when both name fields absent', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        compileMethod('renderGroupDetails').call(stub, {}, titleElement, contentElement, 'g:unk');
        expect(titleElement.textContent).toBe('Unknown Group');
    });

    test('description used as biography fallback when bio absent', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        compileMethod('renderGroupDetails').call(
            stub,
            { name: 'X', description: 'desc-fallback' },
            titleElement, contentElement, 'g:x'
        );
        expect(contentElement.innerHTML).toContain('<h4>Biography</h4><p>desc-fallback</p>');
    });

    test('inferred-active range shown only when formed_date is empty', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        compileMethod('renderGroupDetails').call(
            stub,
            {
                name: 'Inferred Band',
                inferred_first_release_date: '1968',
                inferred_last_release_date: '1972',
            },
            titleElement, contentElement, 'g:inf'
        );
        expect(contentElement.innerHTML).toContain('Active (from releases):');
        expect(contentElement.innerHTML).toContain('1968–1972');
    });

    test('inferred-active hidden when claimed formed_date is present', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        compileMethod('renderGroupDetails').call(
            stub,
            {
                name: 'Claimed Band',
                formed_date: '1965',
                inferred_first_release_date: '1968',
            },
            titleElement, contentElement, 'g:cl'
        );
        expect(contentElement.innerHTML).not.toContain('Active (from releases):');
    });
});

// ---------------------------------------------------------------------------
// renderPersonDetails
// ---------------------------------------------------------------------------

describe('Stage K · renderPersonDetails', () => {
    test('full person with photo, color, city, groups, bio, trivia → snapshot', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        const person = {
            name: 'John Lennon',
            photo: 'https://example.com/lennon.jpg',
            color: '#ff0000',
            city: 'Liverpool',
            groups: [
                { group: 'The Beatles', group_id: 'g:beatles', role: 'Vocals' },
                { group: 'Plastic Ono Band', group_id: 'g:pob' },
                { group: 'Quarrymen' /* no group_id */ },
            ],
            bio: 'Singer, songwriter, peace activist',
            trivia: 'Founded the Beatles in 1960',
        };
        compileMethod('renderPersonDetails').call(stub, person, titleElement, contentElement, 'p:lennon');

        expect(titleElement.textContent).toBe('John Lennon');
        expect(contentElement.innerHTML).toMatchSnapshot();

        expect(stub.inlineEditor.attach).toHaveBeenCalledWith(contentElement);
        expect(stub.callbacks.attachNavLinkListeners).toHaveBeenCalledWith(contentElement);
        expect(stub._editorCalls.map(c => c.field)).toEqual([
            'photo', 'city', 'bio', 'trivia'
        ]);
    });

    test('minimal person (only name) defaults color to #888888 → snapshot', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        compileMethod('renderPersonDetails').call(
            stub, { name: 'Anonymous' }, titleElement, contentElement, 'p:anon'
        );
        expect(contentElement.innerHTML).toMatchSnapshot();
        expect(contentElement.innerHTML).toContain('background:#888888');
    });

    test('falls back to person_name when name absent', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        compileMethod('renderPersonDetails').call(
            stub, { person_name: 'From person_name' }, titleElement, contentElement, 'p:1'
        );
        expect(titleElement.textContent).toBe('From person_name');
    });

    test('color picker input includes data-node-id and current color value', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        compileMethod('renderPersonDetails').call(
            stub, { name: 'X', color: '#aabbcc' }, titleElement, contentElement, 'p:x'
        );
        expect(contentElement.innerHTML).toContain(
            '<input type="color" class="color-picker-input" data-node-id="p:x" value="#aabbcc"'
        );
    });
});

// ---------------------------------------------------------------------------
// renderReleaseDetails
// ---------------------------------------------------------------------------

describe('Stage K · renderReleaseDetails', () => {
    test('full release with art, date, format, labels, groups, tracks, guests, liner notes → snapshot', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        const release = {
            name: 'Abbey Road',
            album_art: 'https://example.com/abbey.jpg',
            release_date: '1969-09-26',
            format: 'LP',
            labels: [{ label: 'Apple Records' }, { name: 'EMI' }],
            groups: [{ name: 'The Beatles' }],
            tracks: [
                { track: 'Come Together', track_number: 1, disc_number: 1, side: 'A' },
                { title: 'Something', track_number: 2, disc_number: 1, side: 'A' },
                { track: 'Octopus\'s Garden', track_number: 1, disc_number: 2, side: 'B' },
                { /* no title */ track_number: 3 },
            ],
            guests: [
                { name: 'Billy Preston', roles: ['Organ', 'Electric Piano'] },
                { name: 'George Martin' /* no roles */ },
            ],
            liner_notes: 'Recorded at EMI Studios',
        };
        compileMethod('renderReleaseDetails').call(stub, release, titleElement, contentElement);

        expect(titleElement.textContent).toBe('Abbey Road');
        expect(contentElement.innerHTML).toMatchSnapshot();

        // Release renderer does NOT touch inlineEditor.attach or nav-link listeners.
        expect(stub.inlineEditor.attach).not.toHaveBeenCalled();
        expect(stub.callbacks.attachNavLinkListeners).not.toHaveBeenCalled();
        expect(stub._editorCalls).toEqual([]);
    });

    test('minimal release (just name) → snapshot', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        compileMethod('renderReleaseDetails').call(
            stub, { name: 'Untitled' }, titleElement, contentElement
        );
        expect(contentElement.innerHTML).toMatchSnapshot();
        expect(contentElement.innerHTML).toBe('');
    });

    test('falls back to "Unknown Release" when name absent', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        compileMethod('renderReleaseDetails').call(stub, {}, titleElement, contentElement);
        expect(titleElement.textContent).toBe('Unknown Release');
    });

    test('tracks sorted by disc_number then track_number (stable across discs)', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        compileMethod('renderReleaseDetails').call(
            stub,
            {
                name: 'Multi-disc',
                tracks: [
                    { track: 'D2T1', track_number: 1, disc_number: 2 },
                    { track: 'D1T2', track_number: 2, disc_number: 1 },
                    { track: 'D1T1', track_number: 1, disc_number: 1 },
                    { track: 'D2T2', track_number: 2, disc_number: 2 },
                ],
            },
            titleElement, contentElement
        );
        const html = contentElement.innerHTML;
        const order = ['D1T1', 'D1T2', 'D2T1', 'D2T2'];
        let lastIdx = -1;
        for (const name of order) {
            const idx = html.indexOf(name);
            expect(idx).toBeGreaterThan(lastIdx);
            lastIdx = idx;
        }
    });

    test('label name fallback: prefers .label, falls back to .name', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        compileMethod('renderReleaseDetails').call(
            stub,
            {
                name: 'X',
                labels: [{ label: 'PrefersLabel' }, { name: 'FallsBackToName' }],
            },
            titleElement, contentElement
        );
        expect(contentElement.innerHTML).toContain('PrefersLabel, FallsBackToName');
    });

    test('track title fallback: track > title > "Untitled"', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        compileMethod('renderReleaseDetails').call(
            stub,
            {
                name: 'X',
                tracks: [
                    { track: 'A1', track_number: 1 },
                    { title: 'A2-from-title', track_number: 2 },
                    { /* no name */ track_number: 3 },
                ],
            },
            titleElement, contentElement
        );
        const html = contentElement.innerHTML;
        expect(html).toContain('A1');
        expect(html).toContain('A2-from-title');
        expect(html).toContain('Untitled');
    });

    test('side prefix prepended to track number when provided', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        compileMethod('renderReleaseDetails').call(
            stub,
            { name: 'X', tracks: [{ track: 'T', track_number: 3, side: 'A' }] },
            titleElement, contentElement
        );
        expect(contentElement.innerHTML).toContain('A-3. T');
    });
});

// ---------------------------------------------------------------------------
// Escaping behavior — observable via the DOM round-trip.
//
// Note: even though the inline `esc()` helper in MusicGraph only encodes
// &, <, " (NOT >), reading back `.innerHTML` re-serializes the parsed DOM
// and the serializer escapes > to &gt; on the way out. So the externally-
// observable behavior is "all four chars escaped", regardless of which
// helper is used to produce the source string. The snapshots above lock
// the round-tripped output — that's the guarantee K.2 must preserve.
// ---------------------------------------------------------------------------

describe('Stage K · escape behavior (round-trip)', () => {
    test('renderGroupDetails: bio with all four special chars round-trips correctly', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        compileMethod('renderGroupDetails').call(
            stub, { name: 'X', bio: 'a < b > c & "d"' }, titleElement, contentElement, 'g:x'
        );
        expect(contentElement.innerHTML).toContain('a &lt; b &gt; c &amp; "d"');
    });

    test('renderPersonDetails: color attr value with quote char survives the round-trip', () => {
        const stub = makeStub();
        const { titleElement, contentElement } = makeContainer();
        compileMethod('renderPersonDetails').call(
            stub, { name: 'X', color: '"#aabbcc"' }, titleElement, contentElement, 'p:x'
        );
        // " is escaped to &quot; in the source HTML so the attribute parses
        // correctly; jsdom round-trips that as itself.
        expect(contentElement.innerHTML).toContain('value="&quot;#aabbcc&quot;"');
    });
});
