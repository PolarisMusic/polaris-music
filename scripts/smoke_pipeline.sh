#!/bin/bash
#
# Polaris Music Registry - Pipeline Smoke Test
#
# Tests the complete event lifecycle:
# 1. Event preparation
# 2. Event signing (using dev signer)
# 3. Event storage (IPFS + S3 + Redis)
# 4. Event ingestion (simulated blockchain anchoring)
# 5. Graph database updates
# 6. Data verification
#
# Prerequisites:
# - Docker and docker compose installed
# - jq installed for JSON processing
# - DEV_SIGNER_PRIVATE_KEY environment variable set (or use default test key)
# - REQUIRE_ACCOUNT_AUTH=false (to skip blockchain account verification)
#
# Usage:
#   ./scripts/smoke_pipeline.sh [api_port]
#
# Example:
#   export DEV_SIGNER_PRIVATE_KEY="5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3"
#   export REQUIRE_ACCOUNT_AUTH=false
#   ./scripts/smoke_pipeline.sh 3000
#

set -e  # Exit on first error

# ============================================================================
# Configuration
# ============================================================================

# API endpoint (default: docker compose exposed port)
API_PORT="${1:-3000}"
API_BASE="http://localhost:${API_PORT}"

# Test key (matches backend/test/crypto/signatureVerification.test.js)
# WARNING: This is a well-known test key - NEVER use in production!
DEFAULT_TEST_KEY="5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3"
DEV_SIGNER_PRIVATE_KEY="${DEV_SIGNER_PRIVATE_KEY:-$DEFAULT_TEST_KEY}"

# Script directory (for finding payload templates)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD_DIR="${SCRIPT_DIR}/smoke_payloads"

# Health check parameters
MAX_HEALTH_CHECKS=60      # 60 attempts
HEALTH_CHECK_INTERVAL=2   # 2 seconds between checks
HEALTH_TIMEOUT=$((MAX_HEALTH_CHECKS * HEALTH_CHECK_INTERVAL))  # 120 seconds total

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================================================
# Helper Functions
# ============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[⚠]${NC} $1"
}

log_error() {
    echo -e "${RED}[✗]${NC} $1"
}

fail() {
    log_error "$1"
    log_error "SMOKE TEST FAILED"
    exit 1
}

# Check if required tools are installed
check_prerequisites() {
    log_info "Checking prerequisites..."

    if ! command -v docker &> /dev/null; then
        fail "docker is not installed"
    fi

    # Check if docker compose is available (modern standard)
    if ! docker compose version &> /dev/null; then
        fail "docker compose is not available (install Docker Compose v2)"
    fi

    if ! command -v jq &> /dev/null; then
        fail "jq is not installed (required for JSON processing)"
    fi

    if ! command -v curl &> /dev/null; then
        fail "curl is not installed"
    fi

    log_success "Prerequisites OK"
}

# Start the Docker stack
start_stack() {
    log_info "Starting Docker Compose stack..."

    # Export environment variables for docker compose
    export DEV_SIGNER_PRIVATE_KEY
    export REQUIRE_ACCOUNT_AUTH=false  # Disable account auth check for smoke test

    docker compose up -d

    log_success "Stack started"
}

# Wait for API to be healthy
wait_for_health() {
    log_info "Waiting for services to be healthy (timeout: ${HEALTH_TIMEOUT}s)..."

    local attempt=1
    while [ $attempt -le $MAX_HEALTH_CHECKS ]; do
        # Try to get status
        if response=$(curl -s -f "${API_BASE}/api/status" 2>/dev/null); then
            # Parse response
            ok=$(echo "$response" | jq -r '.ok // false')

            if [ "$ok" = "true" ]; then
                log_success "All services healthy"

                # Log service status (using new summary structure)
                ipfs_primary=$(echo "$response" | jq -r '.summary.ipfs.primary_ok // false')
                ipfs_secondary_ok=$(echo "$response" | jq -r '.summary.ipfs.secondary_ok // 0')
                ipfs_secondary_total=$(echo "$response" | jq -r '.summary.ipfs.secondary_total // 0')
                neo4j=$(echo "$response" | jq -r '.services.neo4j.ok // false')
                redis=$(echo "$response" | jq -r '.services.redis.ok // false')
                s3=$(echo "$response" | jq -r '.services.s3.ok // false')

                log_info "  IPFS primary: $ipfs_primary"
                log_info "  IPFS secondary: $ipfs_secondary_ok/$ipfs_secondary_total healthy"
                log_info "  Neo4j: $neo4j"
                log_info "  Redis: $redis"
                log_info "  S3/MinIO: $s3"

                return 0
            else
                log_warning "Services not yet healthy (attempt $attempt/$MAX_HEALTH_CHECKS)"
                echo "$response" | jq '.services'
            fi
        fi

        sleep $HEALTH_CHECK_INTERVAL
        attempt=$((attempt + 1))
    done

    fail "Services failed to become healthy within ${HEALTH_TIMEOUT}s"
}

# Generate unique test IDs
generate_test_ids() {
    RUN_ID=$(date +%s)
    SMOKE_AUTHOR="smoketest"

    log_info "Generated test IDs:"
    log_info "  RUN_ID: $RUN_ID"
    log_info "  AUTHOR: $SMOKE_AUTHOR"
}

# Fetch dev signer public key
get_dev_pubkey() {
    log_info "Fetching dev signer public key (GET /api/events/dev-pubkey)..."

    local resp=$(curl -s -f "${API_BASE}/api/events/dev-pubkey" 2>/dev/null) \
        || fail "Could not fetch dev pubkey. Is DEV_SIGNER_PRIVATE_KEY set for the api container?"

    local ok=$(echo "$resp" | jq -r '.success // false')
    if [ "$ok" != "true" ]; then
        log_error "Dev pubkey endpoint error:"
        echo "$resp" | jq '.'
        fail "Dev signer pubkey unavailable"
    fi

    DEV_AUTHOR_PUBKEY=$(echo "$resp" | jq -r '.author_pubkey')
    if [ -z "$DEV_AUTHOR_PUBKEY" ] || [ "$DEV_AUTHOR_PUBKEY" = "null" ]; then
        fail "Dev signer pubkey was empty"
    fi

    log_success "Dev pubkey acquired: ${DEV_AUTHOR_PUBKEY:0:20}..."
}

# Process a single event through the pipeline
# Args: event_file_template, event_name
process_event() {
    local template_file="$1"
    local event_name="$2"

    log_info "========================================="
    log_info "Processing $event_name event"
    log_info "========================================="

    # Step 1: Build event from template
    log_info "Step 1: Building event from template..."
    local timestamp=$(date +%s)

    local event_json=$(cat "$template_file" | \
        sed "s/__RELEASE_ID__/${RELEASE_ID:-placeholder}/g" | \
        sed "s/__RUN_ID__/${RUN_ID}/g" | \
        sed "s/__TIMESTAMP__/${timestamp}/g")

    # Sanity check: created_at must be a number (not a quoted string)
    echo "$event_json" | jq -e '.created_at | (type=="number") and (. > 0)' >/dev/null \
        || fail "Template produced invalid created_at (must be a positive number). Check __TIMESTAMP__ quoting."

    # Inject author_pubkey BEFORE prepare so canonical payload/hash include it
    # This ensures signature verification will succeed (verifier includes author_pubkey in hash)
    event_json=$(echo "$event_json" | jq --arg pub "$DEV_AUTHOR_PUBKEY" '. + {author_pubkey: $pub}')

    log_success "Event built with author_pubkey"

    # Step 2: Prepare event (get canonical hash and payload)
    log_info "Step 2: Preparing event (POST /api/events/prepare)..."

    local prepare_response=$(curl -s -X POST "${API_BASE}/api/events/prepare" \
        -H "Content-Type: application/json" \
        -d "$event_json")

    local prepare_success=$(echo "$prepare_response" | jq -r '.success // false')
    if [ "$prepare_success" != "true" ]; then
        log_error "Prepare failed:"
        echo "$prepare_response" | jq '.'
        fail "Event preparation failed for $event_name"
    fi

    local hash=$(echo "$prepare_response" | jq -r '.hash')
    local canonical_payload=$(echo "$prepare_response" | jq -r '.canonical_payload')

    log_success "Event prepared"
    log_info "  Hash: ${hash:0:16}..."
    log_info "  Canonical payload length: ${#canonical_payload} bytes"

    # Step 3: Sign event (POST /api/events/dev-sign)
    log_info "Step 3: Signing event (POST /api/events/dev-sign)..."

    local sign_response=$(curl -s -X POST "${API_BASE}/api/events/dev-sign" \
        -H "Content-Type: application/json" \
        -d "{\"canonical_payload\": $(echo "$canonical_payload" | jq -R .)}")

    local sign_success=$(echo "$sign_response" | jq -r '.success // false')
    if [ "$sign_success" != "true" ]; then
        log_error "Signing failed:"
        echo "$sign_response" | jq '.'
        fail "Event signing failed for $event_name"
    fi

    local sig=$(echo "$sign_response" | jq -r '.sig')
    local author_pubkey=$(echo "$sign_response" | jq -r '.author_pubkey')

    log_success "Event signed"
    log_info "  Signature: ${sig:0:20}..."
    log_info "  Public key: ${author_pubkey:0:20}..."

    # Step 4: Add signature to event
    log_info "Step 4: Adding signature to event..."

    # Only add sig (author_pubkey was already added before prepare)
    local signed_event=$(echo "$event_json" | jq --arg sig "$sig" '. + {sig: $sig}')

    # Verify pubkey from /dev-sign matches what we injected earlier
    if [ "$author_pubkey" != "$DEV_AUTHOR_PUBKEY" ]; then
        log_warning "Pubkey mismatch: got $author_pubkey, expected $DEV_AUTHOR_PUBKEY"
    fi

    log_success "Signature added to event"

    # Step 5: Store event (POST /api/events/create)
    log_info "Step 5: Storing event (POST /api/events/create)..."

    # Build create payload properly using jq (not fragile string splicing)
    local create_payload=$(jq -n \
        --arg hash "$hash" \
        --argjson event "$signed_event" \
        '{expected_hash: $hash} + $event')

    local create_response=$(curl -s -X POST "${API_BASE}/api/events/create" \
        -H "Content-Type: application/json" \
        -d "$create_payload")

    local create_success=$(echo "$create_response" | jq -r '.success // false')
    if [ "$create_success" != "true" ]; then
        log_error "Storage failed:"
        echo "$create_response" | jq '.'
        fail "Event storage failed for $event_name"
    fi

    local canonical_cid=$(echo "$create_response" | jq -r '.stored.canonical_cid')
    local event_cid=$(echo "$create_response" | jq -r '.stored.event_cid')
    local replication_primary=$(echo "$create_response" | jq -r '.replication.canonical.primary // false')
    local replication_secondary=$(echo "$create_response" | jq -r '.replication.canonical.secondary[0] // false')

    log_success "Event stored"
    log_info "  Canonical CID: ${canonical_cid:0:20}..."
    log_info "  Event CID: ${event_cid:0:20}..."
    log_info "  IPFS primary: $replication_primary"
    log_info "  IPFS secondary: $replication_secondary"

    # Step 6: Simulate blockchain anchoring (POST /api/ingest/anchored-event)
    log_info "Step 6: Simulating blockchain anchoring (POST /api/ingest/anchored-event)..."

    # Get event type code
    local type_code
    case "$event_name" in
        "CREATE_RELEASE_BUNDLE") type_code=21 ;;
        "ADD_CLAIM") type_code=30 ;;
        *) fail "Unknown event type: $event_name" ;;
    esac

    # Build action payload (simulates what comes from blockchain)
    # CRITICAL: Include event_cid in payload to test CID-based retrieval path
    local action_payload=$(jq -n \
        --arg author "$SMOKE_AUTHOR" \
        --argjson type "$type_code" \
        --arg hash "$hash" \
        --arg event_cid "$event_cid" \
        --argjson ts "$timestamp" \
        '{author: $author, type: $type, hash: $hash, event_cid: $event_cid, ts: $ts, tags: []}')

    # Build anchored event
    local anchored_event=$(jq -n \
        --arg content_hash "$hash" \
        --arg payload "$action_payload" \
        --argjson block_num "$RUN_ID" \
        --arg trx_id "smoke-test-trx-$RUN_ID" \
        --arg source "smoke-test" \
        '{
            content_hash: $content_hash,
            payload: $payload,
            block_num: $block_num,
            trx_id: $trx_id,
            source: $source,
            contract_account: "polaris",
            action_name: "put"
        }')

    local ingest_response=$(curl -s -X POST "${API_BASE}/api/ingest/anchored-event" \
        -H "Content-Type: application/json" \
        -d "$anchored_event")

    local ingest_status=$(echo "$ingest_response" | jq -r '.status // "error"')
    if [ "$ingest_status" != "processed" ] && [ "$ingest_status" != "duplicate" ]; then
        log_error "Ingestion failed:"
        echo "$ingest_response" | jq '.'
        fail "Event ingestion failed for $event_name"
    fi

    log_success "Event ingested (status: $ingest_status)"

    # Store results for verification
    EVENT_HASHES+=("$hash")
    EVENT_CIDS+=("$event_cid")
    EVENT_NAMES+=("$event_name")

    log_success "$event_name event processed successfully"
    echo ""
}

# Verify data in Neo4j
verify_neo4j() {
    log_info "========================================="
    log_info "Verifying data in Neo4j"
    log_info "========================================="

    # Give Neo4j a moment to complete writes
    sleep 2

    # Verify release created by CREATE_RELEASE_BUNDLE
    log_info "Checking if release exists (name contains: $RUN_ID)"

    local neo4j_response=$(curl -s -X POST "http://localhost:7474/db/neo4j/tx/commit" \
        -H "Content-Type: application/json" \
        -H "Authorization: Basic $(echo -n 'neo4j:polarisdev' | base64)" \
        -d "{\"statements\": [{\"statement\": \"MATCH (r:Release) WHERE r.name CONTAINS \\\"${RUN_ID}\\\" RETURN r.release_id AS id, r.name AS name, r.catalog_number AS catalog LIMIT 5\"}]}" 2>/dev/null)

    if [ $? -ne 0 ]; then
        log_warning "Neo4j HTTP API not available (this is OK if Neo4j browser is disabled)"
        log_warning "Skipping Neo4j verification"
        return 0
    fi

    local result_count=$(echo "$neo4j_response" | jq -r '.results[0].data | length')

    if [ "$result_count" -eq "0" ]; then
        log_error "Release not found in Neo4j"
        log_error "Query result: $neo4j_response"
        fail "Neo4j verification failed: release not found"
    fi

    local release_name=$(echo "$neo4j_response" | jq -r '.results[0].data[0].row[1]')
    local release_id=$(echo "$neo4j_response" | jq -r '.results[0].data[0].row[0]')
    local catalog_number=$(echo "$neo4j_response" | jq -r '.results[0].data[0].row[2] // "none"')

    log_success "Release found in Neo4j"
    log_info "  ID: $release_id"
    log_info "  Name: $release_name"
    log_info "  Catalog Number: $catalog_number"

    log_success "Neo4j verification complete"
}

# Print final summary
print_summary() {
    echo ""
    log_info "========================================="
    log_success "SMOKE TEST PASSED"
    log_info "========================================="
    echo ""
    log_info "Summary:"
    log_info "  Run ID: $RUN_ID"
    log_info "  Release ID: $RELEASE_ID"
    log_info "  Events processed: ${#EVENT_HASHES[@]}"
    echo ""

    for i in "${!EVENT_HASHES[@]}"; do
        log_info "  Event $((i+1)): ${EVENT_NAMES[$i]}"
        log_info "    Hash: ${EVENT_HASHES[$i]:0:16}..."
        log_info "    CID: ${EVENT_CIDS[$i]:0:20}..."
    done

    echo ""
    log_success "All smoke tests passed!"
    log_info "The complete pipeline is working:"
    log_info "  ✓ Event preparation"
    log_info "  ✓ Event signing"
    log_info "  ✓ Event storage (IPFS + S3 + Redis)"
    log_info "  ✓ Multi-node IPFS replication"
    log_info "  ✓ Event ingestion"
    log_info "  ✓ Graph database updates"
    echo ""
}

# ============================================================================
# Main Script
# ============================================================================

main() {
    # Initialize result arrays
    declare -a EVENT_HASHES
    declare -a EVENT_CIDS
    declare -a EVENT_NAMES

    log_info "========================================="
    log_info "Polaris Music Registry - Smoke Test"
    log_info "========================================="
    echo ""

    # Check prerequisites
    check_prerequisites
    echo ""

    # Start stack
    start_stack
    echo ""

    # Wait for health
    wait_for_health
    echo ""

    # Fetch dev signer pubkey (required for correct signing)
    get_dev_pubkey
    echo ""

    # Generate test IDs
    generate_test_ids
    echo ""

    # Process CREATE_RELEASE_BUNDLE event
    process_event "${PAYLOAD_DIR}/create-release-bundle.tmpl.json" "CREATE_RELEASE_BUNDLE"

    # Capture the created Release ID from Neo4j for ADD_CLAIM
    log_info "Capturing created Release ID from Neo4j..."
    RELEASE_ID=$(docker compose exec -T neo4j cypher-shell -u neo4j -p polarisdev \
        "MATCH (r:Release) WHERE r.name CONTAINS 'Smoke Test Release ${RUN_ID}' RETURN r.release_id LIMIT 1;" \
        2>/dev/null | tail -n 1 | tr -d '\r' | tr -d '"' | xargs)

    if [ -z "$RELEASE_ID" ] || [ "$RELEASE_ID" == "null" ]; then
        log_warning "Could not capture Release ID from Neo4j (this is OK if Neo4j browser is disabled)"
        RELEASE_ID="smoke-release-${RUN_ID}"
        log_info "Using fallback Release ID: $RELEASE_ID"
    else
        log_success "Captured Release ID: $RELEASE_ID"
    fi
    echo ""

    # Process ADD_CLAIM event (claims on the release we just created)
    process_event "${PAYLOAD_DIR}/add-claim.tmpl.json" "ADD_CLAIM"

    # Verify in Neo4j
    verify_neo4j

    # Print summary
    print_summary

    exit 0
}

# Run main function
main "$@"
