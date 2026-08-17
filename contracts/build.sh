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

# Locate the CDT CMake toolchain file. In CDT 4.x, add_contract() alone is
# not enough — CMake needs the toolchain up front, or it falls back to the
# system C++ compiler and hands CDT-specific flags (-abigen, -contract) to
# GCC, which errors out with "unrecognized command-line option".
#
# Priority: honour a user-supplied CDT_TOOLCHAIN_FILE env var, then ask dpkg
# where CDT installed its files, then fall back to a filesystem search.
if [ -n "$CDT_TOOLCHAIN_FILE" ]; then
    TOOLCHAIN="$CDT_TOOLCHAIN_FILE"
elif command -v dpkg >/dev/null 2>&1 && dpkg -L cdt 2>/dev/null | grep -q "toolchain.cmake"; then
    TOOLCHAIN=$(dpkg -L cdt 2>/dev/null | grep -i "toolchain.cmake" | head -1)
else
    TOOLCHAIN=$(find / -name "*Toolchain*.cmake" -path "*cdt*" 2>/dev/null | head -1)
fi

if [ -z "$TOOLCHAIN" ] || [ ! -f "$TOOLCHAIN" ]; then
    echo "ERROR: Could not find CDT CMake toolchain file." >&2
    echo "Install Antelope CDT 4.x, or set CDT_TOOLCHAIN_FILE to its path." >&2
    exit 1
fi

echo "Using CDT toolchain: $TOOLCHAIN"

# Create build directory
mkdir -p build
cd build

# Configure with CMake
cmake -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" -DCMAKE_BUILD_TYPE=Release $TESTNET_FLAG ..

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
