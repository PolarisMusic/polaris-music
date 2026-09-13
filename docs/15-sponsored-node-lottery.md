# Sponsored Node Lottery — Specification

**Status:** design agreed, draw implemented, wiring outstanding.
**Implemented:** `backend/src/api/sponsoredNode.js` + 21 tests.
**Outstanding:** eligibility query, seed fetch, endpoint, cache, frontend.

The visualization opens on a node chosen by a periodic weighted draw. Nodes
with more MUS staked to them are picked more often; nodes with nothing staked
are still picked sometimes. Every visitor in a period sees the same node.

---

## 1. What is already on chain

No contract change is needed for the first version. Everything the draw
consumes already exists:

| Input | Where it lives |
|---|---|
| Stake per node | `nodeagg` table — `node_id` (checksum256), `total` (asset), `staker_count` (`polaris.music.cpp:1550`) |
| Entropy | Block ids, readable over RPC |
| Node identity | `sha256(graph_node_id)`, the same derivation the `like` action already uses (`LikeManager.js:174`) |

The contract comment at `docs/01-smart-contract.md:283` already says staking
"affects home node selection"; this is that mechanism. The architecture
diagram in the README has carried a "Home node" feed into the frontend from
the start.

Today there is no draw at all: the hypertree roots on whichever node the
initial query returned first, which is the group with the most tracks
(`graph.js:41-43`, ordered by `trackCount DESC`).

---

## 2. The draw

Each eligible node gets a contiguous run on a number line:

```
weight(node) = BASE_WEIGHT + floor(staked_units / 10000)
```

`10000` because MUS is `asset` with 4 decimals, so a whole token is ten
thousand units. Runs are laid end to end in canonical order; the seed reduced
modulo the total weight lands in exactly one run, and that node wins.

Worked example — twelve nodes, one holding ten tokens:

| | weight | run |
|---|---|---|
| staked node | 11 | `[0, 11)` |
| eleven others | 1 each | `[11, 22)` |
| **total** | **22** | |

The staked node wins 11/22 of periods. Note it is 11 and not 10: a node's own
base chunk counts alongside the chunks its stake buys.

### 2.1 Three things that must not drift

All three are pinned in `sponsoredNode.js` rather than left to callers,
because the whole value of this design is that a third party can recompute the
winner and check it.

**Integers only.** Stake amounts are parsed as fixed point, never through
`parseFloat`. A float rounding difference between two implementations is
enough to disagree about who won.

**One canonical order.** Candidates are sorted by their on-chain id — the
sha256, not the graph id. Neo4j promises no row order without an `ORDER BY`,
so a draw that inherited query order would be both unverifiable and
intermittently wrong. This is the subtle one: a test for it passes by accident
unless the weights are equal and many seeds are swept, because a heavy
candidate covers most of the number line and wins regardless of order.

**One canonical seed reduction.** 64 hex characters, lower-cased, `0x`
stripped, read as a 256-bit integer. A malformed seed is refused, never
coerced — a seed that silently became `0` would hand the front page to
whichever node sorts first, every period, forever.

On modulo bias: the seed is 256 bits and the total weight will not plausibly
exceed a few million, so the bias is around 2^-230. Recorded so the next
reader need not re-derive it.

---

## 3. Entropy: where the seed comes from

**A contract cannot hash a block itself.** Antelope exposes no `get_block_id`.
What is reachable inside an action is `tapos_block_num()` /
`tapos_block_prefix()` — taken from the *transaction header*, and therefore
chosen by whoever pushes the transaction — plus `current_time_point()` and the
current block number, all predictable. Any "block hash" drawn from inside the
contract would be either manipulable by the submitter or known in advance.

So the contract does not draw. It does not need to:

> **The seed for period *P* is the id of the first block of period *P*, and the
> stake ledger is read as of that same block.**

Nobody knows a block's id before it is produced, and the stakes counted are
the stakes that existed at that instant. The winner is then a pure function of
two published values, and anyone can recompute it.

### 3.1 The ordering that makes it honest

This sequence is the security property, not an implementation detail:

1. Period *P* begins at block *B*.
2. *B* is produced. Its id becomes the seed — unknown to everyone until now.
3. Stakes are read **as of block *B***, not as of now.
4. The draw is computed.

Read stakes *after* the seed is known and the design breaks: a staker watches
the seed appear, computes which node would win, and stakes to become it. The
snapshot must be pinned to the seed block.

---

## 4. Eligibility

> Guest nodes, or nodes that are not members or groups, should not be selected.

In this data model:

- **Group** nodes — eligible.
- **Person** nodes with at least one `MEMBER_OF` — eligible (they are members).
- **Person** nodes with only `GUEST_ON` — **not** eligible (they are guests).
- Everything else — Release, Track, Song, Label, Master — not eligible.

```cypher
MATCH (n)
WHERE n:Group OR (n:Person AND (n)-[:MEMBER_OF]->(:Group))
RETURN CASE WHEN n:Group THEN n.group_id ELSE n.person_id END AS node_id
ORDER BY node_id
```

This happens to line up with what is already on screen: `/graph/initial`
returns exactly groups and their members.

**Be honest about what this costs.** Eligibility is evaluated off chain, so
an operator who altered the predicate could change the outcome. The mitigation
is that the rule is deterministic and published, and the graph is itself
rebuildable from on-chain events — so the result is auditable, but it is not
trustless in the way the seed and the stake ledger are. Moving eligibility on
chain would mean the contract knowing the node type of every entity, which is
exactly the RAM cost this design exists to avoid.

---

## 5. Verifiability

The winner is not written to the chain. It does not have to be: given the
seed block id and the `nodeagg` rows at that block, the draw is reproducible
by anyone with this document. The endpoint therefore publishes its inputs
alongside its answer — seed block number, seed, total weight, offset — so a
sceptic can check the arithmetic without trusting the API.

Recording the winner on chain becomes necessary only if the contract must
*pay* the winner. That is a later phase and it needs a written action, RAM,
and a caller; it is not needed to put a node on the front page.

---

## 6. Choosing BASE_WEIGHT

The base weight sets the exchange rate between tokens and attention. With base
*B*, *N* eligible nodes and *S* tokens on one of them, that node wins
*S*/(*S* + *N·B*) of periods.

| eligible nodes | 10 tokens buys |
|---|---|
| 12 | ~45% |
| 100 | ~9% |
| 10,000 | ~0.1% |

**The price of a given win probability scales with the size of the registry.**
That is probably what you want — the long tail keeps a real collective
chance, and sponsorship gets more valuable as the registry grows — but it
should be a decision rather than a side effect. Ships at `1`. If it should
ever be governable, the natural home is a `base_weight` field in the
contract's `global_state`, which also moves one more input on chain.

---

## 7. Remaining work

1. **Eligibility query** — §4, in the graph layer, with the `ORDER BY`.
2. **Seed fetch** — `get_info` / `get_block` through `ChainReaderService`,
   which already proxies `get_table_rows` (`chainReaderService.js:25`).
3. **Stake snapshot** — read `nodeagg` at the seed block; join to candidates
   on `sha256(node_id)`.
4. **Endpoint** — `GET /api/graph/sponsored`, returning the winner plus the
   inputs from §5.
5. **Cache** — one draw per period, keyed by period id, in the Redis already
   in the stack. Every visitor in a period must get the same node.
6. **Frontend** — centre and select the node on first load, falling back to
   today's behaviour if the endpoint fails. On a phone this lands in the
   collapsed sheet row, which already names the selected node.

### Failure behaviour

The graph must still boot if the chain is unreachable, the draw returns
nothing, or the endpoint errors. The fallback is today's behaviour — root on
the busiest group — and it should be silent to the visitor.

---

## 8. Open questions

1. **Period length.** 24h assumed. A shorter period churns the front page;
   a longer one makes each slot more valuable.
2. **Every load, or only the first visit?** Assumed: every fresh load within
   the period, unless the visitor arrived by deep link or a restored session.
3. **Does a sponsored slot need disclosure in the UI?** It is a paid placement
   in all but name.
