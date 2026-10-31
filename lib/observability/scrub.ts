import type { Breadcrumb, Event } from '@sentry/nextjs'

/**
 * Secret / PII scrubbing for error-tracking events (GlitchTip via the Sentry SDK).
 *
 * Applied in `beforeSend`, `beforeSendTransaction` and `beforeBreadcrumb`, so nothing leaves the
 * process unscrubbed. Two layers:
 *  - KEY rule: any object key matching SENSITIVE_KEY has its whole value replaced by "[Filtered]";
 *  - STRING rule: credentials embedded in free text (URL userinfo, `key=value` pairs, Authorization /
 *    Bearer / Basic header text) are removed and e-mail addresses become "[email]".
 * Order ids, SKUs and ordinary prose are left alone. The functions never throw: on an internal
 * failure the event is reduced to a minimal "[scrub failed]" shell instead of leaking or vanishing.
 */

export const FILTERED = '[Filtered]'
export const EMAIL_PLACEHOLDER = '[email]'
export const SCRUB_FAILED = '[scrub failed]'

const SENSITIVE_KEY = /pass(word)?|secret|token|auth|api[-_]?key|cookie|dsn|session|credential/i

const MAX_DEPTH = 25

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
      out[key] = SENSITIVE_KEY.test(key)
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

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  try {
    if (!isRecord(breadcrumb)) return null
    return scrubValue(breadcrumb, 0, new WeakSet()) as Breadcrumb
  } catch {
    // Drop a breadcrumb we cannot scrub; losing one breadcrumb is safe, leaking one is not.
    return null
  }
}
