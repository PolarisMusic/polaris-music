# Polaris Music Registry - Data Import Tools

Utilities for importing music data from external sources into the Polaris Music Registry.

## Status: Stub Implementation

⚠️ **NOTE**: These tools are currently stub implementations with TODO markers.

Full implementation specifications are available in `/docs/10-data-import-tools.md`.

## Available Tools

### 1. Discogs Importer (`import/discogsImporter.js`)

Import releases and artists from the Discogs database API.

**Features to Implement**:
- Discogs API client with rate limiting (60 requests/minute)
- Release data transformation to Polaris event format
- Artist/Group mapping and deduplication
- Batch import with progress tracking
- Error handling and retry logic

**Usage** (when implemented):
```javascript
import { DiscogsImporter } from './tools/import/discogsImporter.js';

const importer = new DiscogsImporter(process.env.DISCOGS_API_KEY);

// Import a single release
await importer.importRelease(249504); // Beatles White Album

// Import an artist
await importer.importArtist(82730); // The Beatles
```

### 2. CSV Importer (`import/csvImporter.js`)

Import releases, tracks, and artists from CSV files.

**Features to Implement**:
- CSV parsing with validation
- Batch processing (configurable batch size)
- Error handling and partial import recovery
- Support for multiple CSV formats

**CSV Formats**:

`releases.csv`:
```csv
release_name,release_date,label_name,label_city,format,liner_notes
The Beatles,1968-11-22,Apple Records,London,LP,"Double album..."
```

`tracks.csv`:
```csv
track_title,release_id,disc_side,track_number,duration
Back in the U.S.S.R.,<release_hash>,1,1,165
```

**Usage** (when implemented):
```javascript
import { CSVImporter } from './tools/import/csvImporter.js';

const importer = new CSVImporter({ batchSize: 100 });
const stats = await importer.importReleases('./data/releases.csv');

console.log(`Imported ${stats.success} releases, ${stats.errors} errors`);
```

### 3. Migration Tool (`migration/migrate.js`)

Handle database schema migrations and data transformations.

**Features to Implement**:
- Neo4j schema versioning
- Forward (up) and rollback (down) migrations
- Data transformation utilities
- Migration history tracking in database

**Usage** (when implemented):
```javascript
import { MigrationTool } from './tools/migration/migrate.js';

const migrator = new MigrationTool();

// Run pending migrations
await migrator.up();

// Check status
const status = await migrator.status();
console.log(status);

// Rollback last migration
await migrator.down();

// Create new migration
await migrator.create('add-genre-support');
```

## Implementation Guide

To implement these tools, refer to the detailed specifications in `/docs/10-data-import-tools.md`.

### Implementation Priority

1. **DiscogsImporter** (High Priority)
   - Most useful for bootstrapping the registry with real data
   - Discogs has comprehensive music metadata
   - API is well-documented and stable

2. **CSVImporter** (Medium Priority)
   - Useful for custom data sources
   - Simpler to implement than API integration
   - Good for testing and development

3. **MigrationTool** (Low Priority)
   - Needed as schema evolves
   - Can be deferred until schema is more stable
   - Graph databases handle schema changes more flexibly than SQL

### Dependencies to Add

When implementing, add these dependencies to package.json:

```json
{
  "dependencies": {
    "axios": "^1.6.0",           // HTTP client for APIs
    "csv-parser": "^3.0.0",      // CSV parsing
    "papaparse": "^5.4.0",       // Alternative CSV parser
    "p-queue": "^7.4.0",         // Rate limiting queue
    "progress": "^2.0.3"         // Progress bars for CLI
  }
}
```

### Environment Variables

```bash
# For Discogs Importer
DISCOGS_API_KEY=your_api_key_here
DISCOGS_USER_AGENT=PolarisMusic/1.0

# Rate limiting
IMPORT_RATE_LIMIT=60          # requests per minute
IMPORT_BATCH_SIZE=100         # items per batch
```

### Testing

Each tool should have corresponding tests:

```
backend/test/tools/
├── discogsImporter.test.js
├── csvImporter.test.js
└── migrate.test.js
```

Use mock data and fixtures from `backend/test/fixtures/`.

## Contributing

When implementing these tools:

1. Follow the specification in `/docs/10-data-import-tools.md`
2. Write comprehensive tests
3. Add error handling and logging
4. Document edge cases and limitations
5. Update this README with actual usage examples

## Examples

See `/docs/10-data-import-tools.md` for:
- Complete implementation examples
- API response transformations
- Error handling patterns
- Data validation logic

## Support

For questions or issues:
- Check `/docs/10-data-import-tools.md` for detailed specifications
- Review test fixtures in `/backend/test/fixtures/`
- See CLAUDE.md for development guidelines
