# Smart Contract Tag Validation

## Overview

The `put()` action now validates tags to prevent invalid or malformed tags from being stored on-chain, which previously caused transaction failures.

## Validation Rules

### Tag Count
- **Maximum**: 10 tags per event
- **Minimum**: 0 tags (optional)

### Tag Format (enforced by Antelope `name` type)
- **Characters**: Only lowercase letters (a-z), numbers (1-5), and dots (.)
- **Maximum length**: 12 characters
- **Invalid characters**: Uppercase letters, numbers 6-9, special characters (except dots)

### Tag Length (NEW - added in this fix)
- **Minimum length**: 3 characters
- **Maximum length**: 12 characters (enforced by `name` type)

## Examples

### Valid Tags
```cpp
// Single word tags
"rock"         // ✓ Valid
"jazz"         // ✓ Valid
"blues"        // ✓ Valid
"metal"        // ✓ Valid
"punk"         // ✓ Valid

// Multi-word with dots
"prog.rock"    // ✓ Valid (11 chars)
"alt.rock"     // ✓ Valid (8 chars)
"indie.pop"    // ✓ Valid (9 chars)
"death.metal"  // ✓ Valid (11 chars)

// With numbers (1-5 only)
"rock1"        // ✓ Valid
"jazz2"        // ✓ Valid
"blues3"       // ✓ Valid

// Maximum length (12 chars)
"experimental" // ✓ Valid (12 chars exactly)
"psychedelic"  // ✗ INVALID (12 chars but contains invalid chars - see below)
```

### Invalid Tags
```cpp
// Too short (< 3 chars)
"r"            // ✗ INVALID - Too short (1 char)
"rk"           // ✗ INVALID - Too short (2 chars)
""             // ✗ INVALID - Empty string

// Too long (> 12 chars)
"progressiverock"  // ✗ INVALID - Too long (16 chars)
"alternativerock"  // ✗ INVALID - Too long (16 chars)

// Invalid characters
"Rock"         // ✗ INVALID - Uppercase not allowed
"rock-metal"   // ✗ INVALID - Hyphen not allowed
"rock_metal"   // ✗ INVALID - Underscore not allowed
"rock metal"   // ✗ INVALID - Space not allowed
"rock6"        // ✗ INVALID - Number 6 not allowed (only 1-5)
"rock9"        // ✗ INVALID - Number 9 not allowed
"rock!"        // ✗ INVALID - Special character not allowed
```

## Error Messages

The contract will reject transactions with clear error messages:

### Tag Too Short
```
assertion failure with message: Tag too short (minimum 3 characters): r
```

### Tag Too Long
```
assertion failure with message: Tag too long (maximum 12 characters): progressiverock
```

### Invalid Characters (enforced by Antelope name type)
```
eosio_assert_message assertion failure: character is not in allowed character set for names
```

### Too Many Tags
```
assertion failure with message: Too many tags (max 10)
```

## Testing

### Test Cases

#### Valid Tag Submissions
```javascript
// Using cleos
cleos push action polaris put '["alice", 21, "hash123...", null, 1234567890, ["rock", "indie", "alt.rock"]]' -p alice

// Using eosjs
await contract.put({
  author: 'alice',
  type: 21,
  hash: 'hash123...',
  parent: null,
  ts: 1234567890,
  tags: ['rock', 'indie', 'alt.rock']
});
```

#### Invalid Tag Submissions (should fail)
```javascript
// Too short
cleos push action polaris put '["alice", 21, "hash123...", null, 1234567890, ["r"]]' -p alice
// Expected: "Tag too short (minimum 3 characters): r"

// Too long
cleos push action polaris put '["alice", 21, "hash123...", null, 1234567890, ["progressiverock"]]' -p alice
// Expected: "Tag too long (maximum 12 characters): progressiverock"

// Invalid characters
cleos push action polaris put '["alice", 21, "hash123...", null, 1234567890, ["Rock"]]' -p alice
// Expected: "character is not in allowed character set for names"

// Too many tags
cleos push action polaris put '["alice", 21, "hash123...", null, 1234567890, ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8", "tag9", "tag10", "tag11"]]' -p alice
// Expected: "Too many tags (max 10)"
```

## Implementation Details

### Code Location
- **File**: `contracts/polaris.music.cpp`
- **Function**: `ACTION put(...)`
- **Lines**: 80-85

### Validation Logic
```cpp
// Validate each tag format and length
for (const auto& tag : tags) {
    check(tag.length() >= 3, "Tag too short (minimum 3 characters): " + tag.to_string());
    check(tag.length() <= 12, "Tag too long (maximum 12 characters): " + tag.to_string());
    // Note: Antelope name type already validates format (a-z, 1-5, dots only)
}
```

### Why These Rules?

1. **Minimum 3 characters**: Prevents meaningless single/double letter tags that provide no semantic value
2. **Maximum 12 characters**: Enforced by Antelope `name` type design for efficient storage and indexing
3. **Limited character set**: Ensures cross-platform compatibility and efficient on-chain storage
4. **Maximum 10 tags**: Prevents storage bloat and keeps events focused

## Migration Notes

### Existing Data
- Tags created before this validation will remain valid
- No retroactive enforcement on existing anchors
- New submissions must comply with validation rules

### Frontend Integration
- Frontend should validate tags before submission to provide better UX
- Show clear error messages matching contract validation
- Consider tag autocomplete with pre-validated common tags

### Common Tag Recommendations
```
Genre tags:
- rock, pop, jazz, blues, metal, punk, folk, country, soul, funk

Style tags:
- indie, alt.rock, prog.rock, death.metal, free.jazz, folk.rock

Era tags:
- classic, modern, retro, vintage

Quality tags:
- live, studio, acoustic, electric, remix, remaster
```

## Related Issues

- Fixes: Data pipeline patch plan issue (Smart contract tag validation)
- Prevents: Transaction failures from invalid tags
- Improves: Data quality and consistency on-chain
