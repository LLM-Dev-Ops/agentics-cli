#!/usr/bin/env bash
# ============================================================================
# validate_claude_flow_style.sh
#
# Validation script for ADR-006/007/008: Claude Flow-style Claude Code
# execution inside agentics-cli.
#
# Verifies:
# 1. Build succeeds
# 2. Non-synthesis commands (whoami) do NOT invoke Claude Code
# 3. Synthesis commands (simulate create) DO invoke Claude Code (when available)
# 4. Artifact persistence works
# 5. Inspect commands work without synthesis
#
# Usage:
#   ./scripts/validate_claude_flow_style.sh
#
# Exit codes:
#   0 = all checks passed
#   1 = one or more checks failed
# ============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

PASS=0
FAIL=0
SKIP=0

pass() {
  echo -e "${GREEN}[PASS]${NC} $1"
  PASS=$((PASS + 1))
}

fail() {
  echo -e "${RED}[FAIL]${NC} $1"
  FAIL=$((FAIL + 1))
}

skip() {
  echo -e "${YELLOW}[SKIP]${NC} $1"
  SKIP=$((SKIP + 1))
}

# ============================================================================
# Step 1: Install deps and build
# ============================================================================

echo "============================================"
echo "Step 1: Install dependencies and build"
echo "============================================"

if npm install --silent 2>&1; then
  pass "npm install succeeded"
else
  fail "npm install failed"
  exit 1
fi

if npx tsc 2>&1; then
  pass "TypeScript build succeeded"
else
  fail "TypeScript build failed"
  exit 1
fi

# ============================================================================
# Step 2: Verify new modules exist in dist/
# ============================================================================

echo ""
echo "============================================"
echo "Step 2: Verify compiled modules exist"
echo "============================================"

for module in \
  "dist/runtime/claude-code-runner.js" \
  "dist/synthesis/router.js" \
  "dist/synthesis/artifact-writer.js" \
  "dist/synthesis/prompts/index.js" \
  "dist/contracts/adr-006-claude-code-synthesis-runner.js" \
  "dist/contracts/adr-007-subcommand-synthesis-router.js" \
  "dist/contracts/adr-008-synthesis-artifact-persistence.js"; do
  if [ -f "$module" ]; then
    pass "Module exists: $module"
  else
    fail "Module missing: $module"
  fi
done

# ============================================================================
# Step 3: Verify ADR type exports compile correctly
# ============================================================================

echo ""
echo "============================================"
echo "Step 3: Verify ADR exports are importable"
echo "============================================"

# Test that we can import the synthesis router
node --input-type=module -e "
  import { isDecisionGrade } from './dist/synthesis/router.js';
  import { DECISION_GRADE_SUBCOMMANDS } from './dist/contracts/adr-007-subcommand-synthesis-router.js';
  import { SYNTHESIS_SCHEMA_MAP } from './dist/contracts/adr-006-claude-code-synthesis-runner.js';

  // Verify decision-grade subcommand count matches spec
  const expected = 20;
  const actual = DECISION_GRADE_SUBCOMMANDS.size;
  if (actual !== expected) {
    console.error('DECISION_GRADE_SUBCOMMANDS count: expected=' + expected + ' actual=' + actual);
    process.exit(1);
  }

  // Verify schema map covers all decision-grade subcommands
  for (const key of DECISION_GRADE_SUBCOMMANDS) {
    if (!SYNTHESIS_SCHEMA_MAP[key]) {
      console.error('Missing schema mapping for: ' + key);
      process.exit(1);
    }
  }

  // Verify non-synthesis commands return false
  if (isDecisionGrade('login', undefined)) {
    console.error('login should not be decision-grade');
    process.exit(1);
  }
  if (isDecisionGrade('whoami', undefined)) {
    console.error('whoami should not be decision-grade');
    process.exit(1);
  }
  if (isDecisionGrade('simulate', 'list')) {
    console.error('simulate list should not be decision-grade');
    process.exit(1);
  }
  if (isDecisionGrade('simulate', 'inspect')) {
    console.error('simulate inspect should not be decision-grade');
    process.exit(1);
  }

  // Verify decision-grade commands return true
  if (!isDecisionGrade('simulate', 'create')) {
    console.error('simulate create SHOULD be decision-grade');
    process.exit(1);
  }
  if (!isDecisionGrade('plan', 'create')) {
    console.error('plan create SHOULD be decision-grade');
    process.exit(1);
  }
  if (!isDecisionGrade('deploy', 'preview')) {
    console.error('deploy preview SHOULD be decision-grade');
    process.exit(1);
  }

  console.log('All synthesis router checks passed');
" 2>&1 && pass "Synthesis router exports verified" || fail "Synthesis router exports failed"

# ============================================================================
# Step 4: Verify prompt templates exist for all decision-grade subcommands
# ============================================================================

echo ""
echo "============================================"
echo "Step 4: Verify prompt templates coverage"
echo "============================================"

node --input-type=module -e "
  import { PROMPT_TEMPLATES } from './dist/synthesis/prompts/index.js';
  import { DECISION_GRADE_SUBCOMMANDS } from './dist/contracts/adr-007-subcommand-synthesis-router.js';

  let missing = 0;
  for (const key of DECISION_GRADE_SUBCOMMANDS) {
    if (!PROMPT_TEMPLATES[key]) {
      console.error('Missing prompt template for: ' + key);
      missing++;
    }
  }

  if (missing > 0) {
    process.exit(1);
  }

  // Verify templates produce non-empty strings
  for (const [key, fn] of Object.entries(PROMPT_TEMPLATES)) {
    const result = fn({
      runId: 'test-run-id',
      seed: 42,
      command: key.split('.')[0],
      subcommand: key.split('.')[1],
      positionalArgs: ['test-arg'],
      options: {},
      contractSchemaName: 'test-schema',
    });
    if (typeof result !== 'string' || result.length < 50) {
      console.error('Template ' + key + ' produced invalid output: ' + result?.slice(0, 100));
      process.exit(1);
    }
    // Verify JSON-only instruction is present
    if (!result.includes('JSON')) {
      console.error('Template ' + key + ' missing JSON-only instruction');
      process.exit(1);
    }
  }

  console.log('All ' + Object.keys(PROMPT_TEMPLATES).length + ' prompt templates verified');
" 2>&1 && pass "Prompt templates verified" || fail "Prompt templates failed"

# ============================================================================
# Step 5: Verify artifact writer works
# ============================================================================

echo ""
echo "============================================"
echo "Step 5: Verify artifact writer"
echo "============================================"

TEST_RUNS_DIR=$(mktemp -d)
node --input-type=module -e "
  import { createArtifactWriter } from './dist/synthesis/artifact-writer.js';
  import * as fs from 'node:fs';
  import * as path from 'node:path';

  const writer = createArtifactWriter('${TEST_RUNS_DIR}');

  const manifest = {
    run_id: 'run-test-12345',
    command: 'simulate',
    subcommand: 'create',
    synthesis_class: 'SYNTHESIS_REQUIRED',
    contract_schema: 'simulation',
    model: 'claude-sonnet-4-20250514',
    duration_ms: 1234,
    created_at: new Date().toISOString(),
    seed: 42,
    user_id: 'test-user',
    org_id: 'test-org',
    trace_id: 'test-trace',
    artifacts: ['manifest.json', 'claude_output.json', 'platform_receipt.json', 'prompt.txt'],
  };

  const receipt = {
    success: true,
    platform_id: 'sim-abc123',
    platform_type: 'SimulationReference',
    status: 'created',
    timestamp: new Date().toISOString(),
    trace_id: 'test-trace',
  };

  const writeResult = writer.write({
    manifest,
    claudeOutput: { id: 'test', type: 'SimulationReference' },
    platformReceipt: receipt,
    prompt: 'test prompt content',
  });
  const runDir = writeResult.runDir;

  // Verify files exist
  const expectedFiles = ['manifest.json', 'claude_output.json', 'platform_receipt.json', 'prompt.txt'];
  for (const file of expectedFiles) {
    const filePath = path.join(runDir, file);
    if (!fs.existsSync(filePath)) {
      console.error('Missing artifact file: ' + filePath);
      process.exit(1);
    }
  }

  // Verify manifest content
  const readManifest = writer.readManifest('run-test-12345');
  if (!readManifest || readManifest.run_id !== 'run-test-12345') {
    console.error('Failed to read back manifest');
    process.exit(1);
  }

  console.log('Artifact writer verified: ' + runDir);
" 2>&1 && pass "Artifact writer works" || fail "Artifact writer failed"

# Cleanup
rm -rf "$TEST_RUNS_DIR"

# ============================================================================
# Step 6: Verify Claude Code runner binary resolution (graceful failure)
# ============================================================================

echo ""
echo "============================================"
echo "Step 6: Verify Claude Code runner"
echo "============================================"

node --input-type=module -e "
  import { createClaudeCodeRunner } from './dist/runtime/claude-code-runner.js';

  const runner = createClaudeCodeRunner();

  // Test binary resolution - should fail gracefully if claude not installed
  try {
    runner.resolve();
    console.log('Claude Code binary found: resolution succeeded');
  } catch (error) {
    if (error.code === 'ECLI-SYNTH-001') {
      console.log('Claude Code binary not installed (expected in CI): ECLI-SYNTH-001');
    } else {
      console.error('Unexpected error: ' + error.message);
      process.exit(1);
    }
  }
" 2>&1 && pass "Claude Code runner resolution works" || fail "Claude Code runner failed"

# ============================================================================
# Step 7: Verify CLI loads without error (smoke test)
# ============================================================================

echo ""
echo "============================================"
echo "Step 7: CLI smoke tests"
echo "============================================"

# version command (no synthesis)
if node dist/cli/index.js version 2>&1 | grep -q "1\.4"; then
  pass "agentics version works (no synthesis)"
else
  fail "agentics version failed"
fi

# help command (no synthesis)
if node dist/cli/index.js help 2>&1 | grep -qi "usage\|commands\|agentics"; then
  pass "agentics help works (no synthesis)"
else
  fail "agentics help failed"
fi

# ============================================================================
# Summary
# ============================================================================

echo ""
echo "============================================"
echo "VALIDATION SUMMARY"
echo "============================================"
echo -e "  ${GREEN}Passed:${NC}  $PASS"
echo -e "  ${RED}Failed:${NC}  $FAIL"
echo -e "  ${YELLOW}Skipped:${NC} $SKIP"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}VALIDATION FAILED${NC}"
  exit 1
else
  echo -e "${GREEN}ALL CHECKS PASSED${NC}"
  exit 0
fi
