import type { Breadcrumb, Event } from '@sentry/nextjs'

/**
 * Secret / PII scrubbing for error-tracking events (GlitchTip via the Sentry SDK).
 *
 * Applied in `beforeSend`, `beforeSendTransaction` and `beforeBreadcrumb`, so nothing leaves the
 * process unscrubbed. Two layers:
 *  - KEY rule: any object key matching SENSITIVE_KEY has its whole value replaced by "[Filtered]";
 *  - STRING rule: credentials embedded in free text (URL userinfo, `key=value` pairs, Authorization /
 *    Bearer / Basic header text) are removed and e-mail addresses become "[email]".
 * URLs lose their WHOLE query string and fragment (kept as `?[Filtered]` / `#[Filtered]`): OAuth callbacks put `code`/`state` there,
 * and no list of parameter names is safe enough. Order ids, SKUs and ordinary prose are left alone. The functions never throw: on an internal
 * failure the event is reduced to a minimal "[scrub failed]" shell instead of leaking or vanishing.
 */

export const FILTERED = '[Filtered]'
export const EMAIL_PLACEHOLDER = '[email]'
export const SCRUB_FAILED = '[scrub failed]'

// `sig` is matched only as a whole word (x-sig, sig_v2) so "design"/"assigned" are not caught.
const SENSITIVE_KEY =
  /pass(word)?|secret|token|auth|api[-_]?key|cookie|dsn|session|credential|signature|hmac|nonce|(^|[-_.])sig($|[-_.])/i

// Keys whose value is a raw query string / fragment: dropped wholesale.
const QUERY_KEY = /^(query[-_]?string|url\.query|http\.query|http\.query_string|url\.fragment|http\.fragment|url[-_]fragment|fragment)$/i

// Prompt / response / tool payload attributes of AI and MCP spans (gen_ai.request.messages,
// gen_ai.response.text, ai.prompt, mcp.tool.result.content ...): IMS sends product text to an LLM, and
// ordinary prose would survive every other rule. Matched wholesale, as belt and braces to dataCollection.
const AI_PAYLOAD_KEY =
  /^(gen_ai|ai|mcp|llm)\.([a-z0-9_.-]*[._-])?(messages?|prompts?|input|inputs|output|outputs|text|object|completions?|content|arguments|result|results|instructions|system_instructions)([._-][a-z0-9_.-]*)?$/i

const MAX_DEPTH = 25

// scheme://host/path?query and /relative/path?query -> the query string is replaced (path kept).
const ABSOLUTE_URL = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)(\?[^\s#"'<>]+)?(#[^\s"'<>]+)?/gi
const RELATIVE_URL = /(^|[\s"'(=])(\/[^\s?#"'<>]*)(\?[^\s#"'<>]+)?(#[^\s"'<>]+)?/g

/** Keep scheme/host/path; replace `?query` and `#fragment` (either, or both) with a placeholder. */
function stripQueryAndFragment(match: string, base: string, query?: string, fragment?: string): string {
  if (!query && !fragment) return match
  return `${base}${query ? `?${FILTERED}` : ''}${fragment ? `#${FILTERED}` : ''}`
}

// scheme://user:password@host -> scheme://[Filtered]@host
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*:[^\s/?#@]*@/gi
// Authorization: <anything to end of line>
const AUTH_HEADER = /\b((?:proxy-)?authorization)(["']?\s*[:=]\s*)[^\r\n]*/gi
// Bearer <token> / Basic <base64>
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/g
const BASIC = /\b(Basic)\s+[A-Za-z0-9+/]{8,}={0,2}/g
// name=value / name: value / "name":"value" where name looks like a credential
const KEY_VALUE =
  /\b([\w.-]*?(?:password|passwd|pass|token|secret|api[-_]?key|apikey|auth|dsn|credentials?|session(?:[-_]?id)?))(["']?\s*[=:]\s*["']?)("[^"]*"|'[^']*'|[^\s&;,"'}\]]+)/gi
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g

export function scrubString(input: string): string {
  return input
    .replace(ABSOLUTE_URL, stripQueryAndFragment)
    .replace(RELATIVE_URL, (m, lead: string, path: string, q?: string, f?: string) =>
      q || f ? `${lead}${stripQueryAndFragment(m, path, q, f)}` : m,
    )
    .replace(URL_USERINFO, '$1[Filtered]@')
    .replace(AUTH_HEADER, `$1$2${FILTERED}`)
    .replace(BEARER, `$1 ${FILTERED}`)
    .replace(BASIC, `$1 ${FILTERED}`)
    .replace(KEY_VALUE, `$1$2${FILTERED}`)
    .replace(EMAIL, EMAIL_PLACEHOLDER)
}

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubString(value)
  if (value === null || value === undefined) return value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'symbol' || typeof value === 'function') return undefined
  if (typeof value !== 'object') return undefined
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) return scrubString(`${value.name}: ${value.message}`)
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[binary]'
  if (seen.has(value)) return '[Circular]'
  if (depth >= MAX_DEPTH) return '[Truncated]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1, seen))
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      out[key] = SENSITIVE_KEY.test(key) || QUERY_KEY.test(key) || AI_PAYLOAD_KEY.test(key)
        ? FILTERED
        : scrubValue((value as Record<string, unknown>)[key], depth + 1, seen)
    }
    return out
  } finally {
    // Path-based (not global) cycle detection: the same object may legitimately appear twice.
    seen.delete(value)
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Minimal event that still identifies the error class of failure but carries no payload. */
function failedShell(event: unknown): Event {
  const shell: Event = { message: SCRUB_FAILED, exception: { values: [{ type: 'Error', value: SCRUB_FAILED }] } }
  try {
    if (isRecord(event)) {
      for (const k of ['event_id', 'timestamp', 'platform', 'level', 'environment', 'release', 'type'] as const) {
        const v = event[k]
        if (typeof v === 'string' || typeof v === 'number') (shell as Record<string, unknown>)[k] = v
      }
    }
  } catch {
    // keep the bare shell
  }
  return shell
}

// Generic so it fits both `beforeSend` (ErrorEvent) and `beforeSendTransaction` (TransactionEvent).
export function scrubEvent<T extends Event>(event: T): T | null {
  try {
    if (!isRecord(event)) return failedShell(event) as T
    const scrubbed = scrubValue(event, 0, new WeakSet()) as Record<string, unknown>

    const user = scrubbed.user
    if (isRecord(user)) {
      delete user.ip_address
      delete user.email
    }
    const request = scrubbed.request
    if (isRecord(request)) delete request.cookies

    return scrubbed as T
  } catch {
    return failedShell(event) as T
  }
}

/**
 * Streamed spans (the v11 default, `traceLifecycle: 'stream'`) do NOT go through `beforeSendTransaction`;
 * `beforeSendSpan` is the only hook that sees their name and attributes (url.full, http.target, headers...).
 * The SDK sends the span UNMODIFIED if this callback throws, so it must never throw.
 */
export function scrubSpan<T extends object>(span: T): T {
  try {
    const scrubbed = scrubValue(span, 0, new WeakSet()) as Record<string, unknown>
    const attributes = scrubbed.attributes
    if (isRecord(attributes)) {
      for (const k of ['user.email', 'user.ip_address', 'client.address', 'http.client_ip']) delete attributes[k]
    }
    return scrubbed as T
  } catch {
    const shell: Record<string, unknown> = { name: SCRUB_FAILED, attributes: {} }
    try {
      const src = span as Record<string, unknown>
      for (const k of ['trace_id', 'span_id', 'parent_span_id', 'is_segment', 'status', 'start_timestamp', 'end_timestamp']) {
        const v = src[k]
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') shell[k] = v
      }
    } catch {
      // bare shell
    }
    return shell as T
  }
}

// Breadcrumbs are an ALLOWLIST by category: only navigation and HTTP breadcrumbs are kept, and of
// those only scalar metadata. Everything else (ui.click/ui.input with element alt/title text, console,
// sentry.*, and any category a later SDK adds) is dropped, so a new default capture source cannot leak.
const BREADCRUMB_CATEGORIES = new Set(['navigation', 'http', 'fetch', 'xhr'])
const BREADCRUMB_DATA_KEYS = ['method', 'status_code', 'url', 'from', 'to'] as const

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  try {
    if (!isRecord(breadcrumb)) return null
    const category = breadcrumb.category
    if (typeof category !== 'string' || !BREADCRUMB_CATEGORIES.has(category)) return null

    const kept: Breadcrumb = { category }
    for (const k of ['type', 'level'] as const) {
      const v = breadcrumb[k]
      if (typeof v === 'string') kept[k] = v as never
    }
    if (typeof breadcrumb.timestamp === 'number') kept.timestamp = breadcrumb.timestamp

    const data: Record<string, string | number> = {}
    const src = breadcrumb.data
    if (isRecord(src)) {
      for (const k of BREADCRUMB_DATA_KEYS) {
        const v = src[k]
        if (typeof v === 'string') data[k] = scrubString(v)
        else if (typeof v === 'number') data[k] = v
      }
    }
    if (Object.keys(data).length > 0) kept.data = data
    // free-text `message` is never kept
    return kept
  } catch {
    // Drop a breadcrumb we cannot scrub; losing one breadcrumb is safe, leaking one is not.
    return null
  }
}
