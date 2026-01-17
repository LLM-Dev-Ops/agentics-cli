#!/bin/bash
# Deployment script for Agentics Platform Backend to Google Cloud Run
# Usage: ./deploy.sh [PROJECT_ID] [REGION]

set -euo pipefail

# Configuration
PROJECT_ID="${1:-${GOOGLE_CLOUD_PROJECT:-}}"
REGION="${2:-us-central1}"
SERVICE_NAME="agentics-platform"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Validate prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    if [ -z "$PROJECT_ID" ]; then
        log_error "PROJECT_ID is required. Usage: ./deploy.sh PROJECT_ID [REGION]"
        exit 1
    fi

    if ! command -v gcloud &> /dev/null; then
        log_error "gcloud CLI is not installed. Please install Google Cloud SDK."
        exit 1
    fi

    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed. Please install Docker."
        exit 1
    fi

    log_info "Prerequisites check passed."
}

# Configure gcloud
configure_gcloud() {
    log_info "Configuring gcloud for project: ${PROJECT_ID}"
    gcloud config set project "${PROJECT_ID}"
    gcloud auth configure-docker gcr.io --quiet
}

# Build the Docker image
build_image() {
    local tag="${1:-latest}"
    log_info "Building Docker image: ${IMAGE_NAME}:${tag}"

    docker build \
        -t "${IMAGE_NAME}:${tag}" \
        -f deploy/Dockerfile \
        .
}

# Push the Docker image
push_image() {
    local tag="${1:-latest}"
    log_info "Pushing Docker image: ${IMAGE_NAME}:${tag}"

    docker push "${IMAGE_NAME}:${tag}"
}

# Deploy to Cloud Run
deploy_to_cloud_run() {
    local tag="${1:-latest}"
    log_info "Deploying to Cloud Run in region: ${REGION}"

    # NOTE: --no-allow-unauthenticated requires GCP identity tokens
    # The CLI uses `gcloud auth print-identity-token --audiences=<url>` to authenticate
    gcloud run deploy "${SERVICE_NAME}" \
        --image "${IMAGE_NAME}:${tag}" \
        --region "${REGION}" \
        --platform managed \
        --no-allow-unauthenticated \
        --min-instances 0 \
        --max-instances 10 \
        --memory 512Mi \
        --cpu 1 \
        --concurrency 80 \
        --set-env-vars "NODE_ENV=production" \
        --labels "app=agentics-platform,managed-by=deploy-script"
}

# Get the service URL
get_service_url() {
    log_info "Getting service URL..."

    SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
        --region "${REGION}" \
        --format 'value(status.url)')

    echo -e "${GREEN}Service deployed successfully!${NC}"
    echo -e "URL: ${SERVICE_URL}"
    echo -e "Health check: ${SERVICE_URL}/health"
}

# Test the deployment
test_deployment() {
    local url="${1}"
    log_info "Testing deployment health check..."

    if curl -s -o /dev/null -w "%{http_code}" "${url}/health" | grep -q "200"; then
        log_info "Health check passed!"
    else
        log_warn "Health check did not return 200. Service may still be starting."
    fi
}

# Main deployment flow
main() {
    log_info "Starting deployment of Agentics Platform Backend"
    log_info "Project: ${PROJECT_ID}"
    log_info "Region: ${REGION}"
    log_info "Service: ${SERVICE_NAME}"
    echo ""

    check_prerequisites
    configure_gcloud

    # Generate a tag based on git commit or timestamp
    if command -v git &> /dev/null && git rev-parse --short HEAD &> /dev/null; then
        TAG=$(git rev-parse --short HEAD)
    else
        TAG=$(date +%Y%m%d%H%M%S)
    fi

    build_image "${TAG}"
    push_image "${TAG}"
    deploy_to_cloud_run "${TAG}"
    get_service_url

    # Optional: test the deployment
    if [ -n "${SERVICE_URL:-}" ]; then
        test_deployment "${SERVICE_URL}"
    fi

    log_info "Deployment complete!"
}

# Run main function
main
