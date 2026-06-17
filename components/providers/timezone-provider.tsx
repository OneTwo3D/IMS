'use client'

import { createContext, useContext, useCallback } from 'react'
import { formatDateTime as formatWithZone, DEFAULT_TIMEZONE } from '@/lib/format-datetime'

const TimeZoneContext = createContext<string>(DEFAULT_TIMEZONE)

export function TimeZoneProvider({
  value,
  children,
}: {
  value: string
  children: React.ReactNode
}) {
  return <TimeZoneContext.Provider value={value}>{children}</TimeZoneContext.Provider>
}

export function useTimeZone() {
  return useContext(TimeZoneContext)
}

/**
 * Returns a `formatDateTime(value, options?)` bound to the org's configured
 * timezone. Because the zone comes from the provider (seeded by the server
 * layout and serialised into the RSC payload), SSR and client format with the
 * SAME zone — no hydration mismatch.
 */
export function useFormatDateTime() {
  const timeZone = useTimeZone()
  return useCallback(
    (value: string | number | Date, options?: Intl.DateTimeFormatOptions) =>
      formatWithZone(value, options, timeZone),
    [timeZone],
  )
}
