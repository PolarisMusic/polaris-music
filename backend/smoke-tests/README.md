# Smoke Test Release Bundles

This directory contains smoke test release bundles for testing the Polaris Music Registry graph database and ingestion pipeline.

## Directory Structure

```
smoke-tests/
├── README.md                    # This file
└── releases/                    # Release bundle templates
    ├── create-release-bundle.tmpl.json              # "Songs for the Deaf" (QOTSA)
    ├── create-release-bundle-nevermind.tmpl.json    # Nirvana
    ├── create-release-bundle-badmotorfinger.tmpl.json  # Soundgarden
    ├── create-release-bundle-california.tmpl.json   # Mr. Bungle
    └── ... (17 more bundles)
```

## Available Smoke Test Bundles

The smoke test suite includes 22 release bundles covering various artists and scenarios:

### Grunge/Alternative Rock
- **Nevermind** - Nirvana (1991)
- **Badmotorfinger** - Soundgarden (1991)
- **Ten Commandos** - Stone Temple Pilots variant
- **Songs About Angels** - Alternative compilation

### Desert/Stoner Rock
- **Songs for the Deaf** - Queens of the Stone Age (2002) - Original bundle
- **Blues for the Red Sun** - Kyuss (1992)
- **Leave No Ashes** - Desert Sessions variant

### Post-Hardcore/Experimental
- **Off!** - OFF! (2012)
- **Plosivs** - Experimental hardcore
- **Automatic Midnight** - Hot Snakes (2000)
- **Rhythms from the Cosmic Sky** - Earthless variant
- **Audit in Progress** - Hot Snakes (2004)
- **Asking for a Friend** - Rocket from the Crypt variant
- **RFTC** - Rocket from the Crypt compilation
- **Group Sounds** - Rocket from the Crypt (1996)

### Progressive/Alternative
- **California** - Blink-182 (2023)
- **Enema of the State** - Blink-182 (1999)
- **See You in Magic** - The Night Marchers (2008)
- **Autumn Seraphs** - Pinback variant
- **Dream Walker** - Angels & Airwaves variant
- **Under the River** - Oceanic/post-rock variant
- **Oblivion** - Mastodon variant

## Usage

### Load All Smoke Test Bundles

```bash
cd backend
node scripts/loadSmokeTests.js
```

This will:
- Read all `.tmpl.json` files from `smoke-tests/releases/`
- Replace `__TIMESTAMP__` placeholders with current timestamp
- Create all entities (Person, Group, Song, Track, Release, Label, City)
- Create all relationships (MEMBER_OF, WROTE, PERFORMED_ON, GUEST_ON, etc.)
- Generate placeholder photos, bios, and colors for visualization

### Load a Specific Bundle

```bash
node scripts/loadSmokeTests.js --file create-release-bundle-nevermind.tmpl.json
```

### Clear Data Before Loading

```bash
node scripts/loadSmokeTests.js --clear
```

**⚠️ WARNING**: The `--clear` flag deletes ALL graph data before loading!

### Environment Variables

The loader script uses these environment variables:

```bash
GRAPH_URI=bolt://localhost:7687        # Neo4j connection URI
GRAPH_USER=neo4j                       # Neo4j username
GRAPH_PASSWORD=polarisdev              # Neo4j password
```

## Bundle Format

Each bundle follows the `CREATE_RELEASE_BUNDLE` event format:

```json
{
  "v": 1,
  "type": "CREATE_RELEASE_BUNDLE",
  "created_at": __TIMESTAMP__,
  "parents": [],
  "body": {
    "release": { ... },
    "labels": [ ... ],
    "groups": [ ... ],
    "songs": [ ... ],
    "tracks": [ ... ],
    "tracklist": [ ... ]
  }
}
```

### Field Variations Handled

The loader normalizes these field name variations:

- `alt_names` / `altnames` → stored as `altnames`
- `release_altnames` → stored as `altnames`
- `city.id` / `city.city_id` → stored as `city_id`
- `city.name` / `city.city_name` → stored as `name`

## Testing Scenarios

These bundles test various edge cases:

### Member vs. Guest Relationships
- **Nevermind**: Dave Grohl as drummer (member)
- **Songs for the Deaf**: Dave Grohl as guest drummer
- Tests correct handling of same person in different roles

### Collaborative Songwriting
- **Nevermind**: "Smells Like Teen Spirit" credited to all three members
- Tests multiple writers per song

### Label Relationships
- Multiple labels across bundles (DGC, Sub Pop, Interscope, etc.)
- Tests label deduplication and city relationships

### Complex Track Listings
- **California**: 10 tracks with varied personnel
- Tests tracklist ordering, disc numbers, track numbers

### Producer Credits
- Various bundles include producer credits (Billy Anderson, Ross Robinson, etc.)
- Tests PRODUCED relationships

## Integration with Tests

### Unit Tests

The smoke test bundles are used in:

```bash
npm test                           # All tests
npm run test:unit                  # Unit tests only
npm run test:integration           # Integration tests (uses smoke data)
npm run test:e2e                   # E2E workflow tests
```

### Manual Testing

For manual graph exploration:

```bash
# Load smoke tests
node scripts/loadSmokeTests.js

# Open Neo4j Browser
# Navigate to http://localhost:7474
# Run Cypher queries:

# View all releases
MATCH (r:Release) RETURN r.name, r.date

# View Nirvana lineup
MATCH (p:Person)-[m:MEMBER_OF]->(g:Group {name: "Smoke Nirvana"})
RETURN p.name, m.role

# View Songs for the Deaf tracks
MATCH (t:Track)-[:IN_RELEASE]->(r:Release {name: "Smoke Songs for the Deaf"})
RETURN t.title ORDER BY t.track_number

# View Dave Grohl's appearances (both member and guest)
MATCH (p:Person {name: "Smoke Dave Grohl"})-[r]->(target)
RETURN type(r), labels(target), target.name
```

## CI/CD Integration

The smoke tests are run in CI via `.github/workflows/backend-ci.yml`:

```yaml
- name: Load smoke test data
  run: |
    cd backend
    node scripts/loadSmokeTests.js

- name: Run integration tests
  run: npm run test:integration
```

## Data Sources

These bundles are based on real releases with data sourced from:
- Wikipedia discographies
- Discogs release data
- Band official websites
- AllMusic credits

All entities are prefixed with "Smoke" to distinguish test data from production data.

## Adding New Bundles

To add a new smoke test bundle:

1. **Create the template file**:
   ```bash
   touch backend/smoke-tests/releases/create-release-bundle-myalbum.tmpl.json
   ```

2. **Use the standard format**:
   - Copy an existing bundle as a template
   - Use unique UUIDs for all entity IDs (person_id, group_id, etc.)
   - Prefix all names with "Smoke" (e.g., "Smoke Foo Fighters")
   - Use `__TIMESTAMP__` for the `created_at` field

3. **Ensure ID uniqueness**:
   - Use the UUID format: `polaris:person:00000000-0000-4000-8000-{12-hex-digits}`
   - Check existing bundles to avoid ID collisions
   - Reuse person IDs for cross-bundle relationships (e.g., Dave Grohl)

4. **Test the bundle**:
   ```bash
   node scripts/loadSmokeTests.js --clear --file create-release-bundle-myalbum.tmpl.json
   ```

5. **Update this README**:
   - Add to the "Available Smoke Test Bundles" section
   - Document any special test scenarios

## Migrations

After loading smoke tests, run migrations to normalize data:

```bash
# Unify ID properties
node backend/src/graph/migrations/001-unify-id-property.js

# Normalize status values
node backend/src/graph/migrations/002-normalize-status-values.js
```

See `backend/docs/migrations/` for detailed migration documentation.

## Troubleshooting

### Connection Errors

```
Error: Failed to connect to Neo4j
```

**Solution**: Ensure Neo4j is running:
```bash
docker-compose up -d neo4j
```

### Duplicate Key Errors

```
Error: Node already exists with label `Person` and property `person_id`
```

**Solution**: Clear the graph before loading:
```bash
node scripts/loadSmokeTests.js --clear
```

### Missing Fields

```
Error: Cannot read property 'person_id' of undefined
```

**Solution**: Check the bundle JSON for completeness. Some bundles may have incomplete data structures.

## Related Documentation

- [Graph Database Schema](../docs/02-graph-database-schema.md) - Canonical schema definition
- [Event Storage](../docs/03-event-storage.md) - Event format specification
- [Migrations](../docs/migrations/) - Database migration runbooks
- [API Server](../docs/07-api-server.md) - API endpoint documentation

## Maintenance

Smoke tests should be updated when:
- Graph schema changes (add/remove node types or relationships)
- Event format changes
- New edge cases need testing

Review and update bundles quarterly or when making breaking changes.

---

**Last Updated**: 2025-12-05
**Maintainer**: Polaris Development Team
