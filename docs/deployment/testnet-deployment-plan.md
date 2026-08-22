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
- ⏳ **Phase 4** — VPS provisioning + DNS *(you are here)*
- ⏳ Phase 5 — Production secrets
- ⏳ Phase 6 — Stack bring-up behind Caddy
- ⏳ Phase 7 — End-to-end on-chain test
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

9. Verify Neo4j got the anchor row:
   ```bash
   docker-compose exec neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" \
     "MATCH (e:Event) RETURN count(e) as count"
   ```
   Should return at least 1.

**Verification:** sink logs show your `put` action processed; Neo4j has a new Event node.

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
   curl -I https://api.polaris.mu/api/health
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

9. Visit `https://polaris.mu/visualization.html`, search "Test Band" — should appear in the graph.

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

## Day-2 operations

**Backups**
- Hetzner weekly snapshots (already on)
- Nightly `neo4j-admin dump` (Phase 8 cron)
- Weekly `rsync` to your Mac
- For content you must keep, also pin to web3.storage

**Monitoring**
- `docker compose logs -f --tail 50` is your first stop
- Set `healthchecks.io` pinging `https://api.polaris.mu/api/health` every 10 min from your Mac's cron
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
| Frontend baked with wrong `VITE_API_URL` | Phase 5 checklist; verify with `curl https://api.polaris.mu/api/health` from frontend container |
| Let's Encrypt rate limit on early TLS failures | Phase 6 staging first; gate on DNS resolution |
| Pinax token rejected (wrong chain) | Phase 3 standalone smoke test before VPS |
| Neo4j data loss on volume corruption | Phase 8 nightly dumps + Hetzner snapshots |
| `STORAGE_ENCRYPTION_KEY` accidentally rotated | Stored in password manager; documented here as DO NOT ROTATE |

---

## Appendix A — `Caddyfile`

Save at `~/polaris-music/Caddyfile` on the VPS:

```caddyfile
# Uncomment for first attempt to avoid Let's Encrypt rate limits.
# Comment out once Caddy successfully completes the ACME dance.
# {
#   acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
# }

polaris.mu {
    encode gzip
    reverse_proxy frontend:80
}

api.polaris.mu {
    encode gzip
    reverse_proxy api:3000
}
```

---

## Appendix B — `docker-compose.prod.yml`

Save at `~/polaris-music/docker-compose.prod.yml` on the VPS:

```yaml
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - polaris-network

  # Build production frontend (multi-stage, not Dockerfile.dev)
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    restart: unless-stopped
    expose:
      - "80"

  api:
    restart: unless-stopped
    expose:
      - "3000"

  neo4j:
    restart: unless-stopped
  redis:
    restart: unless-stopped
  ipfs:
    restart: unless-stopped
  minio:
    restart: unless-stopped

volumes:
  caddy_data:
  caddy_config:
```

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
2. `https://api.polaris.mu/api/health` returns `{"status":"ok"}`
3. Wallet connect → submit release → sign → tx confirms on https://jungle4.bloks.io
4. Within 30 seconds: release appears at `https://polaris.mu/visualization.html`
5. VPS: `docker compose ps` — all services `(healthy)`
6. `dig polaris.mu` from anywhere resolves to VPS IP
7. `c get table polarismusic polarismusic anchors --limit 5` shows your test events

If all seven pass, you're live.
