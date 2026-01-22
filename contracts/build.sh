#!/bin/bash

# Build script for Polaris Music Registry smart contract
# Requires Antelope CDT to be installed

set -e

echo "Building Polaris Music Registry Contract..."

# Create build directory
mkdir -p build
cd build

# Configure with CMake
cmake -DCMAKE_BUILD_TYPE=Release ..

# Build the contract
make

echo ""
echo "Build complete! Contract files:"
echo "  - polaris.music.wasm"
echo "  - polaris.music.abi"
echo ""
echo "To deploy to testnet:"
echo "  cleos set contract <account> ./build polaris.music.wasm polaris.music.abi"
