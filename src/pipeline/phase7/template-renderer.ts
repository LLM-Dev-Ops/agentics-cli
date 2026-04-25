/**
 * Phase 7 — Template Renderer (ADR-PIPELINE-098 D4)
 *
 * Pure deterministic placeholder substitution for the consulting-deliverables
 * templates. Templates use a Handlebars-flavoured `{{name}}` syntax. There is
 * NO logic, NO loops, NO partials — every template is `template ⇒ string` with
 * a flat `Record<string, string>` of fields.
 *
 * The LLM (or Ruflo writer agent) is invoked BEFORE this renderer runs. The
 * agent returns structured fields; this renderer composes them into the
 * Markdown body. Determinism is critical for the coherence gate (D8) — given
 * identical fields, the output must byte-equal across runs and machines.
 *
 * Three exports:
 *   - `renderTemplate(body, fields)`: substitute `{{key}}` with `fields[key]`.
 *     Missing fields render as `_<key not provided>_` (italic skeleton marker)
 *     so a downstream reader can grep for un-filled slots and the document
 *     still reads coherently.
 *   - `injectStandardSections(rendered, ctx)`: prepend the consensus banner
 *     and append the agent attribution footer if not already present in the
 *     rendered body. Idempotent — calling twice is a no-op on the second
 *     call.
 *   - `extractPlaceholders(body)`: helper used by tests + the registry-vs-spec
 *     audit. Returns the unique `{{name}}` keys found in the template body.
 *
 * No I/O. No LLM calls. No timers.
 */

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*\}\}/g;

/**
 * Substitute `{{key}}` placeholders in `templateBody` with values from
 * `fields`. Unknown keys render as the compact `_TBD_` marker — concise
 * enough that the deliverable reads cleanly while still flagging the gap
 * for human review. The full list of missing keys is recorded per row in
 * `phase7-manifest.json` (so QA can grep that file rather than every doc).
 *
 * Reserved fields injected by `injectStandardSections` (`consensusBanner`,
 * `fcvBlock`, `agentAttributionFooter`) are passed through this function too;
 * the renderer treats them as plain string fields.
 */
const MISSING_FIELD_MARKER = '_TBD_';

export function renderTemplate(
  templateBody: string,
  fields: Record<string, string>,
): string {
  if (typeof templateBody !== 'string') return '';
  return templateBody.replace(PLACEHOLDER_RE, (_match, rawKey: string) => {
    const key = rawKey.trim();
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      const v = fields[key];
      return typeof v === 'string' ? v : String(v ?? '');
    }
    return MISSING_FIELD_MARKER;
  });
}

/**
 * Returns the list of placeholder keys present in `templateBody` that are
 * NOT covered by `fields`. Used by the coordinator to record per-row
 * `unfilled_fields` in `phase7-manifest.json` so QA can audit gaps without
 * grepping every doc.
 */
export function unfilledFields(
  templateBody: string,
  fields: Record<string, string>,
): string[] {
  if (typeof templateBody !== 'string') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // Reset regex state since PLACEHOLDER_RE is module-scoped with the `g` flag.
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(templateBody)) !== null) {
    const key = m[1]!.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      out.push(key);
    }
  }
  return out;
}

/** Standard-sections context injected once per deliverable. */
export interface StandardSectionsContext {
  /**
   * The run's consensus banner (markdown blockquote) as produced by
   * `consensusBanner()` in `synthesis/consensus-tiers.ts`. May be empty when
   * the run is "aligned" tier (banner is omitted entirely upstream).
   */
  readonly consensusBanner: string;
  /**
   * The standard fcv-tagged figure block (markdown) derived from
   * `unit-economics.json`. Empty string when unit-economics is absent —
   * Phase 7 still emits the deliverable, just without the headline figures.
   */
  readonly fcvBlock: string;
  /**
   * The agent attribution footer (single line: `Sources: domain/agent, ...`)
   * appended at the bottom of the rendered body if not already present.
   */
  readonly agentAttribution: string;
}

const BANNER_MARKER = '> 📊 **Consensus:';
const ATTRIBUTION_MARKER = 'Sources:';

/**
 * Append/prepend the standard sections to a rendered deliverable body.
 *
 * - Consensus banner is prepended at the top if not already present (template
 *   may have inlined it via `{{consensusBanner}}`, in which case this is a
 *   no-op).
 * - Agent attribution footer is appended at the bottom if not already present
 *   (templates that include `{{agentAttributionFooter}}` already carry it).
 * - The fcv block is NOT auto-injected here — templates that need it use
 *   `{{fcvBlock}}` explicitly so the writer controls placement. The field is
 *   accepted in the context so a future template revision can reach for it
 *   without changing this signature.
 *
 * Idempotent: calling twice produces the same string as calling once.
 */
export function injectStandardSections(
  rendered: string,
  ctx: StandardSectionsContext,
): string {
  let out = typeof rendered === 'string' ? rendered : '';

  // Prepend banner if non-empty and not already there.
  const banner = (ctx.consensusBanner ?? '').trim();
  if (banner.length > 0 && !out.includes(BANNER_MARKER)) {
    out = `${banner}\n\n${out}`;
  }

  // Append attribution footer if non-empty and not already there.
  const attribution = (ctx.agentAttribution ?? '').trim();
  if (attribution.length > 0 && !out.includes(ATTRIBUTION_MARKER)) {
    const sep = out.endsWith('\n') ? '' : '\n';
    out = `${out}${sep}\n---\n\n${attribution}\n`;
  }

  // ctx.fcvBlock is intentionally not auto-prepended (see jsdoc above). Touch
  // the value so callers can rely on it being part of the public contract.
  void ctx.fcvBlock;

  return out;
}

/**
 * Return the unique `{{placeholder}}` keys appearing in a template body.
 * Stable order = first-occurrence order. Used by the registry-vs-spec audit
 * and by the coordinator when it builds the Ruflo writer prompt (so the
 * writer is told exactly which fields to fill).
 */
export function extractPlaceholders(templateBody: string): string[] {
  if (typeof templateBody !== 'string') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(templateBody)) !== null) {
    const key = (m[1] ?? '').trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}
