# Timeline Scrubber — Specification

**Status:** Draft for review. Nothing below is implemented.
**Author's note:** written after reading the code, not from the roadmap. Every
claim about current behaviour cites a file and line so you can check it.

---

## 1. What was asked for

A control that turns back time in the graph. Scrubbing backwards removes nodes
one by one. The ordering is by the **release date of the release**, explicitly
**not** by when the node was added to the registry.

That second half is the whole design constraint, and it is the right call: a
registry that animates its own data-entry order is a chart of the contributors'
habits, not of music history.

---

## 2. The finding that reshapes this

**The graph on screen contains no releases.**

`/graph/initial` returns Groups and the Persons who are `MEMBER_OF` them, and
nothing else (`backend/src/api/routes/graph.js:41-78`). Its one query starts
`MATCH (g:Group)-[:PERFORMED_ON]->(t:Track)`, uses the tracks only to count
them, and returns three things: group nodes, person nodes, and `MEMBER_OF`
edges. Releases and tracks enter the client only when a node is expanded or
through the release orbit overlay.

So "remove nodes by release date" cannot be a filter on a date the nodes carry.
**Nothing in the client graph has a date on it at all.** `transformToJIT()`
builds each node's payload as `$dim`, `$type`, `$color`, `type`, `trackCount`,
`photo` (`frontend/src/visualization/graphApi.js:428-438`) — no date field
reaches the browser today.

The nodes that would appear and disappear are therefore **groups and persons**,
and each needs a date *derived* from releases they are connected to. That
derivation is the bulk of this feature, and it is backend work.

One asset already exists: `MEMBER_OF` edges are returned **with `from_date` and
`to_date`** (`backend/src/api/routes/graph.js:66-67`) and survive into the
client's edge data (`graphApi.js:393-399`). The lineup half of the timeline can
be built from data already on the wire.

---

## 3. Naming: this is not "History"

"History" is taken. The ❄️ History control in the top bar
(`frontend/index.html:48-51`) opens a panel of **blockchain operations** —
anchors, transaction hashes, vote tallies (`MusicGraph.js:1274` onward, via
`backendApi.getVoteTally`). It is the audit trail, and it is exactly the
"when was this added" axis this feature must *not* be confused with.

Call the new control **Timeline**. Anything else invites a user to read the
chain log as music history.

---

## 4. Defining a node's date

### 4.1 Which dates exist now

| Node | Field | Populated by |
|---|---|---|
| Release | `release_date` | submit form, nullable (`schema.js:895`, `:921`) |
| Group | `formed_date`, `disbanded_date` | submit form (`schema.js:740-741`) |
| Person | `birth_year` | rarely (`schema.js:2994`) |
| Song | `year` | submit form (`schema.js:995`) |
| Track | `recording_date` | submit form (`schema.js:1077`) |
| `MEMBER_OF` | `from_date`, `to_date` | submit form (`schema.js:825-826`) |

`Release.release_date` is the only one the spec is allowed to key on, and it is
**nullable** — see §6.

### 4.2 Derivation

Every node gets a `first_release` date: the earliest release date reachable
from it. `min()` is the correct aggregate throughout, and it happens to solve
the reissue problem for free — see §7.

| Node | `first_release` |
|---|---|
| Release | its own `release_date` |
| Master | `min` over its editions (`IN_MASTER`) |
| Track | `min` over releases containing it (`IN_RELEASE`); fall back to `recording_date` |
| Song | `min` over its recordings (`RECORDING_OF`) |
| Group | `min` over releases holding tracks it `PERFORMED_ON` |
| Label | `min` over releases it `RELEASED` |
| Person | **see below** |

### 4.3 Person is the one that needs care

The naive rule — earliest release of any group the person ever joined — is
wrong, and wrong in a way that would be visible immediately. A bassist who
joined in 1975 would appear in the 1969 graph because the band's debut was
1969.

The precise answer already exists in the schema. Per-person track participation
is recorded as `(p:Person)-[:PERFORMED_ON {via_group_id}]->(t:Track)` — the
same edges that drive the donut rings (`graph.js:45`). A person's
`first_release` is the earliest release date over the tracks they actually
performed on, plus any `GUEST_ON` credits. Same traversal as the donut query,
one aggregate different.

Where those edges are absent, fall back to `MEMBER_OF.from_date`, then to the
group's own `first_release`.

---

## 5. Two possible semantics — pick one

**(a) Growth.** A node is visible when `first_release <= T`. Scrub forward and
the registry grows; scrub back and it shrinks to nothing. This is literally
what was asked for ("turn back time... removes nodes").

**(b) Active-at-T.** A node is visible when `first_release <= T <= last_release`.
1967 shows you the 1967 scene, and bands that had already broken up are gone.

(b) is the more interesting artefact for a music encyclopedia. It is also the
one that will look broken today, because it depends on end dates —
`disbanded_date` and `MEMBER_OF.to_date` — which are optional fields that
almost nothing will have filled in. A band with no `disbanded_date` never
leaves, so (b) degrades into (a) with extra steps.

**Recommendation: ship (a). Add (b) as a toggle once end dates are populated
enough to mean something.** Both read the same two derived fields, so (a) does
not paint us into a corner: compute and ship `last_release` alongside
`first_release` from the start even though v1 ignores it.

---

## 6. Undated releases — the policy that decides whether this looks broken

`release_date` is nullable and written as a raw string (`schema.js:895`,
`:921`). A release with no date contributes nothing to any `min()`, so a group
whose every release is undated has no `first_release` at all.

Three options:

1. **Undated nodes are always visible**, at every scrub position, with a count
   shown in the control ("42 undated"). The graph never looks emptier than the
   data supports.
2. Undated nodes are hidden outside the known range. Cleanest model, worst
   first impression — if half the registry is undated, half the graph vanishes
   the moment the control is touched.
3. Undated nodes are excluded from the feature and the control is disabled
   below some coverage threshold.

**Recommendation: (1).** It fails toward showing data rather than hiding it,
and the count doubles as a nudge to go fill the dates in.

**Measure before deciding.** Run this against production Neo4j and the answer
may pick the option for you:

```cypher
MATCH (r:Release)
RETURN count(*) AS releases,
       count(r.release_date) AS dated,
       round(100.0 * count(r.release_date) / count(*)) AS pct_dated;
```

And for the derived view, which is what actually matters:

```cypher
MATCH (g:Group)-[:PERFORMED_ON]->(:Track)<-[:IN_RELEASE]-(r:Release)
WITH g, min(r.release_date) AS first
RETURN count(*) AS groups_reachable,
       count(first) AS groups_datable;
```

### 6.1 Date format

Dates are strings in three accepted shapes — `YYYY`, `YYYY/MM`, `YYYY/MM/DD` —
and older imported rows use dashes. `dateSortKey()` in
`backend/src/api/editionOrder.js:28` already normalises all of them to a
comparable 8-digit key, and already handles the subtlety that a year-only date
must sort before a fuller date in the same year. **Reuse it. Do not write a
second date parser.**

---

## 7. Editions: why `min()` is the right aggregate

A 2009 CD remaster of a 1969 album is its own Release node with its own
`release_date` (this is what the edition work in this branch established).
Scrubbed to 1970:

- the 1969 pressing is present, the 2009 remaster is not — correct, they are
  distinct nodes with distinct dates;
- the Master takes `min` = 1969, so the work itself is present;
- the group takes `min` over all its releases, so a reissue can never drag a
  1960s band forward into the 2000s.

The failure mode is the reverse: a band whose original pressings are undated
but whose 2009 reissue is dated gets `first_release = 2009` and appears three
decades late. This is §6's problem wearing a different hat, and it is an
argument for policy (1) there.

---

## 8. The hard part: relayout

This is the technical risk, and it is worth more attention than the date model.

The hypertree computes positions from a root by walking the tree. Remove nodes
and the tree changes shape, so **every remaining node moves**. Scrubbing a
slider would re-run that per tick. This project has already been burned twice
by JIT recomputing a layout under the user — `canvas.resize()` zeroing the
pan/zoom offsets and throwing the view back to the root
(`MusicGraph.js:681-691`, jit.js:2941), and the whole `--viz-player-floor`
exercise, which exists purely so the graph stops rescaling when the player
changes height.

Two implementations:

**A. Hide, don't remove.** Keep every node in the JIT graph. Filtering sets a
per-node flag; `styleNode()` and `styleEdge()` skip painting anything outside
the window, or fade it toward zero alpha. Positions never change. Scrubbing is
a fade, the layout is rock solid, and there is no relayout cost per tick.

**B. Remove and re-layout.** Use `Graph.Op.morph()` (jit.js:5764) or
`removeNode()` with animation (jit.js:5447) to transition between graph states.
Truer to "remove", and the remaining graph re-expands to fill the canvas — but
every scrub tick re-roots and re-animates, and the disconnection problem below
becomes load-bearing.

**Recommendation: A for v1.** It is less code, it cannot regress navigation,
and "nodes fade out as you scrub" is a legitimate reading of the request. B can
be added later as a "reflow" toggle if the sparse look bothers you.

### 8.1 Disconnection (only bites under B)

`ensureConnectedForHypertree()` (`graphApi.js:312-355`) already handles a
fragmented graph by injecting a synthetic root and wiring one representative
per component to it. A date filter fragments the graph constantly — hide a
group and its members are orphaned. Under implementation B the synthetic root
would have to be rebuilt on every tick, and the root's own fan-out becomes the
dominant visual feature at early scrub positions. Under A it never arises,
because the graph object is untouched.

---

## 9. Known inconsistency in v1: the donuts lie

Group donut rings and `trackCount` are lifetime aggregates computed server-side
(`graph.js:44-47`, `:70-78`, `:96-110`). Scrubbed to 1969 a group would still show its
full career participation, including members who had not joined yet.

Fixing it properly means time-slicing participation, which the client cannot do
— it has no track-level data (§2). The options are a per-scrub endpoint (a
round trip per tick, or per debounced settle) or shipping per-member
`first_release` so the donut can at least drop slices for members who are not
yet visible.

**Recommendation: ship v1 with the inconsistency, and drop slices for
not-yet-visible members** — that is cheap, because per-person `first_release`
is already being computed for §4.3, and it removes the most glaring case
(a member visibly absent from the graph but still holding a wedge of the donut).
Full time-sliced counts are a later phase.

---

## 10. Work breakdown

### Phase 1 — Backend date derivation (no UI)

- `backend/src/api/timelineDates.js` (new): pure functions mapping raw query
  rows to `{first_release, last_release}` per node, built on `dateSortKey()`.
  Unit-testable with no database.
- Extend the `/graph/initial` query to aggregate `min`/`max` release dates per
  group and per person, via `PERFORMED_ON {via_group_id}` for persons.
- Add `first_release`, `last_release` to each node in the response, plus a
  top-level `timeline: { min, max, undated_count }` so the client can size the
  control without scanning.
- Payload cost: two short strings per node. Negligible — the endpoint already
  returns the entire graph with no `LIMIT` (`graph.js:39`).

### Phase 2 — Client filter and control

- Carry `first_release`/`last_release` through `transformToJIT()` into
  `node.data` (`graphApi.js:428-438`).
- `frontend/src/visualization/TimelineFilter.js` (new): owns the current
  position, decides visibility per node, exposes `setPosition(t)`.
- `styleNode()`/`styleEdge()` consult it (implementation A).
- `TimelineControl.js` (new): the scrubber UI.
- An edge is visible only if both endpoints are.

### Phase 3 — Lineup timeline

- `MEMBER_OF.from_date`/`to_date` are already on the client. Hide a membership
  edge outside its own window, independent of node visibility, so a band's
  lineup changes as you scrub.
- This is the payoff shot for the whole feature and it is the cheapest phase.

### Phase 4 — Optional

- Active-at-T mode (§5b), once end dates exist.
- Time-sliced donuts (§9).
- Reflow mode (§8b).

---

## 11. UI placement

Constraints from what is already there: the bottom bar holds four buttons, the
player is fixed above it, and `#viz-container` reserves exactly
`--viz-player-floor` and **must not change size**
(`visualization.css:265-277`) — that invariant was just established and has
three tests guarding it.

So the scrubber must **overlay** the canvas, not sit in the flow. A slim ribbon
docked to the bottom of `#viz-container`, above the player, toggled from a
Timeline control in the top bar next to History. On a phone it spans the
canvas width and needs a larger hit target than a native range input gives.

The control shows: current position, the range, a play/pause for auto-advance,
and the undated count from §6.

---

## 12. Testing

- **Unit (backend, no DB):** date derivation against fixture rows — a person
  who joined late, a group with one undated release, a reissue, a group with
  no dated releases at all.
- **Graph (requires live Neo4j, `ALLOW_DESTRUCTIVE_GRAPH_TESTS=true`,
  `bolt://127.0.0.1:7687`):** the aggregate query returns the expected
  `min`/`max` for a seeded two-era band.
- **e2e:** a stubbed graph with known dates; assert which nodes are painted at
  three scrub positions, that the late-joining member is absent early, and —
  the one that guards §8 — **that node positions are identical before and
  after a scrub**.

The position-stability test is the one worth writing first. It is the
regression that would make this feature unusable, and it is the one this
codebase has already shipped twice.

---

## 13. Decisions needed before implementation

1. **Growth or active-at-T?** (§5) — recommend growth.
2. **Undated nodes always visible?** (§6) — recommend yes, with a count.
   Answer partly determined by the coverage query in §6.
3. **Hide or remove-and-reflow?** (§8) — recommend hide.
4. **Granularity** — year, or month/day? Year is enough for a scrubber and
   makes the axis legible; the underlying data supports day precision where it
   exists.
5. **Scope** — graph only, or does the scrub also constrain the info panel and
   the player queue? Recommend graph only for v1.

---

## 14. Effort

Larger than anything else in this branch, and the split is not where it looks:
roughly two thirds backend and data modelling, one third UI. Phase 1 is the
long pole — not because the Cypher is hard, but because §4.3 and §6 have to be
right or the feature is confidently wrong, which is worse than absent in a
registry that claims to be canonical.

Phases 1–3 are each independently shippable and independently useful. Phase 1
alone gives the API a first/last release date per entity, which is worth having
whether or not the scrubber ever gets built.
