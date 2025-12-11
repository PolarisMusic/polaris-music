# Graph Visualization Specification - Beatles White Album Example

This document shows how the Beatles White Album release (from `03-event-storage.md`) is ingested into the Neo4j graph database and how it should be visualized using the JavaScript InfoVis Toolkit (JIT).

## Overview

When a CREATE_RELEASE_BUNDLE event is processed, the event processor transforms the nested JSON structure into a graph of interconnected nodes and relationships. This document maps the Beatles example to its graph representation.

## Data Flow

```
Event Storage (JSON)
        ↓
Event Processor (backend/src/indexer/eventProcessor.js)
        ↓
Graph Database (Neo4j via backend/src/graph/schema.js)
        ↓
API Layer (GraphQL/REST)
        ↓
Frontend Visualization (JIT RGraph/Hyperbolic)
```

## Node Types Created

From the Beatles White Album example, the following node types are created:

### Summary Statistics
- **1 Release** node ("The Beatles" / White Album)
- **1 Master** node (since `master_release: [true, null]`)
- **3 Label** nodes (Apple Records, EMI Records, Capitol Records)
- **2 City** nodes (London, Los Angeles)
- **4 Person** nodes (John Lennon, Paul McCartney, George Harrison, George Martin)
- **1 Group** node (The Beatles)
- **3 Track** nodes (Back in the U.S.S.R., Dear Prudence, Glass Onion - example shows 3 of 30)
- **3 Song** nodes (one for each track's composition)
- **Multiple Role** nodes (Lead Vocals, Bass Guitar, Electric Guitar, etc.)
- **1 Claim** node (audit trail for this submission)
- **1 Account** node (the blockchain account that submitted)

**Total:** ~20-30 nodes for this subset (full album would have ~70-100 nodes)

## Complete Node Examples

### 1. Release Node

```cypher
(:Release {
  release_id: "generated-hash-for-white-album",
  release_name: "The Beatles",
  release_altnames: ["The White Album"],
  release_date: date("1968-11-22"),
  release_format: ["LP"],
  liner_notes: "Lorem ipsum",
  status: "final",
  created_at: datetime("2025-12-11T..."),
  updated_at: datetime("2025-12-11T...")
})
```

---

### 2. Person Nodes

#### Paul McCartney
```cypher
(:Person {
  person_id: "d36547078b701635a7412...",
  person_name: "Paul McCartney",
  person_altnames: [],
  status: "final"
})
```

---

### 3. Group Node

```cypher
(:Group {
  group_id: "875a968e0d079c90766544...",
  group_name: "The Beatles",
  group_altnames: ["The Fab Four"],
  status: "final"
})
```

---

### 4. Track Node

```cypher
(:Track {
  track_id: "8d0b789a634ac54...",
  title: "Back in the U.S.S.R.",
  listen_link: [
    "https://open.spotify.com/track/0j3p1p06deJ7f9xmJ9yG22",
    "https://music.apple.com/us/song/back-in-the-u-s-s-r/1441133197"
  ],
  status: "final"
})
```

---

## Key Relationships

### Group Membership (MEMBER_OF)

**Person → Group** (not Person → Track!)

```cypher
(:Person {person_name: "Paul McCartney"})-[:MEMBER_OF {
  from_date: null,
  to_date: null,
  created_at: datetime()
}]->(:Group {group_name: "The Beatles"})
```

### Performance (PERFORMED_AS)

**Person → Track** with group context

```cypher
(:Person {person_name: "Paul McCartney"})-[:PERFORMED_AS {
  group_id: "875a968e0d079c90766544...",
  created_at: datetime()
}]->(:Track {title: "Back in the U.S.S.R."})
```

### Roles (HAS_ROLE)

**Person → Role** for specific track

```cypher
(:Person {person_name: "Paul McCartney"})-[:HAS_ROLE {
  track_id: "8d0b789a634ac54..."
}]->(:Role {role_name: "Lead Vocals"})

(:Person {person_name: "Paul McCartney"})-[:HAS_ROLE {
  track_id: "8d0b789a634ac54..."
}]->(:Role {role_name: "Bass Guitar"})
// ... 6 more roles for Paul on this track
```

---

## Visual Graph Structure

```
                    ┌────────────────────────────────┐
                    │         Release                │
                    │      "The Beatles"             │
                    │    (White Album, 1968)         │
                    └─┬────────┬─────────┬───────────┘
                      │        │         │
         RELEASED ┌───┘        │         └───┐ RELEASED
                  │            │             │
          ┌───────▼──────┐    │    ┌────────▼───────┐
          │    Label      │    │    │     Label      │
          │Apple Records  │    │    │Capitol Records │
          │  (London)     │    │    │     (LA)       │
          └───────────────┘    │    └────────────────┘
                               │
                    RELEASED ──┘
                               │
                       ┌───────▼────┐
                       │   Label    │
                       │EMI Records │
                       │  (London)  │
                       └────────────┘
                               │
                   IN_RELEASE  │ IN_RELEASE
                       ┌───────┼───────┐
                       │       │       │
             ┌─────────▼──┐ ┌──▼─────┐ ┌──▼──────┐
             │   Track    │ │ Track  │ │ Track   │
             │Back in the │ │  Dear  │ │  Glass  │
             │  U.S.S.R.  │ │Prudence│ │  Onion  │
             └─┬──────┬───┘ └┬───┬───┘ └┬───┬────┘
               │      │      │   │      │   │
  RECORDING_OF │      │      │   │      │   │
               │      │      │   │      │   │
          ┌────▼──┐   │ ┌────▼┐  │ ┌────▼┐  │
          │ Song  │   │ │Song │  │ │Song │  │
          │(Back) │   │ │(Dear│  │ │Glass│  │
          └───┬───┘   │ └──┬──┘  │ └──┬──┘  │
              │       │    │     │    │     │
              │ WROTE │    │WROTE│    │WROTE│
              │       │    │     │    │     │
  ┌───────────┴───────┼────┴─────┼────┴─────┼──────┐
  │           PERFORMED_AS PERFORMED_AS PERFORMED_AS│
  │                   │          │          │       │
┌─▼───┐          ┌────▼───┐ ┌───▼───┐ ┌────▼────┐  │
│John │          │ Paul   │ │George │ │ George  │  │
│Lennon◄─────────┤McCartny│ │Harriso│ │ Martin  │  │
└──┬──┘MEMBER_OF └───┬────┘ └───┬───┘ └────┬────┘  │
   │                 │          │          │        │
   │ MEMBER_OF       │ MEMBER_OF│          │        │
   │                 │          │          │        │
   └─────────────────┼──────────┘          │        │
                     │                     │        │
                ┌────▼────┐                │        │
                │  Group  │◄───────────────┘        │
                │   The   │    PRODUCED             │
                │ Beatles │─────────────────────────┘
                └────┬────┘
              PERFORMED_ON
                     │
              (all 3 tracks)
```

---

## Complete Relationship Summary

| Relationship | From | To | Properties | Count |
|--------------|------|-----|------------|-------|
| `IN_MASTER` | Release | Master | - | 1 |
| `RELEASED` | Release | Label | `date` | 3 |
| `IN_RELEASE` | Release | Track | `disc_side`, `track_number` | 3 |
| `BASED_IN` | Label | City | - | 3 |
| `SUBSIDIARY_OF` | Label | Label | - | 1 |
| `RECORDING_OF` | Track | Song | - | 3 |
| `PERFORMED_ON` | Group | Track | - | 3 |
| `WROTE` | Person | Song | `roles` | 6 |
| `PRODUCED` | Person | Track | - | 3 |
| `MEMBER_OF` | Person | Group | `from_date`, `to_date` | 3 |
| `PERFORMED_AS` | Person | Track | `group_id` | 9 |
| `HAS_ROLE` | Person | Role | `track_id` | ~60 |
| `FROM_CITY` | Person | City | - | 4 |

**Total:** ~100 relationships

---

## Cypher Query for Complete Visualization Data

```cypher
MATCH (r:Release {release_id: $releaseId})
OPTIONAL MATCH (r)-[:IN_MASTER]->(m:Master)
OPTIONAL MATCH (r)-[:RELEASED]->(l:Label)
OPTIONAL MATCH (l)-[:BASED_IN]->(lc:City)
OPTIONAL MATCH (r)-[ir:IN_RELEASE]->(t:Track)
OPTIONAL MATCH (t)-[:RECORDING_OF]->(s:Song)
OPTIONAL MATCH (p:Person)-[:WROTE]->(s)
OPTIONAL MATCH (prod:Person)-[:PRODUCED]->(t)
OPTIONAL MATCH (g:Group)-[:PERFORMED_ON]->(t)
OPTIONAL MATCH (perf:Person)-[:PERFORMED_AS]->(t)
OPTIONAL MATCH (perf)-[:MEMBER_OF]->(g)
OPTIONAL MATCH (perf)-[:HAS_ROLE {track_id: t.track_id}]->(role:Role)
OPTIONAL MATCH (perf)-[:FROM_CITY]->(pc:City)
RETURN r, m, l, lc, t, s, p, prod, g, perf, role, pc, ir
ORDER BY ir.disc_side, ir.track_number
```

---

## Query for Member Participation (RGraph Sizing)

```cypher
// Calculate participation percentage for each group member
MATCH (r:Release {release_id: $releaseId})
MATCH (r)-[:IN_RELEASE]->(t:Track)
WITH r, count(t) as totalTracks

MATCH (g:Group {group_id: $groupId})
MATCH (p:Person)-[:MEMBER_OF]->(g)
OPTIONAL MATCH (p)-[:PERFORMED_AS]->(t:Track)<-[:IN_RELEASE]-(r)
WITH g, p, totalTracks, count(DISTINCT t) as tracksPerformed
RETURN g.group_name as group,
       p.person_name as member,
       p.person_id as memberId,
       tracksPerformed,
       totalTracks,
       (tracksPerformed * 100.0 / totalTracks) as participationPercent
ORDER BY participationPercent DESC
```

**Result for Beatles:**
```
group: "The Beatles"
member: "John Lennon", memberId: "347a746...", participated: 3/3, percent: 100%
member: "Paul McCartney", memberId: "d365470...", participated: 3/3, percent: 100%
member: "George Harrison", memberId: "2c689b9...", participated: 3/3, percent: 100%
```

---

## API Response Format for Visualization

```json
{
  "release": {
    "release_id": "generated-hash-for-white-album",
    "release_name": "The Beatles",
    "release_altnames": ["The White Album"],
    "release_date": "1968-11-22",
    "master": {
      "master_id": "same-as-release-id",
      "master_name": "The Beatles"
    },
    "labels": [
      {
        "label_id": "57230498f3982de...",
        "label_name": "Apple Records",
        "city": {"city_name": "London", "lat": 51.50735, "lon": -0.12776}
      }
    ]
  },
  "tracks": [
    {
      "track_id": "8d0b789a634ac54...",
      "title": "Back in the U.S.S.R.",
      "disc_side": 1,
      "track_number": 1,
      "song": {
        "title": "Back in the U.S.S.R.",
        "songwriters": [
          {"person_name": "Paul McCartney", "roles": ["Lyrics", "Songwriter"]},
          {"person_name": "John Lennon", "roles": ["Songwriter"]}
        ]
      },
      "producers": [
        {"person_name": "George Martin"}
      ],
      "groups": [
        {
          "group_id": "875a968e0d079c90766544...",
          "group_name": "The Beatles",
          "members": [
            {
              "person_id": "d36547078b701635a7412...",
              "person_name": "Paul McCartney",
              "participation_percent": 100.0,
              "roles_on_track": [
                "Lead Vocals", "Backing Vocals", "Bass Guitar",
                "Drum Kit", "Percussion", "Handclaps",
                "Electric Guitar", "Piano"
              ],
              "viz_color": "#E94B3C"
            },
            {
              "person_id": "347a746e8c9606f78978fd...",
              "person_name": "John Lennon",
              "participation_percent": 100.0,
              "roles_on_track": [
                "Backing Vocals", "Electric Guitar", "Drum Kit",
                "Percussion", "Handclaps", "Bass Guitar"
              ],
              "viz_color": "#4A90E2"
            },
            {
              "person_id": "2c689b96a8960e79f0d...",
              "person_name": "George Harrison",
              "participation_percent": 100.0,
              "roles_on_track": [
                "Backing Vocals", "Electric Guitar", "Drum Kit",
                "Percussion", "Handclaps", "Bass Guitar"
              ],
              "viz_color": "#6BC47D"
            }
          ]
        }
      ]
    }
  ]
}
```

---

## Visualization Guidelines

### RGraph (Radial Graph) - For Group View

**Purpose:** Show group members with participation sizing

**Layout:**
- **Center:** Group node ("The Beatles")
- **Ring:** Member nodes positioned radially
- **Node Size:** Proportional to `participation_percent`
- **Edge Color:** Deterministic hash of `person_id + group_id`
- **Edge Thickness:** Could represent collaboration intensity

**Example:**
```
         John Lennon (100%)
               ⬤
              /
             /  (blue edge)
            /
    ┌─────────────┐
    │             │
    │  The        │
    │  Beatles    │
    │             │
    └─────────────┘
            \
             \  (red edge)
              \
               ⬤
         Paul McCartney (100%)
```

### Hyperbolic Tree - For Release View

**Purpose:** Show complete release hierarchy

**Levels:**
1. **Root:** Release
2. **Level 1:** Tracks (30 nodes)
3. **Level 2:** Groups performing + Songwriters + Producers
4. **Level 3:** Group members
5. **Level 4:** Roles (expandable)

**Interaction:**
- Click node to focus/zoom
- Hover to show details
- Color-code by node type:
  - Release: Purple
  - Track: Blue
  - Group: Green
  - Person: Orange
  - Role: Gray

---

## Color Generation Algorithm

For consistent Person-Group edge colors:

```javascript
function generatePersonGroupColor(personId, groupId) {
  const combined = personId + groupId;
  const hash = SHA256(combined);
  const hue = parseInt(hash.substring(0, 8), 16) % 360;
  return `hsl(${hue}, 70%, 50%)`;
}
```

This ensures:
- Same Person-Group pair always gets same color
- Different pairs get different colors
- Colors are visually distinct

---

## Implementation Checklist

- [ ] Set up JIT library
- [ ] Create RGraph component for group view
- [ ] Create Hyperbolic Tree component for release view
- [ ] Implement color generation algorithm
- [ ] Implement participation-based sizing
- [ ] Add click handlers for node expansion
- [ ] Add hover tooltips with details
- [ ] Connect to API endpoints
- [ ] Test with full 30-track Beatles data
- [ ] Add export to SVG/PNG
- [ ] Performance optimization for large releases
- [ ] Accessibility (keyboard navigation)

---

## References

- **Event Storage:** `/docs/03-event-storage.md`
- **Graph Schema:** `/docs/02-graph-database-schema.md`
- **JIT Docs:** http://philogb.github.io/jit/
- **Neo4j Cypher:** https://neo4j.com/docs/cypher-manual/current/

---

**Version:** 1.0
**Created:** 2025-12-11
**Purpose:** Bridge backend graph structure and frontend visualization
**Status:** Ready for implementation
