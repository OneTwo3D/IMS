import { AccessDenied } from '@/components/auth/access-denied'
import { authorizePage } from '@/lib/auth/server'
import type { Metadata } from 'next'
import { Card } from '@/components/ui/card'
import { listErasureRecords } from '@/lib/domain/erasure/erasure-record-view'

export const metadata: Metadata = { title: 'Erasure records' }

const VERDICT_LABEL: Record<string, string> = {
  'erased-at-source': 'Erased at source',
  'refused-pending-legal': 'Left untouched, pending legal ruling',
  refused: 'Not written; handle by hand',
  'not-technically-possible': 'Cannot be erased there',
  'not-applicable': 'Nothing held',
  'not-attempted': 'Not attempted',
  propagated: 'Propagated',
}
const SYSTEM_LABEL: Record<string, string> = { storefront: 'Storefront', accounting: 'Accounting (Xero)', warehouse: 'Warehouse', carrierPortal: 'Carrier portal' }

export default async function ErasureRecordsPage() {
  // Page-level authorization, the FIRST statement so a denial performs no read (the dashboard layout establishes authentication only).
  const gate = await authorizePage('settings')
  if (!gate.authorized) return <AccessDenied permission={gate.permission} />

  const records = await listErasureRecords()
  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold">Erasure records</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Proof that a personal-data erasure was done: when, under which request, how much was reached and what each external system still holds. This list never
          shows the erased values. See the help page on erasure for what is erased, what is kept for six years and what must be handled by hand.
        </p>
      </div>
      {records.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">No erasure has been recorded.</Card>
      ) : (
        <div className="space-y-4">
          {records.map((r) => (
            <Card key={r.requestId} className="p-4 space-y-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                <span className="font-mono text-xs">{r.requestId}</span>
                <span>{new Date(r.erasedAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC</span>
                <span className="text-muted-foreground">Trigger: {r.trigger}</span>
                <span className="text-muted-foreground">Orders: {r.orderCount}{r.customerId ? ', customer erased' : ''}</span>
              </div>
              <dl className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
                {Object.entries(r.systems).map(([system, verdict]) => (
                  <div key={system} className="flex justify-between gap-4 border-b py-1">
                    <dt className="text-muted-foreground">{SYSTEM_LABEL[system] ?? system}</dt>
                    <dd>{VERDICT_LABEL[verdict] ?? verdict}</dd>
                  </div>
                ))}
              </dl>
              {r.warehouse && r.warehouse.linkedOrders > 0 && (
                <p className="text-xs text-muted-foreground">
                  Warehouse orders: {r.warehouse.linkedOrders} (despatched {r.warehouse.despatched}, open {r.warehouse.open}, cancelled {r.warehouse.cancelled}, merged {r.warehouse.merged}).
                </p>
              )}
              {r.warehouse && r.warehouse.openOrders.length > 0 && (
                <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                  <p className="font-medium">Open warehouse orders still holding the person&apos;s details. Handle each by hand in the warehouse system:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {r.warehouse.openOrders.map((o) => (
                      <li key={o.orderId}>Warehouse order {o.warehouseOrderNumber ?? '(number not recorded)'}</li>
                    ))}
                  </ul>
                </div>
              )}
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Counts by table</summary>
                <ul className="mt-1 grid grid-cols-2 gap-x-6 sm:grid-cols-3">
                  {Object.entries(r.counts).map(([k, n]) => (<li key={k}>{k}: {n}</li>))}
                </ul>
              </details>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
