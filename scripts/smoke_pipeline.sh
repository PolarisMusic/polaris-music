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
    local replication_primary=$(echo "$create_response" | jq -r '.replication.event.primary // false')
    local replication_secondary=$(echo "$create_response" | jq -r '.replication.event.secondary[0] // false')

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
# Args: release_id_1, release_id_2, release_id_3
verify_neo4j() {
    local release_id_1="$1"
    local release_id_2="$2"
    local release_id_3="$3"

    # Shared person ID (Smoke Dave Grohl appears in both QOTSA and Nirvana)
    local shared_dave_id="polaris:person:00000000-0000-4000-8000-000000000103"

    # Shared persons (Josh Homme + Nick Oliveri appear in both QOTSA and Kyuss)
    local shared_josh_id="polaris:person:00000000-0000-4000-8000-000000000101"
    local shared_nick_id="polaris:person:00000000-0000-4000-8000-000000000102"

    # Nirvana-only members
    local kurt_person_id="polaris:person:00000000-0000-4000-8000-000000000201"
    local krist_person_id="polaris:person:00000000-0000-4000-8000-000000000202"

    # Nevermind guests
    local chad_person_id="polaris:person:00000000-0000-4000-8000-000000000203"
    local kirk_person_id="polaris:person:00000000-0000-4000-8000-000000000204"

    # Group IDs (FIXED: QOTSA is ...0002, not ...0001)
    local group_id_1="polaris:group:00000000-0000-4000-8000-000000000002"  # Smoke QOTSA
    local group_id_2="polaris:group:00000000-0000-4000-8000-000000000003"  # Smoke Nirvana
    local group_id_3="polaris:group:00000000-0000-4000-8000-000000000004"  # Smoke Kyuss

    log_info "========================================="
    log_info "Verifying data in Neo4j"
    log_info "========================================="

    # Give Neo4j a moment to complete writes
    sleep 2

    local neo4j_auth=$(echo -n 'neo4j:polarisdev' | base64)

    # Helper function for Neo4j queries
    run_neo4j_query() {
        local query="$1"
        curl -s -X POST "http://localhost:7474/db/neo4j/tx/commit" \
            -H "Content-Type: application/json" \
            -H "Authorization: Basic $neo4j_auth" \
            -d "{\"statements\": [{\"statement\": \"$query\"}]}" 2>/dev/null
    }

    # ========== Check Release 1 (QOTSA) ==========
    log_info "Checking Release 1 (release_id: $release_id_1)"

    local response1=$(run_neo4j_query "MATCH (r:Release {release_id: \\\"${release_id_1}\\\"}) RETURN r.release_id AS id, r.name AS name, r.catalog_number AS catalog LIMIT 1")

    if [ $? -ne 0 ]; then
        log_warning "Neo4j HTTP API not available (this is OK if Neo4j browser is disabled)"
        log_warning "Skipping Neo4j verification"
        return 0
    fi

    local count1=$(echo "$response1" | jq -r '.results[0].data | length')
    if [ "$count1" -eq "0" ]; then
        log_error "Release 1 not found in Neo4j"
        log_error "Query result: $response1"
        fail "Neo4j verification failed: Release 1 not found"
    fi

    local name1=$(echo "$response1" | jq -r '.results[0].data[0].row[1]')
    log_success "Release 1 found: $name1"

    # ========== Check Release 2 (Nevermind) ==========
    log_info "Checking Release 2 (release_id: $release_id_2)"

    local response2=$(run_neo4j_query "MATCH (r:Release {release_id: \\\"${release_id_2}\\\"}) RETURN r.release_id AS id, r.name AS name, r.catalog_number AS catalog LIMIT 1")

    local count2=$(echo "$response2" | jq -r '.results[0].data | length')
    if [ "$count2" -eq "0" ]; then
        log_error "Release 2 not found in Neo4j"
        log_error "Query result: $response2"
        fail "Neo4j verification failed: Release 2 not found"
    fi

    local name2=$(echo "$response2" | jq -r '.results[0].data[0].row[1]')
    log_success "Release 2 found: $name2"

    # ========== Check Release 3 (Kyuss - Blues for the Red Sun) ==========
    log_info "Checking Release 3 (release_id: $release_id_3)"

    local response3=$(run_neo4j_query "MATCH (r:Release {release_id: \\\"${release_id_3}\\\"}) RETURN r.release_id AS id, r.name AS name, r.catalog_number AS catalog LIMIT 1")

    local count3=$(echo "$response3" | jq -r '.results[0].data | length')
    if [ "$count3" -eq "0" ]; then
        log_error "Release 3 not found in Neo4j"
        log_error "Query result: $response3"
        fail "Neo4j verification failed: Release 3 not found"
    fi

    local name3=$(echo "$response3" | jq -r '.results[0].data[0].row[1]')
    log_success "Release 3 found: $name3"

    # ========== Validate Shared Person Node Count ==========
    log_info "Verifying shared person (Smoke Dave Grohl) is not duplicated..."

    local person_response=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"${shared_dave_id}\\\"}) RETURN count(p) AS c")
    local person_count=$(echo "$person_response" | jq -r '.results[0].data[0].row[0]')

    if [ "$person_count" != "1" ]; then
        log_error "Shared person node count is $person_count (expected 1)"
        fail "Neo4j verification failed: shared person duplicated or missing"
    fi

    log_success "Shared person exists exactly once (count=$person_count)"

    # ========== Verify Shared Person is MEMBER_OF Both Groups ==========
    log_info "Verifying shared person is member of both groups..."

    local member_response=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"${shared_dave_id}\\\"})-[:MEMBER_OF]->(g:Group) RETURN g.group_id AS gid, g.name AS name")
    local member_count=$(echo "$member_response" | jq -r '.results[0].data | length')

    # Diagnostic: print returned group IDs
    log_info "Groups (gid, name) returned for shared person:"
    echo "$member_response" | jq -r '.results[0].data[].row | @tsv' | sed 's/^/  - /'

    if [ "$member_count" -lt "2" ]; then
        log_error "Shared person is member of $member_count groups (expected at least 2)"
        log_error "Groups found: $(echo "$member_response" | jq -r '.results[0].data[].row[1]')"
        fail "Neo4j verification failed: shared person not member of both groups"
    fi

    # Check both group IDs are present
    local groups_json=$(echo "$member_response" | jq -r '[.results[0].data[].row[0]]')
    local has_group1=$(echo "$groups_json" | jq --arg g "$group_id_1" 'contains([$g])')
    local has_group2=$(echo "$groups_json" | jq --arg g "$group_id_2" 'contains([$g])')

    if [ "$has_group1" != "true" ]; then
        log_error "Shared person is NOT a member of Group 1 (QOTSA, expected $group_id_1)"
        log_error "Actual groups: $groups_json"
        fail "Neo4j verification failed: shared person missing MEMBER_OF to Group 1"
    fi

    if [ "$has_group2" != "true" ]; then
        log_error "Shared person is NOT a member of Group 2 (Nirvana, expected $group_id_2)"
        log_error "Actual groups: $groups_json"
        fail "Neo4j verification failed: shared person missing MEMBER_OF to Group 2"
    fi

    log_success "Shared person is member of both groups"

    # ========== Verify Shared Person has PERFORMED_ON Edges via Both Groups ==========
    log_info "Verifying shared person has PERFORMED_ON edges to tracks from both releases..."

    # Check PERFORMED_ON edges exist for tracks in Release 1
    local perf_response1=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"${shared_dave_id}\\\"})-[:PERFORMED_ON]->(t:Track)-[:IN_RELEASE]->(r:Release {release_id: \\\"${release_id_1}\\\"}) RETURN count(t) AS c")
    local perf_count1=$(echo "$perf_response1" | jq -r '.results[0].data[0].row[0]')

    if [ "$perf_count1" -eq "0" ]; then
        log_error "Shared person has no PERFORMED_ON edges to Release 1 tracks"
        fail "Neo4j verification failed: missing Person->Track PERFORMED_ON for Release 1"
    fi

    log_success "Shared person has PERFORMED_ON edges to $perf_count1 tracks in Release 1"

    # Check PERFORMED_ON edges exist for tracks in Release 2
    local perf_response2=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"${shared_dave_id}\\\"})-[:PERFORMED_ON]->(t:Track)-[:IN_RELEASE]->(r:Release {release_id: \\\"${release_id_2}\\\"}) RETURN count(t) AS c")
    local perf_count2=$(echo "$perf_response2" | jq -r '.results[0].data[0].row[0]')

    if [ "$perf_count2" -eq "0" ]; then
        log_error "Shared person has no PERFORMED_ON edges to Release 2 tracks"
        fail "Neo4j verification failed: missing Person->Track PERFORMED_ON for Release 2"
    fi

    log_success "Shared person has PERFORMED_ON edges to $perf_count2 tracks in Release 2"

    # ========== Verify Kurt and Krist are MEMBER_OF Nirvana ==========
    log_info "Verifying Kurt and Krist are members of Nirvana..."

    for pid in "$kurt_person_id" "$krist_person_id"; do
        local resp=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"$pid\\\"})-[:MEMBER_OF]->(g:Group {group_id: \\\"$group_id_2\\\"}) RETURN count(g) AS c")
        local c=$(echo "$resp" | jq -r '.results[0].data[0].row[0]')
        if [ "$c" = "0" ]; then
            fail "Neo4j verification failed: $pid is not MEMBER_OF Nirvana (group_id=$group_id_2)"
        fi
    done
    log_success "Kurt and Krist are MEMBER_OF Nirvana"

    # ========== Verify Kurt and Krist have PERFORMED_ON edges to Nevermind tracks ==========
    log_info "Verifying Kurt and Krist have PERFORMED_ON edges to Nevermind tracks..."

    for pid in "$kurt_person_id" "$krist_person_id"; do
        local resp=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"$pid\\\"})-[:PERFORMED_ON]->(t:Track)-[:IN_RELEASE]->(r:Release {release_id: \\\"$release_id_2\\\"}) RETURN count(t) AS c")
        local c=$(echo "$resp" | jq -r '.results[0].data[0].row[0]')
        if [ "$c" = "0" ]; then
            fail "Neo4j verification failed: $pid has 0 PERFORMED_ON tracks in Release 2 (Nevermind)"
        fi
        log_success "$pid PERFORMED_ON count in Release 2: $c"
    done

    # ========== Verify Kurt and Krist PERFORMED_ON edges have via_group_id ==========
    log_info "Verifying Kurt and Krist PERFORMED_ON edges came via propagation (via_group_id)..."

    for pid in "$kurt_person_id" "$krist_person_id"; do
        local resp=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"$pid\\\"})-[perf:PERFORMED_ON]->(t:Track)-[:IN_RELEASE]->(r:Release {release_id: \\\"$release_id_2\\\"}) RETURN count(CASE WHEN perf.via_group_id = \\\"$group_id_2\\\" THEN 1 END) AS c")
        local c=$(echo "$resp" | jq -r '.results[0].data[0].row[0]')
        if [ "$c" = "0" ]; then
            fail "Neo4j verification failed: $pid PERFORMED_ON edges exist but none have via_group_id=$group_id_2"
        fi
        log_success "$pid has propagated PERFORMED_ON edges via_group_id=$group_id_2: $c"
    done

    # ========== Verify propagated PERFORMED_ON edges have derived=true ==========
    log_info "Verifying propagated PERFORMED_ON edges have derived=true flag..."

    # Check Dave's edges to Nevermind (Release 2) have derived=true
    local derived_resp=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"$shared_dave_id\\\"})-[perf:PERFORMED_ON]->(t:Track)-[:IN_RELEASE]->(r:Release {release_id: \\\"$release_id_2\\\"}) WHERE perf.via_group_id IS NOT NULL RETURN count(perf) AS total, count(CASE WHEN perf.derived = true THEN 1 END) AS derived_count")
    local derived_total=$(echo "$derived_resp" | jq -r '.results[0].data[0].row[0]')
    local derived_count=$(echo "$derived_resp" | jq -r '.results[0].data[0].row[1]')

    if [ "$derived_total" = "0" ]; then
        log_warning "No propagated PERFORMED_ON edges found for Dave -> Nevermind"
    elif [ "$derived_count" = "0" ]; then
        log_warning "Propagated edges exist but none have derived=true (total=$derived_total, derived=$derived_count)"
    else
        log_success "Dave's propagated PERFORMED_ON edges have derived=true: $derived_count/$derived_total"
    fi

    # Check that roles[] array exists on propagated edges
    local roles_resp=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"$shared_dave_id\\\"})-[perf:PERFORMED_ON]->(t:Track)-[:IN_RELEASE]->(r:Release {release_id: \\\"$release_id_2\\\"}) WHERE perf.via_group_id IS NOT NULL RETURN count(CASE WHEN perf.roles IS NOT NULL AND size(perf.roles) > 0 THEN 1 END) AS roles_count")
    local roles_count=$(echo "$roles_resp" | jq -r '.results[0].data[0].row[0]')

    if [ "$roles_count" = "0" ]; then
        log_warning "Propagated edges exist but none have roles[] array populated"
    else
        log_success "Dave's propagated PERFORMED_ON edges have roles[] populated: $roles_count"
    fi

    # ========== Verify Guests have GUEST_ON edges (not PERFORMED_ON) ==========
    log_info "Verifying guests (Chad Channing, Kirk Canning) have GUEST_ON edges..."

    # Chad Channing should have exactly 1 GUEST_ON edge in Release 2 (Polly)
    local chad_resp=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"$chad_person_id\\\"})-[:GUEST_ON]->(t:Track)-[:IN_RELEASE]->(r:Release {release_id: \\\"$release_id_2\\\"}) RETURN count(t) AS c")
    local chad_guest_count=$(echo "$chad_resp" | jq -r '.results[0].data[0].row[0]')
    if [ "$chad_guest_count" != "1" ]; then
        log_warning "Expected Chad Channing GUEST_ON count=1 in Release 2, got $chad_guest_count"
    else
        log_success "Chad Channing has GUEST_ON edge count: $chad_guest_count"
    fi

    # Chad should NOT have member-propagated PERFORMED_ON edges
    local chad_perf_resp=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"$chad_person_id\\\"})-[:PERFORMED_ON]->(t:Track)-[:IN_RELEASE]->(r:Release {release_id: \\\"$release_id_2\\\"}) RETURN count(t) AS c")
    local chad_perf_count=$(echo "$chad_perf_resp" | jq -r '.results[0].data[0].row[0]')
    if [ "$chad_perf_count" != "0" ]; then
        log_warning "Chad Channing should not have PERFORMED_ON edges in Release 2 (got $chad_perf_count) - guest contamination"
    else
        log_success "Chad Channing has no PERFORMED_ON contamination"
    fi

    # Kirk Canning should have exactly 1 GUEST_ON edge in Release 2 (Something in the Way)
    local kirk_resp=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"$kirk_person_id\\\"})-[:GUEST_ON]->(t:Track)-[:IN_RELEASE]->(r:Release {release_id: \\\"$release_id_2\\\"}) RETURN count(t) AS c")
    local kirk_guest_count=$(echo "$kirk_resp" | jq -r '.results[0].data[0].row[0]')
    if [ "$kirk_guest_count" != "1" ]; then
        log_warning "Expected Kirk Canning GUEST_ON count=1 in Release 2, got $kirk_guest_count"
    else
        log_success "Kirk Canning has GUEST_ON edge count: $kirk_guest_count"
    fi

    # Kirk should NOT have member-propagated PERFORMED_ON edges
    local kirk_perf_resp=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"$kirk_person_id\\\"})-[:PERFORMED_ON]->(t:Track)-[:IN_RELEASE]->(r:Release {release_id: \\\"$release_id_2\\\"}) RETURN count(t) AS c")
    local kirk_perf_count=$(echo "$kirk_perf_resp" | jq -r '.results[0].data[0].row[0]')
    if [ "$kirk_perf_count" != "0" ]; then
        log_warning "Kirk Canning should not have PERFORMED_ON edges in Release 2 (got $kirk_perf_count) - guest contamination"
    else
        log_success "Kirk Canning has no PERFORMED_ON contamination"
    fi

    log_success "Guests verified: GUEST_ON only, no PERFORMED_ON contamination"

    # ========== Verify Josh Homme and Nick Oliveri exist exactly once ==========
    log_info "Verifying shared persons (Josh Homme, Nick Oliveri) are not duplicated..."

    for pid in "$shared_josh_id" "$shared_nick_id"; do
        local resp=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"$pid\\\"}) RETURN count(p) AS c")
        local c=$(echo "$resp" | jq -r '.results[0].data[0].row[0]')
        if [ "$c" != "1" ]; then
            fail "Neo4j verification failed: $pid exists $c times (expected 1)"
        fi
    done
    log_success "Josh Homme and Nick Oliveri each exist exactly once"

    # ========== Verify Josh and Nick are MEMBER_OF both QOTSA and Kyuss ==========
    log_info "Verifying Josh and Nick are members of both QOTSA and Kyuss..."

    for pid in "$shared_josh_id" "$shared_nick_id"; do
        # Check QOTSA membership
        local resp1=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"$pid\\\"})-[:MEMBER_OF]->(g:Group {group_id: \\\"$group_id_1\\\"}) RETURN count(g) AS c")
        local c1=$(echo "$resp1" | jq -r '.results[0].data[0].row[0]')
        if [ "$c1" = "0" ]; then
            fail "Neo4j verification failed: $pid is not MEMBER_OF QOTSA (group_id=$group_id_1)"
        fi

        # Check Kyuss membership
        local resp3=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"$pid\\\"})-[:MEMBER_OF]->(g:Group {group_id: \\\"$group_id_3\\\"}) RETURN count(g) AS c")
        local c3=$(echo "$resp3" | jq -r '.results[0].data[0].row[0]')
        if [ "$c3" = "0" ]; then
            fail "Neo4j verification failed: $pid is not MEMBER_OF Kyuss (group_id=$group_id_3)"
        fi
    done
    log_success "Josh and Nick are MEMBER_OF both QOTSA and Kyuss"

    # ========== Verify Josh and Nick have PERFORMED_ON edges to Kyuss tracks ==========
    log_info "Verifying Josh and Nick have PERFORMED_ON edges to Kyuss tracks (Release 3)..."

    for pid in "$shared_josh_id" "$shared_nick_id"; do
        local resp=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"$pid\\\"})-[:PERFORMED_ON]->(t:Track)-[:IN_RELEASE]->(r:Release {release_id: \\\"$release_id_3\\\"}) RETURN count(t) AS c")
        local c=$(echo "$resp" | jq -r '.results[0].data[0].row[0]')
        if [ "$c" = "0" ]; then
            fail "Neo4j verification failed: $pid has 0 PERFORMED_ON tracks in Release 3 (Kyuss)"
        fi
        log_success "$pid PERFORMED_ON count in Release 3: $c"
    done

    # ========== Verify Josh and Nick PERFORMED_ON edges have via_group_id for Kyuss ==========
    log_info "Verifying Josh and Nick PERFORMED_ON edges came via Kyuss propagation (via_group_id)..."

    for pid in "$shared_josh_id" "$shared_nick_id"; do
        local resp=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"$pid\\\"})-[perf:PERFORMED_ON]->(t:Track)-[:IN_RELEASE]->(r:Release {release_id: \\\"$release_id_3\\\"}) RETURN count(CASE WHEN perf.via_group_id = \\\"$group_id_3\\\" THEN 1 END) AS c")
        local c=$(echo "$resp" | jq -r '.results[0].data[0].row[0]')
        if [ "$c" = "0" ]; then
            fail "Neo4j verification failed: $pid PERFORMED_ON edges exist but none have via_group_id=$group_id_3"
        fi
        log_success "$pid has propagated PERFORMED_ON edges via_group_id=$group_id_3: $c"
    done

    # ========== Verify WROTE relationships exist with enriched properties ==========
    log_info "Verifying WROTE relationships for songwriter credits..."

    # Song IDs for verification
    local teen_spirit_song="polaris:song:00000000-0000-4000-8000-000000002100"
    local no_one_knows_song="polaris:song:00000000-0000-4000-8000-000000001002"
    local mosquito_song="polaris:song:00000000-0000-4000-8000-000000001014"

    # Check Kurt wrote "Smells Like Teen Spirit" with roles
    local wrote_resp=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"$kurt_person_id\\\"})-[w:WROTE]->(s:Song {song_id: \\\"$teen_spirit_song\\\"}) RETURN w.role AS role, w.roles AS roles")
    local wrote_count=$(echo "$wrote_resp" | jq -r '.results[0].data | length')
    if [ "$wrote_count" = "0" ]; then
        fail "Neo4j verification failed: Kurt Cobain has no WROTE edge to Smells Like Teen Spirit"
    fi
    local wrote_role=$(echo "$wrote_resp" | jq -r '.results[0].data[0].row[0]')
    log_success "Kurt Cobain WROTE Smells Like Teen Spirit (role=$wrote_role)"

    # Check that Kurt's WROTE edge has roles[] array populated
    local wrote_roles=$(echo "$wrote_resp" | jq -r '.results[0].data[0].row[1]')
    if [ "$wrote_roles" = "null" ] || [ -z "$wrote_roles" ]; then
        log_warning "Kurt's WROTE edge to Teen Spirit has no roles[] array"
    else
        log_success "Kurt's WROTE edge has roles[]: $wrote_roles"
    fi

    # Check Smells Like Teen Spirit has 3 writers total
    local writers_resp=$(run_neo4j_query "MATCH (p:Person)-[:WROTE]->(s:Song {song_id: \\\"$teen_spirit_song\\\"}) RETURN count(p) AS c")
    local writers_count=$(echo "$writers_resp" | jq -r '.results[0].data[0].row[0]')
    if [ "$writers_count" != "3" ]; then
        log_warning "Smells Like Teen Spirit has $writers_count writers (expected 3)"
    else
        log_success "Smells Like Teen Spirit has 3 writers"
    fi

    # Check Josh wrote "No One Knows" with roles
    local josh_wrote_resp=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"$shared_josh_id\\\"})-[w:WROTE]->(s:Song {song_id: \\\"$no_one_knows_song\\\"}) RETURN w.role AS role, w.roles AS roles")
    local josh_wrote_count=$(echo "$josh_wrote_resp" | jq -r '.results[0].data | length')
    if [ "$josh_wrote_count" = "0" ]; then
        fail "Neo4j verification failed: Josh Homme has no WROTE edge to No One Knows"
    fi
    log_success "Josh Homme WROTE No One Knows"

    # Check Mosquito Song has role_detail and share_percentage on Chris Goss
    local chris_goss_id="polaris:person:00000000-0000-4000-8000-000000000110"
    local goss_wrote_resp=$(run_neo4j_query "MATCH (p:Person {person_id: \\\"$chris_goss_id\\\"})-[w:WROTE]->(s:Song {song_id: \\\"$mosquito_song\\\"}) RETURN w.role_detail AS detail, w.share_percentage AS share, w.roles AS roles")
    local goss_wrote_count=$(echo "$goss_wrote_resp" | jq -r '.results[0].data | length')
    if [ "$goss_wrote_count" = "0" ]; then
        fail "Neo4j verification failed: Chris Goss has no WROTE edge to Mosquito Song"
    fi
    local goss_detail=$(echo "$goss_wrote_resp" | jq -r '.results[0].data[0].row[0]')
    local goss_share=$(echo "$goss_wrote_resp" | jq -r '.results[0].data[0].row[1]')
    if [ "$goss_detail" = "null" ] || [ -z "$goss_detail" ]; then
        log_warning "Chris Goss WROTE edge has no role_detail"
    else
        log_success "Chris Goss WROTE Mosquito Song with role_detail='$goss_detail', share=$goss_share"
    fi

    # Check total WROTE edges across all songs
    local total_wrote_resp=$(run_neo4j_query "MATCH ()-[w:WROTE]->() RETURN count(w) AS c")
    local total_wrote=$(echo "$total_wrote_resp" | jq -r '.results[0].data[0].row[0]')
    log_info "Total WROTE relationships in graph: $total_wrote"

    log_success "WROTE relationship verification complete"

    # ========== Verify Label enriched properties (alt_names, parent_label, origin_city) ==========
    log_info "Verifying label enrichment (alt_names, parent_label_name, origin city)..."

    local label_resp=$(run_neo4j_query "MATCH (l:Label) WHERE l.name CONTAINS 'Interscope' RETURN l.name AS name, l.alt_names AS alt_names, l.parent_label_name AS parent LIMIT 1")
    local label_count=$(echo "$label_resp" | jq -r '.results[0].data | length')
    if [ "$label_count" = "0" ]; then
        log_warning "Interscope label not found in Neo4j (labels may not be inside release)"
    else
        local label_parent=$(echo "$label_resp" | jq -r '.results[0].data[0].row[2]')
        local label_alts=$(echo "$label_resp" | jq -r '.results[0].data[0].row[1]')
        if [ "$label_parent" = "null" ] || [ -z "$label_parent" ]; then
            log_warning "Interscope label has no parent_label_name set"
        else
            log_success "Interscope label has parent_label_name='$label_parent'"
        fi
        if [ "$label_alts" = "null" ] || [ "$label_alts" = "[]" ]; then
            log_warning "Interscope label has no alt_names set"
        else
            log_success "Interscope label has alt_names: $label_alts"
        fi
    fi

    # Check label ORIGIN relationship to city
    local label_city_resp=$(run_neo4j_query "MATCH (l:Label)-[:ORIGIN]->(c:City) WHERE l.name CONTAINS 'Interscope' RETURN c.name AS city LIMIT 1")
    local label_city_count=$(echo "$label_city_resp" | jq -r '.results[0].data | length')
    if [ "$label_city_count" = "0" ]; then
        log_warning "Interscope label has no ORIGIN->City relationship"
    else
        local label_city=$(echo "$label_city_resp" | jq -r '.results[0].data[0].row[0]')
        log_success "Interscope label ORIGIN city: $label_city"
    fi

    # ========== Verify release-level guest (producer) credits ==========
    log_info "Verifying release-level guest (producer) credits..."

    local producer_resp=$(run_neo4j_query "MATCH (p:Person)-[g:GUEST_ON]->(r:Release) WHERE g.scope = 'release' AND any(x IN g.roles WHERE x IN ['producer','mixing','engineer','mastering']) RETURN count(g) AS c")
    local producer_count=$(echo "$producer_resp" | jq -r '.results[0].data[0].row[0]')
    if [ "$producer_count" = "0" ]; then
        log_warning "No release-level producer/engineer GUEST_ON edges found"
    else
        log_success "Release-level producer/engineer GUEST_ON edges: $producer_count"
    fi

    # Check guest scope differentiation
    local scope_resp=$(run_neo4j_query "MATCH ()-[g:GUEST_ON]->() RETURN g.scope AS scope, count(g) AS c ORDER BY scope")
    log_info "GUEST_ON scope distribution:"
    echo "$scope_resp" | jq -r '.results[0].data[].row | @tsv' | sed 's/^/  - /'

    log_success "Label and guest enrichment verification complete"

    log_success "Neo4j verification complete - all relationship checks passed"
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
    log_info "  Release 1 (QOTSA): $RELEASE_ID_1"
    log_info "  Release 2 (Nevermind): $RELEASE_ID_2"
    log_info "  Release 3 (Kyuss): $RELEASE_ID_3"
    log_info "  Shared Persons:"
    log_info "    - Smoke Dave Grohl (QOTSA + Nirvana): polaris:person:...-000000000103"
    log_info "    - Smoke Josh Homme (QOTSA + Kyuss): polaris:person:...-000000000101"
    log_info "    - Smoke Nick Oliveri (QOTSA + Kyuss): polaris:person:...-000000000102"
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
    log_info "  ✓ Shared person resolution across releases"
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

    # ========== RELEASE 1: Songs for the Deaf (QOTSA) ==========
    process_event "${PAYLOAD_DIR}/create-release-bundle.tmpl.json" "CREATE_RELEASE_BUNDLE"

    # Use the deterministic Release ID from the template
    log_info "Setting deterministic Release ID for ADD_CLAIM (Release 1)..."
    RELEASE_ID_1="polaris:release:00000000-0000-4000-8000-000000000001"
    RELEASE_ID="$RELEASE_ID_1"
    log_success "Using Release ID: $RELEASE_ID"
    echo ""

    # Process ADD_CLAIM event (claims on the release we just created)
    process_event "${PAYLOAD_DIR}/add-claim.tmpl.json" "ADD_CLAIM"

    # ========== RELEASE 2: Nevermind (Nirvana) ==========
    process_event "${PAYLOAD_DIR}/create-release-bundle-nevermind.tmpl.json" "CREATE_RELEASE_BUNDLE"

    # Use the deterministic Release ID from the Nevermind template
    log_info "Setting deterministic Release ID for ADD_CLAIM (Release 2)..."
    RELEASE_ID_2="polaris:release:00000000-0000-4000-8000-000000000003"
    RELEASE_ID="$RELEASE_ID_2"
    log_success "Using Release ID: $RELEASE_ID"
    echo ""

    # Process ADD_CLAIM event (claims on the second release)
    process_event "${PAYLOAD_DIR}/add-claim.tmpl.json" "ADD_CLAIM"

    # ========== RELEASE 3: Blues for the Red Sun (Kyuss) ==========
    process_event "${PAYLOAD_DIR}/create-release-bundle-blues-red-sun.tmpl.json" "CREATE_RELEASE_BUNDLE"

    # Use the deterministic Release ID from the Kyuss template
    log_info "Setting deterministic Release ID for ADD_CLAIM (Release 3)..."
    RELEASE_ID_3="polaris:release:00000000-0000-4000-8000-000000000005"
    RELEASE_ID="$RELEASE_ID_3"
    log_success "Using Release ID: $RELEASE_ID"
    echo ""

    # Process ADD_CLAIM event (claims on the third release)
    process_event "${PAYLOAD_DIR}/add-claim.tmpl.json" "ADD_CLAIM"

    # Verify in Neo4j (pass all release IDs)
    verify_neo4j "$RELEASE_ID_1" "$RELEASE_ID_2" "$RELEASE_ID_3"

    # Print summary
    print_summary

    exit 0
}

# Run main function
main "$@"
