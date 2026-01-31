# Polaris Identity and Merge Protocol v1.0

## Overview

This document defines the canonical identity management system for Polaris Music Registry.

**Core Principle**: Identity is stable. Facts about identity are claims.

Edits change claims, not IDs.

## The Problem

Using hash-of-fields as permanent IDs creates merge hell:
- Typo fixes change the ID
- Canonicalization changes the ID
- Alias resolution changes the ID
- Result: constant manual merges

## The Solution

**Two-tier ID system**:
1. **Canonical IDs (CID)** - Stable forever, field-independent
2. **Provisional IDs (PID)** - Temporary during import, can be merged

## ID Types

### Canonical ID (CID)

Permanent, stable identifier that never changes.

**Format**: `polaris:{type}:{uuid}`

**Examples**:
```
polaris:person:550e8400-e29b-41d4-a716-446655440000
polaris:group:7c9e6679-7425-40de-944b-e07fc1f90ae7
polaris:release:123e4567-e89b-12d3-a456-426614174000
```

**Generation**: UUIDv4 (random) or UUIDv7 (time-sortable)

**Rules**:
- Created only by explicit MINT_ENTITY event
- Never changes, even if all attributes change
- Used everywhere once established

### Provisional ID (PID)

Temporary identifier used during import before identity is confirmed.

**Format**: `prov:{type}:{hash}`

**Examples**:
```
prov:person:a3f5b2c1d4e6f7a8
prov:group:1234567890abcdef
prov:track:fedcba0987654321
```

**Generation**: SHA256 hash of fingerprint (first 16 chars)

**Rules**:
- Used when importing data before knowing if entity exists
- Allowed to collide (false positives are fine)
- Must eventually be:
  - Resolved to a CID (via RESOLVE_ID event), or
  - Merged into another CID (via MERGE_ENTITY event), or
  - Promoted to a new CID (via MINT_ENTITY event)

### External ID

Reference to an entity in an external system.

**Format**: `{source}:{type}:{id}`

**Examples**:
```
discogs:artist:12345
musicbrainz:artist:5b11f4ce-a62d-471e-81fc-a69a8278c7da
isni:person:0000000121032683
wikidata:person:Q937
```

**Usage**: Stored in IdentityMap to resolve to canonical IDs

## Fingerprints

Fingerprints generate provisional IDs. They're deterministic but not identity.

### Person Fingerprint
```javascript
{
    type: 'person',
    name: normalizeName(name),  // lowercase, trim, remove "The", etc.
    birth_year: birthYear       // optional
}
```

### Group Fingerprint
```javascript
{
    type: 'group',
    name: normalizeName(name)
}
```

### Song Fingerprint
```javascript
{
    type: 'song',
    title: normalizeName(title),
    writer: normalizeName(primaryWriter)  // optional
}
```

### Track Fingerprint
```javascript
{
    type: 'track',
    title: normalizeName(title),
    release: releaseId,
    position: trackNumber
}
```

### Release Fingerprint
```javascript
{
    type: 'release',
    title: normalizeName(title),
    date: releaseDate,
    catalog: catalogNumber  // optional
}
```

## Events

### MINT_ENTITY (new)

Creates a new canonical node with a permanent ID.

**Payload**:
```javascript
{
    entity_type: "person" | "group" | "song" | "track" | "release" | "master" | "label",
    canonical_id: "polaris:{type}:{uuid}",  // generated client or server-side
    initial_claims: [                        // optional
        { property: "name", value: "The Beatles", confidence: 1.0 }
    ],
    provenance: {
        source: "manual" | "import" | "ai_suggested",
        submitter: "account.name",
        evidence: "..."
    }
}
```

### RESOLVE_ID (new)

Maps a provisional or external ID to a canonical ID.

**Payload**:
```javascript
{
    subject_id: "prov:person:a3f5b2c1" | "discogs:artist:12345",
    canonical_id: "polaris:person:550e8400-...",
    method: "manual" | "import" | "ai_suggested" | "authority_source",
    confidence: 0.95,
    evidence: {
        matched_fields: ["name", "birth_year"],
        external_url: "https://discogs.com/artist/12345"
    }
}
```

### MERGE_ENTITY (updated)

Declares two or more entities are the same. Rewires edges and preserves claims.

**Payload**:
```javascript
{
    survivor_id: "polaris:person:550e8400-...",
    absorbed_ids: [
        "polaris:person:123e4567-...",
        "prov:person:fedcba09"
    ],
    evidence: "Same person, different spellings. Verified via ISNI.",
    strategy: {
        rewire_edges: true,
        move_claims: true,
        tombstone_absorbed: true
    }
}
```

**Semantics**:
- All edges pointing to absorbed IDs are rewired to survivor
- All claims from absorbed entities attach to survivor with provenance
- Absorbed nodes marked as MERGED with `merged_into` pointer
- Operation is reversible via SPLIT_ENTITY (future)

## Identity Resolution

### External ID Mapping

IdentityMap nodes store mappings:

```cypher
CREATE (im:IdentityMap {
    key: "discogs:artist:12345",
    source: "discogs",
    external_type: "artist",
    external_id: "12345",
    canonical_id: "polaris:person:550e8400-...",
    confidence: 1.0,
    created_by: "importer",
    created_at: datetime(),
    evidence: "Direct Discogs artist ID match"
})
```

**Key constraint**: `im.key` is unique

**Indexes**: source, external_id, canonical_id

### Authority Hierarchy

When multiple external IDs conflict, use this priority:

1. **MusicBrainz** - Highest authority for music data
2. **ISNI / VIAF / Wikidata** - International authority files
3. **Discogs** - Community-curated music database
4. **Spotify / Apple Music** - Streaming service IDs (less stable)
5. **Name matching** - Last resort, requires high confidence

### Resolution Flow

```
1. Check if external ID has IdentityMap entry → use canonical ID
2. Generate provisional ID from fingerprint
3. Check if provisional ID exists in graph → reuse
4. Otherwise create new provisional node
5. Later: human or AI resolves PID → CID via RESOLVE_ID event
```

## Node Status

Every entity has a status field:

- **ACTIVE** (default) - Normal, usable entity
- **MERGED** - Tombstone redirecting to survivor
- **PROVISIONAL** - Not yet confirmed as canonical

**Query rule**: Only show ACTIVE nodes in UI

## Claims vs Identity

Entities have minimal fields:

```javascript
{
    id: "polaris:person:550e8400-...",  // REQUIRED
    type: "Person",                      // REQUIRED (label)
    status: "ACTIVE",                    // REQUIRED
    display_name: "Paul McCartney",     // CACHED (best-guess for UI)
    created_at: "2024-01-15T...",       // REQUIRED
    merged_into: null,                  // for tombstones
    absorbed_count: 0                   // for survivors
}
```

Everything else is a Claim:

```cypher
CREATE (claim:Claim {
    claim_id: "...",
    property: "name",
    value: "James Paul McCartney",
    confidence: 1.0,
    source: "musicbrainz",
    submitted_by: "importer",
    submitted_at: datetime(),
    event_hash: "..."
})-[:CLAIMS_ABOUT]->(person)
```

## Implementation Checklist

- [x] ID Service (backend/src/identity/idService.js)
- [x] IdentityMap schema constraints
- [x] Merge operations (backend/src/graph/merge.js)
- [ ] MINT_ENTITY event handler
- [ ] RESOLVE_ID event handler
- [ ] MERGE_ENTITY event handler (update existing)
- [ ] Update processReleaseBundle to use PIDs
- [ ] API endpoints for /identity/mint, /identity/resolve, /identity/merge
- [ ] Update graph queries to filter status != MERGED
- [ ] Update visualization to show only ACTIVE entities

## Migration Strategy

### For Existing Data

1. **Generate canonical IDs** for all existing entities
2. **Update all references** from old IDs to new canonical IDs
3. **Create IdentityMap entries** for any external IDs
4. **Set status = ACTIVE** for all entities

### Script Outline

```javascript
// For each entity type
for (const node of existingNodes) {
    // Generate canonical ID
    const cid = IdentityService.mintCanonicalId(node.type);

    // Update node
    node.id = cid;
    node.status = 'ACTIVE';

    // If it had an external ID, create mapping
    if (node.discogs_id) {
        createIdentityMapping({
            source: 'discogs',
            externalId: node.discogs_id,
            canonicalId: cid
        });
    }
}
```

## Testing Scenarios

### Scenario 1: Import from Discogs

1. Fetch release from Discogs API
2. For each artist:
   - Check IdentityMap for `discogs:artist:{id}`
   - If found, use canonical ID
   - If not, generate PID from fingerprint
   - Create provisional Person/Group node
3. Later: admin resolves PID → CID via RESOLVE_ID

### Scenario 2: Manual Merge

1. User identifies duplicates: "The Beatles" and "Beatles"
2. User selects survivor
3. System creates MERGE_ENTITY event
4. Merge operation rewires all edges
5. "Beatles" becomes tombstone → "The Beatles"

### Scenario 3: Import Conflict

1. Import creates `prov:person:abc123` for "John Lennon"
2. Later import creates `prov:person:def456` for "John Winston Lennon"
3. System suggests merge (based on name similarity)
4. Admin approves → MERGE_ENTITY event
5. One becomes canonical, other becomes alias

## API Examples

### Mint a new entity

```http
POST /api/identity/mint
{
    "entity_type": "person",
    "initial_claims": [
        { "property": "name", "value": "Paul McCartney" }
    ],
    "provenance": {
        "source": "manual",
        "submitter": "alice.polaris"
    }
}

Response:
{
    "canonical_id": "polaris:person:550e8400-...",
    "status": "ACTIVE"
}
```

### Resolve external ID

```http
POST /api/identity/resolve
{
    "source": "discogs",
    "external_type": "artist",
    "external_id": "12345",
    "canonical_id": "polaris:person:550e8400-...",
    "confidence": 1.0,
    "submitter": "alice.polaris"
}

Response:
{
    "key": "discogs:artist:12345",
    "canonical_id": "polaris:person:550e8400-...",
    "status": "mapped"
}
```

### Merge entities (event-sourced)

In **chain mode** (production), merges follow the standard event-sourced pipeline.
Direct mutation via `POST /api/identity/merge` is disabled; use the prepare → sign → anchor flow:

```http
# Step 1: Prepare a MERGE_ENTITY event
POST /api/events/prepare
{
    "v": 1,
    "type": "MERGE_ENTITY",
    "author_pubkey": "PUB_K1_...",
    "created_at": 1700000000,
    "parents": [],
    "body": {
        "survivor_id": "polaris:person:550e8400-...",
        "absorbed_ids": ["polaris:person:123e4567-..."],
        "evidence": "Same person, typo in second entry",
        "submitter": "alice.polaris"
    },
    "proofs": { "source_links": [] }
}

Response:
{
    "success": true,
    "hash": "abc123...",
    "normalizedEvent": { ... }
}

# Step 2: Client signs the normalizedEvent with their wallet key
# Step 3: Store the signed event
POST /api/events/create
{ ...signedEvent, "expected_hash": "abc123..." }

# Step 4: Client anchors on-chain (7 args: author, type, hash, event_cid, parent, ts, tags)
# event_cid is the IPFS CID from the /api/events/create response (required for IPFS-based ingestion)
# cleos push action polaris put '["alice.polaris", 60, "abc123...", "bafy...", null, 1700000000, []]' -p alice.polaris

# Step 5: Substreams → /api/ingest/anchored-event → handleMergeEntity applies merge
```

In **dev mode** (`INGEST_MODE=dev`), `POST /api/identity/merge` is available for convenience:

```http
POST /api/identity/merge
{
    "survivor_id": "polaris:person:550e8400-...",
    "absorbed_ids": ["polaris:person:123e4567-..."],
    "evidence": "Same person, typo in second entry",
    "submitter": "alice.polaris"
}

Response:
{
    "success": true,
    "eventHash": "abc123...",
    "merge_result": {
        "absorbedCount": 1,
        "edgesRewired": 47,
        "claimsMoved": 12,
        "tombstonesCreated": 1
    }
}
```

## Hard Rules

### Rule 1: Never use hash-of-fields as permanent ID

Hashes are for provisional IDs only. Canonical IDs must be field-independent.

### Rule 2: Edits change claims, not identity

If you fix a typo in "Paul McCarteny" → "Paul McCartney", create/update a claim. Don't change the ID.

### Rule 3: External IDs are strongest authority

If Discogs says artist 12345 = "The Beatles", trust it unless proven wrong.

### Rule 4: Merges are recorded, not deleted

Never delete an entity. Mark it MERGED and preserve provenance.

### Rule 5: Only show ACTIVE entities in UI

Provisional and merged entities should be filtered out of public views.

---

**Version**: 1.0
**Last Updated**: 2025-12-27
**Status**: Implementation in progress
