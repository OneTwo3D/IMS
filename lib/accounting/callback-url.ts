/**
 * Single source of truth for the accounting OAuth redirect origin + redirect_uri
 * (onetwo3d-ims-qye3). The authorize request and the token exchange MUST send a
 * byte-identical redirect_uri (OAuth exact-match), and the user-facing status
 * redirect must never be derived from attacker-controlled Host/X-Forwarded-Host
 * headers (CWE-601). Both concerns resolve to the trusted, server-configured
 * app URL's ORIGIN — which normalizes case/port/backslashes and strips path,
 * query, fragment, and user-info consistently on every call site.
 */

export const ACCOUNTING_CALLBACK_PATH = '/api/accounting/callback'

/**
 * The trusted web origin of the configured app URL, or null when it's missing,
 * malformed, or not http(s). Never reads request/Host headers. data:/file:/
 * mailto:/javascript: parse but yield origin "null" and are rejected here.
 */
export function resolveAppOrigin(publicAppUrl: string | null): string | null {
  if (!publicAppUrl) return null
  try {
    const parsed = new URL(publicAppUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.origin
  } catch {
    return null
  }
}

/**
 * The OAuth redirect_uri — built from the app URL's normalized ORIGIN so the
 * authorize request and the token exchange produce the identical string for
 * every valid configuration (uppercase host, explicit :443, base path,
 * trailing slash, user-info, IDN, backslashes). Null when there's no valid
 * origin, so callers reject before consuming single-use OAuth state.
 */
export function buildAccountingCallbackUri(publicAppUrl: string | null): string | null {
  const origin = resolveAppOrigin(publicAppUrl)
  return origin ? new URL(ACCOUNTING_CALLBACK_PATH, origin).toString() : null
}
