import { db } from '@/lib/db'
import { DEFAULT_TIMEZONE } from '@/lib/format-datetime'

// Server-side accessor for the organisation's configured display timezone, for
// Server Components / server contexts that format dates with formatDateTime(x,
// opts, tz). Client Components should use the useFormatDateTime() hook instead,
// which reads the same value from the TimeZoneProvider. Falls back to
// DEFAULT_TIMEZONE when unset.
export async function getDisplayTimeZone(): Promise<string> {
  const org = await db.organisation.findFirst({ select: { timezone: true } })
  return org?.timezone ?? DEFAULT_TIMEZONE
}
