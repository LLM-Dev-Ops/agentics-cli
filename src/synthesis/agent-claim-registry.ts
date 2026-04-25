/**
 * ADR-PIPELINE-096 D3 — Agent-Claim Registry.
 *
 * Maps the four headline financial metrics that the executive summary,
 * decision memo, and financial analysis render onto specific agents and
 * response paths. The renderer consults this registry FIRST when synthesising
 * a number; if the canonical agent returned a value, that value is the source
 * of truth and the rendered cell carries `src=<agent>`. If the registry has no
 * winner, the renderer falls through to `unit-economics.json`, then to the
 * per-employee heuristic from ADR-095.
 *
 * The registry is intentionally NARROW — it covers only the four metrics that
 * appear in every CXO-facing document. Adding a new metric is a one-line
 * change here plus a renderer hook; we are explicit about which numbers carry
 * source attribution and which do not.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The four headline metrics that get source attribution. Lined up with the
 * fcv-tag `kind=` values from ADR-PIPELINE-073 (financial-claim-extractor).
 */
export type ClaimKind = 'investment' | 'roi' | 'npv' | 'payback' | 'savings';

/**
 * One entry maps a metric to a specific agent and a response-path
 * (dot-delimited). Multiple entries per kind are allowed and ranked by
 * priority — the first agent that returned a value wins.
 */
export interface ClaimMapping {
  /** The metric this mapping resolves. */
  readonly kind: ClaimKind;
  /** Domain identifier — e.g. `costops`, `simulator`, `platform`. */
  readonly domain: string;
  /** Agent identifier within the domain — e.g. `forecast`, `roi`, `scenario`. */
  readonly agent: string;
  /** Dot-delimited path inside the agent's response object. Supports `.` and array `[0]` notation. */
  readonly response_path: string;
  /** Lower numbers are tried first. Stable, declarative priority. */
  readonly priority: number;
  /** Optional human-readable methodology string used in the rendered cell. */
  readonly methodology?: string;
}

// ---------------------------------------------------------------------------
// Registry (declarative — the single place mappings live)
// ---------------------------------------------------------------------------

/**
 * Canonical mapping table. Adding a new agent that returns one of the four
 * metrics is a single-line append here. The renderer never hardcodes
 * agent/path knowledge; everything flows through this table.
 */
/**
 * Each `kind` declares MULTIPLE candidate (agent, response_path) pairs to
 * cover the variety of shapes Cloud Run agents return. The first that
 * resolves to a non-empty value wins. Paths are written against the
 * `extractSignalPayload(response).data` shape (the same shape Source 2 of
 * synthesizeFinancials uses), so a successful resolution here also produces
 * a value that matches what the existing scanner would have found.
 */
export const AGENT_CLAIM_REGISTRY: ReadonlyArray<ClaimMapping> = [
  // ── Investment (Total Investment / Total Cost) ─────────────────────────────
  // Realistic agent shapes: agents return strings like "$2.0M" directly under
  // `data.<key>`. A few also nest under `.financial_model`.
  { kind: 'investment', domain: 'costops', agent: 'forecast',    response_path: 'data.investment',         priority: 10, methodology: 'costops/forecast: total program investment forecast' },
  { kind: 'investment', domain: 'costops', agent: 'forecast',    response_path: 'data.budget',             priority: 11, methodology: 'costops/forecast: budget envelope' },
  { kind: 'investment', domain: 'costops', agent: 'forecast',    response_path: 'data.total_investment',   priority: 12, methodology: 'costops/forecast: total investment' },
  { kind: 'investment', domain: 'costops', agent: 'forecast',    response_path: 'data.financial_model.investment', priority: 13, methodology: 'costops/forecast: financial_model.investment' },
  { kind: 'investment', domain: 'costops', agent: 'budget',      response_path: 'data.allocated_budget',   priority: 20, methodology: 'costops/budget: allocated budget' },
  { kind: 'investment', domain: 'costops', agent: 'budget',      response_path: 'data.budget',             priority: 21, methodology: 'costops/budget: budget' },
  { kind: 'investment', domain: 'costops', agent: 'attribution', response_path: 'data.total_cost',         priority: 30, methodology: 'costops/attribution: cost attribution rollup' },
  { kind: 'investment', domain: 'costops', agent: 'attribution', response_path: 'data.investment',         priority: 31, methodology: 'costops/attribution: investment' },

  // ── ROI ────────────────────────────────────────────────────────────────────
  // ADR-PIPELINE-096 D3 calibration finding (2.7.11): the costops/roi agent
  // returns AI-program ROI metrics (token cost vs. AI revenue uplift), NOT
  // project-level ROI. Wiring its `data.roi_metrics.roi_percentage` would
  // produce values like 37,738% in user-facing executive summaries —
  // technically attributed to a real agent but contextually wrong. We keep
  // these paths in the registry for completeness but route through the
  // existing project-level aliases first; if they exist they get used. The
  // proper fix is a project-level financial-modeling agent (or LLM-extract
  // from platform/decision-memo's narrative), tracked as task #24.
  { kind: 'roi', domain: 'costops', agent: 'roi', response_path: 'data.roi',                    priority: 10, methodology: 'costops/roi: program ROI' },
  { kind: 'roi', domain: 'costops', agent: 'roi', response_path: 'data.expected_roi',           priority: 11, methodology: 'costops/roi: expected ROI' },
  { kind: 'roi', domain: 'costops', agent: 'roi', response_path: 'data.return_on_investment',   priority: 12, methodology: 'costops/roi: return on investment' },
  { kind: 'roi', domain: 'costops', agent: 'roi', response_path: 'data.projected_roi',          priority: 13, methodology: 'costops/roi: projected ROI' },
  { kind: 'roi', domain: 'costops', agent: 'tradeoff', response_path: 'data.roi',               priority: 20, methodology: 'costops/tradeoff: ROI under cost-quality tradeoff' },

  // ── NPV (5-year NPV) ───────────────────────────────────────────────────────
  { kind: 'npv', domain: 'simulator', agent: 'scenario',  response_path: 'data.npv',                priority: 10, methodology: 'simulator/scenario: 5-year DCF NPV' },
  { kind: 'npv', domain: 'simulator', agent: 'scenario',  response_path: 'data.5_year_npv',         priority: 11, methodology: 'simulator/scenario: 5-year NPV' },
  { kind: 'npv', domain: 'simulator', agent: 'scenario',  response_path: 'data.five_year_npv',      priority: 12, methodology: 'simulator/scenario: five-year NPV' },
  { kind: 'npv', domain: 'simulator', agent: 'scenario',  response_path: 'data.net_present_value',  priority: 13, methodology: 'simulator/scenario: NPV' },
  { kind: 'npv', domain: 'costops',   agent: 'forecast',  response_path: 'data.npv',                priority: 20, methodology: 'costops/forecast: 5-year NPV' },
  { kind: 'npv', domain: 'costops',   agent: 'forecast',  response_path: 'data.5_year_npv',         priority: 21, methodology: 'costops/forecast: 5-year NPV' },

  // ── Payback ────────────────────────────────────────────────────────────────
  // ADR-096 D3 calibration finding (2.7.11): costops/roi returns
  // payback_period_days for AI program (token-cost recovery), not project
  // payback. Same context-mismatch as ROI above; not wired here. Project
  // payback requires either a project-level financial agent or LLM
  // extraction from narrative responses (task #24).
  { kind: 'payback', domain: 'costops', agent: 'budget',   response_path: 'data.payback',         priority: 10, methodology: 'costops/budget: payback period' },
  { kind: 'payback', domain: 'costops', agent: 'budget',   response_path: 'data.payback_period',  priority: 11, methodology: 'costops/budget: payback period' },
  { kind: 'payback', domain: 'costops', agent: 'forecast', response_path: 'data.payback',         priority: 20, methodology: 'costops/forecast: payback from cumulative cashflow' },
  { kind: 'payback', domain: 'costops', agent: 'forecast', response_path: 'data.payback_period',  priority: 21, methodology: 'costops/forecast: payback period' },
  { kind: 'payback', domain: 'costops', agent: 'forecast', response_path: 'data.break_even',      priority: 22, methodology: 'costops/forecast: break-even' },

  // ── Savings (Annual Efficiency Gain / Revenue Impact) ──────────────────────
  { kind: 'savings', domain: 'costops', agent: 'roi',         response_path: 'data.annual_savings',     priority: 10, methodology: 'costops/roi: annual savings' },
  { kind: 'savings', domain: 'costops', agent: 'roi',         response_path: 'data.savings',            priority: 11, methodology: 'costops/roi: savings' },
  { kind: 'savings', domain: 'costops', agent: 'attribution', response_path: 'data.annual_savings',     priority: 20, methodology: 'costops/attribution: annual savings' },
  { kind: 'savings', domain: 'costops', agent: 'attribution', response_path: 'data.cost_savings',       priority: 21, methodology: 'costops/attribution: cost savings' },
  { kind: 'savings', domain: 'costops', agent: 'forecast',    response_path: 'data.projected_revenue',  priority: 30, methodology: 'costops/forecast: projected revenue' },
  { kind: 'savings', domain: 'costops', agent: 'forecast',    response_path: 'data.revenue_impact',     priority: 31, methodology: 'costops/forecast: revenue impact' },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Minimal shape we need from any agent invocation result. */
export interface AgentResultLike {
  readonly domain: string;
  readonly agent: string;
  readonly status: number;
  readonly response: unknown;
}

/** A claim that has been resolved against the registry. */
export interface ResolvedClaim {
  /** Raw value from the agent (number or string — caller decides format). */
  readonly value: number | string;
  /** Source attribution for the rendered `src=` attribute. */
  readonly source: string;
  /** Methodology string for the cell text. */
  readonly methodology: string;
  /** Which agent produced this value. */
  readonly domain: string;
  readonly agent: string;
}

/**
 * Look up the highest-priority agent that returned a value for `kind`.
 * Returns `null` when no registered agent succeeded with a non-null value at
 * the response path. Caller decides whether to fall through to
 * unit-economics.json or to the per-employee heuristic.
 */
export function resolveClaim(
  kind: ClaimKind,
  results: ReadonlyArray<AgentResultLike>,
): ResolvedClaim | null {
  // Filter mappings to this kind, sorted by priority (lower wins).
  const candidates = AGENT_CLAIM_REGISTRY
    .filter(m => m.kind === kind)
    .slice()
    .sort((a, b) => a.priority - b.priority);

  // Index agent results by `domain/agent` for O(1) lookup.
  const byKey = new Map<string, AgentResultLike>();
  for (const r of results) {
    if (r.status >= 200 && r.status < 300) {
      byKey.set(`${r.domain}/${r.agent}`, r);
    }
  }

  for (const c of candidates) {
    const result = byKey.get(`${c.domain}/${c.agent}`);
    if (!result) continue;
    const value = readResponsePath(result.response, c.response_path);
    if (value === null || value === undefined) continue;
    if (typeof value !== 'number' && typeof value !== 'string') continue;
    if (typeof value === 'string' && value.trim().length === 0) continue;
    return {
      value,
      source: `${c.domain}/${c.agent}`,
      methodology: c.methodology ?? `${c.domain}/${c.agent}`,
      domain: c.domain,
      agent: c.agent,
    };
  }

  return null;
}

/**
 * Resolve ALL agents that returned a value for `kind`. Used by D3 part 2's
 * triangulation surface to detect agreement / divergence across multiple
 * sources for the same metric.
 */
export function resolveAllClaims(
  kind: ClaimKind,
  results: ReadonlyArray<AgentResultLike>,
): ResolvedClaim[] {
  const candidates = AGENT_CLAIM_REGISTRY
    .filter(m => m.kind === kind)
    .slice()
    .sort((a, b) => a.priority - b.priority);

  const byKey = new Map<string, AgentResultLike>();
  for (const r of results) {
    if (r.status >= 200 && r.status < 300) {
      byKey.set(`${r.domain}/${r.agent}`, r);
    }
  }

  const out: ResolvedClaim[] = [];
  for (const c of candidates) {
    const result = byKey.get(`${c.domain}/${c.agent}`);
    if (!result) continue;
    const value = readResponsePath(result.response, c.response_path);
    if (value === null || value === undefined) continue;
    if (typeof value !== 'number' && typeof value !== 'string') continue;
    if (typeof value === 'string' && value.trim().length === 0) continue;
    out.push({
      value,
      source: `${c.domain}/${c.agent}`,
      methodology: c.methodology ?? `${c.domain}/${c.agent}`,
      domain: c.domain,
      agent: c.agent,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk a dot-delimited path inside a response object. Supports nested objects
 * and array indices via `[N]` notation. Returns `null` for any miss.
 *
 * Example: `data.dcf.npv_5yr_usd` → result.data.dcf.npv_5yr_usd
 * Example: `data.scenarios[0].npv` → result.data.scenarios[0].npv
 */
export function readResponsePath(response: unknown, path: string): unknown {
  if (response === null || response === undefined) return null;
  // Tokenize the path on `.` and `[N]`.
  const tokens: Array<string | number> = [];
  let buf = '';
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === '.') {
      if (buf) tokens.push(buf);
      buf = '';
    } else if (ch === '[') {
      if (buf) tokens.push(buf);
      buf = '';
      const close = path.indexOf(']', i);
      if (close === -1) return null;
      const idx = parseInt(path.slice(i + 1, close), 10);
      if (Number.isNaN(idx)) return null;
      tokens.push(idx);
      i = close;
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);

  let cur: unknown = response;
  for (const tok of tokens) {
    if (cur === null || cur === undefined) return null;
    if (typeof tok === 'number') {
      if (!Array.isArray(cur)) return null;
      cur = cur[tok];
    } else {
      if (typeof cur !== 'object') return null;
      cur = (cur as Record<string, unknown>)[tok];
    }
  }
  return cur ?? null;
}
