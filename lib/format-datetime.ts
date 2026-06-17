// Shared date/time formatting that renders IDENTICALLY on the server and the
// client. `new Date(x).toLocaleString('en-GB')` without an explicit timeZone
// uses the runtime's zone — UTC on the (SSR) server but the browser's local
// zone on the client — which produces a React hydration mismatch. Passing an
// explicit timeZone makes both sides agree, so the displayed value is
// deterministic and FOUC-free.
//
// The zone is configurable (Organisation.timezone, surfaced via the
// TimeZoneProvider + useFormatDateTime hook). This module-level default is the
// fallback for unconfigured orgs and for non-React/server contexts.
//
// Client-safe: no server-only imports, usable from Client Components.

const APP_LOCALE = 'en-GB'
export const DEFAULT_TIMEZONE = 'Europe/London'

export function formatDateTime(
  value: string | number | Date,
  options?: Intl.DateTimeFormatOptions,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  return new Date(value).toLocaleString(APP_LOCALE, { timeZone, ...options })
}

/** True when `tz` is a valid IANA timezone the runtime accepts. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz })
    return true
  } catch {
    return false
  }
}
