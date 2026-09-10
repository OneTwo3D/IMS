'use client'

import Link from 'next/link'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button-variants'
import type { ExceptionInboxSummary } from '@/app/actions/sync-exceptions'

/**
 * q66in.4.2: surfaces the exception-inbox total at the top of the Integrations
 * page (next to the failed-sync and orphan banners) so dead-lettered work is
 * noticed without knowing where to look. Details + replay live on
 * /sync/exceptions.
 */
export function ExceptionsBanner({ summary }: { summary: ExceptionInboxSummary }) {
  if (summary.total === 0) return null

  const parts = [
    // o3d-hl8l r5: FIRST, because it is the only one that is a system-wide state rather than a queue
    // of rows — and because while it is present, inbound warehouse callbacks are being refused.
    summary.maintenanceRecovery > 0 ? `${summary.maintenanceRecovery} maintenance-window item(s)` : null,
    // o3d-92fu: "blocked", not "dead-lettered" — this count now also covers VALIDATION_FAILED
    // links, which never reached the WMS at all.
    summary.wmsPushDeadLetters > 0 ? `${summary.wmsPushDeadLetters} blocked order push(es)` : null,
    summary.outboxFailures > 0 ? `${summary.outboxFailures} failed outbox row(s)` : null,
    summary.deadReceiptEvents > 0 ? `${summary.deadReceiptEvents} dead receipt event(s)` : null,
    summary.refundSyncParks > 0 ? `${summary.refundSyncParks} parked refund(s)` : null,
    summary.stuckDispatches > 0 ? `${summary.stuckDispatches} stuck dispatch(es)` : null,
    summary.pennyMismatches > 0 ? `${summary.pennyMismatches} order-total mismatch(es)` : null,
    summary.orderReconcileDrift > 0 ? `${summary.orderReconcileDrift} order reconcile drift(s)` : null,
  ].filter(Boolean)

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
      <div className="flex gap-2">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="space-y-2 min-w-0">
          <p className="font-medium">
            {summary.total} sync exception(s) need attention: {parts.join(', ')}.
          </p>
          <Link href="/sync/exceptions" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Open the exception inbox
            <ArrowRight className="h-3 w-3 ml-1" />
          </Link>
        </div>
      </div>
    </div>
  )
}
