import Link from 'next/link'
import { Card } from '@/components/ui/card'
import type { RefusedActionPage } from '@/app/actions/refused-actions'

const SEVERITY_LABEL = { HIGH: 'Serious', MEDIUM: 'Needs a look', LOW: 'Low impact' } as const

/**
 * Actions a gate refused or stalled: what IMS tried, which gate said no, whether it can ever succeed, and how long it has stood. Read-only; a row closes
 * itself when the action later succeeds or the order no longer needs it. A serious one past its age also raises an alert and, for an order change, a
 * "Raise a warehouse query" task above.
 */
export function RefusedActionsSection({ data }: { data: RefusedActionPage }) {
  const { rows, total, shown } = data
  if (total === 0) return null
  return (
    <Card className="p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">{`Refused or stalled actions (${total})`}</h2>
        <p className="text-xs text-muted-foreground">
          IMS tried to do each of these and a check said no, so nothing was changed. The age shows how long it has stood. Rows close themselves when the action later succeeds or the order no longer needs it.
          Low impact rows (a note, a VAT number, a price) change nothing the warehouse does and never raise an alert.
        </p>
      </div>
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.id} className="rounded-lg border p-3 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div className="font-medium">
                {`${row.label}: order `}
                {row.orderId ? <Link className="underline underline-offset-2" href={`/sales/${row.orderId}`}>{row.subject}</Link> : row.subject}
              </div>
              <div className="text-xs text-muted-foreground">{`${SEVERITY_LABEL[row.severity]} · ${row.permanence === 'PERMANENT' ? 'will not succeed on its own' : 'IMS is retrying'}`}</div>
            </div>
            {row.detail && <p className="text-xs text-muted-foreground">{row.detail}</p>}
            {row.wantedLines && <p className="text-xs">{`IMS wanted the order to hold: ${row.wantedLines}`}</p>}
            <p className="text-xs text-muted-foreground">
              {`First seen ${row.firstSeenAt.slice(0, 16).replace('T', ' ')} UTC, last seen ${row.lastSeenAt.slice(0, 16).replace('T', ' ')} UTC, seen ${row.attempts} time${row.attempts === 1 ? '' : 's'}.${row.alerted ? ' An alert was raised.' : ''}`}
            </p>
          </div>
        ))}
      </div>
      {total > shown && <p className="text-xs text-muted-foreground">{`Showing the first ${shown} of ${total}, most serious and oldest first.`}</p>}
    </Card>
  )
}
