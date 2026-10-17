# Cross-Service Links — what a recording is called everywhere else

How a submission acquires the identifiers and the per-service links that let
the same recording be found on another platform, what is built, and what is
blocked on which third party.

**Status**: the Spotify half is built and tested; §1 describes what it does.
The "every other service" half is not started, and not for want of effort —
the API everybody used for it was retired in July 2026. §3 is the evidence and
the options that remain.

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

### Deployment caveat: /search and development mode

The barcode step is the only part of this that uses `/search`. A Spotify app
still in development mode can be refused there, and the refusal is a property
of the credentials rather than of the request, so the endpoint reports it as
`reason: 'search_unavailable'` with an explanation rather than as a server
fault. If the form says *"Spotify refused the barcode search for this app"*,
that is this: the album link still works, and the app's quota mode is the thing
to change.

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

## 3. The other services: Odesli is gone

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

Verified from this container: nothing. Outbound access to api.song.link and
api.deezer.com is blocked by the dev environment's network policy, so the
status above is from the announcement and from third-party reports, not from a
request. **Before building any of §3.1, run the one-line check for that
provider on the VPS, where egress is real.**

### 3.1 What is left, per service

| Service | Lookup by ISRC | What it needs | Verdict |
|---|---|---|---|
| Deezer | `GET api.deezer.com/2.0/track/isrc:{isrc}` | nothing | The only keyless option. Build first. |
| Apple Music | `/v1/catalog/{storefront}/songs?filter[isrc]=` | developer token (ES256 JWT, paid account) | Same credential MusicKit playback needs — see §4 of `13-user-onboarding.md` |
| Tidal | `filter[isrc]` on its v2 API | OAuth client credentials | Free developer app, but another secret to hold |
| YouTube Music | none | YouTube Data API key, then a *search* | No identifier path exists; a search is a guess |
| MusicBrainz | ISRC → recording | nothing | Has the ISRC, rarely has streaming URLs |

The shape this wants is a provider table — one function per service, each
independently configured and independently skippable — rather than one resolver
with a hard dependency. That is also what makes a retirement survivable: the
Odesli lesson is that a single aggregator is a single point of failure for
every service at once.

Rate limits matter more than the code. Deezer allows roughly 50 requests per 5
seconds per IP, so a fourteen-track album is one modest burst. Odesli's keyless
tier was ~10 requests per minute, which was never going to fill a tracklist in
one click — another reason the aggregator was the wrong shape for this.

### 3.2 Why bother, given the listen link already works

Because a Spotify URL is one service's address for a recording, and a visitor
who does not use Spotify gets a dead end. The ISRC is already being recorded
(§2), which means the expensive half — getting the identifier into the
registry, verified, at submission time — is done. Resolving it to other
services can happen later, in a batch job, without re-asking the submitter
anything.

---

## 4. Open

- **Release barcode.** The UPC is fetched, used, and thrown away. It identifies
  the pressing, which is exactly what a `Release` node is. Adding it means a
  property, a schema entry in both copies, a normalizer line and a doc row.
- **Per-track resolution for one service** (Deezer, per §3.1) as a batch job
  over `Track.isrc`, not as another call in the submission path.
- **Apple Music** is the one worth the credential, because the same developer
  token answers both this and playback — see the parked section in
  `13-user-onboarding.md`.

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
