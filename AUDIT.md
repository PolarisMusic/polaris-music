# Polaris Music Registry — Comprehensive Code Audit

**Date**: 2026-05-03
**Scope**: Full monorepo (backend, frontend, smart contract, substreams, infra, CI/CD, tests)
**Reviewer**: AI Code Audit
**Branch audited**: `claude/code-audit-improvements-kubib` (HEAD `59a5727`)

---

## Executive Summary

This audit covers the entire repository end-to-end and complements the two existing review documents:

- `CODE_REVIEW.md` — contract-only review from 2026-01-01. **Now partially stale**: at least two findings it lists as "residual" (hardcoded `council.pol` attestor; `unlike()` brittleness) have been fixed in `polaris.music.cpp` since it was written. Verified at `polaris.music.cpp:286-317` and `polaris.music.cpp:1660-1680`.
- `DOCUMENTATION_ANALYSIS.md` — docs-vs-code mismatches from 2026-01-01. The emission-multiplier README drift (item #2) is still open.

### Headline counts

| Severity   | Backend | Frontend | Contract | Substreams | Infra | Total |
|------------|---------|----------|----------|------------|-------|-------|
| Critical   | 4       | 3        | 0        | 0          | 4     | 11    |
| High       | 6       | 5        | 1        | 1          | 4     | 17    |
| Medium     | 5       | 5        | 3        | 1          | 5     | 19    |
| Low        | 3       | 4        | 1        | 0          | 4     | 12    |
| **Total**  | **18**  | **17**   | **5**    | **2**      | **17**| **59**|

### Top-5 risks (rank-ordered)

1. **`backend/src/api/server.js` is a 2960-line god module.** Every architectural decision compounds here: GraphQL resolvers open Neo4j sessions inline, REST routes mix in identity/crypto, no layering. Refactor blocks most other work.
2. **`backend/src/graph/schema.js:1646-1654` rollback-failure swallowing.** A failed `tx.rollback()` re-throws nothing; the original commit error wins and the rollback failure is silent. Can leave the driver session in an inconsistent state.
3. **`backend/src/api/ingestion.js:175-187` rejected-promise re-throw pattern** double-handles errors and risks silent event loss in the batch ingestion path.
4. **K8s base manifests ship with placeholder secrets in git** (`k8s/base/secret.yaml`) and use `image: ...:latest` (`api-deployment.yaml:38`). Production overlay overrides — but base-as-default invites accidents.
5. **Frontend hash determinism is hand-rolled** (`frontend/src/utils/hashGenerator.js:24-43`) and may diverge from the backend's `fast-json-stable-stringify` canonicalization. If they ever disagree, every event submission silently fails verification.

### Methodology

Findings produced by three parallel exploration agents (backend / frontend / infra+contracts), then **spot-checked** against the actual files. Two agent claims were disproven on review and excluded:

- Claim that hash verification happened *after* storage in `eventStore.js` — actually verified order is `validate → verifyEventSignatureOrThrow → calculateHash → expected-match check → storage` (`eventStore.js:329-359`). Excluded.
- Claim that the contract still hardcodes `"council.pol"` — actually replaced by configurable `g.council_account` set via `setoracle()` (`polaris.music.cpp:397-404`, check at `1666`). Excluded.

Every finding below cites the exact file:line and includes a recommended fix. Severity reflects current state, not historical.

---

## 1. Backend findings

### CRITICAL

#### B1. `server.js` is a 2960-line god module
**Files**: `backend/src/api/server.js` (entire file)
**Severity**: Critical (architecture / maintainability)

A single class boots Express, mounts middleware, defines GraphQL schema in JS, implements every resolver inline, registers all REST routes, performs identity lookups, runs crypto, and wires the chain ingestion router. Resolvers (`server.js:402-727`) open and close Neo4j sessions inline; testing any resolver requires booting the full server. There is no controller/service/repository boundary.

**Fix**: split into:
```
backend/src/api/
├── index.js                # boot + DI
├── middleware/             # cors, helmet, rate-limit, error handler
├── routes/                 # rest routes per domain
│   ├── events.js
│   ├── identity.js
│   ├── ingestion.js
│   └── crypto.js
├── resolvers/              # one file per GraphQL type
│   ├── person.js
│   ├── group.js
│   ├── release.js
│   └── search.js
├── schema/                 # types.graphql (loaded as SDL)
└── lib/withSession.js      # session helper (see B6)
```
Move Neo4j Cypher into a `repositories/` layer; resolvers call repositories.

#### B2. Rollback-failure is silently swallowed in `processReleaseBundle`
**File**: `backend/src/graph/schema.js:1646-1654`
**Severity**: Critical (data integrity)

```js
} catch (error) {
    await tx.rollback();          // if this throws → original error lost,
    timer.endError(...)           //   driver still holds an open tx
    throw error;
} finally {
    await session.close();        // unguarded; if it throws, exception masks any prior
}
```

**Fix**:
```js
} catch (error) {
    try { await tx.rollback(); }
    catch (rollbackErr) {
        this.log.error('rollback_failed', { original_error: error.message, rollback_error: rollbackErr.message });
        // rollback failure is fatal — escalate
        const wrapped = new Error(`Rollback failed after error: ${error.message}`);
        wrapped.cause = rollbackErr;
        throw wrapped;
    }
    throw error;
} finally {
    try { await session.close(); }
    catch (closeErr) { this.log.error('session_close_failed', { error: closeErr.message }); }
}
```
Apply this pattern wherever `tx.rollback()` is called; it occurs ~5 places across `schema.js`, `merge.js`, and `eventProcessor.js`.

#### B3. Promise.allSettled map double-handles rejection
**File**: `backend/src/api/ingestion.js:175-187`
**Severity**: Critical (reliability)

```js
const results = await Promise.allSettled(
    batch.map(({ event, resolve, reject }) =>
        this._processAnchoredEventDirect(event)
            .then(result => { resolve(result); return result; })
            .catch(error => { reject(error); throw error; })  // ← rethrow after settle
    )
);
```

`reject()` settles the deferred (caller is notified), then `throw error` is caught by `Promise.allSettled` purely so the `results[i].status` is `'rejected'` — but neither side reads that result; `successful`/`failed` counts (line 192-193) are never reconciled with the per-event deferreds. If any handler in the `then(resolve)` block throws (e.g., `resolve` is the wrong type), the throw also flows into the `.catch`, double-rejecting the deferred.

**Fix**:
```js
const results = await Promise.allSettled(
    batch.map(({ event, resolve, reject }) =>
        this._processAnchoredEventDirect(event).then(resolve, reject)
    )
);
// Then derive counts from results without altering control flow
const successful = results.filter(r => r.status === 'fulfilled').length;
```

#### B4. `flushBatch()` polls without timeout
**File**: `backend/src/api/ingestion.js:242-254`
**Severity**: Critical (shutdown reliability)

```js
async flushBatch() {
    if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null; }
    await this.processBatch();
    while (this.batchProcessing) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}
```
If `processBatch` sets `batchProcessing=true` and then throws before clearing it, this loop spins forever. SIGTERM handlers calling `flushBatch` will hang indefinitely.

**Fix**: bounded wait with explicit error escalation:
```js
async flushBatch({ timeoutMs = 30_000 } = {}) {
    if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null; }
    try { await this.processBatch(); }
    catch (e) { this.log.error('flushBatch_processBatch_failed', { error: e.message }); }
    const start = Date.now();
    while (this.batchProcessing && Date.now() - start < timeoutMs) {
        await new Promise(r => setTimeout(r, 100));
    }
    if (this.batchProcessing) {
        this.log.error('flushBatch_timeout', { pending_items: this.batchQueue.length });
        throw new Error(`flushBatch timeout after ${timeoutMs}ms with ${this.batchQueue.length} pending`);
    }
}
```

### HIGH

#### B5. N+1 inside `processReleaseBundle` performer propagation
**File**: `backend/src/graph/schema.js:1240-1290`
**Severity**: High (performance / lock contention)

Per release the loop is `tracks × groups × members` Cypher round-trips inside a single transaction. A 15-track release with 3 groups × 4 members = 180 queries, each holding a write lock on the same node range.

**Fix**: collect all `(personId, trackId, groupId)` tuples first, then a single `UNWIND $statements AS stmt` query.

#### B6. Neo4j session pool exhaustion
**Files**: `backend/src/api/server.js` resolvers (`402-727` and elsewhere)
**Severity**: High (resource management)

Every resolver and many REST handlers do `const session = this.db.driver.session(); try { ... } finally { await session.close(); }`. Default driver pool is 100; under load with slow queries the pool fills.

**Fix**: extract a `withSession(driver, fn, { timeoutMs = 30_000 })` helper that uses `Promise.race` with a timeout, ensures `session.close()` runs even on timeout, and increments a metric on pool wait. Replace inline session usage everywhere.

#### B7. Error responses leak internal messages
**File**: `backend/src/api/server.js:1122` and most error handlers
**Severity**: High (security)

```js
res.status(500).json({ success: false, error: error.message });
```
Internal error strings (Neo4j stack traces, `eventStore.js:130` decryption failure messages, AWS SDK responses) flow to clients.

**Fix**: introduce `sanitizeErrorForClient(error)` that returns a generic error class plus an opaque `errorId` (correlation key in logs). Whitelist a small set of user-actionable error codes (`HASH_MISMATCH`, `SIGNATURE_INVALID`, `RATE_LIMITED`, `NOT_FOUND`, `VALIDATION_FAILED`).

#### B8. CORS allowlist accepts wildcards
**File**: `backend/src/api/server.js:304-318`
**Severity**: High (security)

`CORS_ORIGIN` is split on commas; no validation that an entry is a valid URL or rejection of `*`. Misconfiguring the env to `*` opens the API to any origin.

**Fix**:
```js
const origins = corsOriginEnv.split(',').map(s => s.trim()).filter(Boolean)
    .filter(o => {
        if (o === '*') { console.error('Wildcard CORS rejected'); return false; }
        try { new URL(o); return true; } catch { return false; }
    });
if (origins.length === 0) throw new Error('No valid CORS origins configured');
```

#### B9. GraphQL has no pagination
**File**: `backend/src/api/server.js:216-243` (schema definition)
**Severity**: High (scalability / API design)

Queries return unbounded arrays. A search across a popular common name, or a group with many tracks, will OOM the resolver and the client.

**Fix**: introduce Relay-style cursor pagination on every list-returning field. Add `first`/`after` arguments and `*Connection`/`*Edge`/`PageInfo` types. Enforce `first <= 100`.

#### B10. Domain invariants from CLAUDE.md not enforced
**File**: `backend/src/graph/schema.js` `processReleaseBundle`
**Severity**: High (correctness)

CLAUDE.md lists invariants that are unchecked at the persistence layer:
- "Track must `RECORDING_OF` exactly one Song"
- "Release must have at least one Track via `IN_RELEASE`"
- "A Person can't be both `MEMBER_OF` and `GUEST_ON` for same track"

**Fix**: add a `validateInvariants(normalizedBundle)` step before `tx.commit()` that asserts each invariant; reject the bundle with a structured error. After commit, also add a Cypher-level periodic invariant check in `migrationRunner.js` to detect any drift introduced by the merge node action.

### MEDIUM

#### B11. Cypher backtick interpolation is whitelist-protected but fragile
**File**: `backend/src/graph/schema.js:1716` (`processAddClaim` and similar)
**Severity**: Medium (security defense-in-depth)

`MATCH (n:${mapping.label} {${mapping.idField}: $nodeId}) SET n.\`${normalizedField}\` = $value` is currently safe because `mapping.label` is whitelisted via `SAFE_NODE_TYPES` and `normalizedField` matches `SAFE_PROPERTY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/`. **One regex weakening would re-introduce injection** across many call sites.

**Fix**: introduce a `cypher.builder.js` module that exposes `matchNode(label, idField, params)`, `setProperty(label, field)`, etc. Every interpolation point is centralized and testable. Add a regression test that asserts a corpus of malicious labels/fields is rejected.

#### B12. Redis cache of unsigned events
**File**: `backend/src/storage/eventStore.js:670-684` (`retrieveEvent`)
**Severity**: Medium (data integrity)

Logic is "cache only if `event.sig` exists". But if an unsigned canonical version reaches Redis from another path, subsequent retrievals serve unsigned data even when `requireSig=true` falls through to S3.

**Fix**: when `requireSig=true` and IPFS returns an unsigned event, do not cache it; emit a `retrieve_ipfs_nosig_fallback` warning; require S3 retrieval to override the cache key. Add a TTL on all cache writes so stale entries expire.

#### B13. Signature parsing has no error context
**File**: `backend/src/crypto/verifyEventSignature.js:79-82`
**Severity**: Medium (robustness)

`PublicKey.fromString` and `Signature.fromString` can throw with cryptic messages. Wrap them and surface a structured error.

#### B14. In-memory dedup cache lifecycle undocumented
**File**: `backend/src/api/ingestion.js:55,104-105`
**Severity**: Medium (correctness on long-running processes)

`processedHashes` is an unbounded `Set` cleared at `MAX_PROCESSED_HASHES = 10000`. A clear-and-rebuild can let dupes through during the rebuild window.

**Fix**: replace with an LRU (`Map`-based with eviction order) bounded to `N`, or move dedup to Redis with a TTL keyed on event hash.

#### B15. `express-graphql` is end-of-life
**File**: `backend/package.json:42` (`"express-graphql": "0.12.0"`)
**Severity**: Medium (security / maintenance)

`express-graphql` has been unmaintained since 2020. Ships no security patches. Bundles `graphql@15` (current is 16+).

**Fix**: migrate to `@apollo/server` v4+ with `@as-integrations/express`. Gains: Persisted queries, query depth/complexity limits, dataloader integration, modern security middleware.

### LOW

#### B16. Inconsistent logging
Mixed `console.log(...)` and `this.log.info(...)` across the backend. Standardize on `utils/logger.js`.

#### B17. Stale dependencies
- `@aws-sdk/client-s3@3.971.0` (current 3.6xx+)
- `neo4j-driver@5.28.2` (current 5.30+)
- `eosjs@22.1.0` (legacy; `@wharfkit/antelope` is the modern replacement and is already a dep)

**Fix**: drop `eosjs`, run `npm audit`, plan minor upgrades.

#### B18. Test coverage gaps
- No test for B2 (rollback-failure path)
- No test for B3 (batch dedup race)
- No test for B11 (Cypher injection regression of `PROTECTED_FIELDS`)
- No test for B12 (cache poisoning with unsigned event)
- No test wiring `backend/test/performance/` into CI (it exists; `backend-ci.yml` doesn't run it)

---

## 2. Frontend findings

### CRITICAL

#### F1. `MusicGraph.js` is 2562 lines
**File**: `frontend/src/visualization/MusicGraph.js`
**Severity**: Critical (architecture)

Single class handles JIT init, data loading, donut math, info-panel rendering (200+ LOC per entity type), favorites, history, overlay positioning, wallet integration, search and navigation. ~21 distinct `innerHTML` mutations (`MusicGraph.js:563-1952`). Untestable as a unit.

**Fix**: decompose:
```
visualization/
├── MusicGraph.js          # orchestrator, <500 LOC
├── render/
│   ├── HypertreeRenderer.js
│   ├── InfoPanelRenderer.js
│   └── OverlayPositioner.js
├── data/
│   ├── GraphDataLoader.js
│   └── HashIndex.js
├── state/
│   ├── FavoritesStore.js
│   └── HistoryStore.js
└── interaction/
    ├── NavigationController.js
    └── DonutInteractionController.js
```

#### F2. `MusicGraph.enhanced.js` is dead code
**File**: `frontend/src/visualization/MusicGraph.enhanced.js` (293 lines, 100% commented)
**Severity**: Critical (maintainer confusion)

Verified: every line of executable code is inside `/* … */` blocks. The file is "integration instructions" that have already been integrated into `MusicGraph.js`.

**Fix**: delete the file. Add a one-line note in `MusicGraph.js` constructor that PathTracker and LikeManager are wired in, if helpful.

#### F3. Hand-rolled JSON canonicalization risks hash drift
**File**: `frontend/src/utils/hashGenerator.js:24-43`
**Severity**: Critical (correctness — silent data-loss)

Frontend builds canonical JSON by concatenating `'{' + pairs.join(',') + '}'`. Backend uses `fast-json-stable-stringify` (`backend/package.json:39`). Edge cases that diverge:
- escaping rules (`\u00xx` vs raw)
- handling of `null` / `undefined` properties
- numeric serialization (`1.0` vs `1`, `Infinity`, `-0`)
- Unicode normalization

If the two stringifiers ever disagree on any field, the frontend computes a hash that the backend rejects with `Hash mismatch` (`eventStore.js:354`). Users see "submission failed" with no actionable cause.

**Fix**: ship `fast-json-stable-stringify` to the frontend (it's tiny — ~1KB) and use it on both sides. Or move canonicalization to a `shared/canonicalize.js` ESM module imported by both, then add a cross-runtime test fixture (e.g., 50 canonical-JSON pairs hashed in both Node and browser environments) that fails CI on divergence.

### HIGH

#### F4. WalletManager listeners leak
**File**: `frontend/src/wallet/WalletManager.js:408-433`
**Severity**: High (memory + duplicate side effects)

`on(event, callback)` pushes into `this.listeners[event]`; no `off(event, callback)`. Callers that re-init the graph (page route changes, hot reload in dev) accumulate listeners. After 5 reloads, every chain event fires its handler 6×.

**Fix**: implement `off(event, callback)` and `removeAllListeners(event)`. Update `frontend/visualization.html:305-321` and any other call site to call `off` on teardown.

#### F5. Like submission races wallet disconnect
**Files**: `frontend/src/visualization/LikeManager.js:33-60`, `frontend/visualization.html:311-316`
**Severity**: High (UX bug + on-chain/UI desync)

`submitToBlockchain()` is in flight; `walletManager.disconnect()` clears `chainFavorites` and sets `chainFavoritesLoaded=false`. The transaction lands on-chain but the UI never reflects it.

**Fix**: track in-flight submissions in `LikeManager`. On disconnect, do not clear state for in-flight ops; instead show a "transaction pending" indicator. On next reconnect, reconcile with chain.

#### F6. `innerHTML` injection surface
**Files**: `frontend/src/visualization/MusicGraph.js` — at least 21 sites including 1024, 1080, 1308, 1625, 1773
**Severity**: High (XSS via compromised upstream data)

Most sites use `esc()` (`MusicGraph.js:1035`), but inconsistently — and the helper is HTML-only, not attribute-context-aware. Any new code path that forgets to escape becomes XSS.

**Fix**: replace `innerHTML +=` with a small render helper:
```js
function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k.startsWith('data-') || k === 'id' || k === 'class') node.setAttribute(k, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node[k] = v;
    }
    for (const c of children) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
    return node;
}
```
Or adopt `lit-html` for templating with auto-escaping.

#### F7. CSP allows `'unsafe-eval'`
**File**: `frontend/visualization.html:6`
**Severity**: High (security — defense-in-depth)

`script-src 'self' 'unsafe-eval'`. JIT (the visualization library) does not actually require eval in normal operation. Removing this dramatically narrows post-XSS impact.

**Fix**: remove `'unsafe-eval'`; smoke-test the visualization. If JIT is the only blocker, isolate it in a Worker with a stricter CSP, or pre-compile any JIT eval-paths.

#### F8. No test coverage at all
**Severity**: High (regression risk)

Zero test files under `frontend/`. Refactoring `MusicGraph.js` (F1) is dangerous without a regression net.

**Fix**: add Vitest + jsdom; first targets are wallet flow, hash determinism (F3), and info-panel rendering snapshots.

### MEDIUM

#### F9. CSRF tokens missing
**File**: `frontend/src/utils/api.js`
**Severity**: Medium (auth model dependent)

POST/PUT calls send no CSRF token. If the API ever uses cookie auth, CSRF is open. Currently auth seems to be signature-based, but the absence is noted.

**Fix**: if cookie auth is added, require a `X-CSRF-Token` header backed by a server-issued token tied to the session.

#### F10. Discogs client ignores `Retry-After`
**File**: `frontend/src/utils/discogsClient.js:37-60`
**Severity**: Medium (UX)

A single 429 response throws; the import form hangs.

**Fix**: parse `Retry-After`, respect with bounded auto-retry (max 3 attempts, exponential backoff, total cap 30s).

#### F11. `localStorage` writes unguarded
**Files**: `frontend/src/visualization/PathTracker.js`, parts of `MusicGraph.js`
**Severity**: Medium (compat)

Quota-exceeded throws. Private mode in some browsers throws on every write.

**Fix**: wrap every `localStorage.setItem/removeItem` in `try { … } catch (e) { this.memOnly = true; … }` and degrade to in-memory state.

#### F12. Chain profile silently defaults to `jungle4`
**File**: `frontend/src/config/chain.js:25-42`
**Severity**: Medium (operational risk)

If `VITE_CHAIN_PROFILE` is unset or misspelled, fall-through silently selects `jungle4`. A misconfigured prod build could broadcast to testnet.

**Fix**: throw on unknown profile in production (`import.meta.env.PROD`). In dev, log a loud warning. Validate the chosen profile object is fully populated.

#### F13. No accessibility
**Files**: `frontend/visualization.html`, all interaction code
**Severity**: Medium

Canvas nodes have no keyboard equivalent. Color picker has no label. Donut slices have no SR alt text. Modals do not trap focus.

**Fix**: add ARIA labels, keyboard handlers (Enter/Space), a parallel list-mode for screen readers, and focus traps in modals.

### LOW

#### F14. ~148 `console.log` calls
Strip via Vite plugin in production builds; introduce a level-gated logger.

#### F15. JIT loaded as a global script
**File**: `frontend/visualization.html:11`
ESM-ify or dynamic-import; drop the `$jit` global.

#### F16. Discogs User-Agent format
**File**: `frontend/src/utils/discogsClient.js:11`
Use Discogs-recommended format `PolarisMusic/1.0 (+https://…)`.

#### F17. Vite build config sanity
Add explicit `build.minify`, source-map exclusion in prod, bundle-size budget.

---

## 3. Smart contract findings (`contracts/polaris.music.cpp`)

**Note on `CODE_REVIEW.md` staleness**: the prior review claimed `unlike()` was brittle (still using `require_find`) and that `"council.pol"` was hardcoded. **Both fixed in current code**:

- `unlike()` (`polaris.music.cpp:286-317`) uses `find()` + a comment "If aggregate doesn't exist, that's okay".
- Council attestor is now configurable: `g.council_account` set via `setoracle()` (`polaris.music.cpp:397-404`), checked in `is_authorized_attestor()` (`polaris.music.cpp:1660-1680`).

Genuine residual issues:

### HIGH

#### C1. Emission-multiplier README ↔ contract drift
**Files**: `README.md:886-890`, `polaris.music.cpp:1504-1509`
**Severity**: High (economics / reputational)

Cross-reference: `DOCUMENTATION_ANALYSIS.md` #2 (still open). README documents 100M / 1M / 1K; contract defaults are 1M / 50K / 1K (100× and 20× lower). Either update README to match the deployed economics or ship a new `setmultipliers()` call to align.

**Fix (recommended)**: update README. Add the explicit defaults table in atomic units alongside the formula.

### MEDIUM

#### C2. `checksum_to_hex` only used in two log/memo strings
**File**: `polaris.music.cpp:1981-1993`, used at `781`, `952`
**Severity**: Medium (contract size / WASM cost)

```cpp
"Stake on node " + checksum_to_hex(node_id).substr(0, 16)
"Staker reward from node " + checksum_to_hex(node_id).substr(0, 16)
```
Helper is ~13 LOC and called twice; the truncation discards 48 of 64 hex chars anyway.

**Fix**: inline a 16-char prefix helper, or drop the prefix from the memo entirely (the on-chain tx hash already provides traceability):

```cpp
// drop the call entirely
"Stake on node"
"Staker reward"
```
This shrinks the WASM and removes a path that's been called out as unused in two prior reviews.

#### C3. No tag validation
**Severity**: Medium (UX / search relevance)

`tag` (an `eosio::name`) accepts any base32 name — including `"a"`, `""`, or accidental garbage. No whitelist or length check.

**Fix (option A — minimal)**: enforce in the action handler:
```cpp
check(tag.length() >= 3, "Tag must be at least 3 characters");
check(tag.length() <= 12, "Tag must be at most 12 characters"); // name limit
```
**Fix (option B — governed)**: add a `tagcatalog` table of approved tags, modifiable by contract authority; `check(catalog.find(tag.value) != catalog.end(), "Unapproved tag")`.

#### C4. `reinit()` allows changing `token_contract` post-init
**File**: `polaris.music.cpp:1050-1105`
**Severity**: Medium (governance / fund safety)

Existing safeguards are reasonable (paused, no active stakes, no unfinalized escrows with balance, validates account exists). But this remains the most powerful action in the contract.

**Fix**:
1. Document loudly in the contract README and Ricardian as "recovery-only".
2. Emit an inline notification with old + new values for off-chain monitoring.
3. Consider an N-of-M multisig requirement on top of `require_auth(get_self())`.
4. Optionally require a delay (record intent in a table; only execute after `delay_seconds` elapse) to give the community time to react.

### LOW

#### C5. Integer-overflow protection is correct but uneven in coverage
**File**: `polaris.music.cpp:1904, 1913`
**Severity**: Low (defense-in-depth)

`uint128_t` upcast is used for pro-rata reward math. Good. Other arithmetic (vote-weight accumulation, stake totals) does not explicitly upcast.

**Fix**: audit every multiplication site; add the uint128 pattern + an inline comment where overflow is theoretically reachable, even if currently bounded by other invariants.

---

## 4. Substreams findings

### HIGH

#### S1. `polaris.proto` has no automated parity check
**File**: `substreams/proto/polaris.proto`
**Severity**: High (silent drift)

When a new contract action is added, the proto must be updated by hand. Nothing forces this, and the sink will silently drop unknown actions.

**Fix**: add a `tools/check-proto-parity.{js,sh}` that parses contract action signatures from `polaris.music.cpp` (or its ABI) and compares to proto fields; wire into `contracts-ci.yml`.

### MEDIUM

#### S2. Sink mode mismatch between `substreams.yaml` and `docker-compose.yml`
**File**: `substreams/substreams.yaml:131-136`
**Severity**: Medium (operator confusion)

Default sink writes local files; docker-compose runs `sink/http-sink.mjs`. No comment in either file points to the other.

**Fix**: cross-reference both in comments; or remove the default sink stanza so consumers must specify a `--sink-config` flag.

---

## 5. Infrastructure findings

### CRITICAL

#### I1. Secrets template in git
**File**: `k8s/base/secret.yaml`
**Severity**: Critical (security pattern)

Even with placeholder values, having `kind: Secret` manifests in git invites the wrong workflow.

**Fix**:
- Remove `secret.yaml` from base; provide it only as `secret.example.yaml` in `k8s/examples/`.
- Adopt **Sealed Secrets** or **External Secrets Operator** (ESO) backed by AWS Secrets Manager / Vault.
- Add a pre-commit hook (`detect-secrets` or `gitleaks`) to fail commits containing high-entropy strings.
- Document in `k8s/README.md`.

#### I2. Base manifests pin `:latest`
**Files**: `k8s/base/api-deployment.yaml:38`, `frontend-deployment.yaml:38`, `processor-deployment.yaml:20`
**Severity**: Critical (supply-chain)

Production overlay correctly overrides via Kustomize, but the base default is dangerous if a new overlay is added without remembering the override.

**Fix**: pin base by digest (`@sha256:…`). Add a CI gate in `pr-checks.yml` that fails if any base manifest contains `:latest`.

#### I3. No `securityContext` anywhere
**Files**: every Deployment / StatefulSet under `k8s/base/`
**Severity**: Critical (CIS Benchmark)

Pods can escalate to root.

**Fix**: add to every workload:
```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true        # except where volumes require RW
  capabilities:
    drop: [ALL]
```
For stateful services (Neo4j, IPFS, MinIO, Redis), keep `readOnlyRootFilesystem: false` and rely on `runAsNonRoot`. Also add a Pod Security admission policy at the namespace level.

#### I4. No `NetworkPolicy` resources
**Severity**: Critical (zero-trust posture)

Default-allow pod-to-pod traffic.

**Fix**: add `NetworkPolicy`s:
- `api` ingress only from `ingress-nginx` namespace + processor;
- `api` → `neo4j:7687`, `redis:6379`, `ipfs:5001`, `minio:9000` only;
- `processor` → `neo4j:7687`, `redis:6379` only;
- deny-all by default in the namespace.

### HIGH

#### I5. GitHub Actions referenced by tag
**File**: `.github/workflows/*.yml` (8 workflows)
**Severity**: High (supply-chain)

Every `uses:` is on a tag (`@v4`, `@v3`).

**Fix**: pin to 40-char SHAs. Examples:
- `actions/checkout@a81bbbf8298c0fa03ea29cdc473d45aca9db3e8d` (v4.x at time of writing)
- `actions/setup-node@b39b52d1213e96004bfcb1c61a8a6fa8ab84f3e8` (v4.x)

Automate via Renovate config: `extends: ['config:base', 'helpers:pinGitHubActionDigests']`.

#### I6. Missing RBAC
**Severity**: High

No `ServiceAccount`/`Role`/`RoleBinding`. Workloads use the `default` SA in their namespace.

**Fix**: create one SA per workload, bind a minimal `Role`. Example for the API:
```yaml
apiVersion: v1
kind: ServiceAccount
metadata: { name: api-sa, namespace: polaris }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: api-config-reader, namespace: polaris }
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  resourceNames: ["polaris-config"]
  verbs: ["get", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: api-config-reader, namespace: polaris }
subjects: [{ kind: ServiceAccount, name: api-sa, namespace: polaris }]
roleRef: { kind: Role, name: api-config-reader, apiGroup: rbac.authorization.k8s.io }
```
Reference each SA from its Deployment via `spec.template.spec.serviceAccountName`.

#### I7. Hardcoded credentials in `docker-compose.yml`
**Files**: `docker-compose.yml:36, 42, 102-104, 191-193, 199, 280-282, 287, 395`
**Severity**: High

`polarisdev`, `polarisdev123` are hardcoded for Redis and MinIO. Even for dev, having them in source primes them to leak elsewhere.

**Fix**: move all credentials to `.env` with safe placeholders in `.env.example`. Use `${REDIS_PASSWORD:?}` Compose syntax to fail fast on missing env vars.

#### I8. Missing resource limits on stateful workloads
**Files**: `k8s/base/processor-deployment.yaml`, `redis-statefulset.yaml`, `minio-statefulset.yaml`, `ipfs-statefulset.yaml`
**Severity**: High

A runaway pod can starve the cluster.

**Fix**: add `resources.requests` and `resources.limits` to every container. Conservative starts:
```yaml
resources:
  requests: { memory: "512Mi", cpu: "250m" }
  limits:   { memory: "2Gi",   cpu: "1000m" }
```

### MEDIUM

#### I9. Neo4j health check depends on env var
**File**: `k8s/base/neo4j-statefulset.yaml:97, 106`
**Severity**: Medium

`cypher-shell -u neo4j -p $NEO4J_PASSWORD 'RETURN 1'`. If the env var fails to inject, probes fail silently.

**Fix**: explicitly source from secret in the probe environment (StatefulSets allow per-container env), or read from a mounted file.

#### I10. Ingress hardcodes `namespace: polaris`
**File**: `k8s/base/ingress.yaml`
**Severity**: Medium

Dev overlay (`overlays/development`) targets `polaris-dev`, but the ingress in base would still try `polaris`.

**Fix**: remove namespace from base ingress; let each overlay set it via Kustomize patch, or move ingress entirely to overlays.

#### I11. `deploy.sh` brittle YAML parsing
**File**: `deploy.sh:125`
**Severity**: Medium

`namespace=$(grep 'namespace:' "$overlay_dir/kustomization.yaml" | awk '{print $2}')`

Breaks on comments, multiline arrays, or quotes.

**Fix**: use `yq` (`yq eval '.namespace' …`) or `kubectl kustomize "$overlay_dir" | yq …`.

#### I12. CI does not run performance tests
**File**: `.github/workflows/backend-ci.yml`
**Severity**: Medium

`backend/test/performance/` exists with `artillery.yml`, `load.test.js`, `processor.cjs`, `template.js`, but no workflow invokes them.

**Fix**: add a nightly workflow `performance.yml` that runs `npm run test:load`, captures metrics, and fails if 95-pctile latency exceeds a threshold.

#### I13. Backend `package.json` script `dev` requires `--env-file=.env`
**File**: `backend/package.json:8`
**Severity**: Medium (developer onboarding)

Fails opaquely if `.env` is missing; `.env.example` exists but isn't auto-copied.

**Fix**: add a `predev` script that copies `.env.example` to `.env` if missing, with a loud warning.

### LOW

#### I14. `.env.example` missing/under-documented sections
**File**: `.env.example`
**Severity**: Low

Pinata, Substreams API token sections are commented but lack signup links / required scopes.

**Fix**: consolidate "External Services" with link + scope guidance.

#### I15. `NEO4J_PLUGINS` value format unspecified
**File**: `k8s/base/neo4j-statefulset.yaml:51-52` + `configmap.yaml`
**Severity**: Low

Neo4j 5.x expects a JSON array string. Configmap should declare the format.

**Fix**: comment + example value `'["apoc"]'`.

#### I16. CODE_REVIEW.md is stale
**File**: `CODE_REVIEW.md`
**Severity**: Low

Two of its "residual" items are fixed (see §3 of this doc).

**Fix**: prepend a banner with date and pointer to this audit; or rewrite into a curated open-issues list.

#### I17. DOCUMENTATION_ANALYSIS.md item #2 still open
Cross-reference: §3 C1 in this doc.

---

## 6. Cross-cutting architectural recommendations

These are bigger swings that the user explicitly opted in for under "aggressive — anything goes":

### A1. Shared canonicalization module
Create `shared/canonicalize/` (already a `shared/` dir exists). Single canonical-JSON implementation imported by:
- `frontend/src/utils/hashGenerator.js`
- `backend/src/storage/eventStore.js`
- `backend/src/crypto/verifyEventSignature.js`
- `tools/import/*`
- `substreams/sink/http-sink.mjs`

Bind a `shared/canonicalize/test/fixtures.json` with 100 input/expected-hash pairs; both Node and browser tests load and assert.

### A2. Repository pattern for Neo4j
Introduce `backend/src/graph/repositories/{person,group,track,song,release,claim}.js`. Each repo owns its Cypher and exposes typed methods. Resolvers and route handlers depend on repositories, not on `this.db.driver`.

### A3. Replace `express-graphql` with Apollo Server
Same surface area; gain query-cost analysis, persisted queries, and active maintenance. The `graphql` package is already a dep at v15 — schedule a v16 bump as part of this.

### A4. Front-end build hygiene
- ESM-only (drop the global JIT script).
- Type-check via `// @ts-check` JSDoc or migrate to TypeScript.
- Vite plugin for bundle-size limits and dead-code detection.
- Add Vitest + Testing Library DOM.

### A5. Observability spine
- Standard log shape: `{ ts, lvl, svc, op, trace_id, ...fields }`.
- OpenTelemetry traces for the request → resolver → repository → Neo4j chain.
- Prometheus metrics: Neo4j pool wait, IPFS retry counts, batch flush size and latency.

### A6. Secret management
- Sealed Secrets *or* External Secrets Operator with a backing store (AWS SM, Vault).
- Pre-commit `gitleaks` hook.
- Regular secret rotation schedule documented in `docs/operations.md` (currently absent).

### A7. Supply-chain hygiene
- SHA-pin all GitHub Actions (I5).
- `npm audit --omit=dev` in CI; fail on `high`.
- `cargo audit` for the substreams Rust modules.
- Trivy scan on every container image push.
- Sign images with Cosign; verify in K8s admission via `policy-controller`.

### A8. Test pyramid
Current backend test count is reasonable; performance tests exist but aren't wired in. Frontend has zero tests. Targets:
- Unit (Jest/Vitest): >80% on backend services and repositories; >60% on frontend modules post-decomposition.
- Integration (Jest with real Neo4j via Testcontainers): every repository.
- E2E (Playwright): wallet connect → release submission → graph navigation → like submission.
- Performance: nightly Artillery run; regression alerts.

---

## 7. Prioritized remediation roadmap

### Week 1 (blast-radius-limited critical fixes)
- B2 rollback-failure pattern (≤30 LOC, applies in ~5 places).
- B3 ingestion `Promise.allSettled` cleanup.
- B4 `flushBatch` timeout.
- B7 sanitize error responses.
- B8 CORS wildcard guard.
- F2 delete `MusicGraph.enhanced.js`.
- F12 chain-profile guard in production.
- I7 move docker-compose creds to `.env`.
- I5 SHA-pin GitHub Actions (Renovate-assisted).

### Sprint 1 (architectural)
- B1 split `server.js` into routes/resolvers/middleware/repositories.
- B6 `withSession` helper across all session call sites.
- B9 GraphQL pagination.
- F1 split `MusicGraph.js`.
- F3 unify hash canonicalization (frontend + backend share `shared/canonicalize`).
- F6 replace `innerHTML` with DOM helper / lit-html.
- I1 Sealed Secrets / ESO migration; remove `secret.yaml` from base.
- I2 digest-pinned base images + CI gate.
- I3 add `securityContext` to every workload.
- I4 add `NetworkPolicy`s.
- I6 add ServiceAccounts and minimal RBAC.

### Sprint 2 (quality + risk-down)
- B10 invariant validation.
- B11 Cypher builder helper + regression corpus.
- B15 migrate to `@apollo/server`.
- F4 WalletManager `off()` + caller cleanup.
- F5 like/disconnect race fix.
- F7 drop CSP `'unsafe-eval'`.
- F8 frontend test harness with first 20 tests.
- F13 accessibility pass.
- I12 wire performance tests into nightly CI.
- C1 reconcile emission multipliers in README.

### Backlog
- C2 drop or shrink `checksum_to_hex`.
- C3 tag validation.
- C4 `reinit()` multisig/timelock.
- S1 substreams proto parity check in CI.
- A1–A8 cross-cutting initiatives.
- B17 dependency upgrades / drop `eosjs`.

---

## 8. Test coverage gaps (consolidated)

| Area | Missing test |
|---|---|
| `schema.js` rollback path | Force `tx.rollback()` to throw; assert wrapped error and metrics. |
| `ingestion.js` batch | Concurrent `processBatch` calls; assert no double-resolve / double-reject. |
| `ingestion.js` flush | SIGTERM-style flush with stuck `batchProcessing`; assert timeout. |
| `eventStore.js` cache poisoning | IPFS returns unsigned; Redis must not be populated when `requireSig=true`. |
| `verifyEventSignature.js` | Malformed pubkey/sig strings produce structured error, not crash. |
| Cypher safety | Try a malicious label and field name through `processAddClaim`; assert reject. |
| Domain invariants | Build invalid bundles (no tracks; track without song); assert reject before commit. |
| Frontend hash determinism | 50 fixtures hashed in Node and browser must match. |
| Wallet flow | Connect → submit like → disconnect mid-flight → reconnect → reconcile. |
| Contract `unlike` | Manually delete aggregate, then call `unlike`; assert no-throw and no orphan. |
| Contract `reinit` | All safeguards enforced (paused, no stakes, no unfinalized escrows, valid token contract). |

---

## 9. Dependency inventory (backend)

| Package | Version | Status |
|---|---|---|
| `@aws-sdk/client-s3` | 3.971.0 | OK; minor upgrade available. |
| `@wharfkit/antelope` | ^1.1.1 | OK. |
| `ajv`, `ajv-formats` | 8.17.1 / 2.1.1 | OK. |
| `cors`, `helmet` | 2.8.5 / 7.2.0 | OK. |
| `eosjs` | 22.1.0 | **Drop** — superseded by `@wharfkit/antelope`. |
| `express` | 4.22.1 | OK; v5 GA available — schedule. |
| `express-graphql` | 0.12.0 | **EOL — replace with `@apollo/server`**. |
| `express-rate-limit` | 8.2.1 | OK. |
| `fast-json-stable-stringify` | 2.1.0 | Use on frontend too (F3). |
| `graphql` | 15.10.1 | Bump to 16 with Apollo migration. |
| `ioredis` | 5.9.2 | OK. |
| `ipfs-http-client` | 60.0.1 | Verify still maintained (`kubo-rpc-client` is the modern alternative). |
| `multiformats` | 13.4.2 | OK. |
| `neo4j-driver` | 5.28.2 | OK; upgrade to 5.30+ for tx fixes. |
| `node-fetch` | 3.3.2 | OK; consider native `fetch` (Node 22+). |
| `ws` | 8.19.0 | OK. |
| `jest`, `babel-jest` | 29.7.0 | OK; Node 22 + ESM — schedule Vitest. |
| `artillery` | 2.0.27 | OK. |

---

## 10. Appendix — file inventory (top files by size)

| LOC | File |
|---|---|
| 2960 | `backend/src/api/server.js` |
| 2661 | `backend/src/graph/schema.js` |
| 2562 | `frontend/src/visualization/MusicGraph.js` |
| 2074 | `contracts/polaris.music.cpp` |
| 1705 | `backend/src/storage/eventStore.js` |
| 1169 | `backend/src/indexer/eventProcessor.js` |
| 954  | `backend/src/api/ingestion.js` |
| 930  | `backend/src/graph/normalizeReleaseBundle.js` |
| 923  | `backend/src/graph/merge.js` |
| 685  | `frontend/src/visualization/graphApi.js` |
| 444  | `frontend/src/components/FormBuilder.js` |
| 438  | `frontend/src/wallet/WalletManager.js` |
| 415  | `frontend/src/visualization/PathTracker.js` |
| 354  | `frontend/src/visualization/ReleaseOrbitOverlay.js` |
| 351  | `backend/src/api/playerService.js` |
| 335  | `frontend/src/utils/api.js` |
| 307  | `frontend/src/visualization/LikeManager.js` |
| 303  | `backend/src/identity/idService.js` |
| 293  | `frontend/src/visualization/MusicGraph.enhanced.js` (**dead — see F2**) |

---

## 11. Verified vs unverified claims

Each finding above was traced to a file:line. Two earlier-suspected issues were spot-checked and excluded:

| Excluded claim | Verification |
|---|---|
| `eventStore.js` stores before verifying hash | Order is verify → calc → match → store. `eventStore.js:329-359`. |
| Contract still hardcodes `"council.pol"` | Replaced by `g.council_account` configurable via `setoracle()`. `polaris.music.cpp:397-404, 1660-1680`. |
| Contract `unlike()` uses `require_find` | Uses `find()` with explicit graceful-fallback comment. `polaris.music.cpp:286-317`. |

Findings that depend on operational context (e.g., whether cookie auth is in use, whether a CDN already strips `console.log`) are flagged in their bodies as "auth-model dependent" or similar.

---

*End of audit. Cross-references: `CODE_REVIEW.md` (now partially stale), `DOCUMENTATION_ANALYSIS.md` (item #2 still open and tracked here as C1), `CLAUDE.md` (domain invariants referenced in B10).*
