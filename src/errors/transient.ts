/**
 * ADR-PIPELINE-089 §1 — Centralized transient-failure classification.
 *
 * The retry loops in `executeNaturalLanguageRoute` (src/commands/agents.ts)
 * used to inline a substring allowlist over `Error.message`:
 *
 *   const isRetryable = msg.includes('unavailable')
 *     || msg.includes('timeout')
 *     || msg.includes('rate exceeded')
 *     || msg.includes('econnreset')
 *     || msg.includes('econnrefused')
 *     || msg.includes('network error')
 *     || msg.includes('aborterror');
 *
 * Three problems with that shape:
 *
 * 1. `unreachable` is NOT on the list. Several adapter paths surface that
 *    word when a Cloud Run backend is down, and the retry loop then bails
 *    on attempt 1 — the exact field-report symptom on 2026-04-22.
 * 2. It only looks at `.message`. Node/undici errors often carry the
 *    transient signal on `.code` (ECONNRESET, ETIMEDOUT) or on a wrapped
 *    HTTP `response.status` (503, 504). Both were invisible to the
 *    substring check.
 * 3. 400-class terminal failures (contract_violation, unauthorized) never
 *    had an explicit short-circuit. A future drift that made their message
 *    match a retryable substring would silently retry three times.
 *
 * This module exposes:
 *   - isTransientFailure(err) — returns true when a retry has a reasonable
 *     chance of succeeding (widened allowlist + code + status + cause-chain).
 *   - isTerminalFailure(err) — returns true when retrying cannot help
 *     (payload / auth / canonical-not-found). Takes precedence over
 *     isTransientFailure when both match.
 *
 * Used by: the simulation retry loops at src/commands/agents.ts:4154 and
 * :4505. Future sites should import and reuse the helper instead of
 * re-inlining a substring list.
 */

// ============================================================================
// Keyword sets — lowercase compares on error.message
// ============================================================================

const TRANSIENT_MESSAGE_KEYWORDS: readonly string[] = [
  'unavailable',
  'service_unavailable',
  'unreachable',
  'timeout',
  'timed out',
  'etimedout',
  'rate exceeded',
  'rate limit',
  'too many requests',
  'econnreset',
  'connection reset',
  'econnrefused',
  'connection refused',
  'enotfound',
  'eai_again',
  'network error',
  'aborterror',
  'socket hang up',
  'und_err_socket',
  'upstream connect error',
  'upstream request timeout',
];

const TERMINAL_MESSAGE_KEYWORDS: readonly string[] = [
  'contract_violation',
  'contract violation',
  'invalid_payload',
  'bad request',
  'malformed',
  'unauthorized',
  'forbidden',
  'invalid api key',
  'invalid credentials',
  'payload_too_large',
  'payload too large',
];

// ============================================================================
// Error codes — exact match on error.code (typically Node/undici/fetch)
// ============================================================================

const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'AbortError',
]);

// ============================================================================
// HTTP statuses — exact match on error.status or error.response.status
// ============================================================================

const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([
  408, // Request Timeout
  425, // Too Early
  429, // Too Many Requests (retry-after)
  500, // Internal Server Error (often transient in Cloud Run)
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
  522, // Cloudflare connection timeout
  524, // Cloudflare a timeout occurred
]);

const TERMINAL_HTTP_STATUSES: ReadonlySet<number> = new Set([
  400, // Bad Request
  401, // Unauthorized
  403, // Forbidden
  404, // Not Found (ambiguous — only terminal when path canonical; callers that know otherwise can override)
  405, // Method Not Allowed
  409, // Conflict
  410, // Gone
  413, // Payload Too Large
  422, // Unprocessable Entity
]);

// ============================================================================
// Unwrapping helpers
// ============================================================================

const MAX_CAUSE_DEPTH = 3;

interface MaybeHttpError {
  message?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  response?: unknown;
  cause?: unknown;
}

function extractStatus(err: MaybeHttpError): number | undefined {
  if (typeof err.status === 'number') return err.status;
  if (typeof err.statusCode === 'number') return err.statusCode;
  const resp = err.response as MaybeHttpError | undefined;
  if (resp && typeof resp === 'object') {
    if (typeof resp.status === 'number') return resp.status;
    if (typeof resp.statusCode === 'number') return resp.statusCode;
  }
  // Parse "HTTP 503", "status 504", "504 Gateway Timeout" out of message
  if (typeof err.message === 'string') {
    const m = err.message.match(/\b(?:HTTP\s*)?(\d{3})\b/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 400 && n < 600) return n;
    }
  }
  return undefined;
}

function extractCode(err: MaybeHttpError): string | undefined {
  if (typeof err.code === 'string') return err.code;
  return undefined;
}

function extractMessage(err: MaybeHttpError): string {
  if (typeof err.message === 'string') return err.message.toLowerCase();
  return '';
}

/** Walk the `.cause` chain up to MAX_CAUSE_DEPTH levels, flattening fields into an array. */
function unwrapChain(err: unknown): MaybeHttpError[] {
  const chain: MaybeHttpError[] = [];
  let cur: unknown = err;
  for (let i = 0; i <= MAX_CAUSE_DEPTH && cur; i++) {
    if (cur && typeof cur === 'object') {
      chain.push(cur as MaybeHttpError);
      cur = (cur as MaybeHttpError).cause;
    } else {
      break;
    }
  }
  return chain;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * True when the failure shape suggests a retry has a reasonable chance of
 * succeeding: network resets, timeouts, 5xx, rate limits, cold-starts.
 *
 * Takes precedence over isTerminalFailure when inspecting a wrapped error:
 * callers should test `isTerminalFailure(e)` first and short-circuit if true.
 */
export function isTransientFailure(err: unknown): boolean {
  if (err == null) return false;

  // Raw string errors: substring match only.
  if (typeof err === 'string') {
    const lower = err.toLowerCase();
    return TRANSIENT_MESSAGE_KEYWORDS.some(k => lower.includes(k));
  }

  if (typeof err !== 'object') return false;

  const chain = unwrapChain(err);
  for (const link of chain) {
    // HTTP status — strongest signal.
    const status = extractStatus(link);
    if (status !== undefined) {
      if (TRANSIENT_HTTP_STATUSES.has(status)) return true;
      // If the status is in the terminal set, the caller should have
      // already short-circuited via isTerminalFailure. We do NOT return
      // false here because a wrapper may carry a transient signal elsewhere
      // in the chain (e.g. ETIMEDOUT wrapped as HTTP 500).
    }

    // Error code — Node/undici/fetch.
    const code = extractCode(link);
    if (code && TRANSIENT_ERROR_CODES.has(code)) return true;

    // Message substring — widened keyword set.
    const msg = extractMessage(link);
    if (msg && TRANSIENT_MESSAGE_KEYWORDS.some(k => msg.includes(k))) return true;
  }

  return false;
}

/**
 * True when retrying cannot help: bad payload, bad credentials, canonical
 * 404. Callers should short-circuit their retry loop on true.
 */
export function isTerminalFailure(err: unknown): boolean {
  if (err == null) return false;

  if (typeof err === 'string') {
    const lower = err.toLowerCase();
    return TERMINAL_MESSAGE_KEYWORDS.some(k => lower.includes(k));
  }

  if (typeof err !== 'object') return false;

  const chain = unwrapChain(err);
  for (const link of chain) {
    const status = extractStatus(link);
    if (status !== undefined && TERMINAL_HTTP_STATUSES.has(status)) return true;

    const msg = extractMessage(link);
    if (msg && TERMINAL_MESSAGE_KEYWORDS.some(k => msg.includes(k))) return true;
  }

  return false;
}

/**
 * Best-effort classification used by the Phase 1 Health Gate when deciding
 * whether a simulator-level failure should produce a `failed` vs `degraded`
 * verdict.
 *
 *   - 'transient' → the retry loop gave up but the error was retryable;
 *     environment-flake. Still counts as a failure for verdict purposes
 *     (we already retried) but tags the degradation so the user knows a
 *     re-run is likely to succeed.
 *   - 'terminal'  → payload/credentials/canonical. Actionable by user.
 *   - 'unknown'   → neither signature matched. Treat as terminal for
 *     verdict purposes (do not recommend a re-run) but surface the raw
 *     message so the user can see what happened.
 */
export function classifyFailure(err: unknown): 'transient' | 'terminal' | 'unknown' {
  if (isTerminalFailure(err)) return 'terminal';
  if (isTransientFailure(err)) return 'transient';
  return 'unknown';
}
