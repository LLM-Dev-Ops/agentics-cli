/** Strict input schemas matching what the CLI sends. */

import { z } from 'zod';

// ─── Scenario Agent ────────────────────────────────────────────────────────────

export const scenarioInputSchema = z.object({
  scenario_id: z.string(),
  parameters: z.object({
    description: z.string(),
  }),
}).passthrough();

export type ScenarioInput = z.infer<typeof scenarioInputSchema>;

export interface ScenarioResult {
  scenario_id: string;
  description: string;
  success_probability: number;
  confidence: number;
  risk_factors: RiskFactor[];
  timeline: TimelineEstimate;
  evidence_items: EvidenceItem[];
  category: string;
  complexity: 'low' | 'medium' | 'high' | 'critical';
  recommendations: string[];
}

// ─── What-If Agent ─────────────────────────────────────────────────────────────

export const whatIfInputSchema = z.object({
  input: z.string(),
  domain: z.string(),
}).passthrough();

export type WhatIfInput = z.infer<typeof whatIfInputSchema>;

export interface WhatIfResult {
  query: string;
  variables_detected: string[];
  outcomes: OutcomeScenario[];
  impact_summary: ImpactSummary;
  evidence_items: EvidenceItem[];
  analysis_method: 'rule-based' | 'llm-enhanced';
}

// ─── Shared Types ──────────────────────────────────────────────────────────────

export interface RiskFactor {
  factor: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  mitigation: string;
}

export interface TimelineEstimate {
  optimistic_hours: number;
  expected_hours: number;
  pessimistic_hours: number;
  phases: { name: string; hours: number }[];
}

export interface EvidenceItem {
  type: 'keyword' | 'pattern' | 'heuristic' | 'llm';
  source: string;
  detail: string;
  weight: number;
}

export interface OutcomeScenario {
  label: 'best_case' | 'expected' | 'worst_case';
  probability: number;
  description: string;
  platform_impact: PlatformMetrics;
}

export interface PlatformMetrics {
  cost_change_pct: number;
  latency_change_pct: number;
  reliability_change_pct: number;
  throughput_change_pct: number;
}

export interface ImpactSummary {
  overall_risk: 'low' | 'medium' | 'high' | 'critical';
  primary_dimension: string;
  net_benefit_score: number;  // -1.0 to 1.0
  recommendation: string;
}
