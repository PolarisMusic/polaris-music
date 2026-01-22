# Polaris Music Registry - Frontend

Web interface for submitting music releases to the Polaris decentralized music registry.

## Features

- **Release Submission Form**: Comprehensive form for entering detailed music release information
- **Nested Data Entry**: Support for complex hierarchical data (labels, tracks, groups, members)
- **JSON Preview**: Preview and validate data before submission
- **Hash Generation**: Deterministic ID generation for all entities
- **Backend Integration**: Submit directly to Polaris API

## Structure Follows Beatles Example

The form structure matches the canonical event format from `docs/03-event-storage.md`, supporting:

- **Release Metadata**: Name, altnames, date, format, liner notes, master release tracking
- **Labels**: Multiple labels with cities and parent label relationships
- **Tracks**: Complete track information including:
  - Basic info (title, listen links, disc/side, track number)
  - **Songwriters**: Persons with roles and cities
  - **Producers**: Persons with roles and cities
  - **Performing Groups**: Groups with member lineups and roles
  - **Guest Musicians**: Non-member performers with roles
  - Cover & sample information

## Quick Start

### Prerequisites

- Node.js 18+ and npm
- Backend API running (see `../backend/README.md`)

### Installation

```bash
cd frontend
npm install
```

### Development

```bash
npm run dev
```

Opens on http://localhost:5173 with hot reload.

### Build for Production

```bash
npm run build
```

Output in `dist/` directory.

## Usage Guide

### Basic Release Submission

1. **Release Information**
   - Enter release name, date, and format
   - Add alternative names if applicable
   - Provide liner notes
   - Check "master release" if this is the original (not a reissue)

2. **Add Labels**
   - Click "+ Add Label"
   - Enter label name and city with coordinates
   - Add alternative names and parent labels if applicable

3. **Add Tracks**
   - Click "+ Add Track"
   - For each track:
     - Enter title and streaming links
     - Set disc/side and track number
     - Add songwriters with their roles
     - Add producers
     - **Add performing groups** (required):
       - Enter group name
       - Add each group member with their instruments/roles
     - Add guest musicians if applicable
     - Note cover or sample information

4. **Preview & Submit**
   - Click "Preview JSON" to see the data structure
   - Verify all information is correct
   - Click "Confirm & Submit" to send to backend

### Example: The Beatles White Album

Following the Beatles example from the docs:

1. **Release**: "The Beatles" (altname: "The White Album"), 1968-11-22, LP format
2. **Labels**: Apple Records, EMI Records, Capitol Records (all with London/LA cities)
3. **Tracks**: Each track includes:
   - **Group**: "The Beatles" with 4 members (John, Paul, George, Ringo)
   - **Members**: Each with specific roles per track (Lead Vocals, Bass Guitar, etc.)
   - **Songwriters**: Lennon-McCartney credited on most tracks
   - **Producer**: George Martin
   - **Guests**: String players on "Glass Onion", etc.

## Architecture

### Component Structure

```
frontend/
├── index.html              # Main HTML template
├── styles.css              # Complete styling
├── src/
│   ├── index.js           # App initialization & orchestration
│   ├── components/
│   │   └── FormBuilder.js # Dynamic form generation
│   └── utils/
│       ├── api.js         # Backend API client
│       └── hashGenerator.js # Deterministic ID generation
├── package.json
├── vite.config.js         # Build configuration
└── README.md
```

### Data Flow

```
User Input → FormBuilder → Hash Generation → JSON Preview → API Submission
                                                                   ↓
                                                            Backend API
                                                                   ↓
                                                      Event Store (IPFS/S3)
                                                                   ↓
                                                          Blockchain Anchoring
```

### Hash Generation

All entity IDs are deterministically generated using SHA-256:

- **Person ID**: Hash of `{ type: 'person', name, city }`
- **Group ID**: Hash of `{ type: 'group', name }`
- **Label ID**: Hash of `{ type: 'label', name, city }`
- **City ID**: Hash of `{ type: 'city', name, lat, long }`
- **Role ID**: Hash of `{ type: 'role', name }`
- **Track ID**: Hash of `{ type: 'track', title, group }`

This ensures the same entity always gets the same ID, enabling deduplication.

## Unimplemented Features (TODO)

The following features are marked as `UNIMPLEMENTED` in the code with implementation notes:

### Database Search/Autocomplete

**Location**: Multiple input fields throughout the form

**Current State**: All entity inputs are manual text entry

**Needed Implementation**:
1. Add autocomplete component for entity searches
2. Connect to backend search endpoint: `GET /api/search?type={entity}&q={query}`
3. Display matching entities with selection UI
4. Pre-fill forms with selected entity data

**Priority**: High - Would significantly improve UX and data quality

**Implementation Notes**:
```javascript
// Example autocomplete implementation
async function searchEntities(type, query) {
    const response = await fetch(`/api/search?type=${type}&q=${encodeURIComponent(query)}`);
    const results = await response.json();

    // Display results in dropdown
    // On selection, populate form with entity data
}
```

**Affected Fields**:
- Person names (songwriters, producers, members, guests)
- Group names
- Label names
- City names
- Role names
- Track names (for covers/samples)
- Master release selection

### Role Chips/Tags Interface

**Location**: `FormBuilder.js` - Role input fields

**Current State**: Comma-separated text input

**Needed Implementation**:
1. Convert to chip/tag input component
2. Add autocomplete for role names from database
3. Visual chips for selected roles
4. Easy removal/editing of individual roles

**Priority**: Medium - Improves UX but current solution works

### Multi-Select for Samples

**Location**: Track cover/sample inputs

**Current State**: Comma-separated track hash input

**Needed Implementation**:
1. Multi-select search interface for tracks
2. Display track title + group for each result
3. Selected tracks shown as chips

**Priority**: Low - Covers and samples are less common

## Customization

### Styling

All styles are in `styles.css` using CSS custom properties:

```css
:root {
    --primary-color: #2563eb;
    --primary-dark: #1e40af;
    /* ... modify as needed */
}
```

### API Endpoint

Set via environment variable:

```bash
# .env.local
VITE_API_URL=https://api.polaris.music/api
```

Default: `http://localhost:3000/api`

## Testing the Form

### Manual Testing Checklist

- [ ] Basic release info saves correctly
- [ ] Multiple labels can be added/removed
- [ ] Tracks can be added/removed
- [ ] Groups and members nested properly
- [ ] Guests appear separately from members
- [ ] JSON preview matches expected structure
- [ ] Form resets after successful submission
- [ ] Error messages display on submission failure
- [ ] Hash generation produces consistent IDs

### Sample Data

Use the Beatles White Album structure from `docs/03-event-storage.md` as test data.

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+

Uses modern JavaScript (ES6 modules, async/await, optional chaining).

## Known Limitations

1. **No offline support**: Requires active backend connection
2. **No draft saving**: Form data lost on page refresh
3. **No wallet integration**: Uses placeholder public key
4. **No validation beyond required fields**: Accepts any input format
5. **No duplicate detection**: Backend handles deduplication

## Future Enhancements

- [ ] Implement autocomplete for all entity types
- [ ] Add form draft saving to localStorage
- [ ] Integrate blockchain wallet for signatures
- [ ] Add client-side validation for dates, coordinates
- [ ] Implement role tag UI component
- [ ] Add bulk import from CSV/JSON
- [ ] Add image upload for release artwork
- [ ] Add audio player preview for listen links
- [ ] Mobile-optimized layout
- [ ] Dark mode support

## Contributing

When adding new form fields:

1. Update `FormBuilder.js` to add the input
2. Update extraction logic in `index.js`
3. Update JSON preview
4. Test with backend API
5. Update this README

## License

See [LICENSE](../LICENSE) in repository root.

## Support

For frontend issues:
- Check browser console for errors
- Verify backend is running and accessible
- Check network tab for API call failures
- Review generated JSON in preview modal

For data structure questions, see `docs/03-event-storage.md` for canonical format.
