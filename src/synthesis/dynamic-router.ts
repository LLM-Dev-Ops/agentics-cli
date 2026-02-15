/**
 * Dynamic Downstream Router — Thin Passthrough
 *
 * ARCHITECTURE:
 *   The CLI does NOT classify intent, detect categories, score keywords,
 *   select services, or choose agents. All of that is platform-side logic.
 *
 *   This module builds a structured request from the user's raw description
 *   and passes it to agentics-dev-platform for routing decisions.
 *
 * REMOVED (moved to platform):
 *   - CATEGORY_PATTERNS / keyword scoring / phrase matching
 *   - INDUSTRY_PATTERNS / industry detection
 *   - CATEGORY_SERVICE_MAP / service selection
 *   - CATEGORY_AGENT_MAP / agent selection
 *   - detectScale() / employee-count thresholds
 *   - resolveSimulationProfile() / scoring algorithm
 *   - Confidence normalization
 *
 * WHAT REMAINS:
 *   - Type definitions (for contract compatibility)
 *   - buildRoutingRequest() — formats raw description into structured request
 *   - The platform returns the SimulationProfile; we just pass it through.
 */

// ============================================================================
// Types (kept for contract compatibility with platform responses)
// ============================================================================

export interface DownstreamService {
  name: string;
  purpose: string;
  apiSurface: string;
  repo: string;
  contractSchema: string;
  priority: 'primary' | 'supporting';
}

export interface AgentProfile {
  type: string;
  role: string;
  outputs: string[];
}

export type SimulationCategory =
  | 'enterprise_ai_deployment'
  | 'financial_analysis'
  | 'regulatory_compliance'
  | 'infrastructure_deployment'
  | 'security_assessment'
  | 'erp_integration'
  | 'change_management'
  | 'research_development'
  | 'workforce_transformation'
  | 'general';

export interface SimulationProfile {
  category: SimulationCategory;
  confidence: number;
  detectedCategories: Array<{ category: SimulationCategory; score: number }>;
  services: DownstreamService[];
  agents: AgentProfile[];
  layers: string[];
  industry?: string;
  scale?: string;
}

// ============================================================================
// Routing Request (sent to platform)
// ============================================================================

export interface RoutingRequest {
  description: string;
  command: string;
  subcommand: string;
}

/**
 * Build a routing request to send to the platform.
 * The CLI does NOT classify, score, or route — it formats and sends.
 */
export function buildRoutingRequest(
  command: string,
  subcommand: string,
  description: string,
): RoutingRequest {
  return { description, command, subcommand };
}

/**
 * @deprecated The CLI no longer resolves simulation profiles locally.
 * Category detection, service selection, agent mapping, and confidence
 * scoring are platform-side concerns. Use buildRoutingRequest() and
 * send to agentics-dev-platform for a SimulationProfile response.
 *
 * Returns a minimal stub so callers that haven't migrated don't crash.
 */
export function resolveSimulationProfile(_description: string): SimulationProfile {
  return {
    category: 'general',
    confidence: 0,
    detectedCategories: [],
    services: [],
    agents: [],
    layers: [],
  };
}

/**
 * @deprecated Use buildRoutingRequest() + platform call instead.
 * Returns empty string — prompt context is now generated platform-side.
 */
export function generatePromptContext(_profile: SimulationProfile): string {
  return '';
}

/**
 * @deprecated Use buildRoutingRequest() + platform call instead.
 */
export function resolveCommandProfile(
  _command: string,
  _subcommand: string,
  _description: string,
): SimulationProfile | null {
  return null;
}
