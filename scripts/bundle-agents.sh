#!/usr/bin/env bash
# Bundle Cloud Function agent handler code into dist/bundled-agents/
# for inclusion in the npm package. Excludes node_modules, tests, etc.
#
# Run: npm run bundle-agents  (or automatically via prepublishOnly)
set -euo pipefail

REPO_CACHE="${HOME}/.agentics/repo-cache"
BUNDLE_DIR="./dist/bundled-agents"

if [ ! -d "$REPO_CACHE" ]; then
  echo "ERROR: Repo cache not found at $REPO_CACHE"
  echo "Run the agents first to populate the cache, then re-run this script."
  exit 1
fi

# All 27 Cloud Function repos
FUNCTIONS=(
  analytics-hub-agents
  auto-optimizer-agents
  benchmark-exchange-agents
  config-manager-agents
  connector-hub-agents
  copilot-agents
  costops-agents
  data-vault-agents
  edge-agents
  forge-agents
  governance-dashboard-agents
  incident-manager-agents
  inference-gateway-agents
  latency-lens-agents
  marketplace-agents
  memory-graph-agents
  observatory-agents
  orchestrator-agents
  platform-agents
  policy-engine-agents
  registry-agents
  research-lab-agents
  schema-registry-agents
  sentinel-agents
  shield-agents
  simulator-agents
  test-bench-agents
)

rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR"

TOTAL_REPOS=0
SKIPPED=0

for fn in "${FUNCTIONS[@]}"; do
  SRC_DIR="$REPO_CACHE/$fn"
  DST_DIR="$BUNDLE_DIR/$fn"

  if [ ! -d "$SRC_DIR" ]; then
    echo "  SKIP: $fn (not in repo-cache)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  mkdir -p "$DST_DIR"

  # Copy package metadata and tsconfig (needed for npm install and path alias resolution)
  for f in package.json package-lock.json tsconfig.json tsconfig.build.json; do
    [ -f "$SRC_DIR/$f" ] && cp "$SRC_DIR/$f" "$DST_DIR/"
  done

  # Copy handler directories
  for d in dist lib src functions; do
    [ -d "$SRC_DIR/$d" ] && cp -r "$SRC_DIR/$d" "$DST_DIR/"
  done

  # Copy root index.js if present
  [ -f "$SRC_DIR/index.js" ] && cp "$SRC_DIR/index.js" "$DST_DIR/"

  # Ensure injected claude shims are included
  for shim in dist/claude.js src/claude.ts src/claude.js lib/claude.js functions/dist/claude.js; do
    if [ -f "$SRC_DIR/$shim" ] && [ ! -f "$DST_DIR/$shim" ]; then
      mkdir -p "$DST_DIR/$(dirname "$shim")"
      cp "$SRC_DIR/$shim" "$DST_DIR/$shim"
    fi
  done

  # Clean up files that shouldn't be in the bundle
  find "$DST_DIR" -name "node_modules" -type d -exec rm -rf {} + 2>/dev/null || true
  find "$DST_DIR" -name ".git" -type d -exec rm -rf {} + 2>/dev/null || true
  find "$DST_DIR" -name "source.zip" -delete 2>/dev/null || true
  find "$DST_DIR" -name ".agent-runner-tmp-*" -delete 2>/dev/null || true
  find "$DST_DIR" -name "Dockerfile" -delete 2>/dev/null || true
  find "$DST_DIR" -name "docker-compose.yaml" -delete 2>/dev/null || true
  find "$DST_DIR" -name "Makefile" -delete 2>/dev/null || true
  find "$DST_DIR" -name "cloudbuild.yaml" -delete 2>/dev/null || true
  find "$DST_DIR" -name "Cargo.toml" -delete 2>/dev/null || true
  find "$DST_DIR" -name "*.md" -not -name "package.json" -delete 2>/dev/null || true
  rm -rf "$DST_DIR/tests" "$DST_DIR/test" "$DST_DIR/docs" "$DST_DIR/examples" \
         "$DST_DIR/benches" "$DST_DIR/deploy" "$DST_DIR/iam" "$DST_DIR/plans" \
         "$DST_DIR/scripts" "$DST_DIR/crates" "$DST_DIR/sdks" 2>/dev/null || true

  SIZE=$(du -sh "$DST_DIR" | awk '{print $1}')
  echo "  OK: $fn ($SIZE)"
  TOTAL_REPOS=$((TOTAL_REPOS + 1))
done

TOTAL_SIZE=$(du -sh "$BUNDLE_DIR" | awk '{print $1}')
echo ""
echo "Bundled $TOTAL_REPOS/$((TOTAL_REPOS + SKIPPED)) repos → $BUNDLE_DIR ($TOTAL_SIZE)"
