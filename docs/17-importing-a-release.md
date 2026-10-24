# Importing a release — Discogs, Spotify, Bandcamp, and where credits come from

How the submission form fills itself in from a link, what each source can
answer, and what it cannot.

**Status**: Discogs, Spotify and Bandcamp imports are built. Credits from
MusicBrainz are the next piece (§5) and are not built yet.

---

## 1. One box, three kinds of link

The import panel takes a Discogs release or master URL, a Spotify album link,
or a Bandcamp album or track page, and routes on what was pasted
(`normalizeListenLink` decides). One box because it is one act — pasting the
link to a record — and because no service carries everything:

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

Both paths share the decisions that are about music rather than about a
payload — who the "Various" placeholder is, which act performed a track, when a
track stops inheriting the release's credit — in `utils/discogsArtists.js`.
Spotify says those things in its own words (`album_type: "compilation"`, artist
id `0LyfQWJT6nXafLPZqxe9Of`, `tracks[].artists`), and that module speaks both
dialects. See docs/02, "A compilation is credited to its tracks, not to a band".

They do **not** share a populate function. Mapping Spotify into the Discogs
payload shape would invent companies, `extraartists` and format descriptions
that Spotify does not have.

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

Durations are dropped by all three: Spotify gives exact milliseconds, Bandcamp
a float of seconds, and `Track.duration` exists in the schema — but the form
has no duration input. One field away, and now two sources deep.

Bandcamp also states two things nothing else here does and nothing yet reads:
`publisher.foundingLocation` (where the band is from — the registry has an
origin city for Persons, Labels and guests, but the form has no field for a
*Group's*) and `keywords`, the artist's own genre tags, which wait on the
bundle growing a genres field.

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
