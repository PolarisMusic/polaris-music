cmake_minimum_required(VERSION 3.5)
project(polaris_music_contracts VERSION 1.0.0)

find_package(cdt REQUIRED)

# Polaris Music Registry contract
add_contract(polaris.music polaris.music polaris.music.cpp)
target_include_directories(polaris.music PUBLIC ${CMAKE_SOURCE_DIR})

# Ricardian contracts (optional)
target_ricardian_directory(polaris.music ${CMAKE_SOURCE_DIR}/ricardian)
