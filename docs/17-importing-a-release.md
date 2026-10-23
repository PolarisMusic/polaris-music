# Importing a release — Discogs, Spotify, and where credits come from

How the submission form fills itself in from a link, what each source can
answer, and what it cannot.

**Status**: Discogs and Spotify imports are built. Credits from MusicBrainz are
the next piece (§4) and are not built yet.

---

## 1. One box, two kinds of link

The import panel takes a Discogs release or master URL, or a Spotify album
link, and routes on what was pasted (`normalizeListenLink` decides; a Spotify
*album* link goes to the Spotify path, anything else to the Discogs parser).
One box because it is one act — pasting the link to a record — and because
neither service carries everything:

| | Discogs | Spotify |
|---|---|---|
| Releases never distributed digitally | yes | no |
| Releases a label put out last week | often not | yes |
| Credits: performers, producers, engineers, writers | **yes** | **none at all** |
| ISRC per recording | no | yes |
| Barcode / UPC | sometimes | usually |
| Per-track artist on a compilation | yes | yes |
| Exact durations | as text | milliseconds |

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

| Field | Discogs | Spotify |
|---|---|---|
| Release name, date | `title`, `released`/`year` | `name`, `release_date` |
| Format | mapped from `formats[0].name` | always `Digital` — what a Spotify release is |
| Liner notes | `notes` | the copyright lines, which are the nearest thing |
| Labels | every `labels[]`, with catalogue numbers | `label`, one row, no number |
| Barcode | `identifiers[]` of type Barcode | `external_ids.upc` |
| Tracks | `tracklist[]`, position verbatim ("A1") | `track_number`, prefixed with the disc where there are several |
| ISRC | — | per track |
| Credits | `extraartists`, classified by `parseCredits` | — |

Durations are dropped by both: Spotify gives exact milliseconds and `Track.duration`
exists in the schema, but the form has no duration input. One field away.

## 4. Credits for a release that is only on Spotify — next

**MusicBrainz**, reached by the identifiers the Spotify import just wrote: the
UPC for the release, and the ISRC per recording where the barcode finds
nothing. Its relationships carry performers with instruments, producers,
engineers, composers and lyricists — the same credit model this registry wants
— and the client already exists here, since the genre import uses it.

That also improves a *Discogs* import, which already carries a barcode: where
Discogs' credits are thin, MusicBrainz often is not.

Not built yet. The open questions are which relationship types map to
`MEMBER_OF` rather than `GUEST_ON` (the same judgement `parseCredits` makes for
Discogs, where MusicBrainz is more explicit about it), and the one request per
second they ask for.
