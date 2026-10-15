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

So a brand-new account can browse and `like` — `like()` is deliberately
zero-RAM, the action body writes no rows at all and says so. It can do nothing
else.

**An earlier version of this document said a new account could also vote. That
was wrong**, and the table above contradicts it on the same page: `vote()`
reaches `votes.emplace(voter, …)` (`polaris.music.cpp:769`) and that row is
billed to the voter. The claim conflated two separate gates — Respect, which a
new account genuinely does not need (weight falls back to 1), and RAM, which it
does. A zero-RAM account cannot vote and cannot submit. It can read, and it can
like. That is the whole of it, and it makes the RAM question the gate on
*participation*, not just on submission.

### Do not quote a fixed byte cost

The anchor row is **variable width**: fixed fields plus a `std::string
event_cid` holding an IPFS CIDv1 and a `std::vector<name> tags`. A release with
five tags costs more than one with none, so there is no single number to price
against. A comment in `backend/src/chain/reclaimService.js` cites "roughly 461,
336 and 552 bytes" for vote, tally and anchor rows; that figure appears in prose
only, with no derivation anywhere in the codebase, and cannot be right as a
constant for a variable-width row. Treat it as a hypothesis.

**Measured, 2026-10-14, on Jungle4.** One release submission moved
`polaristest2`'s RAM usage by **896 bytes** — the anchor row and its zeroed
tally together, about 448 a row — at a spot price of 0.208658 EOS/KiB, so
roughly **0.18 EOS a submission**.

That is close enough to the "roughly 461, 336 and 552 bytes" in
`reclaimService.js` (552 + 336 = 888) that the prose figure was substantially
right, and the scepticism above was misplaced about the magnitude if not about
the principle: the row *is* variable width, and a release with ten tags carries
80 bytes of `tags` that one with none does not. Treat 896 as the figure for a
typical release and expect tens of bytes either way, not hundreds. The vote row
has not been measured; the same prose puts it at 461, which is the next number
to check, by voting with the watcher running.

Measure it yourself against a real submission:

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

## 4. Decided: passkeys, and a RAM allowance paid by the contract

Decision taken 2026-10-14, replacing the recommended order below where the two
conflict. Both halves are evidenced against the npm registry on the same date;
the chain-side checks could not be run from the authoring sandbox, whose egress
proxy refuses chain endpoints, and are listed as outstanding.

### Login: passkeys (WebAuthn), not email

Email login does not exist for this chain. The three candidates and why:

- `@wharfkit/wallet-plugin-cloudwallet`, which the app already installs, is
  email and social login — and WAX-only, as §2 records. Dead weight here.
- `@wharfkit/wallet-plugin-web-authenticator` 4.0.2 is the right architecture
  (a popup web wallet, which could be email-backed) and its own README says it
  is "currently under development and not ready for production use". It is also
  Jungle4-only and expects *us* to host the authenticator service — the default
  URL in the package is `http://localhost:5174`. Taking this route means
  building and operating a custodial web wallet.
- `@wharfkit/webauthn` 4.0.2 wraps Antelope's native `PUB_WA_` key type:
  Face ID or a fingerprint, no app to install, no seed phrase to lose, and no
  key for us to hold. It is a key-helper library rather than a wallet plugin,
  so the SessionKit side is ours to write.

The third is better than what was asked for. No custody, no password, no email
round trip, and the key never leaves the device's secure element.

**It forces the 4.x upgrade.** On 2026-09-28 the whole `@wharfkit` org
re-versioned in lockstep to 4.0.2, and `session@4.0.2` now pins
`@wharfkit/antelope: 4.0.2` exactly rather than by range. `@wharfkit/webauthn`
exists only at 4.x and pins the same. Mixing it with the app's `session@1.6.1`
installs two copies of `@wharfkit/antelope`, and every `instanceof` across that
boundary fails. The predecessor package `@greymass/webauthn@1.0.2` is no escape:
it depends on `@greymass/eosio@^0.5.0`, the library WharfKit replaced.

**Confirmed 2026-10-15:** Jungle4 has `WEBAUTHN_KEY` activated, so `PUB_WA_`
keys work there and this path is open. The check, for whenever the chain
changes or another one is considered:

```bash
curl -s -X POST https://jungle4.greymass.com/v1/chain/get_activated_protocol_features \
  -H 'Content-Type: application/json' -d '{"limit":200}' | grep -c WEBAUTHN_KEY
```

### Account creation does not need the upgrade

Worth recording separately, because it is cheap and independent:
`SessionKit.createAccount()` already exists in 1.6.1, and
`@wharfkit/account-creation-plugin-jungle4@1.2.0` declares
`peerDependencies: {"@wharfkit/session": "^1.1.0"}` with the same implementation
as its 4.0.2 build — generate a K1 key in the browser, POST to
`jungle4.greymass.com/account/create` with a random account name, show the user
a QR of the private key to save. Free account in seconds, no server key, no
custody. It ends at "now import this into a wallet", which is why it is a
complement to a login route and not one itself.

### RAM: the contract pays for the first N rows per account

Rather than sponsoring from a server-held key (Path B above, with its permanent
attack surface), the contract itself pays. `emplace(get_self(), …)` bills the
contract account, so `put()` chooses its payer by quota: under the allowance the
contract pays, over it the submitter does. The allowance doubles as the
anti-abuse gate — it is finite per account, and past it a user who wants more
arranges their own RAM.

Design notes for the implementation:

- The allowance must cover **votes as well as submissions**, per the correction
  in §1. An allowance that only covers `put()` leaves a new account unable to
  vote, which is the cheaper and more common action.
- Rows paid by the contract return their RAM to the contract when erased, which
  connects this to the existing `reclaimAnchors` path rather than making it a
  one-way cost.
- The quota constant waits on the measurement in §1 —
  `node scripts/measureRam.js <account> --watch` against a *typical* release.
  Ten submissions' worth is the target size; ten times a guess is a guess.
- A row's payer is fixed at `emplace` time. Moving a sponsored row to the user
  later means erase and re-emplace, so "we paid, now you pay" is not a thing
  that can happen to an existing row — only to the next one.

### Parked: streaming-service OAuth as the login

Raised 2026-10-15, not scheduled. Sign in with Spotify, Amazon Music,
SoundCloud, Bandcamp or Deezer, and have that same grant serve as the listen
link and the player authorisation — so there is one sign-in rather than a login
followed by a separate "connect your Spotify" step.

What makes it worth building is not the login. It is that the player stops
being an embed the visitor has to authorise separately: the graph becomes a
thing you can listen to, queue from and build a playlist in, which is the
difference between a reference work and something people use. The login is a
by-product of an authorisation we want anyway.

As abuse prevention it is in the same class as "sign in with Google" — an
account at a third party that costs something to create in bulk. Weaker than
payment, far cheaper than a captcha.

Pairing it with the passkey is the interesting part: the OAuth identity says
who you are to the services, the passkey holds the chain key, and neither alone
gets you both. That is approximately two-factor without building a second
factor.

Open questions, none of them answered here: which services allow playback
control from a third-party web app at all (Spotify's Web Playback SDK needs
Premium; Bandcamp has no public playback API); how an OAuth identity maps onto
a chain account, which is the same custody question §4 answers with passkeys
and does not answer twice; and whether the player's existing per-track `listen`
data can be reconciled with per-service tokens.

---

## 5. Recommended order (superseded in part by §4)

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
