/**
 * ADR-PIPELINE-090: stderr-line → AgentEvent parser for the MCP wrapper.
 *
 * Extracted into its own module so unit tests can exercise the parsing
 * without importing src/mcp/mcp-server.ts (which attaches stdin/stdout
 * listeners at module load time — inappropriate for jest).
 *
 * The grammars recognized here are the actual log prefixes emitted by:
 *   - src/commands/agents.ts            (ruvector simulation retry + [local] fallbacks)
 *   - src/pipeline/swarm-orchestrator.ts ([AGENTICS] [OK|FAIL|FB|!!] ...)
 *   - src/pipeline/auto-chain.ts         (>> Phase N: ...)
 *   - src/pipeline/phase2-preflight.ts   (via swarm-orchestrator — [PREFLIGHT] ...)
 *   - ADR-089 verdict line               (Phase 1 verdict: ...)
 *
 * If you add a new log prefix at one of those sites, add a matching
 * parser branch here so the event reaches the Agent Invocation Report
 * instead of being silently dropped.
 */

export interface AgentEvent {
  phase: number;
  kind: 'sim-start' | 'sim-ok' | 'sim-fail' | 'sim-retry' | 'ok' | 'fail' | 'fallback' | 'preflight' | 'verdict' | 'phase-header';
  domain?: string;
  agent?: string;
  role?: string;
  timingMs?: number;
  reason?: string;
  raw: string;
}

/**
 * Try to parse a single stderr line into an AgentEvent. Returns null for
 * lines that aren't agent-relevant.
 *
 * `state.phase` is mutated when a phase header is seen, so subsequent
 * events get tagged with the current phase. Callers pass the same state
 * across calls for a single pipeline run.
 */
export function parseAgentEvent(line: string, state: { phase: number }): AgentEvent | null {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!clean) return null;

  let m = clean.match(/^>>\s*Phase\s+(\d+):\s*(.+?)\s*$/);
  if (m) {
    state.phase = Number(m[1]);
    return { phase: state.phase, kind: 'phase-header', role: m[2], raw: clean };
  }

  if (/^\[RUVECTOR\]\s+Running simulation/i.test(clean)) {
    return { phase: state.phase, kind: 'sim-start', domain: 'simulator', agent: 'enterprise', raw: clean };
  }
  if (/^\[RUVECTOR\]\s+Simulation succeeded/i.test(clean)) {
    return { phase: state.phase, kind: 'sim-ok', domain: 'simulator', agent: 'enterprise', raw: clean };
  }
  if (/^\[RUVECTOR\]\s+(Retry|Attempt\s+\d+)/i.test(clean)) {
    return { phase: state.phase, kind: 'sim-retry', domain: 'simulator', agent: 'enterprise', reason: clean, raw: clean };
  }
  if (/^\[RUVECTOR\]\s+(Simulation failed|Terminal error|Non-retryable|Unrecognized error)/i.test(clean)) {
    return { phase: state.phase, kind: 'sim-fail', domain: 'simulator', agent: 'enterprise', reason: clean, raw: clean };
  }

  // [AGENTICS] [OK|FAIL|FB|!!] domain/agent (role) — Nms [suffix]
  m = clean.match(/^\[AGENTICS\]\s+\[(OK|FAIL|FB|!!)\]\s+([^/]+)\/(\S+)\s*\(([^)]+)\)\s*—\s*(\d+)ms(.*)$/);
  if (m) {
    const status = m[1];
    const domain = m[2];
    const agent = m[3];
    const role = m[4];
    const timingMs = Number(m[5]);
    const suffix = (m[6] ?? '').trim();
    const kind: AgentEvent['kind'] =
      status === 'OK' ? 'ok'
        : status === 'FB' ? 'fallback'
        : 'fail';
    return { phase: state.phase, kind, domain, agent, role, timingMs, reason: suffix || undefined, raw: clean };
  }

  // [local] domain/agent using local compute[: reason] or (reason)
  m = clean.match(/^\[local\]\s+([^/]+)\/(\S+)\s+using local compute(?:\s*(?::|\()\s*(.+?)\)?)?\s*$/);
  if (m) {
    return {
      phase: state.phase,
      kind: 'fallback',
      domain: m[1],
      agent: m[2],
      reason: m[3]?.trim(),
      raw: clean,
    };
  }

  if (/^\[PREFLIGHT\]/i.test(clean)) {
    return { phase: state.phase, kind: 'preflight', reason: clean, raw: clean };
  }

  m = clean.match(/^Phase\s+1\s+verdict:\s+(HEALTHY|DEGRADED|FAILED)\s*(?:—\s*(.+))?$/i);
  if (m) {
    return { phase: 1, kind: 'verdict', role: m[1], reason: m[2], raw: clean };
  }

  return null;
}

/**
 * One-line human-readable render of an AgentEvent for MCP progress
 * notifications. Kept deliberately short so Claude Code's notification
 * area doesn't truncate the useful part.
 */
export function formatAgentEventLive(ev: AgentEvent): string {
  const tag = ev.phase > 0 ? `P${ev.phase}` : '  ';
  const who = ev.domain && ev.agent ? `${ev.domain}/${ev.agent}` : '';
  const time = ev.timingMs != null ? ` (${ev.timingMs}ms)` : '';
  switch (ev.kind) {
    case 'phase-header':  return `${tag} ▶ Phase ${ev.phase}: ${ev.role ?? ''}`;
    case 'sim-start':     return `${tag} 🔄 simulator/enterprise — starting`;
    case 'sim-ok':        return `${tag} ✓ simulator/enterprise`;
    case 'sim-retry':     return `${tag} ⟳ simulator/enterprise — ${ev.reason?.slice(0, 100) ?? 'retrying'}`;
    case 'sim-fail':      return `${tag} ✗ simulator/enterprise — ${ev.reason?.slice(0, 100) ?? 'failed'}`;
    case 'ok':            return `${tag} ✓ ${who}${time}`;
    case 'fail':          return `${tag} ✗ ${who}${time}${ev.reason ? ' — ' + ev.reason.slice(0, 80) : ''}`;
    case 'fallback':      return `${tag} ⚠ ${who} — local fallback${ev.reason ? ' (' + ev.reason.slice(0, 80) + ')' : ''}`;
    case 'preflight':     return `${tag} 🔍 ${ev.reason?.replace(/^\[PREFLIGHT\]\s*/, '') ?? 'preflight'}`;
    case 'verdict':       return `${tag} 📋 Phase 1 verdict: ${ev.role}${ev.reason ? ' — ' + ev.reason : ''}`;
  }
}

/**
 * End-of-run Agent Invocation Report. Grouped by phase; per-phase shows
 * ok/fail/fallback counts then a per-agent table. Always appended to the
 * tool response so the user has a written record regardless of whether
 * live progress notifications were rendered.
 */
export function formatAgentReport(events: readonly AgentEvent[], traceId?: string): string {
  if (events.length === 0) return '';

  const lines: string[] = [];
  lines.push('═══ Agent Invocation Report ═══');
  if (traceId) lines.push(`Trace: ${traceId}`);
  lines.push('');

  const byPhase = new Map<number, AgentEvent[]>();
  for (const ev of events) {
    if (!byPhase.has(ev.phase)) byPhase.set(ev.phase, []);
    byPhase.get(ev.phase)!.push(ev);
  }

  const phases = [...byPhase.keys()].sort((a, b) => a - b);
  for (const p of phases) {
    const evs = byPhase.get(p)!;
    const header = evs.find(e => e.kind === 'phase-header');
    const label = header?.role ?? (p === 1 ? 'Simulation + graph-routed dispatch' : `Phase ${p}`);
    lines.push(`Phase ${p}: ${label}`);

    const ok = evs.filter(e => e.kind === 'ok' || e.kind === 'sim-ok').length;
    const fail = evs.filter(e => e.kind === 'fail' || e.kind === 'sim-fail').length;
    const fb = evs.filter(e => e.kind === 'fallback').length;
    lines.push(`  ${ok} ok · ${fail} fail · ${fb} local-fallback`);

    const rows = evs.filter(e =>
      e.kind === 'ok' || e.kind === 'fail' || e.kind === 'fallback' ||
      e.kind === 'sim-ok' || e.kind === 'sim-fail');
    for (const e of rows) {
      const who = e.domain && e.agent ? `${e.domain}/${e.agent}` : '(unknown)';
      const icon = e.kind === 'ok' || e.kind === 'sim-ok' ? '✓'
        : e.kind === 'fallback' ? '⚠'
        : '✗';
      const time = e.timingMs != null ? `${e.timingMs}ms`.padStart(8) : '       -';
      const source = e.kind === 'fallback' ? 'local' : (e.kind === 'fail' || e.kind === 'sim-fail' ? 'error' : 'cloud');
      const note = e.reason ? ` — ${e.reason.slice(0, 100)}` : '';
      lines.push(`  ${icon} ${who.padEnd(40)} ${time}  ${source}${note}`);
    }

    const verdict = evs.find(e => e.kind === 'verdict');
    if (verdict) {
      lines.push(`  → ${verdict.role} — ${verdict.reason ?? ''}`);
    }
    const preflights = evs.filter(e => e.kind === 'preflight');
    for (const pf of preflights) {
      lines.push(`  → ${pf.reason?.replace(/^\[PREFLIGHT\]\s*/, '') ?? ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
