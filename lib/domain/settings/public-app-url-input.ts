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
    return { ok: false, error: 'URL must start with http:// or https://' }
  }
  return { ok: true, url: normalized }
}
