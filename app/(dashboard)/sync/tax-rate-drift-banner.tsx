import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button-variants'
import type { CurrentTaxRateDrift } from '@/lib/domain/accounting/tax-rate-drift-status'

/**
 * Sync-dashboard alert when IMS tax rates have diverged from the live Xero
 * definition (detected by the drift cron, 0jls5). Links to the VAT-rates table
 * where each affected rate carries a drift chip + diff tooltip.
 */
export function TaxRateDriftBanner({ drift }: { drift: CurrentTaxRateDrift }) {
  if (drift.count === 0) return null
  const names = Object.values(drift.byTaxRateId).map((d) => d.name).filter(Boolean)

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
      <div className="flex gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 space-y-2">
          <p className="font-medium">
            {drift.count} tax rate{drift.count === 1 ? '' : 's'} differ from the live Xero definition
            {names.length > 0 ? `: ${names.join(', ')}` : ''}.
            {' '}The next invoice will post with the IMS-side numbers — review and reconcile before it does.
          </p>
          <Link href="/settings/accounting?tab=tax" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Review VAT rates
          </Link>
        </div>
      </div>
    </div>
  )
}
