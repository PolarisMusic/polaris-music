#!/bin/bash
# Deploy script for Polaris Music Registry to Jungle4 testnet
# Requires Antelope CLI (cleos) and compiled contract files

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Read environment variables or use defaults
CHAIN_RPC_URL=${CHAIN_RPC_URL:-https://jungle4.greymass.com}
CONTRACT_ACCOUNT=${CONTRACT_ACCOUNT:-polarismusic}
TESTNET_PRIVATE_KEY=${TESTNET_PRIVATE_KEY}

echo -e "${GREEN}=====================================${NC}"
echo -e "${GREEN}  Polaris Music - Testnet Deployment${NC}"
echo -e "${GREEN}=====================================${NC}"
echo ""
echo "Network: Jungle4 Testnet"
echo "RPC URL: $CHAIN_RPC_URL"
echo "Contract Account: $CONTRACT_ACCOUNT"
echo ""

# Check if contract account is set
if [ -z "$CONTRACT_ACCOUNT" ]; then
    echo -e "${RED}ERROR: CONTRACT_ACCOUNT not set${NC}"
    echo "Set via: export CONTRACT_ACCOUNT=<account-name>"
    exit 1
fi

# Check if private key is set
if [ -z "$TESTNET_PRIVATE_KEY" ]; then
    echo -e "${YELLOW}WARNING: TESTNET_PRIVATE_KEY not set${NC}"
    echo "Deployment will require manual wallet unlock or permission approval"
    echo ""
fi

# Step 1: Check if build artifacts exist
echo -e "${YELLOW}[1/4] Checking build artifacts...${NC}"
if [ ! -f "build/polaris.music.wasm" ] || [ ! -f "build/polaris.music.abi" ]; then
    echo "Build artifacts not found. Running build script..."
    ./build.sh
fi

if [ -f "build/polaris.music.wasm" ] && [ -f "build/polaris.music.abi" ]; then
    echo -e "${GREEN}✓${NC} Build artifacts found"
else
    echo -e "${RED}ERROR: Build failed. Artifacts missing.${NC}"
    exit 1
fi

# Step 2: Check if cleos is installed
echo ""
echo -e "${YELLOW}[2/4] Checking cleos installation...${NC}"
if ! command -v cleos &> /dev/null; then
    echo -e "${RED}ERROR: cleos not found${NC}"
    echo "Install Antelope CLI tools: https://github.com/AntelopeIO/leap"
    exit 1
fi
echo -e "${GREEN}✓${NC} cleos is installed ($(cleos version client))"

# Step 3: Check account exists on chain
echo ""
echo -e "${YELLOW}[3/4] Verifying account exists on chain...${NC}"
if cleos -u "$CHAIN_RPC_URL" get account "$CONTRACT_ACCOUNT" &> /dev/null; then
    echo -e "${GREEN}✓${NC} Account '$CONTRACT_ACCOUNT' exists on Jungle4"
else
    echo -e "${RED}ERROR: Account '$CONTRACT_ACCOUNT' not found on chain${NC}"
    echo ""
    echo "Create account via Jungle4 faucet:"
    echo "  1. Visit: https://monitor.jungletestnet.io/#faucet"
    echo "  2. Create account and get test tokens"
    echo "  3. Set CONTRACT_ACCOUNT to your account name"
    exit 1
fi

# Step 4: Deploy contract
echo ""
echo -e "${YELLOW}[4/4] Deploying contract...${NC}"
echo "Account: $CONTRACT_ACCOUNT"
echo "WASM: build/polaris.music.wasm"
echo "ABI: build/polaris.music.abi"
echo ""

# If private key is set, import it temporarily (for CI/CD)
# Otherwise, assume user has wallet unlocked manually
if [ -n "$TESTNET_PRIVATE_KEY" ]; then
    echo "Using provided private key for deployment"
    # Note: In production, use a more secure method (e.g., keosd wallet)
    # For testnet CI/CD, we can use -p flag with key
fi

# Deploy the contract
echo "Executing deployment..."
if cleos -u "$CHAIN_RPC_URL" set contract "$CONTRACT_ACCOUNT" ./build polaris.music.wasm polaris.music.abi -p "$CONTRACT_ACCOUNT@active"; then
    echo ""
    echo -e "${GREEN}=====================================${NC}"
    echo -e "${GREEN}  ✓ Deployment Successful!${NC}"
    echo -e "${GREEN}=====================================${NC}"
    echo ""
    echo "Contract deployed to: $CONTRACT_ACCOUNT"
    echo "Network: Jungle4 Testnet"
    echo "RPC: $CHAIN_RPC_URL"
    echo ""
    echo "Verify deployment:"
    echo "  cleos -u $CHAIN_RPC_URL get code $CONTRACT_ACCOUNT"
    echo ""
    echo "Test contract actions:"
    echo "  cleos -u $CHAIN_RPC_URL push action $CONTRACT_ACCOUNT <action> '<params>' -p <account>"
    echo ""
else
    echo ""
    echo -e "${RED}=====================================${NC}"
    echo -e "${RED}  ✗ Deployment Failed${NC}"
    echo -e "${RED}=====================================${NC}"
    echo ""
    echo "Common issues:"
    echo "  - Wallet not unlocked (run: cleos wallet unlock)"
    echo "  - Insufficient permissions (account must have active permission)"
    echo "  - Network connectivity issues"
    echo "  - Insufficient RAM/NET/CPU resources"
    echo ""
    exit 1
fi
