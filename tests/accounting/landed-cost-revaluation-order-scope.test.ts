import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { refreshShipmentCogsForCostLayerChange } from '@/lib/cost-layers'

// ---------------------------------------------------------------------------
// o3d-zpa7 — the one order-scoped accounting enqueue that cannot hoist `lockSalesOrder`.
//
// o3d-3zgy closed every other one. This path could not be: it runs inside a purchasing/manufacturing
// landed-cost transaction that discovers WHICH shipments are affected mid-flight, by querying
// `shipment_lines.costLayerSnapshot @> ...` AFTER cost-layer and stock rows are already locked. Taking
// the sales-order lock there inverts the lockSalesOrder-then-lockStockLevels ordering
// allocation-service establishes, so it would trade a rare race for a routine deadlock.
//
// THE ANSWER IS THAT NO LOCK IS NEEDED, because the order cannot be hard-deleted at all. Four
// where-clauses in four files make that true:
//
//   the enqueue runs only for a shipment with shipmentJournalDate set (its caller's branch)
//     -> shipmentJournalDate is written only by daily-batch Group B, which selects on
//        `order.revenueDeferredDate != null`
//     -> revenueDeferredDate is stamped only by Group A1, which selects on `accountingInvoiceId != null`
//     -> deleteSalesOrder refuses UNCONDITIONALLY on a non-null accountingInvoiceId, read off the
//        ORDER ROW rather than from an AccountingSyncLog — so unlike every other delete blocker it
//        does not evaporate when retention purges the sync rows.
//
// An argument spread over four files is one refactor away from being false, so the last link is now
// ASSERTED at the enqueue (behavioural tests below) and the two middle links are PINNED here. If a
// future change lets an un-invoiced order reach this point, the enqueue refuses instead of silently
// writing a row nothing protects — and refusing loses no money, because `false` is the established
// "this revaluation did not post here" signal and the caller keeps the delta in its own COGS journal.
// The retention-independent last link is covered in tests/sales-order-delete-guard.test.ts
// ("durable external-document marker survives log retention").
// ---------------------------------------------------------------------------

const JOURNALED_AT = new Date('2026-01-02T00:00:00.000Z')

function makeTx(order: { id: string; accountingInvoiceId: string | null } | null) {
  const queued: Array<Record<string, unknown>> = []
  const tx = {
    $queryRawUnsafe: async () => [{ id: 'shipment-1' }],
    // o3d-c08y r2: models a REAL transaction client — refreshShipmentCogsForCostLayerChange probes with
    // SAVEPOINT at entry, because its refusal only means anything where a transaction can be aborted.
    $executeRawUnsafe: async () => 0,
    $executeRaw: async () => 0,
    shipment: {
      findUnique: async ({ select }: { select: Record<string, unknown> }) => (
        // Select-aware: the COGS read and the delete-protection read ask for different columns, and
        // conflating them would hide which one the refusal actually depends on.
        select.order
          ? (order === null ? null : { order })
          : { cogsBatchAmount: '20.00', shipmentJournalDate: JOURNALED_AT }
      ),
      update: async () => {},
    },
    shipmentLine: {
      findMany: async () => [{
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: '5.000000', unitCostBase: '5.500000' }],
      }],
    },
    cogsSubledgerMovement: { upsert: async ({ create }: { create: unknown }) => create },
  }
  return {
    tx: tx as never,
    queued,
    options: {
      accountingSettings: { inventoryAccount: '120', cogsAccount: '500' },
      isReversalPostingEnabled: async () => true,
      queueAccountingSync: async (_tx: unknown, params: Record<string, unknown>) => {
        queued.push(params)
        return true
      },
    },
  }
}

test('o3d-zpa7: an invoiced (therefore undeletable) order revalues and enqueues as before', async () => {
  const { tx, queued, options } = makeTx({ id: 'order-1', accountingInvoiceId: 'INV-XERO-1' })

  const result = await refreshShipmentCogsForCostLayerChange(tx, 'layer-1', options as never)

  assert.equal(queued.length, 1, 'the normal path is untouched')
  assert.equal(queued[0].referenceType, 'Shipment')
  assert.equal(result.cogsRevaluationDelta.toString(), '7.5', 'and the shipment path owns the delta')
  assert.match(
    String(queued[0].unlockedOrderScopeReason),
    /provably undeletable \(accountingInvoiceId asserted above\)/,
    'the acknowledgement now records WHY no lock is taken, not an open gap',
  )
})

test('o3d-zpa7: an order with NO accountingInvoiceId is refused — it is not delete-protected', async () => {
  // The only state in which the unlocked enqueue would actually be racing a hard delete. It cannot be
  // reached today; if a change to A1/Group B ever makes it reachable, this is what happens instead of
  // an orphaned row.
  const { tx, queued, options } = makeTx({ id: 'order-1', accountingInvoiceId: null })

  const result = await refreshShipmentCogsForCostLayerChange(tx, 'layer-1', options as never)

  assert.deepEqual(queued, [], 'nothing is enqueued against an order that could be deleted underneath it')
  assert.equal(
    result.cogsRevaluationDelta.toString(),
    '0',
    'and the delta is NOT claimed as shipment-owned, so the caller keeps it in its own COGS journal — '
    + 'refusing must not lose the money',
  )
  assert.equal(result.shipmentsUpdated, 1, 'the stored shipment COGS is still corrected either way')
})

test('o3d-zpa7: a shipment that has vanished is refused rather than enqueued blind', async () => {
  const { tx, queued, options } = makeTx(null)

  const result = await refreshShipmentCogsForCostLayerChange(tx, 'layer-1', options as never)

  assert.deepEqual(queued, [])
  assert.equal(result.cogsRevaluationDelta.toString(), '0')
})

test('o3d-zpa7: the chain that makes the race unreachable is pinned in every registered connector', async () => {
  // These two where-clauses are the middle links. If either loses its condition, an order with no
  // accountingInvoiceId can reach a journaled shipment, the enqueue starts refusing work it used to
  // do, and THIS test says which link moved — instead of the change looking harmless.
  //
  // o3d-c08y r2 moved Group B's selection into ONE shared constant (the batch must probe, lock and
  // then re-read through the same clause), so that link is pinned where it now lives — and the
  // connector is pinned to USE it, and pinned NOT to carry its own inlined copy. The last check is an
  // absence check, so unlike the `includes` above it cannot be satisfied by a second, weaker clause
  // sitting beside the right one.
  const shared = readFileSync(join(process.cwd(), 'lib/domain/accounting/daily-batch-group-b-lock.ts'), 'utf8')
    .replace(/\s+/g, ' ')
  assert.ok(
    shared.includes("status: 'SHIPPED', shipmentJournalDate: null, order: { refundStatus: { not: 'FULL' }, revenueDeferredDate: { not: null },"),
    'DAILY_BATCH_GROUP_B_SHIPMENT_WHERE must still require revenueDeferredDate — it is what ties a journaled '
    + 'shipment to Group A1 (o3d-zpa7)',
  )

  // o3d-remove-parked-connectors: the archived QuickBooks file was listed here too, so this rule was
  // checked against TWO independently-written implementations. It is now checked against one — and the
  // shared-clause assertion above is what the second implementation used to corroborate.
  //
  // The roster is DERIVED from the accounting registry, not typed: a connector registered without a
  // `lib/connectors/<id>/daily-sync.ts` carrying these clauses fails here, and an empty registry fails
  // the floor below rather than silently turning this test into a no-op.
  const { ACCOUNTING_CONNECTORS } = await import('@/lib/connectors/accounting-registry')
  const connectors = ACCOUNTING_CONNECTORS.map((entry) => entry.id)
  assert.ok(connectors.length > 0, 'PRECONDITION: the registry lists at least one accounting connector')
  let checked = 0
  for (const connector of connectors) {
    const src = readFileSync(join(process.cwd(), `lib/connectors/${connector}/daily-sync.ts`), 'utf8')
      .replace(/\s+/g, ' ')

    assert.ok(
      src.includes("paidAt: { not: null }, revenueDeferredDate: null, accountingInvoiceId: { not: null },"),
      `${connector} Group A1 must still require accountingInvoiceId — it is what makes the order undeletable (o3d-zpa7)`,
    )
    assert.ok(
      src.includes('where: DAILY_BATCH_GROUP_B_SHIPMENT_WHERE,'),
      `${connector} Group B must still select through the shared clause (o3d-zpa7 / o3d-c08y)`,
    )
    assert.ok(
      !src.includes("shipmentJournalDate: null, order: {"),
      `${connector} Group B must not carry its own inlined selection clause — one clause, one place, or the `
      + 'batches can drift apart again (o3d-c08y)',
    )
    checked += 1
  }
  assert.equal(checked, connectors.length, `every registered connector was checked: ${JSON.stringify(connectors)}`)
})

test('o3d-zpa7: only Group B writes shipmentJournalDate, so the chain has no side entrance', () => {
  // The FIRST link. A third writer of this column anywhere in the codebase would bypass Group A1
  // entirely, and the argument above would stop holding without any of the pinned clauses changing —
  // so this scans the whole source tree rather than a list of files someone remembered.
  //
  // It matches the two forms that assign a real date: `shipmentJournalDate: new Date(...)` and the
  // shorthand `shipmentJournalDate,` at the end of a line. Reads (`: true`), where-operators
  // (`: { ... }`), the two deliberate RESETS to `null` (a failed batch must leave the shipment
  // un-journaled) and property reads (`shipment.shipmentJournalDate`) are all excluded by shape.
  // A write through an intermediate variable would slip past, which is why this is a tripwire on the
  // known shapes rather than a proof — the proof is the enqueue-side assertion the tests above pin.
  const WRITE = /(?:^|[^.\w])shipmentJournalDate(?:: new Date|,\s*$)/gm
  const writers = new Set<string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'generated') continue
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
      const src = readFileSync(full, 'utf8')
      if (!src.includes('shipmentJournalDate')) continue
      if (src.match(WRITE)) writers.add(full.replace(`${process.cwd()}/`, ''))
    }
  }
  walk(join(process.cwd(), 'lib'))
  walk(join(process.cwd(), 'app'))

  assert.deepEqual(
    [...writers].sort(),
    // o3d-remove-parked-connectors: the archived QuickBooks file was listed here too, so this rule was checked against TWO independently-written implementations. It is now checked against one.
    ['lib/connectors/xero/daily-sync.ts'],
    'a writer of shipmentJournalDate outside daily-batch Group B would bypass Group A1 and break the '
    + 'o3d-zpa7 unreachability argument — the landed-cost enqueue would then be racing a real hard delete',
  )
})
