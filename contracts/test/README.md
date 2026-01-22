# Polaris Music Registry Smart Contract Tests

Comprehensive unit tests for the Polaris smart contract (`polaris.music.cpp`).

## Test Coverage

### Critical Functionality
- ✅ Contract initialization and validation
- ✅ Event anchoring (`put` action)
- ✅ Voting and finalization
- ✅ Respect management
- ✅ Staking/unstaking
- ✅ Like system
- ✅ Governance parameter configuration

### Regression Tests (Fixed Bugs)
- ✅ **CRITICAL-1**: Infinite loop in `clear()` (line 578)
- ✅ **CRITICAL-2**: Stale iterator in stake count (line 472)
- ✅ **CRITICAL-3**: Stale iterator in like count (line 200)
- ✅ **HIGH**: Integer overflow in reward distribution
- ✅ **HIGH**: Floating point consensus issue (basis points)
- ✅ **MEDIUM**: Parent hash validation
- ✅ **MEDIUM**: Governance parameters configurable
- ✅ **LOW**: Timestamp validation
- ✅ **LOW**: Election round increment validation

## Setup

### Prerequisites

1. **Local Antelope/EOS Testnet** (one of):
   - [Nodeos](https://github.com/AntelopeIO/leap) (local node)
   - [EOS Local](https://github.com/eoscostarica/eos-local) (Docker-based)
   - [EOSIO Testnet](https://testnet.eos.io/) (remote testnet)

2. **Node.js** (v14+):
   ```bash
   node --version  # Should be v14 or higher
   ```

3. **Install Dependencies**:
   ```bash
   cd contracts/test
   npm install
   ```

### Contract Deployment

Before running tests, deploy the contract to your testnet:

```bash
# Build contract (from project root)
cd contracts
eosio-cpp -abigen polaris.music.cpp -o polaris.music.wasm

# Create contract account (if not exists)
cleos create account eosio polaris <PUBLIC_KEY>

# Deploy contract
cleos set contract polaris . polaris.music.wasm polaris.music.abi

# Create test accounts
cleos create account eosio alice <PUBLIC_KEY>
cleos create account eosio bob <PUBLIC_KEY>
cleos create account eosio charlie <PUBLIC_KEY>
cleos create account eosio dave <PUBLIC_KEY>
cleos create account eosio oracle <PUBLIC_KEY>
```

## Running Tests

### All Tests
```bash
npm test
```

### Watch Mode (auto-rerun on changes)
```bash
npm run test:watch
```

### Verbose Output
```bash
npm run test:verbose
```

### Specific Test Suite
```bash
npx mocha polaris.test.js --grep "Contract Initialization"
npx mocha polaris.test.js --grep "Governance Parameters"
```

## Test Structure

```
contracts/test/
├── polaris.test.js        # Main test suite
├── package.json          # Dependencies and scripts
├── README.md            # This file
└── unit/                # Unit tests (mock-based, no blockchain)
    └── validation.test.js  # Pure logic tests
```

## Configuration

Tests connect to local testnet by default:
- **RPC Endpoint**: `http://127.0.0.1:8888`
- **Contract Account**: `polaris`
- **Oracle Account**: `oracle`

To use a different testnet:
```bash
RPC_ENDPOINT=https://testnet.example.com npm test
```

## Test Accounts

Tests use these accounts (must exist on testnet):
- `polaris` - Contract account
- `oracle` - Fractally oracle
- `alice`, `bob`, `charlie`, `dave` - Test users

## Writing New Tests

Example test case:

```javascript
it('should validate my new feature', async function() {
    const result = await contractApi.transact({
        actions: [{
            account: CONTRACT_ACCOUNT,
            name: 'myaction',
            authorization: [{
                actor: 'alice',
                permission: 'active'
            }],
            data: {
                // action parameters
            }
        }]
    }, {
        blocksBehind: 3,
        expireSeconds: 30
    });

    expect(result).to.have.property('transaction_id');

    // Verify state changes
    const table = await rpc.get_table_rows({
        json: true,
        code: CONTRACT_ACCOUNT,
        scope: CONTRACT_ACCOUNT,
        table: 'mytable',
        limit: 10
    });

    expect(table.rows).to.have.lengthOf(1);
});
```

## Continuous Integration

For CI/CD pipelines, use Docker-based testnet:

```bash
# Start testnet
docker run -d --name eosio -p 8888:8888 eosio/eos:latest

# Run tests
npm test

# Cleanup
docker stop eosio && docker rm eosio
```

## Troubleshooting

### "Connection refused" errors
- Ensure local testnet is running: `cleos get info`
- Check RPC endpoint configuration

### "Account does not exist" errors
- Create test accounts before running tests
- Use setup script: `./scripts/setup-testnet.sh`

### "Transaction took too long" errors
- Increase test timeout: `--timeout 60000`
- Check testnet performance

### "Contract not found" errors
- Deploy contract before testing
- Verify contract account name matches

## Test Coverage Report

Run with coverage (requires `nyc`):

```bash
npm install --save-dev nyc
npx nyc mocha polaris.test.js
```

## Performance Benchmarks

Expected test execution times (local testnet):
- Initialization tests: < 5 seconds
- Event anchoring: < 10 seconds
- Voting/finalization: < 15 seconds (includes time manipulation)
- Full suite: < 2 minutes

## Contributing

When adding new contract features:

1. **Write tests first** (TDD approach)
2. **Cover edge cases** (validation errors, boundary conditions)
3. **Add regression tests** for any bugs fixed
4. **Update this README** with new test descriptions

## License

MIT License - See LICENSE file for details
