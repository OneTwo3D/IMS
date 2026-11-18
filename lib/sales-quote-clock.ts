import { getDisplayTimeZone } from '@/lib/display-timezone'
import { ymdInZone } from '@/lib/domain/sales/sales-quote'

/** Today's calendar date (YYYY-MM-DD) in the organisation's display time zone: the day a quote's validity is judged against. */
export async function quoteTodayYmd(now: Date = new Date()): Promise<string> {
  return ymdInZone(now, await getDisplayTimeZone())
}
