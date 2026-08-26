# Polaris Music Registry — Testnet Deployment Plan

Take Polaris from "code on your laptop" to "live at https://polaris.mu, running against EOS Jungle4 testnet, anyone with a wallet can submit a release."

Total time from Phase 3 onward: ~4–6 hours over 1–2 sittings.
Ongoing cost: ~€10/month (Hetzner CX32 + backups).

---

## Progress tracker

- ✅ **Phase 1** — Local dry run on Mac (Docker Desktop with Rosetta)
- ✅ **Phase 2** — Jungle4 accounts + smart contract deploy + init
  - Contracts live: `polarismusic`, `polaristoken`
  - MUS token issued: 1M to polarismusic
  - `eosio.code` permission granted
  - `init` called successfully; globals populated
- ✅ **Phase 3** — Pinax + Substreams local smoke test
  - Pinax token working against `jungle4.substreams.pinax.network:443`
  - Custom Substreams module builds and decodes `put` actions
  - Full loop verified: store off-chain → anchor on-chain → Substreams →
    sink → backend retrieval → graph
  - Confirmed in Neo4j, not just by the sink's success line: the anchored
    MINT_ENTITY produced `polaris:person:ead2720e-…`, a random UUID that
    could only have come from that event

    ```bash
    # Verifying ingestion: check for the entity the event mints.
    # There is no :Event node type — querying one always returns 0
    # whether or not ingestion worked.
    docker-compose exec neo4j cypher-shell \
      -u neo4j -p "$(grep '^NEO4J_PASSWORD=' .env | cut -d= -f2-)" \
      "MATCH (n) RETURN labels(n)[0] AS type, count(*) AS count ORDER BY count DESC"
    ```

    Note the graph may already hold data from `scripts/smoke_payloads/`,
    whose IDs are sequential (`polaris:person:00000000-…-000000000101`).
    Filter those out to see only what you just ingested.
- ✅ **Phase 4** — VPS provisioning + DNS
  - Hetzner CX32 `polaris-testnet` at 5.78.113.240, Ubuntu 24.04
  - `polaris.mu` and `api.polaris.mu` both resolve
  - UFW 22/80/443, fail2ban active (banning scanners as intended)
- ✅ **Phase 5** — Production secrets
  - Real passwords, `STORAGE_ENCRYPTION_KEY` 64-hex, `INGEST_API_KEY` set
  - `NODE_ENV=production`, `INGEST_MODE=chain`, `CORS_ORIGIN=https://polaris.mu`
  - `frontend/.env` created (baked at build time)
- ✅ **Phase 6** — Stack bring-up behind Caddy
  - Production Let's Encrypt certs for `polaris.mu` and `api.polaris.mu`
    (`issuer: acme-v02.api.letsencrypt.org-directory`)
  - `https://polaris.mu` serves the built frontend through Caddy → nginx
  - API reachable at `https://api.polaris.mu` — note health is `/health`,
    **not** `/api/health`; the latter returns "Endpoint not found" from the
    API itself, which looks like a failure but proves routing works
- 🔄 **Phase 7** — End-to-end on-chain test *(you are here)*
- ⏳ Phase 8 — Backups + restart-on-reboot

---

## Bugs found and fixed during Phase 1–2 (all merged to main)

| Fix | Commit | What was wrong |
|---|---|---|
| Compose mount for frontend | `c47d223` | `shared/` mounted at `/app/shared`; imports used `../../../shared/...` which escaped past `/` in container |
| Compose mount for backend api & chain-source | `4bc65a5` | Same as above; API was crash-looping on unresolved import |
| `build.sh` CDT toolchain | `ebd503e` | CMake was falling back to system GCC and handing CDT-only flags to it |
| Duplicate `nodeagg` in `clear()` | `8843b0b` | Redefined variable in same scope; only surfaced in `--testnet` builds |
| Contract class annotation | `e1f6e8a` | `CONTRACT polaris` derived name `polaris` but build passed `-contract polaris.music`; abigen dropped everything as a result |

## Bugs found and fixed during Phase 3

| Fix | Commit | What was wrong |
|---|---|---|
| Substreams builder image | `df936b0` | Pinned `v1.10.8` no longer resolves on ghcr.io |
| Rust toolchain | `54beda2` | Transitive dep needs edition2024 (Rust ≥1.85); pin was 1.75 |
| CLI invocation | `dd0cd8f` | `substreams` is the image ENTRYPOINT, not on PATH |
| antelope `.spkg` import | `55c6049` | Pinax stopped publishing `.spkg` assets to GitHub Releases; now on spkg.io |
| Manifest `sink:` block | `3a6e944` | v1.21 validates sink types against bundled descriptors; the block was unused |
| `protogen` step | `7bd5394` | Needs `buf`, and did nothing — that stage never compiles Rust |
| Deprecated `pack` | `7dbd8ec` | Switched to `substreams build`; also stopped trusting possibly-stale committed bindings |
| pb type names | `a5fa4c8` | Committed bindings predated current prost: `type_`/`Updrespect` vs `r#type`/`UpdateRespect` |
| `.spkg` filename | `7b1862e` | Runtime path hardcoded the versioned name that `build` no longer produces |
| `START_BLOCK` default | `eff21b1` | `0` replays from genesis and always exceeds the provider block cap |
| API chain config | `22234fd` | `resolveChainConfig()` result was discarded, so `RPC_URL` never reached the server |
| Neo4j LIMIT float | `22234fd` | JS numbers serialize as float64; Cypher `LIMIT` requires an integer |
| IPFS canonical CID | `3b65980` | Read `result.cid` from `block.put()`, which returns the CID itself |
| Payload decoding | `dae3e8b`, `9918fd9` | Assumed base64; v1.21 emits 0x-prefixed hex, and wrong-scheme decodes fail silently |
| Sink error reporting | `c22324c` | Logged application-level ingest errors as successes |
| Anchor-auth ingestion | `37c287e`, `a0322a1` | Frontend stores unsigned events by design, but ingestion required a signature — no UI submission could be ingested |
| Tracklist id mismatch | `67ff27d` | Bundle track ids were used verbatim in the `IN_RELEASE` MATCH; provisional ids resolve to fresh ids, so every release ended up with zero tracks and an empty orbit — silently, because a MATCH that finds nothing yields no rows |
| MiniPlayer audio clear | this branch | `audio.src = ''` resolves against the page URL, so the browser tried to load the page as audio and fired a spurious `error` on every track change |
| Runtime CSP e2e test | this branch | Both the spec and the Playwright config navigated to `/visualization.html`, which this repo does not build — the runtime CSP check had never been able to pass |

---

## Ghost Track nodes — the second graph writer

Symptom: 14 `:Track` nodes carrying only `["id","status","name","track_id"]`
— `name` instead of `title`, no `listen_links`, `status: PROVISIONAL`,
`id_kind: null` — sitting alongside the 14 real, populated tracks.

Cause: `eventProcessor.handleReleaseBundle` runs a post-merge step
(`eventProcessor.js:594`) that calls `extractRelationships` on the *normalized*
bundle and hands the result to `mergeBundle`. Two id schemes were in play:

- `normalizeReleaseBundle.generateTrackId` → `prov:track:<sha256 of title+duration>`
- `schema.resolveEntityId` → `generateProvisionalIdNew` fingerprints

`mergeBundle` MERGEd its endpoints, so an id it could not find was created as
a bare twin rather than reported as missing.

The twins were not inert. On a replay of the same event, the tracklist's
`MATCH (t:Track {track_id: ...})` — which at the time used the raw bundle id —
bound to the twin that the *previous* run's `mergeBundle` had planted. The
release's `IN_RELEASE` edges therefore pointed at empty nodes while the
populated tracks sat orphaned. A cross-run contamination loop.

Fixes, both on this branch:

1. `mergeBundle` now MATCHes its endpoints and only MERGEs the relationship.
   A missing endpoint is warned (`merge_bundle_skip_missing_endpoint`, naming
   both endpoints) and counted in `stats.skippedMissingEndpoint`. It can no
   longer create an entity.
2. `processReleaseBundle` returns `resolvedIds` — bundle id → node id, per
   entity type — and `eventProcessor` rewrites the relationship endpoints
   through it before merging, so the two id schemes meet.

**Diagnostic worth keeping.** `IN_RELEASE` edges written by
`schema.js` always carry `is_bonus` (a real boolean, never null). So:

```cypher
MATCH ()-[ir:IN_RELEASE]->()
RETURN count(*) AS edges, count(ir.is_bonus) AS with_is_bonus,
       count(ir.track_number) AS with_track_number
```

`with_is_bonus < edges` means edges exist that our writer did not create.
`with_track_number = 0` means the tracklist carried no ordering, which leaves
the player queue and release orbit unsorted (`playerService.js` sorts on
`ir.disc_number, ir.track_number`).

---

## Spotify embed playback (added after Phase 7)

Tracks carrying a Spotify link now play through **Spotify's embed iframe**,
driven by their iFrame API (`https://open.spotify.com/embed/iframe-api/v1`).
This needs no Spotify developer app, no client secret, and no OAuth flow of
our own.

Two limits are Spotify's, not ours:

- Anonymous and free listeners hear **30-second previews**. Full-length
  playback requires the visitor to be logged into Spotify **Premium** in that
  browser. Nothing on our side changes this.
- The embed is cross-origin, so a click on our play button does not carry a
  user gesture into the frame. The first play may need a second click, or a
  click on the embed itself.

The CSP meta tag in `frontend/index.html` gained `https://open.spotify.com`
under `script-src`, `frame-src`, and `connect-src`. If that ever has to be
reverted, the fallback is a plain `<iframe src=".../embed/track/{id}">`, which
needs only `frame-src` — it loses programmatic play and auto-advance.

**Known gap, not yet addressed:** `frontend/submit.html` ships with no CSP at
all, in source or in the build, while the read-only visualizer page is locked
down. It is the page that talks to wallets and the API.

---

## Decisions already made (for reference)

| Decision | Choice |
|---|---|
| VPS provider | Hetzner Cloud |
| VPS spec | CX32 (4 vCPU / 8 GB RAM / 80 GB NVMe, ~€7.55/mo) |
| TLS termination | Caddy 2 (auto Let's Encrypt) |
| Topology | Single VPS, docker-compose, no K8s |
| Frontend domain | `polaris.mu` |
| API domain | `api.polaris.mu` |
| Wallet for testers | CloudWallet (no install) |

---

# Phase 3 — Pinax + Substreams local smoke test (~30 min)

**Goal:** Prove Substreams can pull your live Jungle4 events into your local backend before you spend money on a VPS.

**Prereqs:** Phases 1 & 2 complete.

**Steps (all on Mac, not in the CDT container):**

1. Sign up at https://app.pinax.network. Free tier is fine for testnet.

2. In the dashboard, create an API token. **Save it in your password manager** under "Polaris testnet – Pinax API token."

3. Verify the token works for Jungle4:
   - Some Pinax dashboards require you to explicitly enable Jungle4 (default is EOS mainnet). Check the token's chain scope.

4. Update `~/polaris-music/.env`:
   ```
   SUBSTREAMS_API_TOKEN=<paste your token>
   SUBSTREAMS_ENDPOINT=jungle4.substreams.pinax.network:443
   CONTRACT_ACCOUNT=polarismusic
   INGEST_MODE=chain
   ```

5. Bring up the stack with the chain profile:
   ```bash
   cd ~/polaris-music
   docker-compose down
   docker-compose --profile chain up -d
   docker-compose ps
   # All services (including substreams-sink) should show "running" / "healthy"
   ```

6. Tail the sink to see it connect and start consuming blocks:
   ```bash
   docker-compose logs -f substreams-sink
   ```
   Within ~30 seconds you should see block-consumption log lines. Auth errors mean the token or endpoint is wrong — fix here, not on the VPS.

7. From your amd64 CDT container (relaunch if needed), push a test event to your live contract:
   ```bash
   c push action polarismusic put \
     '["polarismusic", 21, "9f86d081884c7d6d9ffd60bb2dd72f1d8a7e7ed5ceab5bbb0b0c0e4d9e6d4c98", "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenpcqywm4", null, '$(date +%s)', []]' \
     -p polarismusic@active
   ```

8. Watch the sink logs — the event should arrive and be forwarded to the api container within a few seconds.

9. Verify the graph actually changed. There is **no `:Event` node type** —
   counting one returns 0 whether or not ingestion worked. Take a label
   census instead, and note the graph may already hold smoke-payload data
   with sequential IDs (`polaris:person:00000000-…`):
   ```bash
   docker-compose exec neo4j cypher-shell \
     -u neo4j -p "$(grep '^NEO4J_PASSWORD=' .env | cut -d= -f2-)" \
     "MATCH (n) RETURN labels(n)[0] AS type, count(*) AS count ORDER BY count DESC"
   ```

   `$NEO4J_PASSWORD` is not exported to your shell — it lives in `.env`,
   which only Docker reads. Hence reading it from the file.

**Verification:** sink logs show `status=processed`, **and** the entity your
event mints is present in the graph. The sink's success line alone only means
the backend returned 2xx; it cannot see whether the graph write happened.

**Troubleshooting:**
- `Authentication failed` → check the token at app.pinax.network; make sure it's enabled for Jungle4
- `Chain ID mismatch` → Pinax serves the chain ID it expects; if it doesn't match Jungle4, you're pointed at the wrong endpoint
- Sink consumes blocks but no event arrives → check that the `put` transaction actually made it on-chain via https://jungle4.bloks.io

**You should now be able to:** prove the full event path works locally against a real testnet chain.

---

# Phase 4 — VPS provisioning + DNS (~1 hour)

**Goal:** A running Ubuntu VPS with Docker installed; both DNS records pointing at it.

**Steps:**

1. Sign up at https://www.hetzner.com/cloud. Add a payment method.

2. Create a project named `polaris`.

3. Add your SSH key (Security → SSH Keys). If you don't have one:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/polaris_vps
   cat ~/.ssh/polaris_vps.pub  # paste into Hetzner
   ```

4. Create a server:
   - Location: Nuremberg (or your nearest)
   - Image: Ubuntu 24.04
   - Type: **CX32**
   - SSH key: the one you added
   - Name: `polaris-testnet`
   - **Enable backups** (€1.20/mo)

5. Note the server's IPv4 address.

6. Configure DNS at your registrar (wherever you bought polaris.mu):
   - A-record: `polaris.mu` → `<server IPv4>`
   - A-record: `api.polaris.mu` → `<server IPv4>`
   - Optional: AAAA-records for IPv6

   A low TTL (300) makes later corrections propagate faster, but nothing
   here depends on it — many registrars enforce a 600s minimum, and that
   is fine. Don't fight it.

7. Wait for DNS to propagate. From your Mac:
   ```bash
   dig @1.1.1.1 polaris.mu
   dig @1.1.1.1 api.polaris.mu
   ```
   Both must resolve to your VPS IP. **Do not proceed until they do** — Let's Encrypt rate-limits failed cert attempts (5 duplicate certs per week per domain).

8. SSH in and harden the VPS:
   ```bash
   ssh -i ~/.ssh/polaris_vps root@<server IP>
   ```
   Then on the server:
   ```bash
   # Non-root user.
   # adduser prompts for a password — SAVE IT to your password manager now.
   # You will not use it to log in (SSH is key-only), so it is easy to
   # assume it does not matter, but every sudo command asks for it.
   adduser polaris
   usermod -aG sudo polaris
   mkdir /home/polaris/.ssh
   cp ~/.ssh/authorized_keys /home/polaris/.ssh/
   chown -R polaris:polaris /home/polaris/.ssh
   chmod 700 /home/polaris/.ssh
   chmod 600 /home/polaris/.ssh/authorized_keys

   # Docker
   curl -fsSL https://get.docker.com | sh
   usermod -aG docker polaris

   # Firewall
   ufw allow 22
   ufw allow 80
   ufw allow 443
   ufw enable

   # fail2ban — whitelist your own IP so a few fat-fingered logins
   # can't lock you out of your own server
   apt install -y fail2ban
   MY_IP=$(who am i | awk '{print $NF}' | tr -d '()')
   cat >/etc/fail2ban/jail.local <<EOF
   [DEFAULT]
   ignoreip = 127.0.0.1/8 ::1 ${MY_IP}
   EOF
   systemctl enable --now fail2ban
   ```

   **Do not disable root SSH yet.** The next step proves the replacement
   login works while root is still available as a fallback.

9. **Verify `polaris` login before removing your fallback.** Keep the root
   session open, and in a *second terminal* on your Mac:

   ```bash
   ssh -i ~/.ssh/polaris_vps polaris@polaris.mu
   sudo whoami        # should print: root
   ```

   If you are prompted for a password, key auth is NOT working — do not
   proceed. Fix it from the still-open root session (usually
   `/home/polaris/.ssh/authorized_keys` is missing, empty, or wrongly
   owned) until this login succeeds on the key alone.

10. **Only once step 9 succeeds**, disable root SSH from the root session:

    ```bash
    sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
    systemctl restart ssh
    ```

    Confirm the `polaris` session still works after the restart before
    closing the root one.

**If SSH stops working:** you are not stuck, and you do not need to
rebuild. Hetzner's web console reaches the machine without SSH — server →
**Console** (`>_`) in the cloud panel. From there:

```bash
sudo fail2ban-client status sshd            # is your IP banned?
sudo fail2ban-client set sshd unbanip <IP>
sudo tail -30 /var/log/auth.log             # why SSH actually refused
```

**If sudo rejects your password** — note this is a different problem from
being locked out; if you reached a `polaris@...$` prompt then SSH is fine
and only the account password is wrong. Password entry displays nothing as
you type, so check Caps Lock and try again before assuming it is lost. To
reset it: Hetzner panel → server → **Rescue** → **Reset root password**
(this reboots), then log in via **Console** as root and run
`passwd polaris`.

Optionally, make sudo passwordless. Pipe through `sudo tee` rather than
using `>`: the redirect is performed by your shell, not by sudo, so
`sudo echo ... > /etc/sudoers.d/polaris` fails with permission denied.

```bash
echo "polaris ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/polaris
sudo chmod 440 /etc/sudoers.d/polaris
sudo visudo -c        # must print "parsed OK" — see below
```

Always run `visudo -c` after touching sudoers. A syntax error there breaks
`sudo` outright, and validating it while you still hold a working session
is the difference between a typo and a trip to the rescue console.

The tradeoff: it drops a second factor if your SSH key is stolen. But
password auth is already disabled on this image, so anyone holding the key
can read `.env` and the Docker volumes anyway — the sudo password buys
less than it looks like. Reasonable for a single-operator testnet box;
skip it if this server ever holds anything you would not want in a
key-compromise scenario.

11. Log in as `polaris` from now on:
    ```bash
    ssh -i ~/.ssh/polaris_vps polaris@polaris.mu
    ```

    If sessions drop while you work, add to `~/.ssh/config` on your Mac:
    ```
    Host polaris.mu
      ServerAliveInterval 60
    ```

**Verification:** SSH as `polaris` works; `dig polaris.mu` resolves; UFW shows 22/80/443 only.

---

# Phase 5 — Production secrets + build config (~1 hour)

**Goal:** A complete `.env` on the VPS with production-quality secrets; frontend build vars locked to production URLs.

**Steps (on the VPS as `polaris`):**

1. Clone the repo:
   ```bash
   cd ~
   git clone https://github.com/PolarisMusic/polaris-music.git
   cd polaris-music
   ```

2. Create `.env`:
   ```bash
   cp .env.example .env
   chmod 600 .env
   nano .env
   ```

3. Fill in with production-grade secrets. Generate each with `openssl rand`:
   ```
   NEO4J_PASSWORD=<openssl rand -base64 24>
   REDIS_PASSWORD=<openssl rand -base64 24>
   MINIO_ROOT_USER=polaris
   MINIO_ROOT_PASSWORD=<openssl rand -base64 24>

   # WARNING: never rotate STORAGE_ENCRYPTION_KEY once data is encrypted with it
   STORAGE_ENCRYPTION_KEY=<openssl rand -hex 32>

   INGEST_API_KEY=<openssl rand -hex 32>

   # From Phase 3
   SUBSTREAMS_API_TOKEN=<your Pinax token>
   SUBSTREAMS_ENDPOINT=jungle4.substreams.pinax.network:443

   # From Phase 2
   CHAIN_PROFILE=jungle4
   CONTRACT_ACCOUNT=polarismusic
   TOKEN_CONTRACT_ACCOUNT=polaristoken

   NODE_ENV=production
   INGEST_MODE=chain
   REQUIRE_ACCOUNT_AUTH=true
   CORS_ORIGIN=https://polaris.mu
   ```

4. Save every value into your password manager under "Polaris testnet – VPS."

5. Configure frontend build-time vars in `frontend/.env`:
   ```bash
   nano frontend/.env
   ```
   ```
   VITE_API_URL=https://api.polaris.mu/api
   VITE_GRAPHQL_URL=https://api.polaris.mu/graphql
   VITE_CHAIN_PROFILE=jungle4
   VITE_CONTRACT_ACCOUNT=polarismusic
   VITE_INGEST_MODE=chain
   ```
   **CRITICAL:** Vite bakes these into the JS bundle at build time. Get them right before Phase 6.

6. Verify the compose file parses:
   ```bash
   docker compose config > /dev/null
   ```
   Any `${VAR:?required}` errors mean a var is unset. Fix and re-run.

**Verification:** `docker compose config` exits 0; `cat .env | wc -l` shows ~15 populated lines.

---

# Phase 6 — Stack bring-up behind Caddy (~1–2 hours)

**Goal:** `https://polaris.mu` serves the frontend; `https://api.polaris.mu` serves the backend; both with valid TLS.

**Steps (on the VPS):**

1. Create `Caddyfile` (see Appendix A). Save at `~/polaris-music/Caddyfile`.

2. Create `docker-compose.prod.yml` (see Appendix B). Save at `~/polaris-music/docker-compose.prod.yml`.

3. **First attempt with Let's Encrypt staging** to avoid rate limits during setup. Edit `Caddyfile`, uncomment the `acme_ca` staging line, then:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile chain up -d
   docker compose logs -f caddy
   ```
   Watch for `certificate obtained successfully`. Cert will be **invalid in browser** (staging CA) — that's fine; we're just testing the ACME dance.

4. Switch to real Let's Encrypt — edit `Caddyfile`, comment the staging line:
   ```bash
   nano Caddyfile  # remove acme_ca line
   docker compose -f docker-compose.yml -f docker-compose.prod.yml restart caddy
   ```
   Should obtain valid certs in <60s.

5. From your Mac, verify:
   ```bash
   curl -I https://polaris.mu
   curl -I https://api.polaris.mu/health
   ```
   Both should return `HTTP/2 200` with valid cert (no `-k` needed).

6. Visit `https://polaris.mu` in a browser — frontend should load.

**Verification:** Browser shows padlock; curl with no `-k` succeeds; visualization page loads.

**Troubleshooting:**
- `cannot obtain certificate` → DNS isn't resolving from Caddy's POV. `docker compose exec caddy nslookup polaris.mu`
- Frontend loads but API calls fail → Caddyfile upstream misconfigured; confirm `reverse_proxy api:3000`
- Blank visualization page / CSP errors → dev HTML got served instead of built version; ensure `frontend/Dockerfile` (not `.dev`) is used

---

# Phase 7 — End-to-end on-chain test (~1 hour)

**Goal:** Submit a release via the public site, see it on Jungle4, see it in the graph.

**Steps:**

1. Open `https://polaris.mu` in an incognito window.

2. Click "Connect Wallet" → **CloudWallet**.

3. Create or sign into CloudWallet. Choose Jungle4 network when prompted.

4. If it's a new account, get it funded from the Jungle4 faucet.

5. Fill in a test release:
   - Release: `Smoke Test EP`
   - Label: `Test Records`
   - Group: `Test Band`
   - Track: `Track 1`

6. Submit → sign in wallet.

7. Copy the txid from the wallet success message → check at https://jungle4.bloks.io/transaction/<txid>.

8. Wait ~30 seconds for Substreams pickup.

9. Visit `https://polaris.mu/`, search "Test Band" — should appear in the graph.

10. Verify Neo4j on the VPS:
    ```bash
    docker compose exec neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" \
      "MATCH (g:Group {name: 'Test Band'}) RETURN g"
    ```

**Verification:** All of the above succeed.

**Troubleshooting:**
- Transaction signed but never in graph → check substreams-sink logs; auth error? Pinax quota?
- Wallet on wrong chain → user picked EOS mainnet; disconnect and switch to Jungle4

---

# Phase 8 — Backups + restart-on-reboot (~30 min, NOT optional)

**Goal:** Survive a VPS reboot and Neo4j volume corruption.

**Steps:**

1. Hetzner snapshots — already enabled in Phase 4. Confirm in the Hetzner UI.

2. Nightly Neo4j dumps:
   ```bash
   sudo mkdir -p /var/backups/neo4j
   sudo chown polaris /var/backups/neo4j
   ```
   Cron (`crontab -e`):
   ```
   0 3 * * * cd ~/polaris-music && docker compose exec -T neo4j neo4j-admin database dump neo4j --to-path=/var/lib/neo4j/data > /tmp/neo4j-$(date +\%F).dump.log 2>&1
   ```

3. Verify restart-on-reboot works:
   ```bash
   sudo reboot
   ```
   SSH back in after ~30s. `docker compose ps` should show services up.

4. Weekly off-VPS backups from your Mac:
   ```bash
   rsync -avz polaris@polaris.mu:/var/backups/neo4j/ ~/polaris-backups/
   ```

**Verification:** Snapshot listed in Hetzner UI; dump file exists; stack survives reboot.

---

## Inspecting Neo4j — and the tunnel hazard

The datastore ports are bound to `127.0.0.1` on the VPS, deliberately: Docker's
iptables rules bypass UFW, so an unbound port is publicly reachable no matter
what the firewall says. To browse the graph, tunnel in rather than reopening
them:

```bash
ssh -i ~/.ssh/polaris_vps -L 7474:localhost:7474 -L 7687:localhost:7687 \
  polaris@polaris.mu
```

Then open `http://localhost:7474` and connect to `bolt://localhost:7687` with
`NEO4J_PASSWORD` from the server's `.env`.

**This tunnel is for read-only inspection through Neo4j Browser. Never point a
test suite at it.**

`ssh -L` binds the forward on `::1`, while local Docker publishes on
`127.0.0.1`. Since Node 17, `dns.lookup` no longer reorders results to
IPv4-first, and on macOS `localhost` resolves `::1` ahead of `127.0.0.1` — so
with this tunnel open, `bolt://localhost:7687` reaches **production**, not your
local stack, with nothing in the output to say so. Three test suites run
`MATCH (n) DETACH DELETE n` in `beforeAll` and `beforeEach`.

This nearly happened during Phase 7. The run was stopped only by an unrelated
authentication failure, one correct password short of wiping the testnet graph.
`backend/test/graphGuard.js` now refuses those suites unless
`ALLOW_DESTRUCTIVE_GRAPH_TESTS=true` is set explicitly, and CI opts in on its
own throwaway service container.

Close the tunnel when you are done — `lsof -nP -iTCP:7687 -sTCP:LISTEN` shows
what is holding the port, and an `ssh` row there is the tunnel.

---

## Redeploying and re-ingesting a release

Use this when you have changed backend code and need the graph rebuilt from
events that are already anchored on-chain.

Each step says which machine to run it on. **Your Mac** means your own laptop.
**The VPS** means the server, after you have SSHed into it.

### Three things to know first

**The sink does not remember where it left off.** `START_BLOCK` defaults to
`-10000`, which means "10,000 blocks behind whatever the current chain head is."
Jungle4 makes two blocks a second, so that is roughly **the last 83 minutes**.
Restarting the sink replays only that window. If your release was anchored
earlier than that, nothing is re-ingested — and nothing reports an error, since
the sink streams the recent blocks correctly and simply finds no matching
events. To replay an older release you must give `START_BLOCK` a specific block
number.

**You cannot just submit the release again.** The contract rejects a duplicate
event hash (`check(hash_idx.find(hash) == hash_idx.end(), "Event hash already
exists")`). Identical bundle content always produces an identical hash, so the
transaction fails. The anchored event has to be replayed instead.

**Deploy before you replay.** The API keeps a list of already-processed event
hashes in memory. It is emptied when the API container restarts. If you replay
without restarting the API first, it answers `duplicate` and rebuilds nothing.

---

### Step 0 — Connect (your Mac)

```bash
ssh -i ~/.ssh/polaris_vps polaris@polaris.mu
cd ~/polaris-music
```

Everything from here on runs on the VPS, inside `~/polaris-music`.

The `.env` file there sets `COMPOSE_FILE` and `COMPOSE_PROFILES`, so plain
`docker compose` already includes the production overlay and the `chain`
profile. You never need `-f` flags on this machine.

### Step 1 — Deploy the new code (the VPS)

```bash
git pull
docker compose up -d --build
```

`--build` rebuilds the images from the new source. It covers the frontend as
well as the backend.

This takes a few minutes. Then check everything came back:

```bash
docker compose ps
```

Every service should show `Up`. `polaris-substreams-sink` should be there too —
if it is missing, `COMPOSE_PROFILES=chain` is not set in `.env`.

### Step 2 — Confirm the new code is actually running (the VPS)

```bash
docker compose ps --format 'table {{.Name}}\t{{.Status}}'
```

The `api` and `processor` rows should show an uptime of seconds or minutes, not
days. If they show days, the rebuild did not replace them — re-run step 1 and
read the build output for errors.

This step exists because skipping it is confusing later: a stale API produces
graph data that does not match the code you are reading.

### Step 3 — Clear the graph (the VPS)

```bash
docker compose exec api node scripts/clearGraphData.js
```

**This deletes every node and relationship in Neo4j.** That is intended here —
you are about to rebuild the graph from the anchored events, and leftover rows
from earlier code versions are exactly what you are trying to get rid of.

It needs no arguments: the API container already has `GRAPH_URI`, `GRAPH_USER`,
and `GRAPH_PASSWORD` set.

Expected output ends with `✨ Database cleared successfully!`.

### Step 4 — Find the block number of your release (the VPS)

The API logs the block number every time it ingests something:

```bash
docker compose logs api | grep ingest_start
```

Each line contains `"block_num":<number>`. Find the one for your release — if
there are several, the earliest is usually the release bundle. Note that number.

Subtract a small margin so the replay starts safely before the transaction:

```
START_BLOCK = block_num - 500
```

**If the logs have rotated** and `grep` finds nothing, look the block up on a
Jungle4 explorer instead: open `https://jungle4.eosq.eosnation.io/account/polarismusic`,
find the `put` action for your submission, and read its block number.

### Step 5 — Replay (the VPS)

```bash
START_BLOCK=<the number from step 4> docker compose up -d --force-recreate substreams-sink
```

Putting the variable in front of the command feeds it into the compose file,
which reads `${START_BLOCK:--10000}`. Substitute the actual number, for example
`START_BLOCK=195482100 docker compose up -d --force-recreate substreams-sink`.

Watch it work:

```bash
docker compose logs -f substreams-sink
```

You are looking for a line like:

```
✓ Posted 4f2a1c… block=195482613 …
```

That means the event reached the API and was accepted. A line starting
`✗ Rejected` means the API refused it — the reason is on the same line, and
`docker compose logs api` has the detail.

Press `Ctrl-C` to stop following the logs. The sink keeps running.

### Step 6 — Check the result (the VPS)

```bash
docker compose exec neo4j cypher-shell \
  -u neo4j -p "$(grep '^NEO4J_PASSWORD=' .env | cut -d= -f2-)" \
  "MATCH ()-[ir:IN_RELEASE]->() RETURN count(*) AS edges, count(ir.is_bonus) AS with_is_bonus, count(ir.track_number) AS with_track_number"
```

How to read it:

- **`edges` equals `with_is_bonus`** — good. Every release-membership edge was
  written by `processReleaseBundle`. If `with_is_bonus` is lower, something
  other than our writer created edges.
- **`with_track_number` is greater than 0** — good. The tracklist carried
  ordering.
- **`with_track_number` is 0** — the graph writer is fine; the submitted bundle
  had no track numbers. Look at the submission form next, not the backend. The
  symptom is tracks appearing in arbitrary order, not tracks going missing.

---

### If you only need recent events

When the anchor is less than about 80 minutes old, the default window already
covers it and you can skip step 4 entirely:

```bash
docker compose restart substreams-sink
```

Steps 1–3 still apply.

---

## Day-2 operations

**Backups**
- Hetzner weekly snapshots (already on)
- Nightly `neo4j-admin dump` (Phase 8 cron)
- Weekly `rsync` to your Mac
- For content you must keep, also pin to web3.storage

**Monitoring**
- `docker compose logs -f --tail 50` is your first stop
- Set `healthchecks.io` pinging `https://api.polaris.mu/health` every 10 min from your Mac's cron
- Defer Prometheus/Grafana until you have traffic worth watching

**Secret rotation**
- Passwords annually
- `INGEST_API_KEY` on suspected leak
- `STORAGE_ENCRYPTION_KEY` **never** without writing a migration

**Contract upgrades** (when you modify `contracts/polaris.music.cpp`)
- In the amd64 container: `cd /repo/contracts && ./build.sh --testnet`
- Deploy: `c set contract polarismusic build polaris.music.wasm polaris.music.abi -p polarismusic@active`
- ABI changes may break the backend reader — deploy to a second Jungle4 account first, smoke-test, then swap `CONTRACT_ACCOUNT` in `.env`

**Dependabot PRs**
- Auto-merge patch bumps
- Manual review: `neo4j` (major versions are migrations), `ipfs/kubo`, `minio`, Antelope CDT

**Pinax quota**
- Check monthly usage in the dashboard

---

## Out of scope (stop if you find yourself doing these)

- Kubernetes (`k8s/base/` manifests exist for future mainnet migration; not for testnet)
- Mainnet contract deployment
- Custom Substreams `.spkg` builds — use the Pinax-hosted default
- Multi-region / failover / load balancers
- Prometheus / Grafana / Loki observability
- Paid IPFS pinning service evaluation
- CI/CD auto-deploy to VPS (manual `git pull && docker compose up -d --build` is fine)
- The `legacy` and `ship` compose profiles — only `chain` is in scope
- Backend SSO / multi-user auth beyond `INGEST_API_KEY`

---

## Risk register

| Risk | Mitigation |
|---|---|
| Frontend baked with wrong `VITE_API_URL` | Phase 5 checklist; verify with `curl https://api.polaris.mu/health` from frontend container |
| Let's Encrypt rate limit on early TLS failures | Phase 6 staging first; gate on DNS resolution |
| Pinax token rejected (wrong chain) | Phase 3 standalone smoke test before VPS |
| Neo4j data loss on volume corruption | Phase 8 nightly dumps + Hetzner snapshots |
| `STORAGE_ENCRYPTION_KEY` accidentally rotated | Stored in password manager; documented here as DO NOT ROTATE |

---

## Appendix A — `Caddyfile` and `docker-compose.prod.yml`

Both files are committed at the repo root — use them as-is rather than
retyping. Two things about them are easy to get wrong:

**The frontend build context must be the repo root.**
`frontend/Dockerfile` does `COPY frontend/…` and `COPY shared/`, so
`context: ./frontend` cannot resolve those paths. The overlay sets
`context: .` with `dockerfile: frontend/Dockerfile`. It also sets `command`
explicitly — compose would otherwise inherit `npm run dev -- --host` from the
base file and run it against an nginx image.

**The Caddyfile is bind-mounted, so editing it does not restart Caddy.**
`docker compose up -d` sees an unchanged container spec, reports the service
as `Running`, and leaves the old config loaded with its cached certificate.
After any Caddyfile edit:

```bash
docker compose restart caddy
```

This bites hardest when switching off the ACME staging endpoint: the config
looks correct, but Caddy keeps serving the staging cert. Confirm which
issuer is actually in use:

```bash
docker compose logs caddy | grep -iE "issuer|obtain" | tail -10
```

Production reads `acme-v02.api.letsencrypt.org-directory`; staging reads
`acme-staging-v02…`. If a staging cert is stuck, clear Caddy's data volume
and let it re-issue — it holds only certificates and ACME account keys:

```bash
docker compose stop caddy && docker compose rm -f caddy
docker volume rm polaris-music_caddy_data
docker compose up -d caddy
```

---

## Appendix B — skip the `-f` flags

`caddy` is defined only in the overlay, so every compose command needs both
`-f` flags or it fails with `no such service: caddy` — including `logs`,
`restart`, and `ps`, not just `up`. Set these once in `.env` on the VPS and
bare `docker compose …` commands work everywhere:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml
COMPOSE_PROFILES=chain
```

Verify with `docker compose config --services` — `caddy` should be listed.

---

## Appendix C — Recovery runbook

**"Neo4j won't start" after a reboot**
```bash
docker compose logs neo4j | tail -50
# "store_lock" → dirty shutdown
docker compose down
docker compose up -d neo4j
# Still broken? Restore from yesterday's dump:
docker compose exec neo4j neo4j-admin database load neo4j \
  --from-path=/var/lib/neo4j/data --overwrite-destination
```

**"Caddy can't get a cert"**
```bash
docker compose logs caddy | grep -i error
docker compose exec caddy nslookup polaris.mu
# Broken? Switch to ACME staging in Caddyfile to avoid burning prod rate limits
```

**"Substreams stops receiving blocks"**
```bash
docker compose logs substreams-sink | tail -50
# Auth error → Pinax token expired
# Timeout → docker compose restart substreams-sink
# Quota exceeded → upgrade tier or wait for reset
```

**"Site loads but submission fails"**
- Browser dev tools → network tab
- 401 on POST `/api/events/create` → `INGEST_API_KEY` mismatch
- 500 with HTML body → backend crashed; `docker compose logs api`
- CORS error → `.env` `CORS_ORIGIN` doesn't include `https://polaris.mu`

---

## End-to-end verification checklist

After all phases:

1. `https://polaris.mu` loads with a valid TLS padlock (any browser)
2. `https://api.polaris.mu/health` returns `{"status":"ok"}`
3. Wallet connect → submit release → sign → tx confirms on https://jungle4.bloks.io
4. Within 30 seconds: release appears at `https://polaris.mu/`
5. VPS: `docker compose ps` — all services `(healthy)`
6. `dig polaris.mu` from anywhere resolves to VPS IP
7. `c get table polarismusic polarismusic anchors --limit 5` shows your test events

If all seven pass, you're live.
