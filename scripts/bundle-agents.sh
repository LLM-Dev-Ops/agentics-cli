#!/usr/bin/env bash
# Bundle Cloud Function agent handler code into dist/bundled-agents/
# for inclusion in the npm package. Excludes node_modules, tests, etc.
#
# Run: npm run bundle-agents  (or automatically via prepublishOnly)
set -euo pipefail

REPO_CACHE="${HOME}/.agentics/repo-cache"
BUNDLE_DIR="./dist/bundled-agents"

if [ ! -d "$REPO_CACHE" ]; then
  echo "WARN: Repo cache not found at $REPO_CACHE — skipping agent bundling"
  echo "Agents will be fetched at runtime instead."
  mkdir -p "$BUNDLE_DIR"
  exit 0
fi

# All 27 agent domains: org-repo-name → bundled-name
# The bundled name uses -agents suffix for backward compatibility with
# the repo-agent-runner domain map and existing deployments.
declare -A AGENT_REPOS=(
  [analytics-hub]="analytics-hub-agents"
  [auto-optimizer]="auto-optimizer-agents"
  [benchmark-exchange]="benchmark-exchange-agents"
  [config-manager]="config-manager-agents"
  [connector-hub]="connector-hub-agents"
  [copilot-agent]="copilot-agents"
  [cost-ops]="costops-agents"
  [data-vault]="data-vault-agents"
  [edge-agent]="edge-agents"
  [forge]="forge-agents"
  [governance-dashboard]="governance-dashboard-agents"
  [incident-manager]="incident-manager-agents"
  [inference-gateway]="inference-gateway-agents"
  [latency-lens]="latency-lens-agents"
  [marketplace]="marketplace-agents"
  [memory-graph]="memory-graph-agents"
  [observatory]="observatory-agents"
  [orchestrator]="orchestrator-agents"
  [platform-agents]="platform-agents"
  [policy-engine]="policy-engine-agents"
  [registry]="registry-agents"
  [research-lab]="research-lab-agents"
  [schema-registry]="schema-registry-agents"
  [sentinel]="sentinel-agents"
  [shield]="shield-agents"
  [simulator]="simulator-agents"
  [test-bench]="test-bench-agents"
)

rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR"

TOTAL_REPOS=0
SKIPPED=0

for org_name in $(echo "${!AGENT_REPOS[@]}" | tr ' ' '\n' | sort); do
  bundle_name="${AGENT_REPOS[$org_name]}"
  SRC_DIR="$REPO_CACHE/$org_name"
  DST_DIR="$BUNDLE_DIR/$bundle_name"

  if [ ! -d "$SRC_DIR" ]; then
    echo "  SKIP: $org_name (not in repo-cache)"
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
  echo "  OK: $org_name → $bundle_name ($SIZE)"
  TOTAL_REPOS=$((TOTAL_REPOS + 1))
done

TOTAL_SIZE=$(du -sh "$BUNDLE_DIR" | awk '{print $1}')
echo ""
echo "Bundled $TOTAL_REPOS/$((TOTAL_REPOS + SKIPPED)) repos → $BUNDLE_DIR ($TOTAL_SIZE)"
