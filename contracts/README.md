# Polaris Music Registry - Smart Contract

This directory contains the Antelope (EOS/WAX/UX/Telos) smart contract for the Polaris Music Registry.

## Overview

The Polaris smart contract handles:
- **Event Anchoring**: On-chain hashing of off-chain music data events
- **Respect-Weighted Voting**: Community voting powered by Fractally Respect values
- **Token Staking**: Support music entities by staking MUS tokens
- **Reward Distribution**: Logarithmic emission curve for contributor rewards
- **Attestation System**: Expert verification for high-value submissions

## Prerequisites

- [Antelope CDT](https://github.com/AntelopeIO/cdt) 4.0 or later
- CMake 3.5+
- An Antelope testnet account for deployment

### Installing Antelope CDT

```bash
# Download latest CDT from GitHub releases
wget https://github.com/AntelopeIO/cdt/releases/download/v4.0.0/cdt_4.0.0_amd64.deb

# Install (Ubuntu/Debian)
sudo apt install ./cdt_4.0.0_amd64.deb

# Verify installation
cdt-cpp --version
```

## Building the Contract

### Quick Build

```bash
./build.sh
```

### Manual Build

```bash
mkdir -p build
cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
make
```

The build produces:
- `polaris.music.wasm` - Contract bytecode
- `polaris.music.abi` - Application Binary Interface

## Testing Locally

### Start Local Testnet

```bash
# Using nodeos (requires EOSIO or Antelope installation)
nodeos -e -p eosio \
  --plugin eosio::producer_plugin \
  --plugin eosio::chain_api_plugin \
  --plugin eosio::http_plugin \
  --access-control-allow-origin='*' \
  --contracts-console \
  --http-validate-host=false \
  --verbose-http-errors
```

### Create Test Accounts

```bash
# Create contract account
cleos create account eosio polaris EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV

# Create test user accounts
cleos create account eosio alice EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV
cleos create account eosio bob EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV
cleos create account eosio fractally EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV

# Create token contract account
cleos create account eosio eosio.token EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV
```

### Deploy Token Contract

```bash
# Deploy eosio.token contract (for MUS token)
cleos set contract eosio.token /path/to/eosio.contracts/contracts/eosio.token

# Create MUS token
cleos push action eosio.token create '["polaris", "1000000000.0000 MUS"]' -p eosio.token

# Issue tokens for testing
cleos push action eosio.token issue '["alice", "10000.0000 MUS", "initial supply"]' -p polaris
cleos push action eosio.token issue '["bob", "10000.0000 MUS", "initial supply"]' -p polaris
```

### Deploy Polaris Contract

```bash
# Set contract code and ABI
cleos set contract polaris ./build polaris.music.wasm polaris.music.abi -p polaris

# Initialize contract
cleos push action polaris init '["fractally", "eosio.token"]' -p polaris
```

## Usage Examples

### Anchor an Event

```bash
# Create a hash (in real usage, this comes from the off-chain event)
HASH="0000000000000000000000000000000000000000000000000000000000000001"

# IPFS CID of the full signed event JSON (returned by /api/events/create)
EVENT_CID="bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenpcqywm4"

# Submit a release bundle event
# put(author, type, hash, event_cid, parent, ts, tags)
cleos push action polaris put '[
  "alice",
  21,
  "'$HASH'",
  "'$EVENT_CID'",
  null,
  '$(date +%s)',
  ["rock", "album", "1970s"]
]' -p alice
```

### Attest to Submission

```bash
# Fractally oracle attests
cleos push action polaris attest '[
  "fractally",
  "'$HASH'",
  21
]' -p fractally
```

### Vote on Submission

```bash
# Update Respect values first
cleos push action polaris updaterespect '[
  [["alice", 50], ["bob", 30]],
  1
]' -p fractally

# Alice votes to approve
cleos push action polaris vote '["alice", "'$HASH'", 1]' -p alice

# Bob votes to approve
cleos push action polaris vote '["bob", "'$HASH'", 1]' -p bob
```

### Finalize After Voting Window

```bash
# Wait for voting window to close (or modify expires_at for testing)
# Then finalize
cleos push action polaris finalize '["'$HASH'"]' -p alice
```

### Stake on a Node

```bash
# Node ID (hash of Group, Person, etc.)
NODE_ID="1111111111111111111111111111111111111111111111111111111111111111"

# Alice stakes 100 MUS on a group
cleos push action eosio.token transfer '["alice", "polaris", "100.0000 MUS", "stake"]' -p alice
cleos push action polaris stake '["alice", "'$NODE_ID'", "100.0000 MUS"]' -p alice
```

### Query Tables

```bash
# View anchored events
cleos get table polaris polaris anchors

# View votes
cleos get table polaris polaris votes

# View Respect values
cleos get table polaris polaris respect

# View stakes for an account
cleos get table polaris alice stakes

# View stake aggregates
cleos get table polaris polaris nodeagg

# View global state
cleos get table polaris polaris globals
```

## Deploying to Testnet

### EOS Testnet (Jungle 4)

```bash
# Set endpoint
cleos -u https://jungle4.cryptolions.io:443 wallet unlock

# Deploy contract
cleos -u https://jungle4.cryptolions.io:443 \
  set contract <your-account> ./build polaris.music.wasm polaris.music.abi \
  -p <your-account>@active
```

### Other Testnets

- **WAX Testnet**: https://testnet.waxsweden.org
- **Telos Testnet**: https://testnet.telos.net
- **UX Testnet**: https://testnet.uxnetwork.io

## Contract Actions Reference

| Action | Description | Authorization |
|--------|-------------|---------------|
| `put` | Anchor an off-chain event | Submitter |
| `attest` | Attest to submission validity | Authorized attestor |
| `vote` | Cast Respect-weighted vote | Voter |
| `finalize` | Complete voting and distribute rewards | Anyone (after window) |
| `stake` | Stake tokens on a node | Staker |
| `unstake` | Remove stake from a node | Staker |
| `like` | Like an entity with path tracking | User |
| `unlike` | Remove a like | User |
| `updaterespect` | Update Respect from Fractally | Oracle only |
| `setoracle` | Set Fractally oracle account | Contract only |
| `init` | Initialize contract | Contract only |
| `clear` | Clear all data (**TESTNET only** - compiled out in production via `#ifdef TESTNET`) | Contract only |

## Event Types

| Code | Type | Voting Window | Multiplier | Attestation Required |
|------|------|---------------|------------|---------------------|
| 21 | CREATE_RELEASE_BUNDLE | 7 days | 1,000,000 | Yes |
| 30 | ADD_CLAIM | 3 days | 50,000 | No |
| 31 | EDIT_CLAIM | 3 days | 1,000 | No |
| 40 | VOTE | N/A | 0 | No |
| 41 | LIKE | N/A | 0 | No |
| 42 | DISCUSS | 1 day | 0 | No |
| 50 | FINALIZE | N/A | 0 | No |
| 60 | MERGE_NODE | 5 days | 10,000 | No |

## Emission Formula

Rewards follow a logarithmic decay curve:

```
g(x) = m * ln(x) / x
```

Where:
- `x` = Global submission number
- `m` = Event type multiplier
- `g(x)` = Tokens to mint for this submission

This ensures early contributors receive higher rewards while maintaining long-term sustainability.

## Distribution Logic

### Accepted Submissions (≥90% approval)
- 50% to submitter
- 50% to voters (proportional to Respect weight)

### Rejected Submissions (<90% approval)
- 50% to voters (proportional to Respect weight)
- 50% to stakers (proportional to stake amount)

## Security Considerations

1. **Duplicate Prevention**: Event hashes are checked for uniqueness
2. **Timestamp Validation**: Events can't be too far in future (max 5 min)
3. **Vote Weight Capping**: Individual Respect capped at 100 to prevent whale control
4. **Attestation Requirements**: High-value submissions require expert verification
5. **Voting Windows**: Time-bound voting prevents indefinite uncertainty
6. **`clear()` Action Safety**: The `clear()` action is protected by multiple layers:
   - **Compile-time**: Only included when compiled with `-DTESTNET` flag (`#ifdef TESTNET`)
   - **Runtime**: Fails if >100 anchors exist (detects production data)
   - **Runtime**: Fails if any tokens are staked (prevents destroying value)
   - **Authorization**: Requires contract authority (`require_auth(get_self())`)
   - **Production builds** must NOT use `-DTESTNET`; verify `clear` is absent from ABI before deployment

## Upgradeability

Smart contracts on Antelope are upgradeable by the account owner. For production:

1. Transfer contract ownership to a multisig or DAO
2. Require community approval for upgrades
3. Consider time-locks on critical changes
4. Maintain backwards compatibility when possible

## Mainnet Deployment Checklist

Before deploying to mainnet:

- [ ] Compile WITHOUT `-DTESTNET` flag (this automatically excludes the `clear()` action)
- [ ] Verify `clear` does NOT appear in the generated ABI file
- [ ] Set proper Fractally oracle account
- [ ] Configure correct token contract
- [ ] Test all actions on testnet
- [ ] Audit emission calculations
- [ ] Verify Respect weight logic
- [ ] Test edge cases (0 votes, ties, etc.)
- [ ] Set up monitoring for contract activity
- [ ] Prepare RAM resources for tables
- [ ] Document operational procedures

## Resources

- [Antelope Documentation](https://docs.antelope.io/)
- [CDT Reference](https://docs.antelope.io/cdt/latest/)
- [Smart Contract Best Practices](https://cc32d9.gitbook.io/antelope-smart-contract-developers-handbook)
- [Polaris Music Registry Docs](../docs/)

## License

See [LICENSE](../LICENSE) in repository root.

## Support

For contract-related questions:
- Review documentation in `../docs/01-smart-contract.md`
- Check test cases for usage examples
- Open an issue in the main repository
