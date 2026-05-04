# Canonicalization Divergence Report (Stage A)

**Generated:** 2026-05-04
**Scope:** Risk R1 — comparing the frontend's hand-rolled
`HashGenerator.canonicalize` (`frontend/src/utils/hashGenerator.js`)
against the backend's `fast-json-stable-stringify`
(`backend/src/storage/eventStore.js`).

**Why this matters:** every event already anchored on-chain was
canonicalized by the frontend implementation before being SHA256'd.
If the backend ever swaps its canonicalizer to one that produces
different bytes for any historical event shape, hash verification
for those events will fail forever. Blockchain anchors are immutable,
so this MUST be a verification-first effort.

The harness lives at `backend/test/crypto/hashDeterminism.test.js`.
Run with `npm test -- test/crypto/hashDeterminism.test.js` from
`backend/`. All 43 cases currently pass.

---

## Stage A result: NOT bit-identical

The two implementations agree on every fixture we expect to see in
real event payloads (objects, arrays, primitives, Unicode strings,
nested structures), but they diverge on three categories of input.
Stage C must therefore take the **versioned** path, not the
swap-and-replace path.

---

## Cases that agree (safe inputs)

The two implementations produce byte-identical output for:

- empty objects and arrays
- objects with arbitrary key order (both sort)
- nested objects of arbitrary depth
- arrays of mixed-type primitives
- all JSON scalar types: `null`, booleans, numbers (including `-0`,
  large safe integers, floats)
- strings containing emoji, RTL text, CJK characters, embedded
  quotes, backslashes, and Unicode escapes
- object keys containing Unicode and special characters
- non-finite numbers (`NaN`, `Infinity`) — both render as `null`
- a representative release-bundle event payload

The full list is in the `agreeing fixtures` block of the test.

---

## Divergent cases

### 1. `undefined` as an object value — DIVERGES

```js
input = { a: 1, b: undefined };
frontend  -> '{"a":1,"b":undefined}'   // literal, not valid JSON
stable    -> '{"a":1}'                 // key elided
```

The frontend's `canonicalize` does `JSON.stringify(key) + ':' + this.canonicalize(value)`.
For `value === undefined`, `JSON.stringify(undefined)` returns the JS
value `undefined` (not a string). String concatenation then coerces
that to the literal text `"undefined"`. The resulting string is not
valid JSON.

`fast-json-stable-stringify` skips keys whose values stringify to
empty (matching `JSON.stringify` object semantics).

**Impact:** if any historical event payload ever contained an
explicit `undefined` value, its on-chain hash was computed over the
non-JSON `"undefined"` literal and cannot be reproduced by
`fast-json-stable-stringify`.

### 2. `undefined` as an array element — DIVERGES

```js
input = [1, undefined, 3];
frontend  -> '[1,,3]'      // .map(...).join(',') coerces undefined to empty
stable    -> '[1,null,3]'  // matches JSON.stringify array semantics
```

The frontend's array branch uses `arr.map(canonicalize).join(',')`.
`canonicalize(undefined)` returns the JS value `undefined`, and
`Array.prototype.join` coerces `undefined` (and `null`) to the empty
string. The resulting `[1,,3]` is again not valid JSON.

`fast-json-stable-stringify` substitutes `null` for any element
whose recursive stringify returns falsy, matching `JSON.stringify`.

**Impact:** same as above — any event with an explicit array hole
was anchored against a non-JSON canonical form.

### 3. `toJSON`-bearing objects — DIVERGES

```js
input = new Date('2026-05-04T00:00:00.000Z');
frontend  -> '{}'                              // iterates own keys (none)
stable    -> '"2026-05-04T00:00:00.000Z"'     // honours toJSON()
```

`fast-json-stable-stringify` calls `node.toJSON()` if present,
matching `JSON.stringify`. The frontend canonicalize does not — it
treats any `typeof === 'object'` non-array as a plain object and
iterates `Object.keys`, which yields `[]` for `Date` and most
class instances.

**Impact:** any event payload that ever held a raw `Date` (or any
custom object exposing `toJSON`) hashed differently in the frontend
than it would in the backend. In practice the codebase already
serialises timestamps to ISO strings before hashing (see the
release-bundle fixture and `index.js` submission flow), so this is
a latent risk rather than an active one.

---

## Cases that happen to agree by accident

- **`undefined` as the top-level input.** Both implementations
  return the JS value `undefined` (no string output). They are
  loosely equal but neither produces a hashable string; any caller
  that hashes the top level must guarantee the input is not
  `undefined`.
- **`NaN` / `Infinity`.** The frontend goes through `JSON.stringify`
  which returns the literal `"null"`. `fast-json-stable-stringify`
  has its own non-finite branch that also returns `"null"`. These
  agree, but the agreement is incidental and is not part of any
  documented contract on either side.
- **`BigInt`.** Both implementations throw, because both ultimately
  call `JSON.stringify` on a `BigInt`.

The harness pins each of these so a future change that converges or
diverges them surfaces immediately.

---

## Stage C decision

**Take the versioned path.**

- Add `canonicalization_version` to the event envelope.
- For `version: 1` (every existing on-chain event), the backend
  must use the legacy frontend canonicalizer logic — including the
  three quirks above — to verify hashes.
- For `version: 2`, the frontend signs with
  `fast-json-stable-stringify`-equivalent output, and the backend
  uses `fast-json-stable-stringify` directly. New events SHOULD
  refuse `undefined` values and raw `toJSON` objects in the payload
  before hashing.
- The `hashDeterminism.test.js` harness should be promoted to a CI
  gate before any Stage C code change lands, with the v1/v2
  fixtures asserted explicitly.

Do **not** swap the frontend to `fast-json-stable-stringify`
unconditionally. Do **not** retire v1 in the same change as v2 is
introduced.

---

## Error-message consumer audit (Stage A grep deliverable)

For Stage B Risk R5 ("error-message sanitisation may break API
clients"), the following call sites read or display
`error.message` / `error.error`. **None of them parses the string
content — every one either logs it or concatenates it into toast or
alert text.** Stage B's 5xx sanitisation therefore changes only the
text users see, not any control flow.

Backend response consumers (read JSON body, prefer `error.error` then
`error.message`):

- `frontend/src/utils/api.js:46` — `prepareEvent`
- `frontend/src/utils/api.js:69` — `storeEvent`
- `frontend/src/utils/api.js:101` — `storeEventForAnchor`
- `frontend/src/utils/api.js:128` — `confirmAnchor`
- `frontend/src/utils/api.js:144` — `getEvent`
- `frontend/src/utils/api.js:273` — `ingestAnchoredEvent`
- `frontend/src/utils/api.js:294` — `getLikes`
- `frontend/src/utils/api.js:315` — `getVoteTally`

Pure log/display surfaces (read `error.message` from a thrown
`Error`):

- `frontend/src/utils/api.js:195` — `console.warn` only
- `frontend/src/utils/searchClient.js:30` — `console.error` only
- `frontend/src/index.js:722, 927, 1091, 1092` — `showToast` text
- `frontend/src/visualization/MusicGraph.js:1118, 1405, 1707` —
  `alert` / `console.warn` text
- `frontend/src/visualization/MusicGraph.enhanced.js:239` — `alert`
  text (this file is slated for deletion in Stage D)
- `frontend/src/visualization/LikeManager.js:58, 85, 231` —
  diagnostic logging only
- `frontend/src/wallet/WalletManager.js:119` — re-thrown error text
- `tools/import/discogsImporter.js:125, 159` — `console.error` only

**No `JSON.parse(error.message)`, `error.message.includes(...)`,
`error.message.match(...)`, or similar parsing was found anywhere
in `tools/`, `frontend/src/`, or the import scripts.** Stage B is
safe to proceed on its planned scope.

---

## Files

- Test harness: `backend/test/crypto/hashDeterminism.test.js`
- Mirrored canonicalize (with drift guard against the live frontend
  source): `backend/test/crypto/__fixtures__/frontendCanonicalize.js`
- Backend canonicalizer entry point:
  `backend/src/storage/eventStore.js:1474` (`calculateHash`)
- Frontend canonicalizer entry point:
  `frontend/src/utils/hashGenerator.js:24` (`HashGenerator.canonicalize`)
