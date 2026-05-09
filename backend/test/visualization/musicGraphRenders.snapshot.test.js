/**
 * @jest-environment jsdom
 *
 * Stage H — Frontend render-method characterization snapshots.
 *
 * Locks the DOM output of the five render methods that started life as
 * `_render*` on MusicGraph (the ~2,562-line god class). Stage J extracted
 * them into `frontend/src/visualization/InfoPanelRenderer.js`, where they
 * are now public methods on the InfoPanelRenderer class — these snapshots
 * are the regression net for that split.
 *
 * Strategy: source-extract + isolated invoke. The renderer class is light
 * (no `$jit`, no live DOM container) but the source-extract approach is
 * preserved so we re-read the live module on every run; any drift in a
 * method body surfaces as a snapshot diff.
 *
 *   1. Read frontend/src/visualization/InfoPanelRenderer.js as text.
 *   2. Locate each method node via @babel/parser and slice its source.
 *   3. Compile the slice as a standalone function via `new Function(...)`.
 *   4. Invoke with `Function.prototype.call(stubThis, ...)` under jsdom.
 *   5. Snapshot the resulting outerHTML / innerHTML.
 *
 * Snapshot file is intentionally unchanged from Stage H — the HTML the
 * renderer emits must be byte-identical after the move.
 */

import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parse } from '@babel/parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RENDERER_PATH = resolve(__dirname, '../../../frontend/src/visualization/InfoPanelRenderer.js');
const SOURCE = readFileSync(RENDERER_PATH, 'utf8');

// ---------------------------------------------------------------------------
// AST-based method extraction. Parses MusicGraph.js once, then locates each
// requested method by name and slices the source between the param-list and
// the closing brace.
// ---------------------------------------------------------------------------

const AST = parse(SOURCE, {
    sourceType: 'module',
    plugins: ['classProperties']
});

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

function extractMethod(methodName) {
    const node = METHOD_INDEX.get(methodName);
    if (!node) {
        throw new Error(`extractMethod: ${methodName} not found in InfoPanelRenderer.js`);
    }
    const params = node.params.map(p => SOURCE.slice(p.start, p.end)).join(', ');
    // Body is everything between the outer braces (exclusive).
    const body = SOURCE.slice(node.body.start + 1, node.body.end - 1);
    return { params, body };
}

function compileMethod(methodName) {
    const { params, body } = extractMethod(methodName);
    // eslint-disable-next-line no-new-func
    return new Function(...params.split(',').map(s => s.trim()).filter(Boolean), body);
}

// ---------------------------------------------------------------------------
// Stub `this` — only the instance methods actually referenced by the renders.
// ---------------------------------------------------------------------------

function makeStubThis() {
    const escapeImpl = function (str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    };
    const stub = {
        // Helpers — now public methods on InfoPanelRenderer.
        escapeHtml: escapeImpl,
        // Nav/vote handlers were `this._foo` on MusicGraph; in the renderer
        // they live behind a `callbacks` indirection so the module has no
        // implicit coupling to MusicGraph beyond this object.
        callbacks: {
            attachNavLinkListeners: jest.fn(),
            navigateToRelease: jest.fn(),
            selectCurateOperation: jest.fn(),
            voteFromDetail: jest.fn(),
        },
    };
    // PR-L: methods now build DOM via the `_el` helper and call
    // `this.detailField(...)` which returns an Element (was a string).
    // Compile both from the live source so changes to either flow into
    // the assertion layer.
    stub._el = compileMethod('_el').bind(stub);
    stub.detailField = compileMethod('detailField').bind(stub);
    // The two delegating methods need real impls so renderCurateDetail can
    // invoke them through `this`.
    stub.renderReleaseBundleDetail = compileMethod('renderReleaseBundleDetail').bind(stub);
    stub.renderClaimDetail = compileMethod('renderClaimDetail').bind(stub);
    return stub;
}

// ---------------------------------------------------------------------------
// Locale/timezone stability — Date formatting is locale-dependent and would
// produce machine-specific snapshots. Pin to deterministic strings.
// ---------------------------------------------------------------------------

const realToLocaleDateString = Date.prototype.toLocaleDateString;
const realToLocaleString = Date.prototype.toLocaleString;

beforeAll(() => {
    Date.prototype.toLocaleDateString = function () {
        return `LOCALE_DATE(${this.toISOString().slice(0, 10)})`;
    };
    Date.prototype.toLocaleString = function () {
        return `LOCALE_DATETIME(${this.toISOString()})`;
    };
});

afterAll(() => {
    Date.prototype.toLocaleDateString = realToLocaleDateString;
    Date.prototype.toLocaleString = realToLocaleString;
});

// ---------------------------------------------------------------------------
// Drift guard — make sure the methods we extract still exist where we expect.
// If MusicGraph.js renames or removes any of these, the test should scream.
// ---------------------------------------------------------------------------

describe('Stage H · InfoPanelRenderer methods · drift guard', () => {
    test.each([
        ['renderSongDetails',         '(song, titleElement, contentElement)'],
        ['renderCurateRow',           '(op)'],
        ['renderCurateDetail',        '(container, resp, op)'],
        ['renderReleaseBundleDetail', '(container, detail)'],
        ['renderClaimDetail',         '(container, detail)'],
    ])('method %s exists with signature %s', (name, sig) => {
        const expected = sig.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).join(', ');
        const { params } = extractMethod(name);
        const actual = params.split(',').map(s => s.trim()).filter(Boolean).join(', ');
        expect(actual).toBe(expected);
    });
});

// ---------------------------------------------------------------------------
// _renderSongDetails
// ---------------------------------------------------------------------------

describe('Stage H · _renderSongDetails', () => {
    test('full song with writers, lyrics, and releases', () => {
        const fn = compileMethod('renderSongDetails');
        const stub = makeStubThis();

        const titleEl = document.createElement('h2');
        const contentEl = document.createElement('div');
        const song = {
            title: 'Come Together',
            writers: [
                { person_id: 'person:lennon', writer: 'John Lennon' },
                { person_id: null, writer: 'Anonymous & Co.' }
            ],
            lyrics: 'Here come old flat-top\nHe come groovin\' up slowly',
            releases: [
                { release_id: 'release:abbey-road', release: 'Abbey Road', release_date: '1969-09-26' },
                { release_id: 'release:1', release: '1 (compilation)', release_date: '2000-11-13' }
            ]
        };

        fn.call(stub, song, titleEl, contentEl);

        expect(titleEl.textContent).toBe('Come Together');
        expect(contentEl.innerHTML).toMatchSnapshot('full');
        expect(stub.callbacks.attachNavLinkListeners).toHaveBeenCalledTimes(1);
        expect(stub.callbacks.attachNavLinkListeners).toHaveBeenCalledWith(contentEl);
    });

    test('minimal song (no writers, no lyrics, no releases)', () => {
        const fn = compileMethod('renderSongDetails');
        const stub = makeStubThis();

        const titleEl = document.createElement('h2');
        const contentEl = document.createElement('div');
        fn.call(stub, { title: 'Untitled' }, titleEl, contentEl);

        expect(titleEl.textContent).toBe('Untitled');
        expect(contentEl.innerHTML).toMatchSnapshot('minimal');
    });
});

// ---------------------------------------------------------------------------
// _renderCurateRow
// ---------------------------------------------------------------------------

describe('Stage H · _renderCurateRow', () => {
    test('open release row with positive net score', () => {
        const fn = compileMethod('renderCurateRow');
        const stub = makeStubThis();
        const op = {
            hash: 'abcdef0123456789',
            type: 21,
            author: 'alice',
            ts: '2026-05-05T00:00:00',
            finalized: false,
            event_summary: { release_name: 'Abbey Road' },
            tally: { up_weight: 7, down_weight: 2, up_voter_count: 3, down_voter_count: 1 }
        };
        const row = fn.call(stub, op);
        expect(row.outerHTML).toMatchSnapshot('open-release-positive');
    });

    test('finalized vote row with no event_summary (uses hash prefix)', () => {
        const fn = compileMethod('renderCurateRow');
        const stub = makeStubThis();
        const op = {
            hash: 'fedcba9876543210',
            type: 40,
            author: 'bob',
            ts: null,
            finalized: true,
            event_summary: null,
            tally: { up_weight: 1, down_weight: 4, up_voter_count: 1, down_voter_count: 2 }
        };
        const row = fn.call(stub, op);
        expect(row.outerHTML).toMatchSnapshot('finalized-vote-negative');
    });
});

// ---------------------------------------------------------------------------
// _renderCurateDetail
// ---------------------------------------------------------------------------

describe('Stage H · _renderCurateDetail', () => {
    test('release_bundle detail (open) with raw event JSON', () => {
        const fn = compileMethod('renderCurateDetail');
        const stub = makeStubThis();
        const container = document.createElement('div');
        const resp = {
            operation: { type_name: 'CREATE_RELEASE_BUNDLE', author: 'alice', ts: '2026-05-05T00:00:00', finalized: false },
            tally: { up_weight: 2, down_weight: 0, up_voter_count: 1, down_voter_count: 0 },
            viewer_vote: null,
            event: { v: 1, type: 'CREATE_RELEASE_BUNDLE' },
            detail: {
                type: 'release_bundle',
                release: { name: 'Abbey Road', release_date: '1969-09-26', format: ['LP'] },
                groups: [],
                tracks: [],
                songs: [],
                sources: []
            }
        };
        fn.call(stub, container, resp, op_for_detail());
        expect(container.innerHTML).toMatchSnapshot('release-bundle-open');
    });

    test('add_claim detail (finalized) suppresses vote buttons', () => {
        const fn = compileMethod('renderCurateDetail');
        const stub = makeStubThis();
        const container = document.createElement('div');
        const resp = {
            operation: { type_name: 'ADD_CLAIM', author: 'eve', ts: '2026-05-05T00:00:00', finalized: true },
            tally: { up_weight: 5, down_weight: 1, up_voter_count: 3, down_voter_count: 1 },
            viewer_vote: { val: 1 },
            event: null,
            detail: { type: 'add_claim', target_type: 'Person', target_id: 'person:lennon', field: 'bio', value: 'Songwriter and rhythm guitarist' }
        };
        fn.call(stub, container, resp, op_for_detail());
        expect(container.innerHTML).toMatchSnapshot('add-claim-finalized');
    });
});

function op_for_detail() {
    return { hash: 'opHash', type: 21, author: 'alice' };
}

// ---------------------------------------------------------------------------
// _renderReleaseBundleDetail
// ---------------------------------------------------------------------------

describe('Stage H · _renderReleaseBundleDetail', () => {
    test('full release bundle with two groups, tracks, songs, and sources', () => {
        const fn = compileMethod('renderReleaseBundleDetail');
        const stub = makeStubThis();
        const container = document.createElement('div');
        const detail = {
            release: {
                name: 'Abbey Road',
                release_date: '1969-09-26',
                format: 'LP',
                alt_names: ['Abbey Rd.'],
                master_id: 'master:abbey',
                labels: [{ name: 'Apple Records', label_id: 'label:apple' }],
                guests: [{ name: 'Billy Preston', roles: ['organ'] }]
            },
            groups: [
                {
                    name: 'The Beatles',
                    group_id: 'group:beatles',
                    members: [
                        { name: 'John Lennon', roles: ['rhythm guitar', 'vocals'] },
                        { name: 'Paul McCartney', roles: ['bass', 'vocals'] }
                    ]
                },
                { name: 'Sessioneers', group_id: null, members: [] }
            ],
            tracks: [
                {
                    title: 'Come Together',
                    track_id: 'track:abbey-1',
                    performed_by_groups: [{ name: 'The Beatles', members: [{ name: 'John Lennon' }, { name: 'Paul McCartney' }] }],
                    guests: [{ name: 'Billy Preston', roles: ['organ'] }],
                    producers: [{ name: 'George Martin' }],
                    cover_of_song_id: null,
                    samples: [],
                    listen_links: ['https://example.com/come-together']
                },
                {
                    title: 'Something',
                    track_id: 'track:abbey-2',
                    performed_by_groups: [],
                    guests: [],
                    producers: [],
                    samples: [{ sampled_track_id: 'track:earlier' }],
                    listen_links: []
                }
            ],
            tracklist: [{ position: 1 }, { position: 2 }],
            songs: [
                { title: 'Come Together', writers: [{ name: 'John Lennon' }, { name: 'Paul McCartney' }] },
                { title: 'Something', writers: [{ name: 'George Harrison' }] }
            ],
            sources: [{ url: 'https://discogs.com/release/12345' }]
        };
        fn.call(stub, container, detail);
        expect(container.innerHTML).toMatchSnapshot('release-bundle-full');
    });

    test('minimal release (no labels, no groups, no tracks, no sources)', () => {
        const fn = compileMethod('renderReleaseBundleDetail');
        const stub = makeStubThis();
        const container = document.createElement('div');
        fn.call(stub, container, { release: { name: 'Solo EP' } });
        expect(container.innerHTML).toMatchSnapshot('release-bundle-minimal');
    });
});

// ---------------------------------------------------------------------------
// _renderClaimDetail
// ---------------------------------------------------------------------------

describe('Stage H · _renderClaimDetail', () => {
    test('add_claim with object value and url source', () => {
        const fn = compileMethod('renderClaimDetail');
        const stub = makeStubThis();
        const container = document.createElement('div');
        fn.call(stub, container, {
            type: 'add_claim',
            target_type: 'Person',
            target_id: 'person:lennon',
            field: 'aka',
            value: { official: 'John Lennon', stage: 'JL' },
            source: { url: 'https://en.wikipedia.org/wiki/John_Lennon' }
        });
        expect(container.innerHTML).toMatchSnapshot('add-claim-object-value');
    });

    test('edit_claim with primitive value and string source', () => {
        const fn = compileMethod('renderClaimDetail');
        const stub = makeStubThis();
        const container = document.createElement('div');
        fn.call(stub, container, {
            type: 'edit_claim',
            target_type: 'Track',
            target_id: 'track:abbey',
            field: 'duration',
            value: 259,
            source: 'liner notes'
        });
        expect(container.innerHTML).toMatchSnapshot('edit-claim-primitive');
    });
});
