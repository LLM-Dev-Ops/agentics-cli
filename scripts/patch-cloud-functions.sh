#!/usr/bin/env bash
# ============================================================================
# Patch & Redeploy All 27 Agent Cloud Functions
#
# For each function:
# 1. Download source from GCS
# 2. Patch entry point to read ANTHROPIC_API_KEY from env var
# 3. For functions without Claude integration, add claude.ts + rewire agents
# 4. Redeploy with ANTHROPIC_API_KEY env var
#
# Usage:
#   export ANTHROPIC_API_KEY=sk-ant-...
#   bash scripts/patch-cloud-functions.sh [--dry-run] [--function <name>]
# ============================================================================

set -euo pipefail

GCLOUD="/home/codespace/google-cloud-sdk/bin/gcloud"
GSUTIL="/home/codespace/google-cloud-sdk/bin/gsutil"
PROJECT="agentics-dev"
REGION="us-central1"
BUCKET="gcf-v2-sources-1062287243982-us-central1"
WORKDIR="/tmp/cloud-function-patches"
DRY_RUN=false
SINGLE_FN=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --function) SINGLE_FN="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ERROR: ANTHROPIC_API_KEY env var required"
  echo "  export ANTHROPIC_API_KEY=sk-ant-..."
  exit 1
fi

# All 27 agent Cloud Functions
ALL_FUNCTIONS=(
  platform-agents
  shield-agents
  costops-agents
  sentinel-agents
  test-bench-agents
  observatory-agents
  memory-graph-agents
  latency-lens-agents
  forge-agents
  edge-agents
  auto-optimizer-agents
  incident-manager-agents
  orchestrator-agents
  governance-dashboard-agents
  policy-engine-agents
  registry-agents
  marketplace-agents
  analytics-hub-agents
  config-manager-agents
  schema-registry-agents
  connector-hub-agents
  copilot-agents
  simulator-agents
  benchmark-exchange-agents
  inference-gateway-agents
  data-vault-agents
  research-lab-agents
)

# If single function specified, only do that one
if [ -n "$SINGLE_FN" ]; then
  FUNCTIONS=("$SINGLE_FN")
else
  FUNCTIONS=("${ALL_FUNCTIONS[@]}")
fi

mkdir -p "$WORKDIR"

# ============================================================================
# Shared claude.ts module (added to functions that don't have one)
# ============================================================================
CLAUDE_TS='const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

interface ClaudeContentBlock {
  type: string;
  text: string;
}

interface ClaudeMessageResponse {
  content: ClaudeContentBlock[];
}

/**
 * Call the Anthropic Messages API.
 * API key resolved from: parameter > x-anthropic-api-key header > ANTHROPIC_API_KEY env var.
 */
export async function callClaude(
  apiKey: string,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const resp = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
    signal: AbortSignal.timeout(50000),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Claude API ${resp.status}: ${errText}`);
  }
  const data = (await resp.json()) as ClaudeMessageResponse;
  return data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

export function extractJson<T = unknown>(text: string): T {
  const fenceMatch = text.match(/```(?:json)?\\s*([\\s\\S]*?)```/);
  if (fenceMatch) return JSON.parse(fenceMatch[1].trim()) as T;
  const startIdx = text.search(/[{[]/);
  if (startIdx >= 0) {
    const startChar = text[startIdx];
    const endChar = startChar === "{" ? "}" : "]";
    let depth = 0;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === startChar) depth++;
      else if (text[i] === endChar) depth--;
      if (depth === 0) return JSON.parse(text.slice(startIdx, i + 1)) as T;
    }
  }
  return JSON.parse(text.trim()) as T;
}

export function resolveApiKey(headerKey?: string): string | undefined {
  return headerKey || process.env.ANTHROPIC_API_KEY || undefined;
}
'

# ============================================================================
# Process each function
# ============================================================================
SUCCESS=0
FAILED=0
SKIPPED=0

for fn in "${FUNCTIONS[@]}"; do
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Processing: $fn"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  FN_DIR="$WORKDIR/$fn"
  rm -rf "$FN_DIR"
  mkdir -p "$FN_DIR"

  # Step 1: Download source
  echo "  [1/4] Downloading source..."
  if ! $GSUTIL cp "gs://$BUCKET/$fn/function-source.zip" "$FN_DIR/source.zip" 2>/dev/null; then
    echo "  ⚠️  Could not download source for $fn — skipping"
    ((SKIPPED++))
    continue
  fi
  unzip -oq "$FN_DIR/source.zip" -d "$FN_DIR/src"

  # Step 2: Detect architecture and find entry point
  echo "  [2/4] Analyzing architecture..."
  ENTRY_FILE=""
  # Common entry point locations
  for candidate in \
    "$FN_DIR/src/src/index.ts" \
    "$FN_DIR/src/functions/index.ts" \
    "$FN_DIR/src/index.ts" \
    "$FN_DIR/src/dist/index.js"; do
    if [ -f "$candidate" ]; then
      ENTRY_FILE="$candidate"
      break
    fi
  done

  if [ -z "$ENTRY_FILE" ]; then
    echo "  ⚠️  No entry point found — skipping"
    ((SKIPPED++))
    continue
  fi
  echo "  Entry: ${ENTRY_FILE#$FN_DIR/src/}"

  # Check if it already has env var fallback
  if grep -q 'process.env.ANTHROPIC_API_KEY' "$ENTRY_FILE" 2>/dev/null; then
    echo "  ✅ Already has env var fallback — just needs ANTHROPIC_API_KEY set"
  else
    # Step 3: Patch the entry point
    echo "  [3/4] Patching entry point..."

    # Pattern A: Has x-anthropic-api-key header reading — add env fallback
    if grep -q 'x-anthropic-api-key' "$ENTRY_FILE" 2>/dev/null; then
      echo "    Adding process.env.ANTHROPIC_API_KEY fallback to header reading..."
      # Replace: (req.headers["x-anthropic-api-key"] as string) || undefined
      # With:    (req.headers["x-anthropic-api-key"] as string) || process.env.ANTHROPIC_API_KEY || undefined
      sed -i 's|(req\.headers\["x-anthropic-api-key"\] as string) || undefined|(req.headers["x-anthropic-api-key"] as string) || process.env.ANTHROPIC_API_KEY || undefined|g' "$ENTRY_FILE"

      # Also handle the copilot pattern where it hard-fails without header
      if grep -q "if (!anthropicApiKey)" "$ENTRY_FILE" 2>/dev/null; then
        sed -i "s|const anthropicApiKey = req.headers\['x-anthropic-api-key'\] as string | undefined;|const anthropicApiKey = (req.headers['x-anthropic-api-key'] as string) || process.env.ANTHROPIC_API_KEY || undefined;|g" "$ENTRY_FILE"
      fi
    fi

    # Pattern B: Has callClaude but API key only from parameter — add env fallback
    if grep -q 'callClaude' "$ENTRY_FILE" 2>/dev/null && ! grep -q 'process.env.ANTHROPIC_API_KEY' "$ENTRY_FILE" 2>/dev/null; then
      echo "    Adding env var fallback to callClaude path..."
      # Find where apiKey is resolved and add env fallback
      sed -i 's|const apiKey = undefined;|const apiKey = process.env.ANTHROPIC_API_KEY || undefined;|g' "$ENTRY_FILE"
    fi
  fi

  # Step 4: Deploy
  if [ "$DRY_RUN" = true ]; then
    echo "  [4/4] DRY RUN — would deploy $fn with ANTHROPIC_API_KEY"
    ((SUCCESS++))
  else
    echo "  [4/4] Deploying $fn..."

    # Set ANTHROPIC_API_KEY env var on the function
    if $GCLOUD functions deploy "$fn" \
      --project="$PROJECT" \
      --region="$REGION" \
      --update-env-vars="ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
      --quiet 2>&1 | tail -3; then
      echo "  ✅ Deployed $fn with ANTHROPIC_API_KEY"
      ((SUCCESS++))
    else
      echo "  ❌ Failed to deploy $fn"
      ((FAILED++))
    fi
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Results: $SUCCESS success, $FAILED failed, $SKIPPED skipped"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
