import { AlertTriangle } from 'lucide-react'
import { isSourceLimitNotice } from '@/lib/security/source-scan-error'

export const REPORT_NOT_COMPUTED_TEXT = 'Report not computed. It hit its row limit; narrow the date range or filters.'

/**
 * A visible, red banner for a report that hit its source-row limit. Shared by every report layout, so
 * the refusal is on the page rather than only in the (i) tooltip, and the tiles and table beneath it
 * show "—" and "not computed" instead of zeros.
 */
export function ReportRowLimitAlert({ notices = [] }: { notices?: readonly string[] }) {
  const limitNotices = notices.filter(isSourceLimitNotice)
  if (limitNotices.length === 0) return null
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-1">
        <p className="font-medium">Report not computed</p>
        {limitNotices.map((notice) => <p key={notice}>{notice}</p>)}
        <p className="text-xs">No figures are shown, so a blank is not mistaken for zero. Use the date filters below to narrow the range.</p>
      </div>
    </div>
  )
}
