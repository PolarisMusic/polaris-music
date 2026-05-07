/**
 * @jest-environment jsdom
 *
 * Stage J.2 — FavoritesManager characterization tests.
 *
 * Stage J.2 extracted the favorites cluster from MusicGraph into
 * `frontend/src/visualization/FavoritesManager.js`. State (`chainFavorites`,
 * `chainFavoritesLoaded`, `favoritesPanelOpen`) and the four panel methods
 * now live on the new class; MusicGraph reaches in via `this.favorites.*`.
 *
 * Methods covered:
 *   updateFavoritesCount()            — writes count to #favorites-count
 *   refreshFavoritesFromChain()       — fetches account likes, populates Set
 *   toggleFavoritesPanel()            — flips state, shows/hides panel,
 *                                       triggers render on open
 *   renderFavoritesPanel()            — renders <li> rows; HTML snapshot
 *
 * Strategy: source-extract + isolated invoke (same as the Stage H
 * InfoPanelRenderer test). We compile each method body via `new Function`
 * and call it with `Function.prototype.call(stubThis, ...)`. The five
 * pre-extraction HTML snapshots are unchanged — extraction must reproduce
 * them byte-for-byte.
 */

import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parse } from '@babel/parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAVORITES_PATH = resolve(__dirname, '../../../frontend/src/visualization/FavoritesManager.js');
const SOURCE = readFileSync(FAVORITES_PATH, 'utf8');

// ---------------------------------------------------------------------------
// AST extraction (same machinery as the Stage H test).
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
    if (!node) throw new Error(`extractMethod: ${name} not found in FavoritesManager.js`);
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
// Per-test DOM scaffolding. The favorites methods read/write three IDs:
// #favorites-count, #favorites-panel, #favorites-list. We build a fresh
// scaffold per test so state never leaks between cases.
// ---------------------------------------------------------------------------

function setupDOM() {
    document.body.innerHTML = `
        <div id="favorites-count">0</div>
        <div id="favorites-panel" style="display: none;"></div>
        <ul id="favorites-list"></ul>
    `;
}

afterEach(() => {
    document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// Stub `this` builder. The methods now reach into:
//   - this.chainFavorites          (Set, instance state)
//   - this.chainFavoritesLoaded    (boolean, instance state)
//   - this.favoritesPanelOpen      (boolean, instance state)
//   - this.walletManager           (constructor dep, .isConnected())
//   - this.likeManager             (constructor dep, .fetchAccountLikes())
//   - this.hashIndex               (constructor dep, shared Map ref)
//   - this.callbacks.escapeHtml(s) (constructor callback)
//   - this.callbacks.navigate(id)  (constructor callback)
//   - this.refreshFavoritesFromChain() / .updateFavoritesCount() /
//     .renderFavoritesPanel()      (intra-class — wired via compileMethod)
// ---------------------------------------------------------------------------

function makeStub({
    chainFavorites = new Set(),
    chainFavoritesLoaded = false,
    favoritesPanelOpen = false,
    walletConnected = true,
    accountLikes = [],
    hashIndex = new Map(),
    fetchAccountLikesImpl,
} = {}) {
    const escapeHtml = (str) => {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    };
    const stub = {
        chainFavorites,
        chainFavoritesLoaded,
        favoritesPanelOpen,
        hashIndex,
        walletManager: {
            isConnected: jest.fn(() => walletConnected),
        },
        likeManager: {
            fetchAccountLikes: fetchAccountLikesImpl
                ? jest.fn(fetchAccountLikesImpl)
                : jest.fn(async () => accountLikes),
        },
        callbacks: {
            escapeHtml,
            navigate: jest.fn(),
        },
    };
    // Intra-class delegations. Each method is its own compiled body so
    // mutual calls go through the same source we're locking.
    stub.updateFavoritesCount      = compileMethod('updateFavoritesCount').bind(stub);
    stub.refreshFavoritesFromChain = compileMethod('refreshFavoritesFromChain').bind(stub);
    stub.renderFavoritesPanel      = compileMethod('renderFavoritesPanel').bind(stub);
    return stub;
}

// ---------------------------------------------------------------------------
// Drift guard — if MusicGraph.js renames or moves these methods, fail loud.
// ---------------------------------------------------------------------------

describe('Stage J.2 · FavoritesManager · drift guard', () => {
    test.each([
        ['updateFavoritesCount',      '()'],
        ['refreshFavoritesFromChain', '()'],
        ['toggleFavoritesPanel',      '()'],
        ['renderFavoritesPanel',      '()'],
    ])('method %s exists with signature %s', (name, sig) => {
        const expected = sig.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).join(', ');
        const { params } = extractMethod(name);
        const actual = params.split(',').map(s => s.trim()).filter(Boolean).join(', ');
        expect(actual).toBe(expected);
    });
});

// ---------------------------------------------------------------------------
// updateFavoritesCount
// ---------------------------------------------------------------------------

describe('Stage J.2 · updateFavoritesCount', () => {
    test('writes Set size to #favorites-count', () => {
        setupDOM();
        const stub = makeStub({ chainFavorites: new Set(['a', 'b', 'c']) });
        compileMethod('updateFavoritesCount').call(stub);
        expect(document.getElementById('favorites-count').textContent).toBe('3');
    });

    test('writes "0" for empty Set', () => {
        setupDOM();
        const stub = makeStub();
        compileMethod('updateFavoritesCount').call(stub);
        expect(document.getElementById('favorites-count').textContent).toBe('0');
    });

    test('is a no-op when #favorites-count element is missing', () => {
        document.body.innerHTML = '';  // no scaffold
        const stub = makeStub({ chainFavorites: new Set(['a']) });
        expect(() => compileMethod('updateFavoritesCount').call(stub)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// refreshFavoritesFromChain
// ---------------------------------------------------------------------------

describe('Stage J.2 · refreshFavoritesFromChain', () => {
    test('replaces chainFavorites Set with node_ids from rows', async () => {
        setupDOM();
        const stub = makeStub({
            chainFavorites: new Set(['stale1', 'stale2']),
            accountLikes: [
                { node_id: 'hash:a' },
                { node_id: 'hash:b' },
                { node_id: 'hash:c' },
            ],
        });

        const rows = await compileMethod('refreshFavoritesFromChain').call(stub);

        expect([...stub.chainFavorites].sort()).toEqual(['hash:a', 'hash:b', 'hash:c']);
        expect(stub.chainFavoritesLoaded).toBe(true);
        expect(rows).toHaveLength(3);
    });

    test('passes 200 as the limit to fetchAccountLikes', async () => {
        setupDOM();
        const stub = makeStub();
        await compileMethod('refreshFavoritesFromChain').call(stub);
        expect(stub.likeManager.fetchAccountLikes).toHaveBeenCalledWith(200);
    });

    test('updates #favorites-count side-effect', async () => {
        setupDOM();
        const stub = makeStub({
            accountLikes: [{ node_id: 'h1' }, { node_id: 'h2' }],
        });
        await compileMethod('refreshFavoritesFromChain').call(stub);
        expect(document.getElementById('favorites-count').textContent).toBe('2');
    });
});

// ---------------------------------------------------------------------------
// toggleFavoritesPanel
// ---------------------------------------------------------------------------

describe('Stage J.2 · toggleFavoritesPanel', () => {
    test('flips closed → open: shows panel and calls renderFavoritesPanel', () => {
        setupDOM();
        const stub = makeStub({ favoritesPanelOpen: false });
        // Spy on renderFavoritesPanel without actually executing it (jsdom-safe).
        stub.renderFavoritesPanel = jest.fn();

        compileMethod('toggleFavoritesPanel').call(stub);

        expect(stub.favoritesPanelOpen).toBe(true);
        expect(document.getElementById('favorites-panel').style.display).toBe('flex');
        expect(stub.renderFavoritesPanel).toHaveBeenCalledTimes(1);
    });

    test('flips open → closed: hides panel and does NOT call render', () => {
        setupDOM();
        const stub = makeStub({ favoritesPanelOpen: true });
        stub.renderFavoritesPanel = jest.fn();

        compileMethod('toggleFavoritesPanel').call(stub);

        expect(stub.favoritesPanelOpen).toBe(false);
        expect(document.getElementById('favorites-panel').style.display).toBe('none');
        expect(stub.renderFavoritesPanel).not.toHaveBeenCalled();
    });

    test('is a no-op when #favorites-panel element is missing', () => {
        document.body.innerHTML = '';
        const stub = makeStub({ favoritesPanelOpen: false });
        stub.renderFavoritesPanel = jest.fn();
        // Note: state still flips before the missing-element early return —
        // characterizing current behavior, not arguing it's correct.
        compileMethod('toggleFavoritesPanel').call(stub);
        expect(stub.favoritesPanelOpen).toBe(true);
        expect(stub.renderFavoritesPanel).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// renderFavoritesPanel — HTML snapshots across all four branches.
// ---------------------------------------------------------------------------

describe('Stage J.2 · renderFavoritesPanel', () => {
    test('wallet not connected → shows "Login to see your favorites."', async () => {
        setupDOM();
        const stub = makeStub({ walletConnected: false });
        await compileMethod('renderFavoritesPanel').call(stub);
        expect(document.getElementById('favorites-list').innerHTML).toMatchSnapshot('not-connected');
    });

    test('connected with zero rows → shows "No favorites yet."', async () => {
        setupDOM();
        const stub = makeStub({ accountLikes: [] });
        await compileMethod('renderFavoritesPanel').call(stub);
        expect(document.getElementById('favorites-list').innerHTML).toMatchSnapshot('zero-rows');
    });

    test('rows resolve through hashIndex → renders type badges and names', async () => {
        setupDOM();
        const hashIndex = new Map([
            ['hash:beatles',    { nodeId: 'group:beatles',  name: 'The Beatles', type: 'Group'  }],
            ['hash:lennon',     { nodeId: 'person:lennon',  name: 'John Lennon', type: 'Person' }],
            ['hash:abbeyroad',  { nodeId: 'release:abbey',  name: 'Abbey Road',  type: 'Release'}],
        ]);
        const stub = makeStub({
            hashIndex,
            accountLikes: [
                { node_id: 'hash:beatles' },
                { node_id: 'hash:lennon' },
                { node_id: 'hash:abbeyroad' },
            ],
        });

        await compileMethod('renderFavoritesPanel').call(stub);
        expect(document.getElementById('favorites-list').innerHTML).toMatchSnapshot('with-hashindex');
    });

    test('rows missing from hashIndex → shows truncated hash + disabled style', async () => {
        setupDOM();
        const stub = makeStub({
            hashIndex: new Map(),  // empty: every row falls to hash-prefix fallback
            accountLikes: [
                { node_id: '0123456789abcdefdeadbeef' },
                { node_id: 'fedcba9876543210cafebabe' },
            ],
        });
        await compileMethod('renderFavoritesPanel').call(stub);
        expect(document.getElementById('favorites-list').innerHTML).toMatchSnapshot('without-hashindex');
    });

    test('clicking a resolved row calls callbacks.navigate(nodeId)', async () => {
        setupDOM();
        const hashIndex = new Map([
            ['hash:beatles', { nodeId: 'group:beatles', name: 'The Beatles', type: 'Group' }],
        ]);
        const stub = makeStub({
            hashIndex,
            accountLikes: [{ node_id: 'hash:beatles' }],
        });
        await compileMethod('renderFavoritesPanel').call(stub);

        const li = document.querySelector('.history-item');
        li.click();
        expect(stub.callbacks.navigate).toHaveBeenCalledWith('group:beatles');
    });

    test('unresolved rows have no click handler attached', async () => {
        setupDOM();
        const stub = makeStub({
            hashIndex: new Map(),
            accountLikes: [{ node_id: '0123456789abcdef' }],
        });
        await compileMethod('renderFavoritesPanel').call(stub);

        const li = document.querySelector('.history-item');
        expect(li.dataset.nodeId).toBe('');
        li.click();
        expect(stub.callbacks.navigate).not.toHaveBeenCalled();
    });

    test('fetch failure → shows "Failed to load favorites."', async () => {
        setupDOM();
        const stub = makeStub({
            fetchAccountLikesImpl: async () => { throw new Error('chain RPC down'); },
        });
        // Quiet the error-log emitted by the catch branch.
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await compileMethod('renderFavoritesPanel').call(stub);
            expect(document.getElementById('favorites-list').innerHTML).toMatchSnapshot('fetch-error');
        } finally {
            errSpy.mockRestore();
        }
    });

    test('is a no-op when #favorites-list element is missing', async () => {
        document.body.innerHTML = '';
        const stub = makeStub();
        await expect(compileMethod('renderFavoritesPanel').call(stub)).resolves.toBeUndefined();
        expect(stub.likeManager.fetchAccountLikes).not.toHaveBeenCalled();
    });
});
