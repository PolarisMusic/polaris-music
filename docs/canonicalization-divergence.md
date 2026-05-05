# Canonicalization Divergence Report (Stages A + C)

**Generated:** 2026-05-04
**Updated:** 2026-05-05 — Stage C audit reframed the risk; see "Stage
C update" below before reading the body.

**Scope:** Risk R1 — comparing the frontend's hand-rolled
`HashGenerator.canonicalize` (`frontend/src/utils/hashGenerator.js`)
against the backend's `fast-json-stable-stringify`
(`backend/src/storage/eventStore.js`).

The harness lives at `backend/test/crypto/hashDeterminism.test.js`.
Run with `npm test -- test/crypto/hashDeterminism.test.js` from
`backend/`. All 43 cases currently pass.

---

## Stage C update — R1 does not apply

The Stage A plan assumed that "every event already anchored on-chain
was canonicalized by the frontend implementation before being
SHA256'd." Stage C traced the actual hash flow and that assumption
turned out to be wrong. The corrected picture:

1. The frontend never hashes events on the on-chain path. Submission
   POSTs the unhashed event to `/api/events/prepare`. The **backend**
   computes the canonical hash (`EventStore.calculateHash`, which
   delegates to `fast-json-stable-stringify`) and returns it together
   with the canonical payload. The frontend then signs that payload
   and submits via `/api/events/create`, where `storeEvent`
   recomputes the hash one more time as a verification step.
2. `frontend/src/utils/hashGenerator.js` (the `HashGenerator` class
   with its hand-rolled `canonicalize`) is imported in two files
   (`frontend/src/index.js`, `frontend/src/components/FormBuilder.js`)
   but **never called** anywhere in the frontend, tools, or backend.
3. `frontend/src/utils/transactionBuilder.js` exposes
   `calculateEventHash` / `canonicalizeJSON` / `sortKeysDeep`, but
   nothing in the codebase calls them either. They are intra-class
   helpers that no caller invokes.
4. Backend git history shows `EventStore.calculateHash` has used
   `fast-json-stable-stringify` since the function was introduced
   (commit `d9ddddd`, Feb 2026).

**Therefore:** the divergent cases enumerated below describe a
behavioural difference between two canonicalizers that do not, and
have never, both been on the hash path simultaneously. There are no
historical on-chain anchors hashed via the frontend canonicalizer
that we could orphan by changing the backend.

**Stage C decision (revised):** drop the v1/v2 versioning plan. The
canonicalizer was never split; we don't need to split it. Instead:

- **Lock in** the backend's canonicalization output via a snapshot
  test (`backend/test/crypto/canonicalizationSnapshot.test.js`) so
  any future change to `fast-json-stable-stringify`, the way
  `EventStore.calculateHash` calls it, or the set of fields stripped
  before hashing, fails CI loudly. The pinned hex hashes for six
  representative events ARE the contract.
- **Deprecate** the dead frontend canonicalizers in place
  (`HashGenerator`, `TransactionBuilder.calculateEventHash` /
  `canonicalizeJSON` / `sortKeysDeep`) with a clear header pointing
  back to this document. We do not delete them in the same session
  to keep this change small and reversible — Stage D / a later
  cleanup can do that once consumers have been re-confirmed.

The body of this document (everything below this line) was the
Stage A finding and is preserved for the historical record. The
divergent cases are still real — they would matter if a future
caller ever hashes via `HashGenerator.canonicalize` again. They
just are not the on-chain risk Stage A thought they were.

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

## Stage C decision (superseded)

The original Stage A guidance — "take the versioned path; add a
`canonicalization_version` field; v1 = legacy frontend, v2 =
stable-stringify" — was made on the assumption that the frontend
had been the canonicalizer of record for on-chain anchors. Stage C
disproved that assumption (see the "Stage C update" section at the
top of this document). The versioning plan is therefore unnecessary
and was not implemented.

**What Stage C actually shipped:**

1. `backend/test/crypto/canonicalizationSnapshot.test.js` — a CI
   gate that pins the hex SHA-256 hash produced by
   `EventStore.calculateHash` for six representative event shapes
   (a release bundle, an ADD_CLAIM, a reverse-key-order body, a
   Unicode payload, an event with a `sig` field that must be
   stripped, and a deeply-nested-array event). If any of those
   pinned values change, the test fails — which is what we want,
   because changing them would orphan every on-chain anchor.
2. Deprecation headers on `frontend/src/utils/hashGenerator.js`
   and on the hashing helpers inside
   `frontend/src/utils/transactionBuilder.js`, pointing back to
   this document. Code is not deleted in the same session; a
   later cleanup will do that once consumers (if any are added)
   are re-confirmed.

The divergence enumeration below is still accurate as a description
of the two implementations' edge-case behaviour. It is no longer
load-bearing for hash compatibility, but stays here as the
authoritative reference for any future contributor who is tempted
to call `HashGenerator.canonicalize` from new code.

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
