# Stage H — Frontend characterization tests (TODO)

This is a handoff note for the next session. Stage H of the refactor plan asks
for two things:

1. **Backend** snapshot tests for the top 8–10 endpoints in `server.js`.
2. **Frontend** render-snapshot tests for each `_render*` method in
   `MusicGraph.js`.

Item 1 shipped on this branch — see `backend/test/api/serverEndpoints.snapshot.test.js`
(19 tests, 20 snapshots, 469-passing full suite).

Item 2 is **not done yet**. This document captures everything the next session
needs to finish it without re-discovering the constraints.

## Why it isn't done

`MusicGraph.js` is a single ~2,562-line ES-module class that:

- Lives in `frontend/`, where `package.json` declares `"type": "commonjs"`.
- Imports four sibling ES modules at the top: `colorPalette`, `graphApi`,
  `PathTracker`, `LikeManager`, `MiniPlayer`. These transitively pull in the
  rest of the frontend.
- Calls into the global `$jit` provided by `frontend/public/lib/jit.js` (a
  loose UMD-ish library that attaches to `window`).

The backend Jest harness used for item 1 (`node --experimental-vm-modules`
plus `jest.unstable_mockModule()`) does not import that frontend tree out of
the box because:

1. The ESM resolver needs frontend's `package.json` to declare
   `"type": "module"` to load `frontend/src/**/*.js` as ES modules. Adding it
   means re-verifying `vite build` still works (Vite is fine with either, but
   any tooling that assumed CJS — including custom Vite plugins, if any —
   needs a check).
2. There is no DOM available. Jest's `testEnvironment: 'node'` (set in
   `backend/test/jest.config.js`) needs to switch to `'jsdom'` for the
   render tests, OR a per-test-file pragma `@jest-environment jsdom` plus the
   `jest-environment-jsdom` package added as a backend devDep.
3. The five `_render*` methods reference `this._escapeHtml`,
   `this._attachNavLinkListeners`, `this._navigateToRelease`,
   `this._selectCurateOperation`, etc. — testing them requires either
   instantiating `MusicGraph` (heavy: needs `$jit`, DOM containers, real API
   client) or invoking via `MusicGraph.prototype._renderCurateRow.call(stubThis, op)`.

## Methods in scope

From `frontend/src/visualization/MusicGraph.js`:

| Method                       | Line  | Signature                                          | What it does |
| ---------------------------- | ----- | -------------------------------------------------- | ------------ |
| `_renderSongDetails`         | 1977  | `(song, titleElement, contentElement)`             | Sets `titleElement.textContent`, builds `contentElement.innerHTML` for a Song info-panel (writers, lyrics, releases) |
| `_renderCurateRow`           | 2148  | `(op) → HTMLDivElement`                            | Returns a `.curate-row` element rendered from a curate-list operation summary |
| `_renderCurateDetail`        | 2227  | `(container, resp, op)`                            | Replaces `container` content with the curate-detail panel for a fetched operation |
| `_renderReleaseBundleDetail` | 2315  | `(container, detail)`                              | Builds the release-bundle inspection panel (groups, tracks, guests) |
| `_renderClaimDetail`         | 2454  | `(container, detail)`                              | Builds the ADD_CLAIM/EDIT_CLAIM inspection panel |

Each method is mostly DOM building via `innerHTML` + `appendChild`, with a
small set of `this`-method calls.

## Recommended approach for the next session

**Use the prototype-call pattern** so we don't need to instantiate the class:

```js
import { jest } from '@jest/globals';

// Mock sibling imports so MusicGraph.js loads under jsdom without side effects.
jest.unstable_mockModule('../../../frontend/src/visualization/colorPalette.js', () => ({ /* stubs */ }));
jest.unstable_mockModule('../../../frontend/src/visualization/graphApi.js',     () => ({ GraphApi: class {} }));
jest.unstable_mockModule('../../../frontend/src/visualization/PathTracker.js',  () => ({ PathTracker: class {} }));
jest.unstable_mockModule('../../../frontend/src/visualization/LikeManager.js',  () => ({ LikeManager: class {} }));
jest.unstable_mockModule('../../../frontend/src/visualization/MiniPlayer.js',   () => ({ MiniPlayer: class {} }));
// Provide a $jit stub on globalThis since MusicGraph references it at module scope.
globalThis.$jit = { Hypertree: class {}, util: {}, Trans: { Quart: { easeInOut: 'noop' } } };

const { MusicGraph } = await import('../../../frontend/src/visualization/MusicGraph.js');

const stubThis = {
    _escapeHtml: s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])),
    _attachNavLinkListeners: jest.fn(),
    _navigateToRelease: jest.fn(),
    _selectCurateOperation: jest.fn(),
};

test('_renderCurateRow snapshot', () => {
    const op = {
        hash: 'abc123def456',
        type: 21,
        author: 'alice',
        ts: '2026-01-01T00:00:00',
        finalized: false,
        event_summary: { release_name: 'Abbey Road' },
        tally: { up_weight: 5, down_weight: 1, up_voter_count: 3, down_voter_count: 1 }
    };
    const row = MusicGraph.prototype._renderCurateRow.call(stubThis, op);
    expect(row.outerHTML).toMatchSnapshot();
});
```

### Setup checklist for the next session

1. **Decide the frontend package type.** The cleanest path is to add
   `"type": "module"` to `frontend/package.json`, then run `cd frontend && npx
   vite build` once to confirm bundling still works. If that breaks, fall back
   to the **fixture-mirror pattern** Stage A used for `canonicalize`: copy the
   five `_render*` methods byte-for-byte into `backend/test/visualization/__fixtures__/musicGraphRenders.js`,
   add a drift guard that re-reads the live source line ranges and asserts
   equality. That pattern is in
   `backend/test/crypto/__fixtures__/frontendCanonicalize.js` — copy its
   shape.

2. **Add `jest-environment-jsdom`** to `backend/package.json` devDependencies
   (and `npm install` it). Either set `testEnvironment: 'jsdom'` for a new
   project entry in `backend/test/jest.config.js`, or scope it to the new
   test file with the `@jest-environment jsdom` docblock pragma.

3. **Make Jest resolve frontend modules.** Add a `moduleNameMapper` entry
   pointing `^@frontend/(.*)$` → `<rootDir>/../../frontend/src/$1`, OR use
   relative imports as in the example above. The existing
   `moduleNameMapper` is at `backend/test/jest.config.js:48`.

4. **Mock the sibling imports** — see the snippet above. The exact named
   exports each module provides:
   - `colorPalette.js` — exports `getColorForId`, `releaseColor`, etc.
     (look at imports in MusicGraph.js for the full list)
   - `graphApi.js` — exports `GraphApi`
   - `PathTracker.js` — exports `PathTracker`
   - `LikeManager.js` — exports `LikeManager`
   - `MiniPlayer.js` — exports `MiniPlayer`

5. **Provide a `$jit` stub** on `globalThis` before importing MusicGraph,
   because MusicGraph reads it at module-evaluation time inside its
   constructor and a few static configurations. The verification we did in
   Stage E proved `$jit` exposes `Hypertree`, `Trans.Quart.easeInOut`, and
   `util.event.getPos`. Stub each with no-ops.

6. **Build a `stubThis` per render method** containing only the instance
   methods that method actually calls. The five methods together touch:
   - `this._escapeHtml(s)` — all five use it. Simplest: copy the real impl
     (it's a one-liner in MusicGraph.js, search for `_escapeHtml`).
   - `this._attachNavLinkListeners(el)` — `_renderSongDetails`. Stub as
     `jest.fn()`.
   - `this._navigateToRelease(id)` — `_renderSongDetails`. Stub.
   - `this._selectCurateOperation(op)` — `_renderCurateRow` attaches it as
     a click handler. Stub.
   - `this.api.fetchOperationDetail` — `_selectCurateOperation` only;
     `_renderCurateDetail` itself doesn't need it. The detail methods take
     `resp` already.

7. **Snapshot strategy.** Snapshot the resulting `outerHTML` (for methods
   that return an element) or the post-call `container.innerHTML` (for
   methods that mutate a container). Pin five snapshots — one per method.
   Use representative fixtures: a non-trivial Song with writers + releases;
   a finalized curate row; an open curate detail; a release-bundle detail
   with two groups; an ADD_CLAIM detail.

8. **Run on `main` first.** The whole point of characterization is to lock
   current behavior. Capture the snapshots on `main` (or this branch) before
   Stage J extracts InfoPanelRenderer. If a snapshot diff appears during
   the extraction, that's the alarm.

## Time estimate

About one focused session: 30 min for setup (jsdom + module resolution),
60 min for writing the five tests + fixtures, 15 min for snapshot review.

## Existing precedents in this repo

- `backend/test/crypto/hashDeterminism.test.js` — fixture-mirror pattern
  with drift guard against frontend source.
- `backend/test/crypto/__fixtures__/frontendCanonicalize.js` — the
  fixture-mirror with the drift-guard regex.
- This session's `backend/test/api/serverEndpoints.snapshot.test.js` —
  `jest.unstable_mockModule` + dynamic-import pattern for ESM mocking.

These three together cover everything the frontend test will need.
