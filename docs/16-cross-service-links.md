# Cross-Service Links — what a recording is called everywhere else

How a submission acquires the identifiers and the per-service links that let
the same recording be found on another platform, what is built, and what is
blocked on which third party.

**Status**: the Spotify chain is built (§1), and so is the first other
service: Deezer, by ISRC, needing no credentials (§3). Apple Music, Tidal and
YouTube Music each wait on one credential or on a lookup path that does not
exist; §4.1 says which. Odesli, which would have answered for all of them at
once, is gone — measured, not assumed (§4).

---

## 1. The chain, as it runs today

```
paste a Discogs URL
  → Discogs release (api.discogs.com, from the browser)
      → tracklist, labels, credits, barcode
  → barcode  ──POST /api/spotify/album {upc}──▶  Spotify search upc:…
      → album id → full album + full tracks
          → UPC (the release) and an ISRC per track
  → match Spotify's tracklist to the form's, by title
      → per-track listen link, ISRC, and Spotify's spelling where it differs
```

One click. The submitter presses *Fetch Data* and the form fills in.

**The barcode is the bridge.** Discogs carries no streaming ids of any kind, so
the alternative is matching on artist and title — two strings that two
community databases spell differently, which is the guesswork
`frontend/src/utils/tracklistDiff.js` exists to referee. The UPC on the sleeve
is the UPC in Spotify's `external_ids`, and it names the *edition* rather than
the music, which is the precision wanted: a different pressing is a different
row in this registry.

A barcode match is only accepted when the album Spotify returns carries that
same barcode itself (`resolveAlbumByUpc` in `backend/src/api/routes/spotify.js`).
A search hit is Spotify's word that the barcode matched, not evidence of it:
search returns *simplified* album objects, which carry no `external_ids` at
all. The full album does, so that is what gets checked — an unverified match
would attach a whole tracklist of links, codes and titles to the wrong edition,
silently.

**Two codes, not one.** A UPC names the release; an ISRC names each recording on
it. Matching an album by one of its tracks' ISRCs finds whichever release that
recording also appears on, which for a hit single is a compilation nobody asked
about. The ISRC is the more valuable of the two here: `prov:track:isrc:{isrc}`
is the registry's first choice of provisional track id, ahead of anything
derived from a title, and it is the key every other catalogue can be asked
about the same recording with.

Neither of Spotify's album endpoints returns an ISRC — both return *simplified*
track objects with no `external_ids` at all — so it costs one extra request per
fifty tracks, from the full-track endpoint.

### When the form says the check is unavailable

There are four distinct ways for this to fail and they want four different
fixes. Until 2026-10-17 they all reached the submitter as one sentence — "The
Spotify check is unavailable" — because the route answered 502 and the
sanitizer strips the message out of a 5xx body. Each now comes back as its own
reason, with the fix in the text:

| What the form says | reason | Fix |
|---|---|---|
| …not configured on this server | `not_configured` | Set `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` |
| Spotify rejected this server's credentials (HTTP …) | `credentials_rejected` | They are set but wrong, revoked, or from another app |
| Spotify refused the request for this app (HTTP 403) | `request_refused` | App is in development mode; request extended quota |
| This server could not reach Spotify | `unreachable` | Container egress or DNS, not credentials |
| Spotify is rate-limiting this server | `rate_limited` | Wait |

Anything else is still a 502, because anything else really is this server
failing at its job. That body carries an `errorId`, which the form now shows,
and it matches a line in the api log.

To find out which without reading logs, from inside the container that holds
the credentials:

```bash
docker compose exec api node scripts/checkSpotify.js
```

It walks the same four steps the client walks — token, album, full tracks,
barcode search — and names the fix for whichever one fails. It prints the
credentials as lengths and a last-four fingerprint, never the values.

`/search` is worth calling out separately: it is the only endpoint the barcode
shortcut needs and the one an app in development mode is most likely to be
refused for. Album links keep working when it is refused; only the one-click
Discogs path stops.

---

## 2. What is recorded

| Field | Where it lands | Notes |
|---|---|---|
| `track.isrc` | `Track.isrc` | Hidden form field; preferred provisional id |
| `track.alt_titles` | `Track.alt_titles` | Spotify's spelling, when it differs |
| `track.listen_links` | `Track.listen_links` | Only ever fills an empty field |
| album UPC | *nowhere yet* | No Release property holds a barcode |

The first two have no visible field on the form, because neither is something a
submitter types. Both are dropped if the title is edited afterwards — they were
resolved against the title as it stood, and an ISRC pointing at the wrong
recording is worse than no ISRC, since it is the key everything else is matched
by. The report under the Listen Links block says what was attached, and the
curation panel shows it per track, because those are the only two places a
human can see it.

A near-match on title fills the link and records the other spelling; an exact
match records nothing, because edition noise is not a spelling. "Lithium -
Remaster" normalizes to a match, and writing that into the registry as a title
somebody printed would fill it with catalogue cruft.

---

## 3. And then the other services

```
each track's ISRC  ──POST /api/links/resolve {isrcs}──▶  provider table
      → deezer:  GET api.deezer.com/track/isrc:{isrc}
      → (apple, tidal: unconfigured, so not asked and not named)
  → links appended to each track's listen-links field, keyed by ISRC
```

Appended, never replacing: a Spotify link and a Deezer link for the same
recording both belong on the track. De-duplication is on normalized identity,
so a locale-prefixed Deezer link with a share token does not get added beside
its plain twin — which is why `frontend/src/utils/listenLinks.js` now knows
Deezer's URL forms, including the bare two-letter locale segment (`/en/track/…`)
that Spotify writes as `/intl-de/`.

This runs *after* the tracklist report is rendered. It is a second round of
requests to another service, and the comparison — the part a submitter is
waiting on — should not sit behind it.

Failures are quiet by design. A recording Deezer does not have is the common
case, not an error: a 1981 B-side is frequently absent from a streaming
catalogue entirely. A provider that throws costs only that provider; a
provider with no credentials is not asked and does not appear in the
`services` list, so a caller can tell "Deezer has not got it" from "Deezer was
never asked".

---

## 4. Where the other services stand: Odesli is gone, Deezer is in

The plan was Odesli (song.link): give it one platform's URL, get back the same
recording on Apple Music, Deezer, Tidal, YouTube Music and others. One request
per track, no per-service credentials.

**It was retired.** Linktree, which owns Songlink/Odesli, announced the sunset
of the public API on 2026-05-21 with a retirement date of 2026-07-31, and
stopped issuing API keys. Reports from early October 2026 are that keyless
calls now answer 401; one API aggregator recorded a 200 as late as 2026-08-12,
so the shutdown may be staged rather than clean. Either way it cannot be built
on: an integration whose provider has announced its own removal is a dependency
with a known expiry.

**Measured from the production host on 2026-10-17**, since the dev container's
egress to both hosts is blocked by policy:

```
$ curl -s -o /dev/null -w '%{http_code}\n' \
    "https://api.song.link/v1-alpha.1/links?url=https%3A%2F%2Fopen.spotify.com%2Ftrack%2F0Fl6Pl6w89IL1FWt8Uvg01"
401

$ curl -s "https://api.deezer.com/2.0/track/isrc:USSM17900123"
{"error":{"type":"DataException","message":"no data","code":800}}
```

So: Odesli refuses an unauthenticated request outright, and Deezer answers one
without credentials. The Deezer body there is a *miss* — that ISRC was made up
— and its shape is the one `deezerClient.js` reads: HTTP 200 with an `error`
object and no `id`. A client trusting the status code would take it for a hit.

An access request was sent to Odesli on 2026-10-17; if a key arrives it becomes
one more provider in the table rather than the thing the table depends on.

### 4.1 What is left, per service

| Service | Lookup by ISRC | What it needs | Verdict |
|---|---|---|---|
| Deezer | `GET api.deezer.com/track/isrc:{isrc}` | nothing | **Built.** `api/deezerClient.js` |
| Apple Music | `/v1/catalog/{storefront}/songs?filter[isrc]=` | developer token (ES256 JWT, paid account) | Same credential MusicKit playback needs — see §4 of `13-user-onboarding.md` |
| Tidal | `filter[isrc]` on its v2 API | OAuth client credentials | Free developer app, but another secret to hold |
| YouTube Music | none | YouTube Data API key, then a *search* | No identifier path exists; a search is a guess |
| MusicBrainz | ISRC → recording | nothing | Has the ISRC, rarely has streaming URLs |

The shape is a provider table — one client per service, each independently
configured and independently skippable — rather than one resolver with a hard
dependency. That is what makes a retirement survivable, and it is the Odesli
lesson: a single aggregator is a single point of failure for every service at
once. Adding a provider means a client with `isConfigured()` and
`tracksByIsrcs()`, and one line in `createLinkRoutes`.

Odesli's keyless tier was ~10 requests per minute, which was never going to
fill a tracklist in one click — another reason the aggregator was the wrong
shape for this, quite apart from its retirement.

Concurrency, not rate limits, is what the code worries about: Deezer allows
roughly 50 requests per 5 seconds per IP, and this server has one IP for every
submitter, so lookups run four at a time rather than as one burst per album.

### 4.2 Why bother, given the listen link already works

Because a Spotify URL is one service's address for a recording, and a visitor
who does not use Spotify gets a dead end. The ISRC is already being recorded
(§2), which means the expensive half — getting the identifier into the
registry, verified, at submission time — is done. Resolving it to other
services can happen later, in a batch job, without re-asking the submitter
anything.

---

## 5. Open

- **Release barcode.** The UPC is fetched, used, and thrown away. It identifies
  the pressing, which is exactly what a `Release` node is. Adding it means a
  property, a schema entry in both copies, a normalizer line and a doc row.
- **Backfill**: every `Track` already holding an ISRC predates this and has no
  Deezer link. The resolver is a POST with a list of ISRCs, so a backfill is a
  query for `Track.isrc` plus an ADD_CLAIM per answer — no submitter involved.
- **Apple Music** is the one worth the credential, because the same developer
  token answers both this and playback — see the parked section in
  `13-user-onboarding.md`.

---

## Verifying it on a deployment

```bash
# Deezer needs no credentials, so this works on any host with egress.
curl -s "https://api.deezer.com/track/isrc:USSM17900123" | head -c 200; echo
#   {"error":…,"code":800}  → reachable, that ISRC is simply not in Deezer
#   {"id":…,"title":…}      → reachable, and a hit

# Through our own endpoint, which is what the form uses:
curl -s -X POST http://127.0.0.1:3000/api/links/resolve \
  -H 'Content-Type: application/json' \
  -d '{"isrcs":["USSM17900123"]}'
#   {"success":true,"links":{…},"services":["deezer"]}
```

---

## Sources

- Linktree, *Sunsetting the Songlink (Odesli) public API* — announced
  2026-05-21, retirement 2026-07-31; no new API keys.
- Reports of keyless 401s, October 2026:
  <https://github.com/eeegoloauq/music-bot/issues/7>,
  <https://github.com/VictorNain26/AubeSonore/pull/221> (which moved to
  per-platform lookups for the same reason).
- Odesli listing recording a 200 on 2026-08-12:
  <https://jentic.com/apis/odesli.co/odesli>.
