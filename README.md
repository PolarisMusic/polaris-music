# Polaris Music Registry - Complete Documentation

## Overview

Polaris is a decentralized, visualized music registry built on blockchain technology. It provides a canonical, auditable registry of music creators, releases, tracks, and compositions. All information is submitted in the form of projects, which are the core collaborative event used. Projects are things like Album releases, Album rereleases, EP releases, Single releases, documented live performances, and other auditable artifacts of musical creation.

The project uses:
Javascript InfoVis Toolkit (JIT) - https://github.com/philogb/jit
Antelope Blockchain Framework    - https://github.com/antelopeIO
Wharfkit Antelope integration    - https://github.com/wharfkit
GQL-compliant Cypher by Neo4j    - https://github.com/neo4j/neo4j
IPFS decentralized storage       - https://github.com/ipfs/ipfs
fractally DAO platform           - https://github.com/gofractally

The different pieces of the project include:
- Submission form for releases
- Hyperbolic-plane graph visualization of musician connections
- User's traversal path through the visualization is stored when the user "likes" a node 
- Blockchain rewards system for contributors and data validators
- Graph database for entity-relationship data storage


## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Frontend:                         │         ┌───────────────────────────────┐
│         JIT Hypertree + RGraph Visualization        │<────────│  Graph->Frontend convertor:   │
│             Project Submission Form                 │         │  Hypertree Populating Script  │
│              WharfKit Integration                   │         └───────────────────────────────┘      
└─────────────────────────────────────────────────────┘                  │          │
                          │                                     entities │          │ Home node
┌─────────────────────────────────────────────────────┐         ┌───────────────┐   │
│                    API Layer:                       │         │   Graph DB    │   │ 
│           GraphQL + REST Endpoints                  │         │      GQL      │   │
└─────────────────────────────────────────────────────┘         └───────────────┘   │
                          │                                              │          │
        ┌─────────────────┴─────────────────┐                            │          │
        │                                   │                     ┌──────────────────────┐
┌───────────────┐                  ┌──────────────────┐           │      Ingestion:      │
│   Storage:    │                  │    Blockchain:   │           │      Substreams      │
│  Redis(hot)   │                  │    EOS/Vaulta    │           └──────────────────────┘
│  IPFS + S3    │                  │    fractally     │                    │
│  -> GQL       │                  │multi-chain design│────────────────────┘
└───────────────┘                  └──────────────────┘


```

## Quick Start

### Prerequisites

- Node.js 18+
- Docker & Docker Compose
- GQL-compabitble Neo4j replacement /// TO BE IMPLEMENTED
- Redis 7.0+
- IPFS node (optional, can use public gateway)
- EOS/Vaulta account (for blockchain submission)

### Installation

```bash
# Clone the repository
git clone https://github.com/polaris/music-registry.git
cd music-registry

# Install dependencies
npm install

# Copy environment configuration
cp .env.example .env.local

# Start services with Docker Compose
docker-compose up -d

# Initialize database
npm run init:db

# Start development server
npm run dev
```

### Basic Configuration

```bash
# .env.local
# Blockchain Configuration
CHAIN_ID=1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4
RPC_URL=https://eos.greymass.com
CONTRACT_ACCOUNT=polaris

# Database Configuration
GRAPH_URI=bolt://localhost:7687
GRAPH_USER=your-user
GRAPH_PASSWORD=your-password

# Storage Configuration
IPFS_URL=http://localhost:5001
S3_ENDPOINT=https://s3.amazonaws.com
S3_ACCESS_KEY=your-access-key
S3_SECRET_KEY=your-secret-key
S3_BUCKET=polaris-events

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your-redis-password

# Frontend Configuration (frontend/.env or docker-compose.yml)
# IMPORTANT: VITE_API_URL must include the /api prefix
VITE_API_URL=http://localhost:3000/api
VITE_GRAPHQL_URL=http://localhost:3000/graphql
```

**Note on Frontend API URL**: The `VITE_API_URL` environment variable must include the `/api` prefix. The backend API serves REST endpoints under `/api/*` (e.g., `/api/events/create`), while GraphQL is at `/graphql` and health checks at `/health`. The frontend client automatically normalizes the URL if the `/api` suffix is missing, but it's recommended to include it explicitly in your configuration.

### Chain Ingestion (Blockchain Events)

The system supports automated chain ingestion via Substreams, which monitors the blockchain for anchored events and automatically ingests them into the graph database.

#### Substreams HTTP Sink

The `substreams-sink` service consumes events from the blockchain via Pinax Firehose and posts them to the backend ingestion endpoint. This service is included in `docker-compose.yml` but requires a Pinax API token to run.

**Setup**:

1. **Get a Pinax API Token**:
   - Visit https://app.pinax.network
   - Sign up and get your API token

2. **Configure the token** (choose one method):

   **Method A - Environment file** (recommended):
   ```bash
   # Create .env file in project root
   echo "SUBSTREAMS_API_TOKEN=your_token_here" >> .env
   ```

   **Method B - docker-compose.yml**:
   ```yaml
   # Uncomment and set in docker-compose.yml line 250
   - SUBSTREAMS_API_TOKEN=your_token_here
   ```

3. **Start the stack** (including chain ingestion):
   ```bash
   docker-compose up -d
   ```

   The `substreams-sink` service will automatically start and begin ingesting blockchain events.

4. **Verify ingestion** (check logs):
   ```bash
   docker-compose logs -f substreams-sink
   ```

   You should see events being posted to `/api/ingest/anchored-event`.

**Running without chain ingestion** (if you don't have a Pinax token):
```bash
# Start only core services (excludes substreams-sink)
docker-compose up -d neo4j redis ipfs minio api frontend
```

**Configuration Options**:
- `START_BLOCK`: Block number to start ingestion from (default: 0)
- `CONTRACT_ACCOUNT`: Contract account name (default: polaris)
- `SUBSTREAMS_ENDPOINT`: Firehose endpoint (default: eos.firehose.pinax.network:443)

## Core Concepts

### Releases as the primary means for building the registry.

**Releases** are the core accounting unit of the system. All releases:
- Consist of one or more *tracks*, which are peformances arranged by *arrangers*, using particular *songs* written by *songwriteirs*, which performance includes one or more *groups* with consistent *members*, as well as any non-negative number of *guests*, including session musicians, engineers, and other documented personnel.
- All releases must include a reference link.
- In the visualization, releases from a particular group appear when the user clicks on that particular group's node.

### Groups vs. Persons

**Groups** are persons or collections of persons credited on a release (including solo artsists, bands, orchestras, ensembles):
- Have members with defined roles and time periods.
- Perform on tracks as a unit. All releases are done by at lease one group; even solo artists are classified as a "group" of one.
- Visualized with RGraph showing member participation

**Persons** are individual musicians:
- Can be members of multiple groups
- Can appear as guests on tracks
- Each person has a randomly assigned color that is connected to groups with colored edges

### Members vs. Guests

**Members** are persons who are credited as core group members on the album:
- Each group member performs one or more roles. Members cannot also be guests; a group member on a song should be listed for all roles performed.
- Members are the persons who are listed in the liner notes as members of the group. If the liner notes do not specify who is a member of the group, then members are limited to personnel who performed on more than 2/3 of tracks on a release for a one-group release. For multi-group releases where the members of each group are not listed, members are inherited from other group releases, or if the group has no existing releases, then the persons can be assumed to be guests.
- If a group includes non-musician personnel as part of the official group in a release's liner notes, then they should be listed as group members for the relevant tracks.
- Members are visualized as  RGraph showing member participation

**Guests** are individual musicians who participate in a released track outside of the context of the group or groups that performed on the release:
- Guests should include all personnel not listed as group members. 
- Can appear as guests on tracks and as guests on releases. Track guests are people like tracking engineers, session musicians, and others who worked on an individual track. Release guests are people like mastering engineers, album art designers, release-level liner note acknowledgements, and others whose contribution only makes sense in the context of an entire release.
- Guests are visualized when a user clicks on a release or track, as non-colored edge connections to a particular release or track.

### Key Relationships

| Relationship | From → To | Description |
|-------------|-----------|-------------|
| MEMBER_OF | Person → Group | Group membership with dates and roles |
| PERFORMED_ON | Group → Track | Group performed this track |
| GUEST_ON | Person → Track | Guest personnel on a track (not a group member) |
| GUEST_ON | Person → Track | Guest personnel on an album (not a group member) |
| WROTE | Person → Song | Songwriting credit |
| ARRANGED | Person → Track/Song | Arranger credit |
| PRODUCER | Person → Track | Producer credit |
| RECORDING_OF | Track → Song | Track records this composition |
| SAMPLES | Track → Track | Songs sampled in a released track |
| IN_RELEASE | Track → Release | Tracks used in a release |
| IN_MASTER | Release → Master | Original Release (self) or Re-release |
| RELEASED | Label → Release | Labels publishes the release |
| ORIGIN | Person/Group/Release/Label → City | The city the entity is from |
| SUBMITTED | Account → Any | Tracks the account that submitted the record |
| REPRESENTS | Media → Any | Tracks related multimedia content |


### Event Types

All data modifications are submitted as canonical events:

| Event Type | Code | Description |
|------------|------|-------------|
| CREATE_RELEASE_BUNDLE | 21 | Full release with groups and tracks |
| ADD_CLAIM | 30 | Add data to entity |
| EDIT_CLAIM | 31 | Modify existing data |
| VOTE | 40 | Vote on release submission |
| FINALIZE | 50 | Finalize and distribute rewards |

## API Documentation

### GraphQL Endpoint

```graphql
# Get group with members
query GetGroup($id: String!) {
    group(id: $id) {
        id
        name
        memberCount
        members {
            person {
                name
            }
            role
            instrument
            fromDate
            toDate
            participationPercentage
        }
    }
}

# Search across all entities
query Search($query: String!) {
    search(query: $query) {
        ... on Group {
            id
            name
            memberCount
        }
        ... on Person {
            id
            name
        }
        ... on Release {
            id
            name
            releaseDate
        }
    }
}
```

### REST Endpoints

#### Groups

```http
GET /api/groups/:groupId/participation
```
Returns member participation data for RGraph visualization:
```json
{
    "groupId": "group:beatles",
    "members": [
        {
            "personId": "person:lennon",
            "personName": "John Lennon",
            "trackCount": 213,
            "participationPercentage": 100.0,
            "releaseCount": 13
        }
    ]
}
```

```http
GET /api/groups/:groupId/details
```
Returns comprehensive group information with timeline.

#### Persons

```http
GET /api/persons/:personId/groups
```
Returns all groups a person has been a member of.

#### Graph Data

```http
GET /api/graph/initial
```
Returns initial graph data for visualization.

#### Events

```http
POST /api/events/create
```
Create and store a new release:
```json
{
    "v": 1,
    "type": "CREATE_RELEASE_BUNDLE",
    "author_pubkey": "PUB_K1_...",
    "created_at": 1758390021,
    "parents": [],
    "body": {
        "release": {
            "release_name": "The Beatles",
            "release_altnames": ["The White Album", ],
            "release_date": "1968-11-22",
            "release_format": ["LP"],
            "liner_notes": "Lorem ipsum",
            "release_guests": [{"person_id": "f14c98a0e88b0965...", 
                        "person_name":"Ken Scott",
                        "person_roles": [{
                            "role_id": "865f856c89890b79...",
                            "role_name": "Engineer"}, {
                            "role_id": "5e578a87f087d908b7...",
                            "role_name": "Mixer"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}],
            "master_release": [true, null], //For reissues (false), the second value is the Master node ID
            "labels": [{ //UI will Search to see if label exists, input label_id 
                    "label_id":"57230498f3982de...",
                    "label_name": "Apple Records",
                    "label_altnames":"Apple Corps",
                    "label_parents":"",
                    "label_city":[{
                        "city_id":"d857a85e07f2344290...",
                        "city_name":"London",
                        "city_lat":51.50735,
                        "city_long":-0.12776
                    }]
                    
                }, {
                    "label_id":"909876543b46a8e...",
                    "label_name": "EMI Records",
                    "label_altnames":["EMI", "EMI Group plc","Electric and Musical Industries" ],
                    "label_parents":"",
                    "label_city":[{
                        "city_id":"d857a85e07f2344290...",
                        "city_name":"London",
                        "city_lat":51.50735,
                        "city_long":-0.12776
                    }]
                },
                {
                    "label_id":"78efc658da7d5438...",
                    "label_name": "Capitol Records",
                    "label_altnames":["Capitol Records, Inc.", "Capitol Records, LLC","Capitol"],
                    "label_parents":["909876543b46a8e..."],
                    "label_city":[{
                        "city_id":"22342522fa68c6e089d...",
                        "city_name":"Los Angeles",
                        "city_lat":34.09834,
                        "city_long":-118.32674
                    }]
                }
            ],
            "tracks": [
                {
                "track_id":"8d0b789a634ac54...",
                "title": "Back in the U.S.S.R.",
                "listen_link":["https://open.spotify.com/track/0j3p1p06deJ7f9xmJ9yG22", "https://music.apple.com/us/song/back-in-the-u-s-s-r/1441133197"],
                "cover_song":[],
                "sampled_songs":[],
                "songwriters":[{"person_id": "d36547078b701635a7412...", 
                        "person_name":"Paul McCartney",
                        "person_roles": [{
                            "role_id": "96e96770c07b0707a07e078f078...",
                            "role_name": "Lyrics"}, {
                            "role_id": "9a96c96e78fac74e765876b...",
                            "role_name": "Songwriter"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}, {"person_id": "347a746e8c9606f78978fd...", 
                        "person_name":"John Lennon",
                        "person_roles": [{
                            "role_id": "9a96c96e78fac74e765876b...",
                            "role_name": "Songwriter"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}],
                "producers": [{"person_id": "436a765c764e73567978b6979e97f97...", 
                        "person_name":"George Martin",
                        "person_roles": [{
                            "role_id": "c976b975aa254354665e9...",
                            "role_name": "Producer"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}
                ],
                "groups": [{
                    "group_id": "875a968e0d079c90766544...", //create if does not already exist
                    "group_name": "The Beatles",
                    "group_altnames":"The Fab Four",
                    "members": [
                        {"person_id": "347a746e8c9606f78978fd...", 
                        "person_name":"John Lennon",
                        "person_roles": [{
                            "role_id": "007697d63b680e6ac254365...",
                            "role_name": "Backing Vocals"}, {
                            "role_id": "53429f698e98a789c635...",
                            "role_name": "Electric Guitar" }, {
                            "role_id": "a123456c234567890e9987...",
                            "role_name": "Drum Kit" }, {
                            "role_id": "d869a6354675b07e079476eec...",
                            "role_name": "Percussion" }, {
                            "role_id": "960e264a079b957c207296...",
                            "role_name": "Handclaps" }, {
                            "role_id": "7e4a648c57697089f2653a8796b...",
                            "role_name": "Bass Guitar" 
                        }], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                        {"person_id": "d36547078b701635a7412...", 
                        "person_name":"Paul McCartney",
                        "person_roles": [{
                            "role_id": "969e63c089a465...",
                            "role_name": "Lead Vocals"}, {
                            "role_id": "007697d63b680e6ac254365...",
                            "role_name": "Backing Vocals"}, {
                            "role_id": "7e4a648c57697089f2653a8796b...",
                            "role_name": "Bass Guitar" }, {
                            "role_id": "a123456c234567890e9987...",
                            "role_name": "Drum Kit" }, {
                            "role_id": "d869a6354675b07e079476eec...",
                            "role_name": "Percussion" }, {
                            "role_id": "960e264a079b957c207296...",
                            "role_name": "Handclaps" }, {
                            "role_id": "53429f698e98a789c635...",
                            "role_name": "Electric Guitar" }, {
                            "role_id": "70a3654eb7654c67bbc...",
                            "role_name": "Piano" 
                        }], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                        {"person_id": "2c689b96a8960e79f0d...", 
                        "person_name":"George Harrison",
                        "person_roles": [{
                            "role_id": "007697d63b680e6ac254365...",
                            "role_name": "Backing Vocals"}, {
                            "role_id": "53429f698e98a789c635...",
                            "role_name": "Electric Guitar" }, {
                            "role_id": "a123456c234567890e9987...",
                            "role_name": "Drum Kit" }, {
                            "role_id": "d869a6354675b07e079476eec...",
                            "role_name": "Percussion" }, {
                            "role_id": "960e264a079b957c207296...",
                            "role_name": "Handclaps" }, {
                            "role_id": "7e4a648c57697089f2653a8796b...",
                            "role_name": "Bass Guitar" }], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}
                    ]
                }],
                "guests": [
                ]
            }, {
                "track_id":"b4354534d0778e98c68...",
                "title": "Dear Prudence",
                "listen_link":["https://open.spotify.com/track/5NQYyej46WQkgCbnzGD21W", "https://music.apple.com/us/song/dear-prudence/1441133428"],
                "cover_song":[],
                "sampled_songs":[],
                "songwriters":[{"person_id": "d36547078b701635a7412...", 
                        "person_name":"Paul McCartney",
                        "person_roles": [{
                            "role_id": "9a96c96e78fac74e765876b...",
                            "role_name": "Songwriter"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}, {"person_id": "347a746e8c9606f78978fd...", 
                        "person_name":"John Lennon",
                        "person_roles": [{
                            "role_id": "96e96770c07b0707a07e078f078...",
                            "role_name": "Lyrics"}, {
                            "role_id": "9a96c96e78fac74e765876b...",
                            "role_name": "Songwriter"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}],
                "producers": [{"person_id": "436a765c764e73567978b6979e97f97...", 
                        "person_name":"George Martin",
                        "person_roles": [{
                            "role_id": "c976b975aa254354665e9...",
                            "role_name": "Producer"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}
                ],
                "groups": [{
                    "group_id": "875a968e0d079c90766544...", 
                    "group_name": "The Beatles",
                    "group_altnames":"The Fab Four",
                    "members": [
                        {"person_id": "347a746e8c9606f78978fd...", 
                        "person_name":"John Lennon",
                        "person_roles": [{
                            "role_id": "969e63c089a465...",
                            "role_name": "Lead Vocals"}, {
                            "role_id": "007697d63b680e6ac254365...",
                            "role_name": "Backing Vocals"}, {
                            "role_id": "53429f698e98a789c635...",
                            "role_name": "Electric Guitar" }
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                        {"person_id": "d36547078b701635a7412...", 
                        "person_name":"Paul McCartney",
                        "person_roles": [ {
                            "role_id": "007697d63b680e6ac254365...",
                            "role_name": "Backing Vocals"}, {
                            "role_id": "7e4a648c57697089f2653a8796b...",
                            "role_name": "Bass Guitar" }, {
                            "role_id": "a123456c234567890e9987...",
                            "role_name": "Drum Kit" }, {
                            "role_id": "c745a1b27389e897468a654c8...",
                            "role_name": "Tambourine" }, {
                            "role_id": "960e264a079b957c207296...",
                            "role_name": "Handclaps" }, {
                            "role_id": "70a3654eb7654c67bbc...",
                            "role_name": "Piano" 
                        }], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                        {"person_id": "2c689b96a8960e79f0d...", 
                        "person_name":"George Harrison",
                        "person_roles": [{
                            "role_id": "007697d63b680e6ac254365...",
                            "role_name": "Backing Vocals"}, {
                            "role_id": "53429f698e98a789c635...",
                            "role_name": "Electric Guitar" }, {
                            "role_id": "c745a1b27389e897468a654c8...",
                            "role_name": "Tambourine" }, {
                            "role_id": "960e264a079b957c207296...",
                            "role_name": "Handclaps" }
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}
                    ]
                }],
                "guests": []
            }, {
                "track_id":"c63b233ae432ccf8544...",
                "title": "Glass Onion",
                "listen_link":["https://open.spotify.com/track/2jAojvUaPoHPFSPpF0UNRo", "https://music.apple.com/us/song/glass-onion/1441133436"],
                "cover_song":[],
                "sampled_songs":[],
                "songwriters":[{"person_id": "d36547078b701635a7412...", 
                        "person_name":"Paul McCartney",
                        "person_roles": [{
                            "role_id": "9a96c96e78fac74e765876b...",
                            "role_name": "Songwriter"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}, {"person_id": "347a746e8c9606f78978fd...", 
                        "person_name":"John Lennon",
                        "person_roles": [{
                            "role_id": "96e96770c07b0707a07e078f078...",
                            "role_name": "Lyrics"}, {
                            "role_id": "9a96c96e78fac74e765876b...",
                            "role_name": "Songwriter"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}, {"person_id": "436a765c764e73567978b6979e97f97...", 
                        "person_name":"George Martin",
                        "person_roles": [{
                            "role_id": "24654d566f47e9780a9a68c9...",
                            "role_name": "String Arrangement"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}], 
                "producers": [{"person_id": "436a765c764e73567978b6979e97f97...", 
                        "person_name":"George Martin",
                        "person_roles": [{
                            "role_id": "c976b975aa254354665e9...",
                            "role_name": "Producer"}], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}
                ],    
                "groups": [{
                    "group_id": "875a968e0d079c90766544...", 
                    "group_name": "The Beatles",
                    "group_altnames":"The Fab Four",
                    "members": [
                        {"person_id": "347a746e8c9606f78978fd...", 
                        "person_name":"John Lennon",
                        "person_roles": [{
                            "role_id": "969e63c089a465...",
                            "role_name": "Lead Vocals"}, {
                            "role_id": "007697d63b680e6ac254365...",
                            "role_name": "Backing Vocals"}, {
                            "role_id": "53429f698e98a789c635...",
                            "role_name": "Acoustic Guitar" }
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                        {"person_id": "d36547078b701635a7412...", 
                        "person_name":"Paul McCartney",
                        "person_roles": [ {
                            "role_id": "7e4a648c57697089f2653a8796b...",
                            "role_name": "Bass Guitar" }, {
                            "role_id": "070f0786a078c08e7a0b7074325...",
                            "role_name": "Recorder" }, {
                            "role_id": "70a3654eb7654c67bbc...",
                            "role_name": "Piano" 
                        }], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                        {"person_id": "2c689b96a8960e79f0d...", 
                        "person_name":"George Harrison",
                        "person_roles": [ {
                            "role_id": "53429f698e98a789c635...",
                            "role_name": "Electric Guitar" }
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                        {"person_id": "a13248576c56746e89980d...", 
                        "person_name":"Ringo Starr",
                        "person_roles": [{
                            "role_id": "c745a1b27389e897468a654c8...",
                            "role_name": "Tambourine"}, {
                            "role_id": "a123456c234567890e9987...",
                            "role_name": "Drum Kit" 
                        }], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}
                    ]
                }],
                "guests": [
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"Chris Thomas",
                        "person_roles": [{
                            "role_id": "070f0786a078c08e7a0b7074325...",
                            "role_name": "Recorder"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}, 
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"Henry Datyner",
                        "person_roles": [{
                            "role_id": "3456c856f85a856c865e4...",
                            "role_name": "Violin"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"Eric Bowie",
                        "person_roles": [{
                            "role_id": "3456c856f85a856c865e4...",
                            "role_name": "Violin"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"Norman Lederman",
                        "person_roles": [{
                            "role_id": "3456c856f85a856c865e4...",
                            "role_name": "Violin"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}, 
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"Ronald Thomas",
                        "person_roles": [{
                            "role_id": "3456c856f85a856c865e4...",
                            "role_name": "Violin"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"John Underwood",
                        "person_roles": [{
                            "role_id": "79870c708f98ff78e780e7523352...",
                            "role_name": "Viola"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"Keith Cummings",
                        "person_roles": [{
                            "role_id": "79870c708f98ff78e780e7523352...",
                            "role_name": "Viola"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"Eldon Fox",
                        "person_roles": [{
                            "role_id": "5454f34c64364a3646e6634d6422...",
                            "role_name": "Cello"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }},
                    {"person_id": "b74342a254c587e098d98ddf9785436...", 
                        "person_name":"Reginald Kilby",
                        "person_roles": [{
                            "role_id": "5454f34c64364a3646e6634d6422...",
                            "role_name": "Cello"}
                            ], 
                        "person_city":{
                            "city_id":"d857a85e07f2344290...",
                            "city_name":"London",
                            "city_lat":51.50735,
                            "city_long":-0.12776
                        }}
                ]
            }
            ///, ... CONTINUED TRACK LISTING (elided from example but should be included in actual payload)
            ],
            
        },
        

        "tracklist": [
            {
            "track_id": "8d0b789a634ac54...",
            "disc_side": 1,
            "track_number": 1
        }, {
            "track_id": "b4354534d0778e98c68...",
            "disc_side": 1,
            "track_number": 2
        }, {
            "track_id": "c63b233ae432ccf8544....",
            "disc_side": 1,
            "track_number": 3
        }
        ///, ... CONTINUED TRACK LISTING (elided from example but should be included in actual payload)
        ]
    },
    "proofs": {
        "source_links": ["https://discogs.com/..."]
    },
    "sig": "SIG_K1_..."
}
```

## Blockchain Integration

### Smart Contract Actions

```cpp
// Anchor an event on-chain
ACTION put(
    name author,           // Submitting account
    uint8_t type,         // Event type code
    checksum256 hash,     // Event hash
    optional<checksum256> parent,
    uint32_t ts,
    vector<name> tags
);

// Vote on a submission
ACTION vote(
    name voter,
    checksum256 tx_hash,
    int8_t val           // +1, 0, -1
);

// Stake on a node (Group or Person)
ACTION stake(
    name account,
    checksum256 node_id,
    asset quantity
);


// Stake on a node (Group or Person)
ACTION unstake(
    name account,
    checksum256 node_id,
    asset quantity
);

// Like a node after traversing the graph front-end
ACTION like(
    name account,
    checksum256 node_id,
    vector<checksum256> node_path,
);

// Batch update Respect values from Fractally elections (oracle-only)
// Called weekly after Fractally consensus rounds complete
ACTION updaterespect(
    std::vector<std::pair<name, uint32_t>> respect_data,  // Array of account:respect pairs
    uint64_t election_round                                // Fractally round number
);
```

### Submission Flow

1. **Create Event**: Generate canonical JSON event with deterministic hash
2. **Store Off-chain**: Save to IPFS and S3 (minimum 2 locations)
3. **Anchor On-chain**: Submit hash to blockchain
4. **Process**: Event processor updates graph database
5. **Vote**: Community votes during window (7 days for releases)
6. **Finalize**: Calculate rewards using logarithmic emission

### Emission Formula

```
g(x) = m * ln(x) / x

where:
- x = global submission counter
- m = multiplier by event type
  - CREATE_RELEASE_BUNDLE: 100,000,000
  - ADD_CLAIM: 1,000,000
  - EDIT_CLAIM: 1,000
```

## Frontend Visualization

### Group Nodes with RGraph

Groups display an RGraph showing member participation:
- Each member gets a wedge sized by participation percentage
- Colors are consistent across the visualization
- Percentage labels show contribution levels

```javascript
// Initialize visualization
const visualizer = new MusicGraphVisualizer(
    'graph-container',
    'http://localhost:3000/api'
);
```

### Person to Group Connections

Persons connect to Groups with colored edges:
- Each person-group relationship has a unique color
- Colors are deterministic (same person-group always same color)
- No RGraph around Person nodes

## Data Import

### From Discogs

```bash
# Import single release
node tools/cli/import-cli.js discogs release -i 12345

# Import from label
node tools/cli/import-cli.js discogs label -i 5678 -l 100
```


## Development

### Running Tests

```bash
# All tests
npm test

# Specific test suites
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:performance

# With coverage
npm run test:coverage
```

### Project Structure

```
polaris-music-registry/
├── contracts/           # Smart contracts
│   └── polaris.music.cpp
├── backend/
│   ├── src/
│   │   ├── api/            # API server
│   │   ├── graph/          # Graph database
│   │   ├── config/         # Configuration files
│   │   ├── storage/        # Event storage
│   │   └── indexer/        # Event processor
│   └── test/
│       ├── api/            # API tesets
│       ├── graph/          # Graph tests
│       ├── e2e/            # End-to-end tests
│       ├── storage/        # Event storage tests
│       ├── performance/    # Performance tests
│       └── utils/          # Test utilities
├── frontend/
│   ├── src/
│   │   └── visualization/  # JIT graphs
│   └── public/
├── substreams/             # Blockchain indexing
│   ├── src/
│   └── proto/
├── tools/                  # Import and migration
│   ├── import/
│   └── migration/
├── k8s/                    # Kubernetes files
├── nginx/                  # nginx files
├── monitoring/             # Monitoring scripts and configurations
├── docs/                   # Documentation and pseudocode
└── docker-compose.yml
```

### Database Schema

#### Nodes
- **Person**: Individual musicians
- **Group**: Bands, orchestras, ensembles
- **Song**: Musical compositions
- **Track**: Recordings of songs
- **Release**: Albums, EPs, singles
- **Master**: Canonical album grouping
- **Label**: Record labels
- **Account**: Blockchain accounts
- **City**: Geographic locations
- **Media**: Multimedia link

#### Key Relationships
- `(Person)-[:MEMBER_OF]->(Group)`
- `(Group)-[:PERFORMED_ON]->(Track)`
- `(Person)-[:GUEST_ON]->(Track)`
- `(Person)-[:ARRANGED]->(Track)`
- `(Person)-[:PRODUCER]->(Track)`
- `(Track)-[:RECORDING_OF]->(Song)`
- `(Person)-[:WROTE]->(Song)`
- `(Track)-[:IN_RELEASE]->(Release)`
- `(Track)-[:SAMPLES]->(Track)`
- `(Release)-[:IN_MASTER]->(Master)`
- `(Label)-[:RELEASED]->(Release)`
- `(Person|Group|Release|Label)-[:ORIGIN]->(City)`
- `(Account)-[:SUBMITTED]->(Any)`
- `(Media)-[:REPRESENTS]->(Any)`


## Deployment

### Docker Compose

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f api-server

# Stop services
docker-compose down
```

### Production Deployment

```bash
# Build and deploy
./deploy.sh production v1.0.0

# Run database migrations
kubectl exec -it polaris-api-0 -- npm run migrate

# Scale API servers
kubectl scale deployment polaris-api --replicas=5
```

### Monitoring

Access monitoring dashboards:
- Grafana: http://localhost:3002 (admin/polarisgrafana123)
- Graph Browser: http://localhost:7474
- IPFS WebUI: http://localhost:5001/webui

## Troubleshooting

### Common Issues

#### Event Not Processing
```bash
# Check processor logs
docker-compose logs event-processor

# Verify event storage
curl http://localhost:3000/api/events/{hash}

# Check blockchain anchor
cleos get table polaris polaris anchors
```

#### Graph Database Issues
```cypher
// Check database status
CALL dbms.components() YIELD name, versions;

// Clear test data
MATCH (n) WHERE n.status = 'test' DETACH DELETE n;
```

#### Storage Issues
```bash
# Test IPFS
ipfs swarm peers

# Test S3/MinIO
aws s3 ls s3://polaris-events --endpoint-url http://localhost:9000
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Submit a pull request

### Code Standards

- Use ESLint configuration
- Write tests for new features
- Document API changes
- Follow commit message conventions

## Security

### Best Practices

1. **Event Validation**: All events are cryptographically signed
2. **Hash Verification**: Content integrity checked on retrieval
3. **Rate Limiting**: API endpoints protected
4. **Input Sanitization**: All user input validated
5. **Access Control**: Smart contract permission checks

### Reporting Issues

Report security issues to: security@polaris.music

## License

MIT License - see LICENSE file for details

## Support

- Documentation: https://docs.polaris.music
- Discord: https://discord.gg/polaris
- GitHub Issues: https://github.com/polaris/music-registry/issues

## Roadmap

### Phase 1: Foundation (Complete)
- 🔄 Graph database schema with Groups
- 🔄 Smart contract deployment
- 🔄 Event storage system
- 🔄 Basic visualization

### Phase 2: Enhancement (In Progress)
- 📋 "Like" function that tracks a user's path through the visualization from the home node or searched node to the "liked" node. This will be used to weight edges with more like-paths higher, mimicking how ants find food.
- 📋 Advanced search capabilities
- 📋 Mobile application
- 📋 IPNS for mutable references

### Phase 3: Expansion (Planned)
- 📋 Multi-chain support
- 📋 AI-powered deduplication
- 📋 Fractally integration for organizational coordination and Respect voting
- 📋 DAO governance

## Acknowledgments

- JIT (JavaScript InfoVis Toolkit) for visualizations
- WharfKit for blockchain integration
- GQL compatible Cypher queries for Neo4j graph database
- IPFS for decentralized storage
- EOS/Vaulta blockchain community
---

## Documentation vs Implementation Mismatches

_Last Updated: 2025-12-07_

This section documents discrepancies between the English-language descriptions in README files and the actual implemented code.

### Main README.md Mismatches

#### 1. **release_guests Field Missing from Frontend** ✅ FIXED
- **Previously**: Frontend form did NOT capture release-level guests
- **Now Fixed**: Added "Release-Level Credits" section to form
- **Implementation**:
  - Added `createReleaseGuestForm()` to FormBuilder.js
  - Added `extractReleaseGuests()` to index.js
  - Updated `buildReleaseData()` to include `release_guests` array
- **Usage**: Credits mastering engineers, album designers, and other release-level contributors
- **Location**: `frontend/index.html` lines 95-107, `frontend/src/components/FormBuilder.js` lines 200-253, `frontend/src/index.js` lines 135, 190-228

#### 2. **Emission Formula Multiplier Mismatch**
- **README States** (line 886-890): Multipliers should be:
  - CREATE_RELEASE_BUNDLE: 100,000,000
  - ADD_CLAIM: 1,000,000
  - EDIT_CLAIM: 1,000
- **Smart Contract Implements** (`contracts/polaris.music.cpp` line 507-512):
  - CREATE_RELEASE_BUNDLE: 1,000,000
  - ADD_CLAIM: 50,000
  - EDIT_CLAIM: 1,000
- **Impact**: Rewards are 100x lower for release bundles and 20x lower for claims than documented
- **Location**: `contracts/polaris.music.cpp` getMultiplier() function

#### 3. **updaterespect Action Signature Mismatch** ✅ FIXED
- **Previously**: README documented wrong signature with single account parameter
- **Now Fixed**: Documentation updated to match actual implementation
- **Correct Signature**:
  ```cpp
  ACTION updaterespect(
      std::vector<std::pair<name, uint32_t>> respect_data,
      uint64_t election_round
  )
  ```
- **Purpose**: Batch update Respect values from Fractally elections (oracle-only)
- **Location**: `contracts/polaris.music.cpp` lines 242-243, README.md lines 864-867

#### 4. **Missing Backend Directory Structure**
- **README States** (line 958): Backend should have `config/` directory
- **Implementation**: No `backend/src/config/` directory exists - configuration is handled via environment variables in code
- **Impact**: Documentation incorrectly describes file structure
- **Location**: `backend/src/` directory

#### 5. **Docker Compose File Missing** ✅ FIXED
- **Previously**: No `docker-compose.yml` file existed in repository
- **Now Fixed**: Created comprehensive docker-compose.yml with all services
- **Services Included**:
  - Neo4j graph database (with APOC and GDS plugins)
  - Redis cache
  - IPFS node
  - MinIO (S3-compatible storage)
  - Backend API server
  - Event processor
  - Frontend development server
- **Additional Files**: Created Dockerfiles and .env.example
- **Location**: `docker-compose.yml`, `backend/Dockerfile`, `frontend/Dockerfile.dev`, `.env.example`

#### 6. **Missing Deployment Scripts**
- **README States** (line 1034): Should have `./deploy.sh` script
- **Implementation**: No deployment script exists
- **Impact**: Production deployment instructions don't work
- **Location**: Repository root
- **Note**: Docker Compose can be used for local deployment; production deployment scripts deferred

#### 7. **Missing Tools Directory** ✅ PARTIALLY FIXED
- **Previously**: No `tools/` directory existed
- **Now Fixed**: Created stub implementations with TODO markers
- **Implementation**:
  - Created `tools/import/discogsImporter.js` (stub with specification reference)
  - Created `tools/import/csvImporter.js` (stub with specification reference)
  - Created `tools/migration/migrate.js` (stub with specification reference)
  - Created `tools/README.md` (implementation guide)
- **Status**: Stubs created; full implementation specified in `/docs/10-data-import-tools.md`
- **Location**: `tools/import/`, `tools/migration/`, `tools/README.md`

#### 8. **Missing Kubernetes Files**
- **README States** (line 977): Should have `k8s/` directory for Kubernetes deployment
- **Implementation**: No `k8s/` directory exists
- **Impact**: Kubernetes deployment instructions (line 1037-1040) don't work
- **Location**: Repository root

#### 9. **Backend README.md Doesn't Exist** ✅ FIXED
- **Previously**: No `backend/README.md` file existed
- **Now Fixed**: Created comprehensive backend documentation
- **Content Includes**:
  - Architecture diagram
  - Directory structure guide
  - Quick start with Docker Compose
  - Manual setup instructions
  - Available npm scripts
  - API endpoint documentation
  - Environment variables reference
  - Testing guide with performance targets
  - Development workflow
  - Troubleshooting section
  - Production deployment considerations
- **Location**: `backend/README.md`

### Frontend README.md vs Implementation

#### 10. **Frontend README Claims "Visualization" Directory**
- **Frontend README States** (line 42): `src/visualization/` for JIT-based graph visualization
- **Implementation**: Directory exists but only has placeholder `MusicGraph.js` file (1 line)
- **Impact**: Misleading - visualization is not actually implemented in frontend
- **Location**: `frontend/src/visualization/MusicGraph.js`

#### 11. **Frontend README Incorrect Package Reference**
- **Frontend README States** (line 10): Uses "crypto-js" package for hashing
- **Implementation**: Correct - `package.json` does include crypto-js@^4.2.0
- **Status**: ✅ MATCHES (no mismatch - documentation is accurate)

### Smart Contract README.md vs Implementation

#### 12. **Missing "clear" Action Documentation**
- **Contract README**: Does not document the `clear()` action
- **Implementation** (`contracts/polaris.music.cpp` line 311-347): Has a `clear()` action for testing
- **Impact**: Undocumented dangerous action exists in code
- **Location**: `contracts/polaris.music.cpp` clear action
- **Note**: README correctly warns this should be removed before mainnet (line 621)

#### 13. **Contract README Correctly Documents Actions**
- **Contract README** (line 11-116): Documents all main actions accurately
- **Implementation**: Matches - all documented actions exist with correct signatures
- **Status**: ✅ MATCHES

### Substreams README.md vs Implementation

#### 14. **Substreams Module Outputs Don't Match**  
- **Substreams README States** (line 61-72): Four modules exist:
  1. map_events
  2. store_stats  
  3. store_account_activity
  4. map_stats
- **Implementation** (`substreams/substreams.yaml`): Only defines three modules in YAML manifest
  - Missing proper module definitions for store modules
- **Impact**: Incomplete module configuration
- **Location**: `substreams/substreams.yaml` lines 55-95

#### 15. **Substreams README Build Instructions**
- **Substreams README** (line 79-83): Says `make build` will work
- **Implementation**: `Makefile` exists and should work, but requires external dependencies (substreams CLI)
- **Status**: ⚠️ CONDITIONAL - Works if dependencies installed

### CLAUDE.md vs Implementation

#### 16. **CLAUDE.md Says Tests Directory Has performance/**
- **CLAUDE.md States** (line 37): `backend/test/performance/` should exist
- **Implementation**: No `backend/test/performance/` directory exists
- **Impact**: Performance testing documentation references non-existent directory
- **Location**: `backend/test/` directory structure

#### 17. **CLAUDE.md Lists Docs That Don't Exist**
- **CLAUDE.md States** (lines 53-56): Should have comprehensive docs in `docs/` directory
- **Implementation**: Only 3 docs files exist:
  - `docs/01-smart-contract.md` ✅
  - `docs/02-graph-database-schema.md` ❌ (doesn't exist)
  - `docs/03-event-storage.md` ✅
  - Other numbered docs don't exist
- **Impact**: Referenced documentation is incomplete
- **Location**: `docs/` directory

### Critical Functional Mismatches

#### 18. **Backend Has No Implementation**
- **Multiple READMEs State**: Backend should have full implementation with Neo4j, IPFS, Redis, etc.
- **Implementation**: Backend files are mostly placeholder stubs (schema.js, eventStore.js, server.js created but not fully tested)
- **Status**: ⚠️ CODE EXISTS BUT UNTESTED - Implementation is present but requires:
  - Database setup
  - Storage backend configuration  
  - Testing and validation
- **Location**: All `backend/src/` files

#### 19. **Event Processor Integration**  
- **CLAUDE.md States** (line 144): Backend has `backend/src/indexer/eventProcessor.js`
- **Implementation**: File exists with full implementation
- **Status**: ✅ MATCHES

### Data Structure Mismatches

#### 20. **proofs Field Inconsistency** ✅ FIXED
- **Previously**: Frontend form did NOT capture or send proofs field
- **Now Fixed**: Added "Source Attribution" section to form
- **Implementation**:
  - Added `source_links` input field to index.html
  - Updated `buildReleaseData()` to create proofs object with source_links array
- **Usage**: Provide verification sources (Discogs, MusicBrainz, official websites, etc.)
- **Location**: `frontend/index.html` lines 95-102, `frontend/src/index.js` lines 140-142, 154

### Summary of Critical Issues

**High Priority (Breaks Documented Functionality):**
1. ~~Missing `release_guests` field in frontend~~ ✅ FIXED
2. Emission multipliers 100x different from docs
3. ~~`updaterespect` action completely different signature~~ ✅ FIXED
4. ~~Missing `proofs` field in frontend~~ ✅ FIXED
5. ~~Docker Compose file missing~~ ✅ FIXED

**Medium Priority (Documentation Errors):**
6. ~~Tools directory doesn't exist (Discogs import broken)~~ ✅ PARTIALLY FIXED (stubs created)
7. Deployment scripts missing (deferred - Docker Compose covers local deployment)
8. K8s files missing (deferred - not critical for initial development)
9. ~~Backend README missing~~ ✅ FIXED
10. Performance test directory missing (deferred - can add when running performance tests)

**Low Priority (Minor Inconsistencies):**
11. Visualization directory exists but not implemented
12. Some documentation files missing
13. `clear()` action undocumented

### Recommended Actions

1. ~~**Frontend Form**: Add `release_guests` field and `proofs` field to form~~ ✅ FIXED
2. **Smart Contract**: Either update multipliers to match docs or update docs to match code (REMAINING)
3. ~~**Documentation**: Update `updaterespect` signature in README to match actual implementation~~ ✅ FIXED
4. ~~**Docker**: Create `docker-compose.yml` or remove references from README~~ ✅ FIXED
5. ~~**Backend README**: Create comprehensive backend documentation~~ ✅ FIXED
6. ~~**Tools**: Either create tools/import directory or remove from README~~ ✅ FIXED (stubs created)
7. **Testing**: Create performance test directory or update CLAUDE.md (DEFERRED)

