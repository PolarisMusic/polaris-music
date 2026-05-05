# Stage H — Frontend characterization tests

> **Status: shipped.** This document was originally a deferred-work handoff;
> kept as design notes since the approach is non-obvious and Stage J will
> rely on the same test patterns.

## What shipped

`backend/test/visualization/musicGraphRenders.snapshot.test.js` — 15 tests,
10 snapshots, locks the DOM output of all five `_render*` methods on
`MusicGraph.js` so the upcoming Stage J split (extract InfoPanelRenderer,
FavoritesManager, OverlayPositioner, GraphDataLoader) cannot silently change
rendered HTML.

Methods covered:

| Method                         | Snapshots                                            |
| ------------------------------ | ---------------------------------------------------- |
| `_renderSongDetails`           | full (writers + lyrics + releases) + minimal         |
| `_renderCurateRow`             | open release w/ positive net + finalized vote w/ negative |
| `_renderCurateDetail`          | release_bundle (open) + add_claim (finalized)        |
| `_renderReleaseBundleDetail`   | full (groups + tracks + songs + sources) + minimal   |
| `_renderClaimDetail`           | add_claim (object value) + edit_claim (primitive)    |

Plus a **drift guard** (5 tests) that asserts each method still exists with
its expected signature in `MusicGraph.js`. If a future change renames a
parameter or a method, that test fails before any snapshot diff appears.

## Approach

The class itself is heavy to instantiate (needs `$jit` global, sibling
module imports, real DOM containers). Instead of mocking all of that, the
test does **AST-based source extraction**:

1. `@babel/parser` parses `frontend/src/visualization/MusicGraph.js` once at
   test-suite startup.
2. A walk over the AST builds a `Map<methodName, ClassMethod-node>`.
3. For each method under test, slice the source between the param-list
   open-paren and the body's closing brace — produces `{ params, body }`
   strings.
4. `new Function(...params, body)` compiles a standalone function that takes
   the original parameters and runs the original method body verbatim.
5. Invoke via `Function.prototype.call(stubThis, ...args)` under jsdom (Jest
   `@jest-environment jsdom` pragma).
6. Snapshot the resulting `outerHTML` (for methods that return an element)
   or post-call `innerHTML` (for methods that mutate a container).

Because the test re-reads the live source file every run, **any drift in
method bodies surfaces as a snapshot diff** — the alarm Stage J needs.

### Why source-extract instead of importing the class?

The cleaner alternative would be:

```js
const { MusicGraph } = await import('../../../frontend/src/visualization/MusicGraph.js');
MusicGraph.prototype._renderCurateRow.call(stubThis, op);
```

That requires mocking 6 sibling imports (`graphApi`, `colorPalette`,
`PathTracker`, `LikeManager`, `ClaimManager`, `ReleaseOrbitOverlay`) plus
`../utils/api.js`, providing a `$jit` global, AND solving cross-package ESM
resolution (frontend `package.json` says `"type": "commonjs"`, so Node will
treat the file as CJS and fail on `import` syntax). Source-extract avoids
all of this and produces tests that depend only on the methods being tested.

### Stub `this` surface

Across all five render methods, only these instance methods are referenced:

- `_escapeHtml(str)` — DOM-based HTML escape; replicated verbatim in the stub.
- `_detailField(label, value)` — small wrapper around `_escapeHtml`; replicated.
- `_attachNavLinkListeners(container)` — `jest.fn()`.
- `_navigateToRelease(releaseId)` — `jest.fn()`.
- `_selectCurateOperation(op)` — `jest.fn()`.
- `_curateVoteFromDetail(op, val)` — `jest.fn()`.
- `_renderReleaseBundleDetail` and `_renderClaimDetail` — bound onto the
  stub via the same `compileMethod()` so `_renderCurateDetail` can dispatch
  through `this`.

### Locale stability

`_renderCurateRow` and `_renderCurateDetail` call `Date.prototype.toLocaleDateString`
and `toLocaleString`, which are locale-and-TZ-dependent. The test stubs both
in `beforeAll` with deterministic `LOCALE_DATE(YYYY-MM-DD)` and
`LOCALE_DATETIME(ISO)` strings, restored in `afterAll`. Snapshots are
identical on every machine.

## Dependencies added

`backend/package.json` devDeps:

- `jest-environment-jsdom` — DOM environment for the new test file.
- `@babel/preset-env` — pulled in primarily for `@babel/parser`, which is
  used to do the AST extraction. We are **not** using it as a Jest
  transform; the existing `transform: {}` in `backend/test/jest.config.js`
  is unchanged.

The `@jest-environment jsdom` docblock pragma keeps the new environment
scoped to this single file. All other tests still run under
`testEnvironment: 'node'`.

## Verification

`cd backend && npm test`

- `Stage H · MusicGraph render methods · drift guard` — 5 tests
- `Stage H · _renderSongDetails` — 2 tests
- `Stage H · _renderCurateRow` — 2 tests
- `Stage H · _renderCurateDetail` — 2 tests
- `Stage H · _renderReleaseBundleDetail` — 2 tests
- `Stage H · _renderClaimDetail` — 2 tests

Full backend suite after this commit: **484 passed / 218 skipped / 0 failed,
30 snapshots passed** (was 469 / 218 / 0 / 20).

## Stage J implications

When `MusicGraph.js` is split, the natural seam is to extract these methods
verbatim into `InfoPanelRenderer.js` (or a similar module). The drift guard
in this test will fail when the methods leave `MusicGraph.js` — that's
expected. To migrate:

1. Update `METHOD_INDEX` to walk the new module's AST instead of (or in
   addition to) `MusicGraph.js`.
2. Update the drift-guard `test.each` expectations to match the new
   signatures (likely no `_` prefix once the methods are public exports).
3. Keep the snapshots untouched — if the rendered HTML changed, that's a
   refactor regression, not a test issue.

A small follow-up commit at the end of Stage J should also delete the
`compileMethod` machinery and switch to a regular import-and-call pattern
once the renderer module has no remaining `this`-dependencies.
