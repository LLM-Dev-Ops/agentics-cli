/**
 * ADR-PIPELINE-097 — Live phase / agent status renderer.
 *
 * Hand-rolled spinner + multi-row status manager (no external deps), matching
 * the pattern used by `@claude-flow/cli` (ruflo). Single-line phase spinner
 * uses `\r` redraw; multi-row agent panel uses ANSI cursor-up + line-clear.
 *
 * TTY-detection rules (gracefully degrade in CI / piped output):
 *  - render target is `process.stderr` (stdout is reserved for JSON results)
 *  - if `!stderr.isTTY` OR `process.env.NO_COLOR` OR `process.env.CI` →
 *    no animation; emit plain `[AGENTICS] event` lines on state transitions,
 *    preserving the prior log shape so log scrapers still work.
 *  - if `process.env.AGENTICS_NO_LIVE === '1'` → forced plain mode.
 *
 * All frame text written to stderr; never to stdout.
 */

const FRAMES = ['◐', '◓', '◑', '◒'];
const FRAME_INTERVAL_MS = 120;
const ICON = {
  pending: '·',
  running: '', // placeholder — running rows use the animated frame
  success: '✓',
  failed:  '✗',
  skipped: '○',
} as const;

const COLOR = {
  reset:   '\x1b[0m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  red:     '\x1b[31m',
  yellow:  '\x1b[33m',
  gray:    '\x1b[90m',
} as const;

export type AgentStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface AgentRow {
  readonly id: string;
  label: string;
  status: AgentStatus;
  startedAt?: number;
  finishedAt?: number;
  detail?: string;
}

/**
 * True when stderr is a TTY and the user has NOT opted out of live rendering.
 * Exported for callers that need the same decision (e.g. to decide whether to
 * emit verbose plain-log lines).
 */
export function isLiveCapable(): boolean {
  if (process.env['AGENTICS_NO_LIVE'] === '1') return false;
  if (process.env['CI']) return false;
  if (process.env['NO_COLOR']) return false;
  return Boolean(process.stderr.isTTY);
}

function color(s: string, c: keyof typeof COLOR): string {
  if (!isLiveCapable()) return s;
  return COLOR[c] + s + COLOR.reset;
}

function formatElapsed(startedAt: number | undefined, finishedAt?: number): string {
  if (!startedAt) return '';
  const ms = (finishedAt ?? Date.now()) - startedAt;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ============================================================================
// PhaseSpinner — single-line spinner for "Phase N: <label>" boundaries.
// ============================================================================

export class PhaseSpinner {
  private label: string;
  private frameIndex = 0;
  private interval: NodeJS.Timeout | null = null;
  private rendered = '';
  private readonly live: boolean;

  constructor(label: string) {
    this.label = label;
    this.live = isLiveCapable();
  }

  /**
   * Non-live mode is silent (callers already emit phase boundary log lines).
   * Live mode animates `\r`-redrawn frames at 120ms intervals.
   */
  start(): this {
    if (!this.live) return this;
    if (this.interval) return this;
    this.render();
    this.interval = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % FRAMES.length;
      this.render();
    }, FRAME_INTERVAL_MS);
    return this;
  }

  setLabel(label: string): void {
    this.label = label;
    if (this.live) this.render();
  }

  succeed(message?: string): void {
    this.stop(`${color('✓', 'green')} ${message ?? this.label}`);
  }

  fail(message?: string): void {
    this.stop(`${color('✗', 'red')} ${message ?? this.label}`);
  }

  /** Stop the spinner. Final line only printed in TTY mode. */
  stop(finalLine?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.live) {
      this.clearLine();
      if (finalLine !== undefined) {
        process.stderr.write(`  ${finalLine}\n`);
      }
    }
  }

  private render(): void {
    const frame = color(FRAMES[this.frameIndex]!, 'cyan');
    const line = `  ${frame} ${this.label}`;
    this.clearLine();
    process.stderr.write(line);
    this.rendered = line;
  }

  private clearLine(): void {
    if (!this.rendered) return;
    // \r + spaces wide enough to wipe + \r. We can't know the visual width
    // (ANSI codes have zero visual width), so over-clear with the raw length.
    process.stderr.write('\r' + ' '.repeat(this.rendered.length + 4) + '\r');
    this.rendered = '';
  }
}

// ============================================================================
// AgentPanel — multi-row live panel for parallel agent fan-out.
// ============================================================================

/**
 * Renders one row per agent with animated frames for in-flight rows.
 *
 *   ◓ shield/pii          (running, 1.2s)
 *   ✓ shield/secrets      (success, 0.8s)
 *   ✗ test-bench/benchmark — timeout
 *
 * Falls back to plain `[AGENTICS] event` lines in non-TTY mode.
 */
export class AgentPanel {
  private rows: AgentRow[];
  private rowIndex: Map<string, number> = new Map();
  private frameIndex = 0;
  private interval: NodeJS.Timeout | null = null;
  private renderedRows = 0;
  private readonly live: boolean;
  private readonly title: string;

  constructor(title: string, agents: ReadonlyArray<{ id: string; label: string }>) {
    this.title = title;
    this.rows = agents.map((a) => ({ id: a.id, label: a.label, status: 'pending' as AgentStatus }));
    this.rows.forEach((r, i) => this.rowIndex.set(r.id, i));
    this.live = isLiveCapable();
  }

  /**
   * Non-live mode is intentionally silent — the dispatch site already emits
   * legacy `[AGENTICS] Dispatching N agents: ...` and per-result `[OK]/[FB]/
   * [!!]` lines that log scrapers depend on. We only render in TTY mode;
   * otherwise every method is a no-op (state still tracked for `stop()`).
   */
  start(): this {
    if (!this.live) return this;
    if (this.interval) return this;
    this.renderHeader();
    this.renderAll();
    this.interval = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % FRAMES.length;
      if (this.rows.some((r) => r.status === 'running')) {
        this.renderAll();
      }
    }, FRAME_INTERVAL_MS);
    return this;
  }

  /** Mark a row as in-flight. Idempotent. No-op in non-TTY mode. */
  begin(id: string, detail?: string): void {
    const r = this.row(id);
    if (!r) return;
    if (r.status === 'success' || r.status === 'failed') return;
    r.status = 'running';
    r.startedAt = r.startedAt ?? Date.now();
    r.detail = detail;
    if (this.live) this.renderAll();
  }

  /** Mark a row as completed (success/failure/skipped). Idempotent. */
  complete(id: string, status: 'success' | 'failed' | 'skipped', detail?: string): void {
    const r = this.row(id);
    if (!r) return;
    if (r.status === status) return;
    r.status = status;
    r.finishedAt = Date.now();
    r.startedAt = r.startedAt ?? r.finishedAt;
    r.detail = detail ?? r.detail;
    if (this.live) this.renderAll();
  }

  /**
   * Stop the timer; finalize any pending rows as 'skipped'. Returns a count
   * summary so callers can decide whether to log additional context.
   */
  stop(): { success: number; failed: number; skipped: number } {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    let success = 0, failed = 0, skipped = 0;
    for (const r of this.rows) {
      if (r.status === 'pending' || r.status === 'running') {
        r.status = 'skipped';
        r.finishedAt = Date.now();
      }
      if (r.status === 'success') success++;
      else if (r.status === 'failed') failed++;
      else if (r.status === 'skipped') skipped++;
    }
    if (this.live) {
      this.renderAll();
      const summary = `${color(`${success}✓`, 'green')}  ${color(`${failed}✗`, 'red')}  ${color(`${skipped}○`, 'gray')}`;
      process.stderr.write(`  ${color('─', 'gray')} ${this.title}: ${summary}\n`);
    }
    return { success, failed, skipped };
  }

  private row(id: string): AgentRow | undefined {
    const i = this.rowIndex.get(id);
    return i === undefined ? undefined : this.rows[i];
  }

  private renderHeader(): void {
    const line = color(`  ▼ ${this.title} (${this.rows.length} agents)`, 'cyan');
    process.stderr.write(line + '\n');
    this.renderedRows = 0;
  }

  private renderAll(): void {
    if (!this.live) return;
    // Move cursor up to the first row of the panel (if we've already drawn
    // anything), clear from there to end-of-screen, then redraw all rows.
    if (this.renderedRows > 0) {
      process.stderr.write(`\x1b[${this.renderedRows}A`); // cursor up N
      process.stderr.write('\x1b[0J');                    // clear to end of screen
    }
    let written = 0;
    for (const r of this.rows) {
      process.stderr.write(this.formatRow(r) + '\n');
      written++;
    }
    this.renderedRows = written;
  }

  private formatRow(r: AgentRow): string {
    const elapsed = r.startedAt ? formatElapsed(r.startedAt, r.finishedAt) : '';
    const detail = r.detail ? color(` — ${r.detail}`, 'gray') : '';
    let icon: string;
    let labelColor: keyof typeof COLOR;
    switch (r.status) {
      case 'pending':
        icon = color(ICON.pending, 'gray');
        labelColor = 'gray';
        break;
      case 'running':
        icon = color(FRAMES[this.frameIndex]!, 'cyan');
        labelColor = 'cyan';
        break;
      case 'success':
        icon = color(ICON.success, 'green');
        labelColor = 'reset';
        break;
      case 'failed':
        icon = color(ICON.failed, 'red');
        labelColor = 'red';
        break;
      case 'skipped':
        icon = color(ICON.skipped, 'gray');
        labelColor = 'gray';
        break;
    }
    const label = color(r.label.padEnd(34, ' '), labelColor);
    const elapsedStr = elapsed ? color(elapsed.padStart(7, ' '), 'dim') : '       ';
    return `    ${icon} ${label} ${elapsedStr}${detail}`;
  }
}
