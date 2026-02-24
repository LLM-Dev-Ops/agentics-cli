/**
 * LLM Enhancement Layer
 *
 * When ANTHROPIC_API_KEY is available (via env var or X-Anthropic-Api-Key header),
 * uses Claude for deeper analysis. Falls back to rule-based results if unavailable.
 */

import type { ScenarioResult, WhatIfResult } from './types.js';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

async function callClaude(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 1024,
): Promise<string | null> {
  try {
    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }] satisfies ClaudeMessage[],
      }),
    });

    if (!response.ok) return null;

    const data = await response.json() as { content?: { text?: string }[] };
    return data.content?.[0]?.text ?? null;
  } catch {
    return null;
  }
}

export async function enhanceScenario(
  apiKey: string | undefined,
  ruleBasedResult: ScenarioResult,
): Promise<ScenarioResult> {
  if (!apiKey) return ruleBasedResult;

  const system = `You are a platform operations analyst for the Agentics AI platform. Given a scenario analysis result (JSON) and the original description, provide enhanced analysis. Return ONLY valid JSON with these fields:
- additional_risks: array of { factor: string, severity: "low"|"medium"|"high"|"critical", mitigation: string }
- refined_success_probability: number (0-1)
- additional_recommendations: string[]
- reasoning: string (1-2 sentences)`;

  const userMsg = `Scenario: "${ruleBasedResult.description}"
Current analysis: ${JSON.stringify({
    success_probability: ruleBasedResult.success_probability,
    complexity: ruleBasedResult.complexity,
    category: ruleBasedResult.category,
    risk_count: ruleBasedResult.risk_factors.length,
  })}`;

  const llmResponse = await callClaude(apiKey, system, userMsg, 512);
  if (!llmResponse) return ruleBasedResult;

  try {
    const enhancement = JSON.parse(llmResponse) as {
      additional_risks?: ScenarioResult['risk_factors'];
      refined_success_probability?: number;
      additional_recommendations?: string[];
      reasoning?: string;
    };

    // Merge LLM enhancements with rule-based results
    const merged = { ...ruleBasedResult };

    if (enhancement.additional_risks?.length) {
      merged.risk_factors = [...merged.risk_factors, ...enhancement.additional_risks];
    }

    if (typeof enhancement.refined_success_probability === 'number') {
      // Weighted average: 60% rule-based, 40% LLM
      merged.success_probability = Math.round(
        (ruleBasedResult.success_probability * 0.6 + enhancement.refined_success_probability * 0.4) * 100,
      ) / 100;
    }

    if (enhancement.additional_recommendations?.length) {
      merged.recommendations = [...merged.recommendations, ...enhancement.additional_recommendations];
    }

    if (enhancement.reasoning) {
      merged.evidence_items = [
        ...merged.evidence_items,
        { type: 'llm', source: 'claude-enhancement', detail: enhancement.reasoning, weight: 0.5 },
      ];
    }

    merged.confidence = Math.min(0.95, merged.confidence + 0.15);
    return merged;
  } catch {
    return ruleBasedResult;
  }
}

export async function enhanceWhatIf(
  apiKey: string | undefined,
  ruleBasedResult: WhatIfResult,
): Promise<WhatIfResult> {
  if (!apiKey) return ruleBasedResult;

  const system = `You are a platform impact analyst for the Agentics AI platform. Given a what-if analysis result (JSON) and the original query, provide enhanced analysis. Return ONLY valid JSON with these fields:
- additional_evidence: array of { type: "llm", source: string, detail: string, weight: number }
- refined_recommendation: string
- reasoning: string (1-2 sentences)`;

  const userMsg = `Query: "${ruleBasedResult.query}"
Variables detected: ${JSON.stringify(ruleBasedResult.variables_detected)}
Impact summary: ${JSON.stringify(ruleBasedResult.impact_summary)}`;

  const llmResponse = await callClaude(apiKey, system, userMsg, 512);
  if (!llmResponse) return ruleBasedResult;

  try {
    const enhancement = JSON.parse(llmResponse) as {
      additional_evidence?: WhatIfResult['evidence_items'];
      refined_recommendation?: string;
      reasoning?: string;
    };

    const merged = { ...ruleBasedResult };

    if (enhancement.additional_evidence?.length) {
      merged.evidence_items = [...merged.evidence_items, ...enhancement.additional_evidence];
    }

    if (enhancement.refined_recommendation) {
      merged.impact_summary = {
        ...merged.impact_summary,
        recommendation: enhancement.refined_recommendation,
      };
    }

    if (enhancement.reasoning) {
      merged.evidence_items.push({
        type: 'llm',
        source: 'claude-enhancement',
        detail: enhancement.reasoning,
        weight: 0.5,
      });
    }

    merged.analysis_method = 'llm-enhanced';
    return merged;
  } catch {
    return ruleBasedResult;
  }
}
