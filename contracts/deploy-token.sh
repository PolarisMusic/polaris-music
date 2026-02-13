#!/bin/bash
# Deploy script for MUS token contract to Jungle4 testnet
# Requires Antelope CLI (cleos) and eosio.token contract files

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=====================================${NC}"
echo -e "${BLUE}  Deploy MUS Token Contract${NC}"
echo -e "${BLUE}  Jungle4 Testnet${NC}"
echo -e "${BLUE}=====================================${NC}"
echo ""

# Load environment variables (attempt from parent .env)
if [ -f "../.env" ]; then
    source ../.env 2>/dev/null || true
fi

# Read environment variables or use defaults
RPC_URL=${CHAIN_RPC_URL:-https://jungle4.greymass.com}
TOKEN_ACCOUNT=${TOKEN_CONTRACT_ACCOUNT:-polaristoken}
POLARIS_ACCOUNT=${CONTRACT_ACCOUNT:-polarismusic}
PRIVATE_KEY=${TESTNET_PRIVATE_KEY}

echo "Network: Jungle4 Testnet"
echo "RPC URL: $RPC_URL"
echo "Token Account: $TOKEN_ACCOUNT"
echo "Polaris Account: $POLARIS_ACCOUNT"
echo ""

# Validate required environment variables
if [ -z "$PRIVATE_KEY" ]; then
    echo -e "${RED}ERROR: TESTNET_PRIVATE_KEY not set${NC}"
    echo "Set via: export TESTNET_PRIVATE_KEY=5K..."
    exit 1
fi

if [ -z "$TOKEN_ACCOUNT" ]; then
    echo -e "${RED}ERROR: TOKEN_CONTRACT_ACCOUNT not set${NC}"
    echo "Set via: export TOKEN_CONTRACT_ACCOUNT=polaristoken"
    exit 1
fi

if [ -z "$POLARIS_ACCOUNT" ]; then
    echo -e "${RED}ERROR: CONTRACT_ACCOUNT not set${NC}"
    echo "Set via: export CONTRACT_ACCOUNT=polarismusic"
    exit 1
fi

# Step 1: Verify cleos is installed
echo -e "${YELLOW}[1/5] Checking cleos installation...${NC}"
if ! command -v cleos &> /dev/null; then
    echo -e "${RED}ERROR: cleos not found${NC}"
    echo "Install Antelope CLI tools: https://github.com/AntelopeIO/leap"
    exit 1
fi
echo -e "${GREEN}✓${NC} cleos is installed ($(cleos version client))"
echo ""

# Step 2: Verify accounts exist on chain
echo -e "${YELLOW}[2/5] Verifying accounts exist on chain...${NC}"

if cleos -u "$RPC_URL" get account "$TOKEN_ACCOUNT" &> /dev/null; then
    echo -e "${GREEN}✓${NC} Token account '$TOKEN_ACCOUNT' exists"
else
    echo -e "${RED}ERROR: Account '$TOKEN_ACCOUNT' not found${NC}"
    echo ""
    echo "Create token account via Jungle4 faucet:"
    echo "  1. Visit: https://monitor.jungletestnet.io/#faucet"
    echo "  2. Create account: $TOKEN_ACCOUNT"
    exit 1
fi

if cleos -u "$RPC_URL" get account "$POLARIS_ACCOUNT" &> /dev/null; then
    echo -e "${GREEN}✓${NC} Polaris account '$POLARIS_ACCOUNT' exists"
else
    echo -e "${RED}ERROR: Account '$POLARIS_ACCOUNT' not found${NC}"
    echo "Deploy Polaris contract first (./deploy-testnet.sh)"
    exit 1
fi
echo ""

# Step 3: Check for eosio.token contract files
echo -e "${YELLOW}[3/5] Checking for eosio.token contract files...${NC}"
if [ ! -f "eosio.token.wasm" ] || [ ! -f "eosio.token.abi" ]; then
    echo -e "${RED}ERROR: eosio.token.wasm and/or eosio.token.abi not found${NC}"
    echo ""
    echo "You need to provide the eosio.token contract files:"
    echo "  1. Download from: https://github.com/AntelopeIO/reference-contracts"
    echo "  2. Place eosio.token.wasm and eosio.token.abi in contracts/ directory"
    echo ""
    echo "Or build from source:"
    echo "  git clone https://github.com/AntelopeIO/reference-contracts"
    echo "  cd reference-contracts/contracts/eosio.token"
    echo "  mkdir build && cd build"
    echo "  cmake .. && make"
    echo "  cp eosio.token.wasm eosio.token.abi /path/to/polaris-music/contracts/"
    exit 1
fi
echo -e "${GREEN}✓${NC} eosio.token contract files found"
echo ""

# Step 4: Deploy eosio.token contract to token account
echo -e "${YELLOW}[4/5] Deploying eosio.token contract...${NC}"
echo "Deploying to: $TOKEN_ACCOUNT"
echo ""

if cleos -u "$RPC_URL" set contract "$TOKEN_ACCOUNT" . eosio.token.wasm eosio.token.abi -p "$TOKEN_ACCOUNT" --private-key "$PRIVATE_KEY"; then
    echo -e "${GREEN}✓${NC} Token contract deployed successfully"
else
    echo -e "${RED}ERROR: Failed to deploy token contract${NC}"
    exit 1
fi
echo ""

# Step 5: Create MUS token (max supply: 1 billion)
echo -e "${YELLOW}[5/5] Creating MUS token...${NC}"
echo "Issuer: $POLARIS_ACCOUNT"
echo "Max Supply: 1,000,000,000.0000 MUS"
echo ""

# Check if token already exists
if cleos -u "$RPC_URL" get currency stats "$TOKEN_ACCOUNT" MUS 2>/dev/null | grep -q "MUS"; then
    echo -e "${YELLOW}⚠${NC}  MUS token already exists, skipping creation"
else
    if cleos -u "$RPC_URL" push action "$TOKEN_ACCOUNT" create "[\"$POLARIS_ACCOUNT\", \"1000000000.0000 MUS\"]" -p "$TOKEN_ACCOUNT" --private-key "$PRIVATE_KEY"; then
        echo -e "${GREEN}✓${NC} MUS token created successfully"
    else
        echo -e "${RED}ERROR: Failed to create MUS token${NC}"
        exit 1
    fi
fi
echo ""

# Final step: Inform about Polaris initialization
echo -e "${GREEN}=====================================${NC}"
echo -e "${GREEN}  ✓ Token Deployment Complete!${NC}"
echo -e "${GREEN}=====================================${NC}"
echo ""
echo "Token Contract: $TOKEN_ACCOUNT"
echo "Token Issuer: $POLARIS_ACCOUNT"
echo "Network: Jungle4 Testnet"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo ""
echo "1. Initialize Polaris contract with token account:"
echo "   cleos -u $RPC_URL push action $POLARIS_ACCOUNT init \\"
echo "     '[\"<oracle_account>\", \"$TOKEN_ACCOUNT\"]' \\"
echo "     -p $POLARIS_ACCOUNT --private-key \$TESTNET_PRIVATE_KEY"
echo ""
echo "2. Verify token creation:"
echo "   cleos -u $RPC_URL get currency stats $TOKEN_ACCOUNT MUS"
echo ""
echo "3. Test token issuance (Polaris contract can now issue MUS):"
echo "   # MUS will be issued automatically when rewards are distributed via finalize()"
echo ""
