# Importing a release — Discogs, Spotify, Bandcamp, and where credits come from

How the submission form fills itself in from a link, what each source can
answer, and what it cannot.

**Status**: Discogs, Spotify and Bandcamp imports are built. Credits from
MusicBrainz are the next piece (§5) and are not built yet.

---

## 1. One box, three kinds of link

The import panel takes a Discogs release or master URL, a Spotify album link,
or a Bandcamp album or track page, and routes on what was pasted. One box
because it is one act — pasting the link to a record — and because no service
carries everything:

| | Discogs | Spotify | Bandcamp |
|---|---|---|---|
| Releases never distributed digitally | yes | no | no |
| Releases a label put out last week | often not | yes | yes, and preorders months ahead |
| Releases on no other service at all | — | — | **this is the case it answers** |
| Credits: performers, producers, engineers, writers | **yes, structured** | **none at all** | free text, unparsed |
| ISRC per recording | no | yes | no |
| Barcode / UPC | sometimes | usually | rarely (`current.upc`, usually null) |
| Per-track artist on a compilation | yes | yes | sometimes, and unverified — see §4 |
| Exact durations | as text | milliseconds | seconds, as a float |

Bandcamp is in here for the catalogue the other two do not have: self-released
records, small-label records, and anything a band put up themselves and never
distributed. It is also the only one of the three with no API at all.

Routing is three different questions, because the three links are not alike.
`normalizeListenLink` recognises a Spotify *album* link, because a Spotify URL
carries a service, a type and an id. `discogsClient.extractReleaseId` pulls the
release or master number out of a Discogs URL. A Bandcamp URL has no id in it
at all — the slug is the title, and the numeric ids live in the page — so
`isBandcampLink` answers on the host alone and the server decides whether the
page is really a release. That looseness is deliberate: a stricter test would
turn a readable error into a dead end, and it cannot be made strict anyway,
since Bandcamp lets a label point its own domain at a store and no rule over a
URL can tell that from any other website. Pasting the `bandcamp.com` address of
the same record works.

## 2. Spotify has no credits. None.

Not "sparse", not "sometimes": the Web API has no endpoint for them. No
songwriter, producer, engineer or instrument credit is reachable, and the
proposed `/v1/songwriter/{id}` paths in their community threads are a
developer's wishlist rather than anything Spotify published. The credits panel
in their apps is fed by an internal client endpoint, announced in 2018 and
never exposed.

So a Spotify import arrives **complete in structure and empty of people**: the
release, its label, its barcode, every track with its number, ISRC and listen
link, and the act named on each track — with every Performing Groups section
empty. The status line says so after the import, because an empty section
inside a collapsed track row is not a message.

What it does carry is the pair of identifiers that make the gap fillable: the
**UPC** for the release and an **ISRC** per recording.

## 3. What each import writes

All three share the decisions that are about music rather than about a
payload — who the "Various" placeholder is, which act performed a track, when a
track stops inheriting the release's credit — in `utils/discogsArtists.js`.
Spotify says those things in its own words (`album_type: "compilation"`, artist
id `0LyfQWJT6nXafLPZqxe9Of`, `tracks[].artists`), Bandcamp barely says them at
all, and that module speaks all three dialects. See docs/02, "A compilation is credited to its tracks, not to a band".

They do **not** share a populate function. Mapping Spotify or Bandcamp into the
Discogs payload shape would invent companies, `extraartists` and format
descriptions that neither has.

Bandcamp needs that shared module for a reason the others do not: it publishes
**no compilation flag of any kind**. There is no `album_type`, no format
description, nothing — so the only signals are the act being a Various Artists
placeholder and the tracks disagreeing with it, and the placeholder has to count
on its own. A Various Artists page whose tracks name nobody would otherwise
arrive with "Various Artists" written into the form as though it were a band.
It arrives instead with no release act and a note saying how many tracks still
need one.

| Field | Discogs | Spotify | Bandcamp |
|---|---|---|---|
| Release name, date | `title`, `released`/`year` | `name`, `release_date` | `name`, `datePublished` |
| Format | mapped from `formats[0].name` | always `Digital` — what a Spotify release is | `Digital`, or `Single` for a track page; see §4 |
| Liner notes | `notes` | the copyright lines, which are the nearest thing | `creditText` and `description`, verbatim |
| Labels | every `labels[]`, with catalogue numbers | `label`, one row, no number | `recordLabel`, or nothing for a self-released record |
| Barcode | `identifiers[]` of type Barcode | `external_ids.upc` | `current.upc`, usually null |
| Tracks | `tracklist[]`, position verbatim ("A1") | `track_number`, prefixed with the disc where there are several | `position` from the `ItemList` |
| ISRC | — | per track | — |
| Credits | `extraartists`, classified by `parseCredits` | — | free text only, to liner notes |
| Album art | withheld — see below | `images[0].url`, largest first | `image` / the player's `art_id` |
| Photo of the act | `/artists/{id}`, server-side | `/artists`, one extra request | `publisher.image` |
| Photo of a person | **the only source** — one request each | none — no artist page | none |

Durations are dropped by all three: Spotify gives exact milliseconds, Bandcamp
a float of seconds, and `Track.duration` exists in the schema — but the form
has no duration input. One field away, and now two sources deep.

### Photos of acts and people

The registry has had somewhere to put these all along — `photo` on Group and
Person, drawn on the node itself, shown in the info panel with an editable
Photo URL row, and returned on every search result — and nothing had ever
written one from a submission.

**Bandcamp** supplies a band photo for free. `publisher.image` is the band's own
page image, and `publisher` is the block `labelFrom` already reads for the
label name while throwing the picture away. No extra request.

**Spotify** supplies one for an extra request. The artist objects hanging off
an album are *simplified* — id, name, uri — and carry no images, so the photo
needs `/v1/artists`. Batched, with the same retreat `/tracks?ids=` needed:
this app is served a 403 on that batch endpoint while the single-id form
works, and nothing says `/artists?ids=` is treated differently. **Unverified
against the live app** — the fallback is written and tested, but which branch
this app actually takes can only be seen on a deployment.

**Discogs is the only source for photos of individual people**, and since it
needs a token it needs a server — see below. Spotify has artist images, and a
session drummer has no Spotify artist page; Bandcamp has one image per band
page. Discogs files a person and a band as the same kind of thing, so a band's
page names its members and each of those is an artist page with a photograph
of a human on it.

### Discogs images need a token, so the artist call moved to the server

**Discogs serves no `images` to an unauthenticated request.** Everything else
about Discogs works from the browser — api.discogs.com sends CORS headers,
which is why the tracklist import runs there — but a browser cannot hold a
credential, because the bundle is public.

So the artist call moved: `POST /api/discogs/artist` takes an artist id and
answers with the act's own photo and its members with theirs. The roster rides
along, because `fetchDiscogsRoster` was already making that exact call for the
membership list, so one request now answers both.

A **release** cover is still not available this way, and is not worth another
request: Spotify and Bandcamp already supply one, and
`populateFormFromDiscogs` reads `images[]` for the day a token makes it
possible.

Three things about the shape of it:

- **A photo per person costs a request.** A member entry carries an id and no
  images, so each one is another artist page. A five-piece band is six
  requests, capped at twenty-four members so an orchestra cannot spend a
  minute's whole budget on one import; the rest arrive without pictures, which
  is what they would have had anyway.
- **Without a token it still answers.** `members` is public, and the roster is
  what distinguishes a band member from a session player. Only the photographs
  are lost, and the response says `configured: false` so an empty photo field
  can be explained rather than just being empty.
- **The browser's own call is kept as a fallback.** If the route is missing or
  unreachable, the roster still comes back the old way — without pictures. An
  import that works slightly worse beats one that fails outright.

The rate limit is now **shared**: 60 requests a minute against the server's
token, rather than 25 against each visitor's own IP. For a handful of
submitters that is a straight gain; with twenty at once it is a queue, and
Discogs limits the token rather than the caller. The import reads
`images[]` anyway — preferring the `primary` shot, since a secondary is the
back, an insert or a photo of the vinyl — so that adding a token later needs no
change here.

The first source to supply a cover keeps it. A Discogs import chains straight
into a Spotify lookup, so two sources touch the same form in sequence; and a
submitter who typed one keeps it over both. What is stored is a URL on somebody
else's CDN, not a copy, so it will eventually rot — pinning the image the way
events are pinned is the real answer and is not built.

Bandcamp also states two things nothing else here does and nothing yet reads:
`publisher.foundingLocation` (where the band is from — the registry has an
origin city for Persons, Labels and guests, but the form has no field for a
*Group's*) and `keywords`, the artist's own genre tags, which wait on the
bundle growing a genres field.

### A track's line-up is read whether or not the act changed

Two separate reasons a track does not inherit the release's credit, and the
import used to check only one.

The **act** can differ — a compilation names it per track. The **line-up** can
differ while the act does not, which is what an ensemble or session record is:
"San Diego Sessions" credits bass, drums, guitar, keyboards, organ and
percussion under every track, eleven players across seven tracks, all of them
Ellis Munk Ensemble.

None of that was read. The whole per-track credit block sat behind
`overridesReleaseCredit`, a compilation's signal, so a single-act record never
entered it. Every track inherited the release line-up, which on that record was
the two people credited with mixing and recording it, and the players were
dropped silently — seven identical tracklists in the submitted JSON.

Either signal is now enough. The act still comes from
`trackPerformers`, so reading a track's roster does not invent an act per
track; and the compilation note's counters still move only when the act
differs, since a track reading its own roster has said nothing about who the
act is.

### Two catalogues, two tracklists

Neither Discogs nor Spotify is authoritative, so differences are reported
rather than corrected. Two rules keep that report worth reading:

**An insertion is one fact, not one per track.** A streaming release of a live
record carries the between-song banter as tracks of its own. The songs are all
present and all in order, and every position after the first interlude is off
by one — which came out as a separate mismatch per track: nine differences and
a count line for the single fact that Spotify has two extra tracks. When the
shorter tracklist runs through the longer one in order, only the extra tracks
are named.

**A trailing character is forgiven from eight characters up.** The general
tolerance is one edit per ten characters of the shorter title, which gives an
eight-character title none — so "Super Fx" against "Super Fxx" was reported as
a different song and no link was filled. A tail is weaker evidence of a
different song than an edit in the middle of one, since it cannot turn a word
into another word. Guarded three ways: the shared part must be eight
characters, the tail at most two, and it must not be a digit, because "Disc 1"
and "Disc 10" are a prefix pair and are not the same thing. Six characters
still buy nothing, so "Lithiu" and "Lithium" stay a reported difference.

A near match is still *reported*, as a spelling difference — the link gets
filled and the submitter is told the two catalogues disagree.

## 4. Bandcamp publishes no API, and its page is not an interface

There is no Bandcamp catalogue API. Their developer programme is an artist's
own sales and orders, with no album endpoint; every "Bandcamp API" you can find
is a third-party scraper. So `api/bandcampClient.js` reads the public page, and
the page carries two structures:

- **schema.org JSON-LD** — a `MusicAlbum` with `byArtist`, `datePublished`,
  `albumRelease`, `creditText`, `keywords` and an `ItemList` of tracks.
- **the embedded player data** — `data-tralbum`, carrying `current`,
  `packages` and `trackinfo`.

Neither is a published, versioned interface, and either can change without
notice. So the parser takes whichever of the two supplies each field, returns
`null` for anything neither carries, and returns `null` for the whole page
rather than a half-filled album. `scripts/checkBandcamp.js` fetches a real
album and prints what each structure offered; run it when an import stops
working, and `--raw` dumps the structures before interpretation.

Four things about the page are not what they look like. Three were found by
running that script against a live album, having written the parser blind:

**`publisher` is not the label.** It is the band whose page it is, so on an
act's own page it is the act. Reading it as the label gave "Watermelon" a label
called *Howlin Rain* for a record **Silver Current Records** put out. A real
label is stated outright — `recordLabel` on a release, `label` on a package —
and both appear only when the selling band differs from the page's own.
`publisher` is the label in exactly one shape: an album hosted on a *label's*
page, where the page owner is the label and `byArtist` is somebody else.

**Most tracks have no page of their own.** Only some do; the rest are listed
with an `@id` of the album URL plus a `#t4` fragment. That is the album page,
so using it as a track's listen link pointed six of that album's nine tracks at
the same address. A track that really has a page says so in `mainEntityOfPage`
and in the player's `title_link`, and both are absent for the others.

**An album page is several releases.** `albumRelease` and `packages` carry the
vinyl, the CD, the test pressing and the digital album together. In this
registry those are *separate* Releases — format is part of the release
fingerprint precisely so a CD does not MERGE onto the LP it was remastered
from — so the page maps to its digital release and the editions it sells
alongside come back in `other_editions` for the submitter to see.

**A preorder lists tracks that do not exist yet.** `duration: 0` and
`unreleased_track: true`, with no duration in the JSON-LD. The titles are real
and the tracklist is complete, so it imports; the durations come back `null`
rather than zero. Expect a release date in the future.

The one field never seen on a live page is the **per-track act** on a
compilation (`item.byArtist` / `trackinfo[].artist`). It is parsed, null-safe,
and unverified: on a single-act record both are null, which is correct, so only
a label sampler pasted through `checkBandcamp.js` will settle whether those are
the right names.

### Credits on Bandcamp are free text

`creditText` is a block the artist typed. It is often *better* than Discogs —
the Watermelon page names every player and their instruments, who engineered,
mixed and mastered, and the songwriters of all nine covers — but it has no
structure at all: no roles, no per-person fields, no per-track attachment.

It goes to liner notes verbatim. People are not invented from it. Guessing
`MEMBER_OF` out of prose is exactly the kind of approximation a registry that
claims precision on credits cannot make, and a human reading those lines into
the form is the correct cost.

## 5. Credits for a release that is only on Spotify — next

**MusicBrainz**, reached by the identifiers the Spotify import just wrote: the
UPC for the release, and the ISRC per recording where the barcode finds
nothing. Its relationships carry performers with instruments, producers,
engineers, composers and lyricists — the same credit model this registry wants
— and the client already exists here, since the genre import uses it.

That also improves a *Discogs* import, which already carries a barcode: where
Discogs' credits are thin, MusicBrainz often is not.

It will help a **Bandcamp** import least, and that is worth saying plainly: a
Bandcamp page rarely carries a UPC and never an ISRC, so the lookup would fall
back to matching on name and date — the weakest kind of match, and the one most
likely to attach the wrong record's credits. For a self-released album
MusicBrainz probably has nothing anyway. Bandcamp's own free-text credits,
read by a human, remain the best source for exactly the catalogue Bandcamp is
here to cover.

Not built yet. The open questions are which relationship types map to
`MEMBER_OF` rather than `GUEST_ON` (the same judgement `parseCredits` makes for
Discogs, where MusicBrainz is more explicit about it), and the one request per
second they ask for.
