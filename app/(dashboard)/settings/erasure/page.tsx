import { AccessDenied } from '@/components/auth/access-denied'
import { authorizePage } from '@/lib/auth/server'
import type { Metadata } from 'next'
import Link from 'next/link'
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

export default async function ErasureRecordsPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  // Page-level authorization, the FIRST statement so a denial performs no read (the dashboard layout establishes authentication only).
  const gate = await authorizePage('settings')
  if (!gate.authorized) return <AccessDenied permission={gate.permission} />

  const params = (await searchParams) ?? {}
  const one = (v: string | string[] | undefined) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
  const onlyObligations = one(params.filter) === 'obligations'
  const requestId = one(params.q)
  const cursor = one(params.cursor)
  const { rows: records, nextCursor } = await listErasureRecords({ onlyObligations, requestId, cursor })
  const keep = (extra: Record<string, string>) => {
    const q = new URLSearchParams({ ...(onlyObligations ? { filter: 'obligations' } : {}), ...(requestId ? { q: requestId } : {}), ...extra })
    return `/settings/erasure${q.size ? `?${q}` : ''}`
  }
  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold">Erasure records</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Proof that a personal-data erasure was done: when, under which request, how much was reached and what each external system still holds. This list never
          shows the erased values. See the help page on erasure for what is erased, what is kept for six years and what must be handled by hand.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        {onlyObligations
          ? <><span className="font-medium">Showing only records with warehouse orders to handle by hand.</span><Link className="underline" href={requestId ? `/settings/erasure?q=${encodeURIComponent(requestId)}` : '/settings/erasure'}>Show all records</Link></>
          : <Link className="underline" href={keep({ filter: 'obligations' })}>Show only records with warehouse orders to handle by hand</Link>}
        <form action="/settings/erasure" className="flex items-center gap-2">
          {onlyObligations && <input type="hidden" name="filter" value="obligations" />}
          <input name="q" defaultValue={requestId ?? ''} placeholder="Find by request id" className="h-8 w-72 rounded border px-2 text-xs" />
          <button type="submit" className="h-8 rounded border px-3 text-xs">Find</button>
        </form>
      </div>
      {records.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">{onlyObligations || requestId ? 'No record matches.' : 'No erasure has been recorded.'}</Card>
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
                  Warehouse orders: {r.warehouse.linkedOrders} (despatched {r.warehouse.despatched}, open {r.warehouse.open}, cancelled {r.warehouse.cancelled}, unverified {r.warehouse.ambiguous}, merged {r.warehouse.merged}).
                </p>
              )}
              {r.warehouse && r.warehouse.openOrders.length > 0 && (
                <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                  <p className="font-medium">Open warehouse orders still holding the person&apos;s details. Handle each by hand in the warehouse system:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {r.warehouse.openOrders.map((o) => (
                      <li key={o.orderId}>
                        Warehouse order {o.warehouseOrderNumber ?? (o.numberWithheld ? '(number withheld)' : '(number not recorded)')}; IMS order{' '}
                        <Link className="underline" href={`/sales/${o.orderId}`}>{r.orderNumbers[o.orderId] ?? '(number withheld)'}</Link>
                        <span className="text-muted-foreground"> ({o.orderId})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {r.warehouse && r.warehouse.ambiguousOrders.length > 0 && (
                <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                  <p className="font-medium">IMS cannot prove these orders are gone from the warehouse (a create whose outcome was never recorded, or a cancellation the warehouse did not confirm). Check each in the warehouse system and handle it by hand if it exists:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {r.warehouse.ambiguousOrders.map((o) => (<li key={o.orderId}>
                      IMS order <Link className="underline" href={`/sales/${o.orderId}`}>{r.orderNumbers[o.orderId] ?? '(number withheld)'}</Link>
                      <span className="text-muted-foreground"> ({o.orderId})</span>{o.warehouseOrderNumber ? `, warehouse order ${o.warehouseOrderNumber}` : o.numberWithheld ? ', warehouse order number withheld' : ''}
                    </li>))}
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
          {nextCursor && <Link className="inline-block text-sm underline" href={keep({ cursor: nextCursor })}>Older records</Link>}
        </div>
      )}
    </div>
  )
}
