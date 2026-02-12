#!/bin/bash

# Build script for Polaris Music Registry smart contract
# Requires Antelope CDT to be installed

set -e

# Parse command-line arguments
TESTNET_FLAG=""
if [ "$1" = "--testnet" ]; then
    TESTNET_FLAG="-DTESTNET=ON"
    echo "⚠️  TESTNET BUILD MODE - clear() action will be included"
    echo ""
fi

echo "Building Polaris Music Registry Contract..."

# Create build directory
mkdir -p build
cd build

# Configure with CMake
cmake -DCMAKE_BUILD_TYPE=Release $TESTNET_FLAG ..

# Build the contract
make

echo ""
echo "Build complete! Contract files:"
echo "  - polaris.music.wasm"
echo "  - polaris.music.abi"
echo ""
if [ -n "$TESTNET_FLAG" ]; then
    echo "⚠️  Testnet build - Verify clear() is present in ABI (for testnet only)"
    echo ""
fi
echo "To deploy to testnet:"
echo "  cleos set contract <account> ./build polaris.music.wasm polaris.music.abi"
echo ""
echo "For production builds:"
echo "  - Do NOT use --testnet flag"
echo "  - Verify clear() is NOT in the ABI before deployment"
