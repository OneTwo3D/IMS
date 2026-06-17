// Shared date/time formatting that renders IDENTICALLY on the server and the
// client. `new Date(x).toLocaleString('en-GB')` without an explicit timeZone
// uses the runtime's zone — UTC on the (SSR) server but the browser's local
// zone on the client — which produces a React hydration mismatch. Pinning the
// zone to Europe/London (matching the app's hardcoded en-GB locale) makes both
// sides agree, so the displayed value is deterministic and FOUC-free.
//
// Client-safe: no server-only imports, usable from Client Components.

const APP_LOCALE = 'en-GB'
const APP_TIME_ZONE = 'Europe/London'

export function formatDateTime(
  value: string | number | Date,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Date(value).toLocaleString(APP_LOCALE, { timeZone: APP_TIME_ZONE, ...options })
}
