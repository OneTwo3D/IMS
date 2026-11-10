/**
 * ONE normalisation rule for the Public App URL (o3d-osl8 round 9, finding 1).
 *
 * Two screens write this setting — the Settings panel and the onboarding Company step — and each
 * carried its own copy of "trim, strip trailing slashes, require http/https". The server action that
 * now owns the write validates with this same function, so a value that reaches the database has
 * passed the rule regardless of which screen (or none) sent it.
 *
 * Pure and dependency-free on purpose: the client uses it to give immediate feedback, the server
 * action uses it as the actual gate.
 */
export type PublicAppUrlNormalization =
  | { ok: true; url: string }
  | { ok: false; error: string }

/**
 * The public base URL is written into the managed crontab (`BASE_URL="<url>/api/cron"`) and every cron job
 * sends the cron secret to it, so it must be a plain origin plus an optional path: an absolute https URL
 * (http only for a loopback host), no userinfo, query or fragment, and only characters that carry no meaning
 * to cron or the shell. Control characters, whitespace, quotes, `$`, backtick, backslash and `%` all fail
 * the character allowlist. The same predicate gates the write and the crontab render, so a bad value that
 * is already stored is refused at render rather than spliced in.
 */
const SAFE_URL_CHARS = /^[A-Za-z0-9\-._~:/[\]]+$/
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isSafePublicBaseUrl(value: string): boolean {
  // The WHATWG parser accepts `https:example.com` and `https:/example.com` and rewrites them to a full URL, so
  // the raw text must itself carry the `scheme://` form: the text is what a stored value is checked against.
  if (!/^https?:\/\/[^/]/i.test(value)) return false
  if (!SAFE_URL_CHARS.test(value)) return false
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || value.includes('?') || value.includes('#')) return false
  if (parsed.protocol === 'http:') return LOOPBACK_HOSTS.has(parsed.hostname)
  return parsed.protocol === 'https:'
}

export function normalizePublicAppUrl(value: string): PublicAppUrlNormalization {
  const normalized = value.trim().replace(/\/+$/, '')
  if (!normalized) return { ok: false, error: 'Enter the public base URL.' }

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    return { ok: false, error: 'Enter a valid URL.' }
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'URL must start with https://' }
  }
  if (!isSafePublicBaseUrl(normalized)) {
    return {
      ok: false,
      error: 'URL must be an https:// address (http:// only for localhost) with no spaces, credentials, query, fragment or special characters.',
    }
  }
  // Store the parser's canonical form (lower-case scheme and host, dot segments resolved), not the raw text.
  return { ok: true, url: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '') }
}
