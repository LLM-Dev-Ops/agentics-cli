#!/usr/bin/env bash
# Auto-register Agentics CLI as a global MCP server in Claude Code.
# Best-effort: silently exits if Claude Code is not installed.

# Skip in CI environments
if [ -n "$CI" ] || [ -n "$GITHUB_ACTIONS" ] || [ -n "$JENKINS_URL" ]; then
  exit 0
fi

# Skip during npm publish
if [ -n "$npm_command" ] && [ "$npm_command" = "publish" ]; then
  exit 0
fi

# Check if claude CLI exists
if ! command -v claude >/dev/null 2>&1; then
  exit 0
fi

# Remove stale registration if present, then re-register with @latest
# to ensure npx always fetches the newest version.
# Timeout after 5s and redirect stdin to avoid blocking npm install.
timeout 5 claude mcp remove agentics </dev/null >/dev/null 2>&1 || true
timeout 5 claude mcp add -s user agentics -- npx -y @llm-dev-ops/agentics-cli@latest </dev/null >/dev/null 2>&1 || true

exit 0
