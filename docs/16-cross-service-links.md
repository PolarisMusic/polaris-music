# Cross-Service Links — what a recording is called everywhere else

How a submission acquires the identifiers and the per-service links that let
the same recording be found on another platform, what is built, and what is
blocked on which third party.

**Status**: built end to end. Odesli granted this deployment a key on
2026-10-21, so one request now returns Apple Music, Tidal, YouTube Music,
Amazon Music, Deezer and SoundCloud together (§3). The keyless Deezer lookup
stays as the provider that answers when no key is configured. A release with no
usable barcode is found by artist and title and accepted on its tracklist
(§1), which is what the chain used to stop dead on. §4 is the history of
getting here, kept because it is the reason the design is a provider table
rather than one integration.

---

## 1. The chain, as it runs today

```
paste a Discogs URL
  → Discogs release (api.discogs.com, from the browser)
      → tracklist, labels, credits, barcode
  → POST /api/spotify/album {links, upc, artist, album}
      → a Spotify link the submitter pasted           → that album
      → else barcode    ──▶ search upc:…              → album, verified
      → else artist+title ──▶ search album:… artist:… → up to 3 candidates
          → full album + full tracks for each
              → UPC (the release) and an ISRC per track
  → match Spotify's tracklist to the form's, by title
      → candidates: accept one only if the tracklists agree
      → per-track listen link, ISRC, and Spotify's spelling where it differs
```

One click. The submitter presses *Fetch Data* and the form fills in.

**Three ways in, in descending order of what they prove.** Discogs carries no
streaming ids of any kind, so nothing here is a shared key; what differs is how
much each route has to be trusted.

A **link** the submitter pasted is a statement about which release they mean,
and it is taken at its word.

A **barcode** is the next best thing, and the usual one after a Discogs import.
The UPC on the sleeve is the UPC in Spotify's `external_ids`, and it names the
*edition* rather than the music, which is the precision wanted: a different
pressing is a different row in this registry. A barcode match is accepted only
when the album Spotify returns carries that same barcode itself
(`resolveAlbumByUpc` in `backend/src/api/routes/spotify.js`). A search hit is
Spotify's word that the barcode matched, not evidence of it: search returns
*simplified* album objects, which carry no `external_ids` at all. The full album
does, so that is what gets checked — an unverified match would attach a whole
tracklist of links, codes and titles to the wrong edition, silently.

The **artist and title** are the last resort, and the only route a release with
no barcode has. See below: the name only proposes, and the tracklist decides.

### When there is no barcode

Which is often. Nothing was printed on a sleeve before the mid-80s, and plenty
of Discogs entries for later pressings have left the field blank or filled it
with `none`, a catalogue number or a price code. Until 2026-10-21 the chain
simply stopped there: the form sent no request, printed no report, and said
nothing at all, which from the submitter's side is indistinguishable from the
feature being broken. That silence is what two "it didn't work" reports on
2026-10-21 came down to, and it is the reason the no-barcode case now always
produces a message of its own, whether or not the fallback below finds
anything. (The other way to land in the same place: a CD barcode that is not
the digital UPC Spotify files the album under, which is the normal state of a
reissued record and dead-ended at "no release under that barcode" with a
perfectly findable album one search away.)

A title and an artist cannot identify a release: they are two strings two
community databases spell differently, which is the guesswork
`frontend/src/utils/tracklistDiff.js` exists to referee. So the search is used
for what it can do — *propose* — and the acceptance test is evidence the form
already holds, namely the imported tracklist. Eleven titles agreeing in order is
not something two unrelated releases do.

Mechanically: the endpoint returns up to three candidates with their full
tracklists and **no verdict** (`matched_by: "name"`, `candidates`, no `album`),
and `chooseAlbumByTracklist` in the browser accepts one only if

- it accounts for at least three quarters of the form's titles, and at least
  three of them (so a one-track form cannot be matched by a greatest-hits
  package that happens to carry that track), and
- the form accounts for at least as much of the candidate as it leaves
  unexplained (so a thirty-track compilation carrying four of these songs is
  not this album), and
- no second candidate explains the tracklist equally well, unless the two are
  the same list of recordings — two editions of one record are not a choice,
  while two different records scoring alike are a coin toss and are refused.

Ties on the first test are broken by the tightest fit, so a standard edition
wins over the deluxe reissue that contains it. Titles are compared with the
same tolerance used for filling in links: edition suffixes discounted, one edit
per ten characters.

A refusal is reported with the rejected front-runner named and linked —
"Spotify's closest release by name is *X*, which accounts for 4 of this form's
11 tracks" — because that is something a submitter can act on, where "no match"
is not. A name match that is accepted says so in the report too, along with
whether the barcode was missing or simply not in Spotify's catalogue; a filled
field with no visible basis is the thing to avoid.

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

**Unless this app may not use it.** Measured on this deployment on 2026-10-22,
with credentials Spotify accepts and an album lookup that answers 200:

```
200  /tracks/4KqudHCw4rafIQeijpFxZp            isrc: QM9AA1922066
403  /tracks?ids=4KqudHCw4rafIQeijpFxZp
200  /tracks/4KqudHCw4rafIQeijpFxZp?market=US  isrc: QM9AA1922066
403  /tracks?ids=4KqudHCw4rafIQeijpFxZp&market=US
```

Only the batch form is refused; the market makes no difference; the 403 carries
no explanation; and `GET /v1/tracks` is not on Spotify's published list of
restricted endpoints, so there is nothing to read but the measurement. So
`getTracks` tries the batch form, remembers a 403 for the life of the process,
and asks for each track singly instead — eleven requests for an album rather
than one, which is a poor trade against one request and a fine one against
losing every ISRC. Only a 403 triggers it: answering a 429 with fifty more
requests would be the worst possible response to being rate-limited.

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

`/search` is worth calling out separately: it is the endpoint both the barcode
shortcut and the name fallback need, and the one an app in development mode is
most likely to be refused for. Album links keep working when it is refused;
only the one-click Discogs path stops. A 403 from it comes back as
`search_unavailable` rather than a 502, and the second search is not attempted
once the first has been refused — the refusal is a property of the credentials,
so it would be refused identically.

---

## 2. What is recorded

| Field | Where it lands | Notes |
|---|---|---|
| `track.isrc` | `Track.isrc` | Hidden form field; preferred provisional id |
| `track.alt_titles` | `Track.alt_titles` | Spotify's spelling, when it differs |
| `track.listen_links` | `Track.listen_links` | Only ever fills an empty field |
| `release.barcode` | `Release.barcode` | Digits only; also the MusicBrainz key |

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

### 3.1 Odesli, with a key

```
each track's Spotify link ──POST /api/links/resolve {tracks}──▶ provider table
      → odesli:  GET api.song.link/v1-alpha.1/links?url=…&key=…
          → apple, tidal, youtubeMusic, youtube, amazonMusic, deezer,
            soundcloud, pandora — all from one request
      → deezer:  the keyless fallback, for a deployment with no key
  → every link appended to the track, and the album to the release
```

Odesli resolves by **link**, not by code, which is why the request carries both
an ISRC and a URL per row. That suits the registry: the Spotify link a
submission holds was itself matched by barcode or by title under the rules in
`tracklistDiff.js`, so resolving from it inherits that match rather than making
a new guess. Nothing is ever matched by name.

Three things about the service are set by the grant rather than by the code,
and all three are environment variables, so correcting one needs no release:
`ODESLI_API_KEY`, `ODESLI_API_BASE` (they announced v1-alpha.1's retirement) and
`ODESLI_REQUESTS_PER_MINUTE` (the keyless tier was 10; a key raises it). They go
in the deployment's own `.env`, which compose reads, and take effect when the
container is **re-created** — `docker compose up -d api`, not `restart`, which
keeps the environment the container was created with. A 401 is reported as *the
key is not being accepted* rather than as an outage, because keyless access is
retired and with a key configured there is no other reading — and a rejected key
stops the batch rather than spending the rate limit proving the point once per
track.

**Blank is not a value.** Every optional setting in `docker-compose.yml` is
written `- FOO=${FOO:-}`, so that compose does not refuse to start over one
nobody set — which puts it in the container as an *empty string* rather than
leaving it out. `??` reads that as configured and the code's default never
applies, so `ODESLI_API_BASE` arrived empty, `${this.apiBase}/links` became a
relative URL, and every lookup threw `Failed to parse URL` with a correctly
installed key sitting right there. `MUSICBRAINZ_USER_AGENT` had the same shape
and sent the one header MusicBrainz refuses. Both failed only in a container: a
developer running the same code with the line commented out in `.env` gets the
default and sees nothing wrong. Settings read through
`utils/envSetting.js`, which treats blank and whitespace as unset and trims what
it returns — a key pasted out of an email with a trailing newline is the same
key, and sending it unmodified is a 401 that reads as the wrong key.

**Store pages are not listen links.** `itunes`, `amazonStore` and `googleStore`
come back in the same response and are deliberately dropped: the field is
called listen_links, and a purchase page is a different claim about a
recording.

**Everything stored is parsed.** Apple, Amazon and both YouTubes keep the thing
being linked to in a *query parameter*, so `utils/listenLinks.js` grew a
per-service parser — a path-only read turns every Apple track link into its
album and collapses every song on a record into one identity. Apple's slug is
dropped (it changes when a title is edited) and its storefront is kept in the
URL but left out of the identity (the same recording in two storefronts is one
recording). Pandora is the one service left unparsed: its links are slugs with
no id to key on, so they are stored tracking-stripped and work, just without
deduplication.



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

## 4. How this got here: Odesli went away, then came back

The plan was Odesli (song.link): give it one platform's URL, get back the same
recording on Apple Music, Deezer, Tidal, YouTube Music and others. One request
per track, no per-service credentials. That is what §3.1 now does — with a key,
granted 2026-10-21 after a request. What follows is why the key mattered, and
why the thing built around it is a table of providers rather than one
integration.

**Keyless access was retired.** Linktree, which owns Songlink/Odesli, announced the sunset
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

An access request was sent to Odesli on 2026-10-17 and **granted on
2026-10-21**. It is one more provider in the table, not the thing the table
depends on: with no key configured it drops out of the answer and the keyless
Deezer lookup carries on alone. That is the shape the retirement argued for,
and it survives the next one.

### 4.1 What is left, per service

| Service | Lookup by ISRC | What it needs | Verdict |
|---|---|---|---|
| *(all of them)* | — Odesli, by link | an API key, granted 2026-10-21 | **Built.** `api/odesliClient.js` |
| Deezer | `GET api.deezer.com/track/isrc:{isrc}` | nothing | **Built**, and the fallback with no key |
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

- **A name match is never written back.** The album a name search resolved to is
  not recorded as such, so a later import of the same release repeats the
  search and the comparison. Storing the Spotify album id on the `Release`
  would make it a one-time cost, and would also give the player an embed for
  releases matched this way.
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

# Odesli needs the key, and answers 401 without one.
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://api.song.link/v1-alpha.1/links?url=https%3A%2F%2Fopen.spotify.com%2Ftrack%2F0Fl6Pl6w89IL1FWt8Uvg01&key=$ODESLI_API_KEY"
#   200 → the key works
#   401 → the key is missing, wrong, or not yet active
#   410 → the namespace moved; set ODESLI_API_BASE

# Through our own endpoint, which is what the form uses. `providers` says who
# was asked, `services` what came back:
curl -s -X POST http://127.0.0.1:3000/api/links/resolve \
  -H 'Content-Type: application/json' \
  -d '{"tracks":[{"isrc":"USSM17900123","url":"https://open.spotify.com/track/0Fl6Pl6w89IL1FWt8Uvg01"}]}'
#   {"success":true,"links":{…},"services":["apple","deezer",…],"providers":["odesli","deezer"]}
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
