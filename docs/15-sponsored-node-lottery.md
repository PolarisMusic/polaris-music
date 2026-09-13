# Sponsored Node Lottery — Specification

**Status:** design agreed and settled; draw and schedule implemented.
**Implemented:** contract `lottery` singleton + `setlottery`;
`backend/src/api/sponsoredNode.js` (21 tests); `backend/src/api/lotteryPeriod.js`
(20 tests).
**Outstanding:** eligibility query, seed fetch, stake snapshot, endpoint, frontend.

**Settled:** 24h period; base weight lives on chain and is governable; the node
changes on every fresh load with nothing remembered between visits; no paid-
placement disclosure — most nodes drawn will have nothing staked on them, so a
blanket "sponsored" label would misdescribe the majority of them.

The visualization opens on a node chosen by a periodic weighted draw. Nodes
with more MUS staked to them are picked more often; nodes with nothing staked
are still picked sometimes. Every visitor in a period sees the same node.

---

## 1. What is on chain

The draw's inputs already existed; the only thing added is the rules table:

| Input | Where it lives |
|---|---|
| Stake per node | `nodeagg` table — `node_id` (checksum256), `total` (asset), `staker_count` (`polaris.music.cpp:1550`) |
| Entropy | Block ids, readable over RPC |
| Node identity | `sha256(graph_node_id)`, the same derivation the `like` action already uses (`LikeManager.js:174`) |
| Draw rules | `lottery` singleton — `base_weight`, `period_blocks`, `seed_delay_blocks`, written by `setlottery` |

`lottery` is a singleton of its own rather than three more fields on
`global_state`. That struct is already `set` on testnet, and eosio unpacks a
singleton against the current struct definition: stored bytes shorter than the
struct is a read failure, not a defaulted field. A new table has no stored rows
to be short, so `get_or_default()` returns the defaults cleanly and there is
nothing to migrate.

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

Periods are counted in blocks, so the whole schedule falls out of a block
number with no clock and no time zone:

```
period P       = floor(block / period_blocks)
snapshot block = P * period_blocks           ← stakes are fixed here
seed block     = snapshot + seed_delay       ← its id is the randomness
```

The gap between those last two is the security property, not a tuning knob:

1. At the snapshot block, stakes are fixed. Anything staked later does not
   count for this period.
2. `seed_delay_blocks` later — about a minute — the seed block is produced. Its
   id was unknowable at step 1.
3. The draw is computed from the two.

Collapse the gap to zero and a staker reads the seed at the instant stakes are
fixed, computes which node would win, and buys it. `setlottery` refuses a zero
delay for that reason, and refuses a delay at or beyond the period length,
which would put the seed in the next period and make two periods share one
seed.

**The seed must also be irreversible.** A seed block a fork could replace would
silently change the winner, so the schedule resolves against the last
irreversible block rather than the head. In practice that costs another few
minutes at each period boundary, during which the previous period's node stays
up — which is also what happens during the seed delay itself. Neither is an
error state and neither should be visible to a visitor.

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

## 6. Choosing base_weight

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
should be a decision rather than a side effect. Ships at `1`, and it is
governable: `setlottery` writes it, so it can be retuned as the registry grows
without redeploying anything, and it is one more input a verifier reads from
the chain rather than taking on trust.

---

## 7. Remaining work

1. **Eligibility query** — §4, in the graph layer, with the `ORDER BY`.
2. **Seed fetch** — `get_info` for the last irreversible block, `get_block_info`
   for the seed block's id, through `ChainReaderService`, which already proxies
   `get_table_rows` (`chainReaderService.js:25`).
3. **Stake snapshot** — the open problem, see §7.1.
4. **Endpoint** — `GET /api/graph/sponsored`, returning the winner plus the
   inputs from §5, cached for the period so every visitor sees the same node.
5. **Frontend** — centre and select the node on every fresh load, falling back
   to today's behaviour if the endpoint fails. Nothing is remembered between
   visits. On a phone this lands in the collapsed sheet row, which already
   names the selected node.

### 7.1 Reading stakes as of a past block

`get_table_rows` returns *current* state. A plain nodeos cannot answer "what
did `nodeagg` hold at block B", so the snapshot cannot simply be read after the
fact — which matters, because the design says stakes are fixed at the snapshot
block and the seed arrives a minute later.

Three ways out, in order of preference:

1. **Record the snapshot when the block passes.** The backend reads `nodeagg`
   once, at the snapshot block, and stores it against the period. Current-state
   reads are enough because the read happens *now*, at the right moment. Needs
   something running continuously and a place to keep the snapshot.
2. **Reconstruct from indexed stake events.** The substreams pipeline already
   carries stake and unstake events, so stakes-as-of-a-block can be replayed
   from the projection, which also makes the snapshot independently checkable
   rather than operator-asserted.
3. **Read current stakes at draw time.** Simplest, and wrong in a specific way
   worth naming rather than hiding: it reopens a window between the seed block
   appearing and the read, in which someone watching the chain could stake
   against a known seed. The window is seconds and they would have to win the
   race every period, but it is not the property §3.1 claims.

(2) is the one that matches the rest of the architecture, since the events are
already being indexed.

### Failure behaviour

The graph must still boot if the chain is unreachable, the draw returns
nothing, or the endpoint errors. The fallback is today's behaviour — root on
the busiest group — and it should be silent to the visitor.

---

## 8. Settled

- **Period length:** 24h — `period_blocks` 172800, retunable via `setlottery`.
- **Base weight:** on chain and governable, default 1.
- **When it applies:** every fresh load. Nothing is stored client-side; a
  visitor returning within the period sees the same node because the draw is
  the same, not because anything was remembered about them.
- **Disclosure:** none. The slot is not a paid placement — with base weight 1
  most nodes drawn will have nothing staked on them, so a blanket "sponsored"
  label would misdescribe the majority of them.

## 9. Not verifiable from this repository

Two claims in this document cannot be checked by anything in CI, and should be
checked before the contract is deployed:

- **The contract compiles.** CI's "Smart Contract Check" greps for three action
  names (`ci.yml:134-145`); it does not invoke a compiler. `contracts/build.sh`
  does.
- **`lottery` reads back as expected on a chain that already has `globals`
  set.** The no-migration argument above is a claim about eosio's singleton
  unpacking, and testnet is where it stops being a claim.
