#!/usr/bin/env bash
# Auto-register Agentics CLI as a global MCP server in Claude Code.
# Runs on `npm install -g @llm-dev-ops/agentics-cli` (postinstall hook).
# Best-effort: silently exits if Claude Code is not installed.
set -e

# Skip in CI environments
if [ -n "$CI" ] || [ -n "$GITHUB_ACTIONS" ] || [ -n "$JENKINS_URL" ]; then
  exit 0
fi

# Skip during npm publish (prepublishOnly triggers install)
if [ -n "$npm_command" ] && [ "$npm_command" = "publish" ]; then
  exit 0
fi

# Check if claude CLI exists
if ! command -v claude >/dev/null 2>&1; then
  exit 0
fi

# Register as user-scoped MCP server (works in every project)
claude mcp add -s user agentics -- npx -y @llm-dev-ops/agentics-cli 2>/dev/null || true

echo "✓ Agentics CLI registered with Claude Code (global MCP server)"
