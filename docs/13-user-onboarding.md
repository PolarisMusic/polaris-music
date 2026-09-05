# 13 — Onboarding users onto the chain

**Status:** analysis and decision record. Path A is partly built (this document
says what was added and what is left); Path B is unbuilt and needs a decision
before it can be.

Every write the site performs is an Antelope action signed by the visitor:
`put`, `like` and `vote` are the only three the frontend ever pushes. There is
no server-side account, no login, no session and no signature check on the
off-chain write path, and that is deliberate — the real gate is
`require_auth(author)` inside `put()`, so unsigned data POSTed off-chain sits in
IPFS/S3 unreferenced and never reaches the graph. The chain account *is* the
identity.

That makes "getting a chain account" the entire onboarding problem.

---

## 1. The fact the business model rests on: the submitter pays for RAM

The contract does not subsidise submissions. In `contracts/polaris.music.cpp`,
`put()` writes two rows and bills both to the submitter:

| Site | Row | Payer |
|---|---|---|
| `anchors.emplace(author, …)` | the anchor | **submitter** |
| `tallies.emplace(author, …)` | its zeroed vote tally | **submitter** |
| `votes.emplace(voter, …)` | a vote | **voter** |
| `aggregates.emplace(account, …)`, `staker_nodes.emplace(account, …)` | a stake | **staker** |
| `respect.emplace(get_self(), …)`, `pending.emplace(get_self(), …)` | oracle/system rows | contract |

So a brand-new account can browse, `like` (deliberately zero-RAM — the action
writes no rows) and `vote` (an account with no Respect gets weight 1, no
Respect required). It **cannot submit** until it owns RAM.

### Do not quote a fixed byte cost

The anchor row is **variable width**: fixed fields plus a `std::string
event_cid` holding an IPFS CIDv1 and a `std::vector<name> tags`. A release with
five tags costs more than one with none, so there is no single number to price
against. A comment in `backend/src/chain/reclaimService.js` cites "roughly 461,
336 and 552 bytes" for vote, tally and anchor rows; that figure appears in prose
only, with no derivation anywhere in the codebase, and cannot be right as a
constant for a variable-width row. Treat it as a hypothesis.

Measure it instead, against a real submission:

```bash
cd backend
node scripts/measureRam.js polaristest2 --watch
```

Then submit a release through the site. The script prints the byte delta the
moment the account's usage changes, and prices it from the `eosio.rammarket`
pool. That number — for a *typical* release, not a minimal one — is what
"covering RAM plus margin" has to cover. Run it against a large tracklist too;
the tracklist does not enter the anchor row, but the tag vector and CID length
do vary.

---

## 2. Path A — the user brings their own Anchor account

**This mostly works today.** The gaps were UI, not protocol.

- `frontend/src/wallet/WalletManager.js` registers `WalletPluginAnchor` and
  `WalletPluginCloudWallet`. Both `connect()` and `restore()` reject the `owner`
  permission and force `active`. Session persistence is WharfKit's default
  `BrowserLocalStorage` — no cookie, no server session.
- **Anchor is the only wallet that can work on Jungle4.** The CloudWallet
  plugin's `supportedChains` contains exactly one entry, WAX mainnet
  (`1064487b…aea5a4`), while we run Jungle4 (`73e4385a…16c4d`), so WharfKit
  filters it out of the login modal. Independently, `mycloudwallet.com` appears
  nowhere in the `connect-src` of `frontend/index.html` or
  `frontend/submit.html`. Adding it back needs a plugin that supports the chain
  **and** CSP entries in *both* HTML files.
  `docs/deployment/testnet-deployment-plan.md` used to instruct the operator to
  log in with CloudWallet at Phase 7; that step could never have worked and has
  been corrected.

### Fixed here

- `/submit` had **no wallet UI at all** — no account display, no sign-in button.
  It relied on `restore()` firing at page load plus a toast. Anyone arriving by
  a direct link saw nothing about the requirement and discovered it only when a
  filled-in form failed to submit. There is now a wallet bar at the top of the
  page showing the signed-in account, with connect and disconnect.

### Still open on this path

- **Edit affordances are not hidden when logged out.** `ClaimManager` throws
  late, so the inline edit buttons render, the visitor types a correction, presses
  Save, and only then learns they needed a wallet (`InlineEditor.js`).
- **`unlikeNode()` is local-only** — it never pushes the contract action, so an
  unlike is invisible on chain.
- **`put` hardcodes `permission: 'active'`** in `transactionBuilder.js` while
  `like` and `vote` use `session.permission`. Worth unifying before any
  sponsored-key or custom-permission scheme, which would otherwise break on the
  hardcoded one.

---

## 3. Path B — we create the account for them

**Entirely greenfield.** `newaccount`, `buyrambytes`, `powerup` and `delegatebw`
return **zero hits** across `backend/src`, `frontend/src` and `contracts/`. The
contract exposes no onboarding hook, and how `polaristest2` / `polaristest3` were
created is documented nowhere — `git log -S polaristest` finds no provisioning
commit; they appear only as test fixtures.

Building it requires all of:

1. **A key-holding signer service.** The backend currently holds **no
   chain-pushing key** by design: `DEV_SIGNER_PRIVATE_KEY` is off-chain only and
   hard-disabled in production. Path B reverses that decision — a funded
   sponsoring account whose key lives on the server, able to mint accounts and
   buy RAM. That is a new and permanent piece of attack surface, and it is the
   part of this that deserves the most thought.
2. **A transaction builder** for `newaccount` + `buyrambytes` (or `powerup`),
   with the RAM figure taken from §1's measurement rather than guessed.
3. **An anti-abuse gate.** Free accounts backed by a funded key get drained.
   Since the stated model is *paid* account creation, the natural gate is
   payment: take the money first, mint on receipt. That sidesteps captchas and
   email verification entirely, and it is the reason Path B is worth building at
   all rather than pointing everyone at the faucet.
4. **A "I don't have a wallet" branch in the UI**, with key custody decided:
   generate in-browser and hand the user their key (they can import it into
   Anchor), or hold it server-side (which makes us a custodian, with everything
   that implies).

### The Vaulta/Google route the brief mentions

"Download Anchor, get a free Vaulta account by signing in with Google" is Path A
with a smoother funnel, not a third path — the account still arrives via a
wallet the user controls, and we never hold a key. If that funnel works on the
chain we deploy to, it is strictly cheaper than Path B and removes items 1 and 4
above. **Confirm it supports our chain before designing around it**: the
CloudWallet finding above is exactly this class of assumption failing on a
`supportedChains` list, and I could not verify Vaulta's chain support from here
— the sandbox has no outbound access to chain or wallet endpoints.

---

## 4. Recommended order

1. **Measure the RAM cost** (§1). Everything about pricing is guesswork until
   this number exists, and it takes one command plus one submission.
2. **Finish Path A's UI** — hide or gate the edit affordances when logged out,
   and unify the `put` permission. Small, and it stops the two remaining ways a
   logged-out visitor wastes work.
3. **Verify the Vaulta/Google funnel against our chain id.** If it works, the
   onboarding story is "install Anchor, sign in with Google" and Path B may never
   need building.
4. **Only then decide on Path B**, whose real cost is the key-holding service,
   not the transaction building.
