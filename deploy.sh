#!/usr/bin/env bash
#
# deploy.sh - Deployment script for Polaris Music Registry
#
# Supports two deployment modes:
#   1. Docker Compose (local development)
#   2. Kubernetes via Kustomize (development/production)
#
# Usage:
#   ./deploy.sh docker              # Start local Docker Compose stack
#   ./deploy.sh docker down         # Stop local Docker Compose stack
#   ./deploy.sh k8s development     # Deploy to Kubernetes (dev overlay)
#   ./deploy.sh k8s production      # Deploy to Kubernetes (prod overlay)
#   ./deploy.sh k8s production diff # Preview changes before applying
#   ./deploy.sh status              # Show deployment status
#   ./deploy.sh --help              # Show this help message
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

usage() {
    cat <<EOF
Polaris Music Registry - Deployment Script

Usage:
  $0 docker [down]                    Local Docker Compose deployment
  $0 k8s <environment> [diff]         Kubernetes deployment via Kustomize
  $0 status                           Show current deployment status
  $0 --help                           Show this help message

Environments (k8s):
  development    Dev namespace with debug logging, latest images
  production     Prod namespace with info logging, tagged images

Examples:
  $0 docker                           Start local dev stack
  $0 docker down                      Stop local dev stack
  $0 k8s development                  Deploy dev overlay to Kubernetes
  $0 k8s production diff              Preview production changes
  $0 k8s production                   Apply production overlay
  $0 status                           Check what's running

Prerequisites:
  Docker Compose:  docker, docker compose
  Kubernetes:      kubectl, kustomize (or kubectl with -k flag)
EOF
}

# --- Docker Compose deployment ---
deploy_docker() {
    local action="${1:-up}"

    if ! command -v docker &>/dev/null; then
        log_error "docker not found. Install Docker: https://docs.docker.com/get-docker/"
        exit 1
    fi

    cd "$SCRIPT_DIR"

    case "$action" in
        up)
            log_info "Starting Polaris Music Registry (Docker Compose)..."
            docker compose up -d
            log_info "Services starting. Check status with: docker compose ps"
            log_info "API:     http://localhost:3000"
            log_info "Neo4j:   http://localhost:7474"
            log_info "GraphQL: http://localhost:3000/graphql"
            ;;
        down)
            log_info "Stopping Polaris Music Registry..."
            docker compose down
            log_info "All services stopped."
            ;;
        *)
            log_error "Unknown docker action: $action (use 'up' or 'down')"
            exit 1
            ;;
    esac
}

# --- Kubernetes deployment ---
deploy_k8s() {
    local environment="${1:-}"
    local action="${2:-apply}"

    if [[ -z "$environment" ]]; then
        log_error "Environment required. Use: $0 k8s <development|production>"
        exit 1
    fi

    local overlay_dir="$SCRIPT_DIR/k8s/overlays/$environment"
    if [[ ! -d "$overlay_dir" ]]; then
        log_error "Overlay not found: $overlay_dir"
        log_error "Available environments: $(ls "$SCRIPT_DIR/k8s/overlays/" 2>/dev/null || echo 'none')"
        exit 1
    fi

    if ! command -v kubectl &>/dev/null; then
        log_error "kubectl not found. Install: https://kubernetes.io/docs/tasks/tools/"
        exit 1
    fi

    case "$action" in
        diff)
            log_info "Previewing changes for $environment..."
            kubectl diff -k "$overlay_dir" || true
            ;;
        apply)
            log_info "Deploying to $environment..."
            kubectl apply -k "$overlay_dir"
            log_info "Deployment applied. Waiting for rollout..."
            local namespace
            namespace=$(grep 'namespace:' "$overlay_dir/kustomization.yaml" | awk '{print $2}')
            kubectl rollout status deployment/api -n "$namespace" --timeout=120s || true
            log_info "Deployment to $environment complete."
            ;;
        *)
            log_error "Unknown k8s action: $action (use 'apply' or 'diff')"
            exit 1
            ;;
    esac
}

# --- Status check ---
show_status() {
    log_info "Checking deployment status..."

    # Docker Compose status
    if command -v docker &>/dev/null; then
        echo ""
        echo "=== Docker Compose ==="
        cd "$SCRIPT_DIR"
        docker compose ps 2>/dev/null || echo "  No Docker Compose services running"
    fi

    # Kubernetes status
    if command -v kubectl &>/dev/null; then
        echo ""
        echo "=== Kubernetes (polaris namespace) ==="
        kubectl get pods -n polaris 2>/dev/null || echo "  No pods in polaris namespace"
        echo ""
        echo "=== Kubernetes (polaris-dev namespace) ==="
        kubectl get pods -n polaris-dev 2>/dev/null || echo "  No pods in polaris-dev namespace"
    fi
}

# --- Main ---
case "${1:-}" in
    docker)
        deploy_docker "${2:-up}"
        ;;
    k8s|kubernetes)
        deploy_k8s "${2:-}" "${3:-apply}"
        ;;
    status)
        show_status
        ;;
    --help|-h|help)
        usage
        ;;
    "")
        usage
        exit 1
        ;;
    *)
        log_error "Unknown command: $1"
        usage
        exit 1
        ;;
esac
