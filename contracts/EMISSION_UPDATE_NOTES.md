# Smart Contract Emission Update - Implementation Notes

## Changes Required

### 1. Update Emission Multipliers (CRITICAL)

**Before**:
- CREATE_RELEASE_BUNDLE: 1,000,000
- ADD_CLAIM: 50,000
- EDIT_CLAIM: 1,000

**After** (to match README):
- CREATE_RELEASE_BUNDLE: 100,000,000 (100x increase)
- ADD_CLAIM: 1,000,000 (20x increase)
- EDIT_CLAIM: 1,000 (unchanged)

### 2. Add Escrow Fields to anchor Table

```cpp
TABLE anchor {
    // ... existing fields ...
    uint64_t    escrowed_amount = 0;  // Tokens minted and held in escrow
    uint64_t    submission_x = 0;     // Value of g.x at submission time

    EOSLIB_SERIALIZE(..., (escrowed_amount)(submission_x))
};
```

### 3. Add Distribution Ratios to global_state

```cpp
TABLE global_state {
    // ... existing fields ...

    // Distribution ratios (in basis points, 10000 = 100%)
    uint64_t    approved_author_pct = 4000;    // 40% to author if approved
    uint64_t    approved_voters_pct = 3000;    // 30% to voters if approved
    uint64_t    approved_stakers_pct = 3000;   // 30% to stakers if approved

    uint64_t    rejected_voters_pct = 5000;    // 50% to no-voters if rejected
    uint64_t    rejected_stakers_pct = 5000;   // 50% to stakers if rejected

    EOSLIB_SERIALIZE(..., (approved_author_pct)(approved_voters_pct)(approved_stakers_pct)
                          (rejected_voters_pct)(rejected_stakers_pct))
};
```

### 4. Modify put() Action

**Changes**:
1. Capture `submission_x = g.x` BEFORE incrementing
2. Calculate emission using submission_x
3. Mint tokens to contract (escrow) via inline action
4. Store escrowed_amount and submission_x in anchor
5. Then increment g.x
6. Update carry in globals

**Key Code**:
```cpp
// Capture submission-time x
uint64_t submission_x = g.x;

// Calculate emission
uint64_t multiplier = get_multiplier(type);
double x = static_cast<double>(submission_x);
uint64_t mint = 0;
// ... calculate mint ...

// Mint to escrow if > 0
if (mint > 0) {
    issue_tokens(get_self(), mint, "Escrow for anchor " + std::to_string(anchor_id));
}

// Store anchor with escrow data
anchors.emplace(author, [&](auto& a) {
    a.id = anchor_id;
    // ... other fields ...
    a.escrowed_amount = mint;
    a.submission_x = submission_x;
});

// NOW increment x
g.x++;
```

### 5. Modify finalize() Action

**Changes**:
1. Remove emission calculation
2. Retrieve escrowed_amount from anchor
3. Determine approval status
4. Calculate distribution shares based on ratios
5. Transfer from contract to recipients
6. Zero out escrowed_amount

**Key Code**:
```cpp
// Retrieve escrow
uint64_t escrowed_amount = anchor_itr->escrowed_amount;
if (escrowed_amount == 0) {
    // No rewards to distribute
    hash_idx.modify(anchor_itr, same_payer, [&](auto& a) {
        a.finalized = true;
    });
    return;
}

// Determine acceptance
bool accepted = (total_votes > 0) && (up_votes * 10000 >= total_votes * g.approval_threshold_bp);

// Distribute based on outcome
if (accepted) {
    distribute_rewards_approved(anchor_itr->author, tx_hash, escrowed_amount);
} else {
    distribute_rewards_rejected(tx_hash, escrowed_amount);
}

// Zero escrow and mark finalized
hash_idx.modify(anchor_itr, same_payer, [&](auto& a) {
    a.finalized = true;
    a.escrowed_amount = 0;
});
```

### 6. Add New Distribution Functions

```cpp
void distribute_rewards_approved(name author, checksum256 tx_hash, uint64_t total_amount) {
    auto g = get_globals();

    // Calculate shares
    uint64_t author_share = (total_amount * g.approved_author_pct) / 10000;
    uint64_t voters_share = (total_amount * g.approved_voters_pct) / 10000;
    uint64_t stakers_share = total_amount - author_share - voters_share;

    // Transfer to author
    if (author_share > 0) {
        transfer_tokens(author, author_share, "Approved submission reward");
    }

    // Distribute to voters (weighted by stake)
    if (voters_share > 0) {
        distribute_to_voters(tx_hash, voters_share, true); // true = up voters
    }

    // Distribute to stakers
    if (stakers_share > 0) {
        distribute_to_stakers(stakers_share);
    }
}

void distribute_rewards_rejected(checksum256 tx_hash, uint64_t total_amount) {
    auto g = get_globals();

    // Calculate shares
    uint64_t voters_share = (total_amount * g.rejected_voters_pct) / 10000;
    uint64_t stakers_share = total_amount - voters_share;

    // Distribute to voters who voted NO (down voters)
    if (voters_share > 0) {
        distribute_to_voters(tx_hash, voters_share, false); // false = down voters
    }

    // Distribute to stakers
    if (stakers_share > 0) {
        distribute_to_stakers(stakers_share);
    }
}
```

### 7. Add Configuration Action

```cpp
ACTION setdistribution(
    uint64_t approved_author_pct,
    uint64_t approved_voters_pct,
    uint64_t approved_stakers_pct,
    uint64_t rejected_voters_pct,
    uint64_t rejected_stakers_pct
) {
    require_auth(get_self());

    // Validate approved ratios sum to 10000
    check(approved_author_pct + approved_voters_pct + approved_stakers_pct == 10000,
          "Approved distribution must sum to 100%");

    // Validate rejected ratios sum to 10000
    check(rejected_voters_pct + rejected_stakers_pct == 10000,
          "Rejected distribution must sum to 100%");

    globals_singleton globals(get_self(), get_self().value);
    auto g = get_globals();

    g.approved_author_pct = approved_author_pct;
    g.approved_voters_pct = approved_voters_pct;
    g.approved_stakers_pct = approved_stakers_pct;
    g.rejected_voters_pct = rejected_voters_pct;
    g.rejected_stakers_pct = rejected_stakers_pct;

    globals.set(g, get_self());
}
```

## Testing Checklist

- [ ] Verify emission calculated at submission time
- [ ] Verify tokens minted to contract (escrow)
- [ ] Verify escrowed_amount stored in anchor
- [ ] Verify g.x increments after escrow
- [ ] Verify approved distribution ratios correct
- [ ] Verify rejected distribution ratios correct
- [ ] Verify no double-distribution (escrow zeroed)
- [ ] Verify concurrent submissions use their own x
- [ ] Verify multipliers match README values
- [ ] Verify carry mechanism still works

## Migration Notes

For existing anchors without escrow data:
- `escrowed_amount` defaults to 0
- `finalize()` will skip distribution if escrowed_amount == 0
- This gracefully handles old data

## Security Considerations

1. **Double Distribution**: Prevented by zeroing escrowed_amount
2. **Insufficient Funds**: Contract must have minted funds
3. **Overflow**: Use uint128_t for intermediate calculations
4. **Authorization**: Only contract can mint
5. **Reentrancy**: No recursive inline calls

## Performance Impact

- Slightly higher RAM usage per anchor (+16 bytes)
- Escrow mint happens during put() (may increase CPU)
- Distribution logic more complex (split into approved/rejected)
- Overall: Acceptable trade-off for economic correctness
