/**
 * Claude Shim — Replaces the Anthropic HTTP API with local `claude --print`
 *
 * This module provides a drop-in replacement for the `callClaude()` function
 * found in each Cloud Function repo's `claude.ts`. Instead of calling the
 * Anthropic Messages API (which requires an API key), it invokes the local
 * `claude` binary via `claude --print` (powered by the user's Claude Max
 * subscription).
 *
 * This allows repo code to run locally with real AI — no API keys needed.
 */

import { createClaudeCodeRunner } from '../runtime/claude-code-runner.js';

/**
 * Drop-in replacement for the Cloud Function repos' `callClaude()`.
 *
 * Same signature: (apiKey, systemPrompt, userMessage) => string
 * The apiKey parameter is ignored — Claude Max handles auth.
 */
export function callClaude(
  _apiKey: string,
  systemPrompt: string,
  userMessage: string,
): string {
  const runner = createClaudeCodeRunner();
  const prompt = `${systemPrompt}\n\n${userMessage}`;
  const result = runner.invoke<Record<string, unknown>>(prompt, {
    runId: `shim-${Date.now()}`,
    schemaKey: undefined,
    timeoutMs: 120_000,
    verbose: false,
  });

  // Return the raw text — the repo's extractJson() handles parsing
  const data = result.data;
  if (typeof data === 'string') return data;
  // If claude --print returned parsed JSON, stringify it back
  // (the repo's handler will re-parse it)
  return JSON.stringify(data);
}

/**
 * Extract JSON from Claude's response, handling markdown code fences.
 * Identical to the function in each repo's claude.ts.
 */
export function extractJson<T = unknown>(text: string): T {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    return JSON.parse(fenceMatch[1]!.trim()) as T;
  }
  const startIdx = text.search(/[{[]/);
  if (startIdx >= 0) {
    const startChar = text[startIdx]!;
    const endChar = startChar === '{' ? '}' : ']';
    let depth = 0;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === startChar) depth++;
      else if (text[i] === endChar) depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(startIdx, i + 1)) as T;
      }
    }
  }
  return JSON.parse(text.trim()) as T;
}
