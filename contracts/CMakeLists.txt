cmake_minimum_required(VERSION 3.5)
project(polaris_music_contracts VERSION 1.0.0)

find_package(cdt REQUIRED)

# Polaris Music Registry contract
add_contract(polaris.music polaris.music polaris.music.cpp)
target_include_directories(polaris.music PUBLIC ${CMAKE_SOURCE_DIR})

# Testnet build option (includes clear() action)
# WARNING: Do NOT use for production builds
option(TESTNET "Enable testnet-only features (clear() action)" OFF)
if(TESTNET)
    message(WARNING "TESTNET mode enabled - clear() action will be included")
    target_compile_definitions(polaris.music PUBLIC TESTNET)
endif()

# Compile options for WASM and ABI generation
target_compile_options(polaris.music PUBLIC
    -abigen  # Generate ABI file
    -abigen_output=${CMAKE_CURRENT_BINARY_DIR}/polaris.music.abi  # ABI output path
)

# Ricardian contracts (optional)
target_ricardian_directory(polaris.music ${CMAKE_SOURCE_DIR}/ricardian)
