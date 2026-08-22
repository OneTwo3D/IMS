import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// o3d-k26m.6 round 4 — A RETRY WITH NO DRIVER IS NOT A RETRY.
//
// Round 3 made the release confirm the accounting sync row exists before closing the hold, so a
// silently-skipped enqueue stopped being reported as success. What it left behind was a hold row
// sitting PENDING with "the next redelivery or poll retries it" written next to it — and nothing
// scheduling either. `releaseHeldWcSalesInvoice` runs only from an import of that order, and the
// only reason WooCommerce would touch the order again is the number arriving, which has already
// happened by the time the release fails. So the commonest failure (accounting connector off) left
// an order numbered, PROCESSING and permanently un-invoiced.
//
// These drive the sweep that comes back for it, against a database double.
// ---------------------------------------------------------------------------

type HeldRow = {
  id: string
  status: string
  entityId: string | null
  externalId: string | null
  payload: unknown
  errorMessage: string | null
  syncedAt: Date | null
  createdAt: Date
}

type Order = { id: string; invoiceNumber: string | null; accountingInvoiceId: string | null }

const state = {
  held: [] as HeldRow[],
  orders: [] as Order[],
  queued: [] as { referenceId: string; idempotencyKey: string; payload: Record<string, unknown> }[],
  /** The connector being off: queueAccountingSync returns silently and writes nothing. */
  enqueueNoOps: false,
  activity: [] as { action: string; description: string }[],
}

/** Block and line comments removed, so a commented-out call cannot satisfy a source scan. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function heldRow(overrides: Partial<HeldRow> & { id: string; entityId: string }): HeldRow {
  return {
    status: 'PENDING',
    externalId: '9001',
    errorMessage: 'Waiting for _wcpdf_invoice_number on WooCommerce order 164981 before the sales invoice can be posted.',
    syncedAt: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    payload: {
      reason: 'missing_wc_invoice_number',
      connector: 'woocommerce',
      externalOrderId: '9001',
      externalOrderNumber: '164981',
      salesOrderId: overrides.entityId,
      orderNumber: 'WC-164981',
      metaKey: '_wcpdf_invoice_number',
      accountingPayload: { contactName: 'A Customer', date: '2026-08-01', currency: 'GBP', lines: [] },
    },
    ...overrides,
  }
}

/** The held-queue predicate, checked rather than assumed — a double that ignores it proves nothing. */
function matchesHeld(row: HeldRow, where: Record<string, unknown>): boolean {
  assert.equal(where.connector, 'woocommerce')
  assert.equal(where.direction, 'FROM_CONNECTOR')
  assert.equal(where.entityType, 'SalesOrder')
  const payload = where.payload as { path: string[]; equals: string } | undefined
  assert.deepEqual(payload?.path, ['reason'])
  if (row.status !== where.status) return false
  if (where.entityId !== undefined && row.entityId !== where.entityId) return false
  const reason = (row.payload as { reason?: string } | null)?.reason
  return reason === payload?.equals
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      shoppingSyncLog: {
        findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
          state.held.filter((r) => matchesHeld(r, where)).slice(0, take ?? undefined),
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          state.held.filter((r) => matchesHeld(r, where))[0] ?? null,
        update: async ({ where, data }: { where: { id: string }; data: Partial<HeldRow> }) => {
          const row = state.held.find((r) => r.id === where.id)
          if (!row) throw new Error(`no held row ${where.id}`)
          Object.assign(row, data)
          return row
        },
        create: async () => { throw new Error('the sweep must not create hold rows') },
      },
      salesOrder: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          state.orders.filter((o) => where.id.in.includes(o.id)),
      },
      accountingSyncLog: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          const key = (where.payload as { path: string[]; equals: string }).equals
          assert.deepEqual((where.payload as { path: string[] }).path, ['_idempotencyKey'])
          const hit = state.queued.find((q) => q.idempotencyKey === key && q.referenceId === where.referenceId)
          return hit ? { id: 'acc-1' } : null
        },
      },
    },
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; description: string }) => { state.activity.push(entry) },
    logActivityPersisted: async () => {},
  },
})
mock.module('@/lib/accounting', {
  namedExports: {
    queueAccountingSync: async (params: { referenceId: string; idempotencyKey: string; payload: Record<string, unknown> }) => {
      // Returns void and returns EARLY — silently — when the connector is off. That is the state
      // the whole sweep exists for.
      if (state.enqueueNoOps) return
      state.queued.push({ referenceId: params.referenceId, idempotencyKey: params.idempotencyKey, payload: params.payload })
    },
  },
})

type Sweep = typeof import('@/lib/connectors/woocommerce/sync/order-import')['retryHeldWcSalesInvoiceReleases']

async function sweep(...args: Parameters<Sweep>): ReturnType<Sweep> {
  const mod = await import('@/lib/connectors/woocommerce/sync/order-import')
  return mod.retryHeldWcSalesInvoiceReleases(...args)
}

function reset() {
  state.held = []
  state.orders = []
  state.queued = []
  state.enqueueNoOps = false
  state.activity = []
}

test('a numbered order whose release failed is picked up WITHOUT the storefront touching it again', async () => {
  reset()
  state.held.push(heldRow({ id: 'hold-1', entityId: 'so-1' }))
  state.orders.push({ id: 'so-1', invoiceNumber: '164981', accountingInvoiceId: null })

  const result = await sweep()

  assert.equal(result.released, 1)
  assert.equal(state.queued.length, 1)
  assert.equal(state.queued[0].idempotencyKey, 'wc-held-sales-invoice:so-1:164981')
  assert.equal(state.queued[0].payload.invoiceNumber, '164981')
  assert.equal(state.held[0].status, 'SYNCED')
})

test('the failure that has no other driver — connector off — is retried on the NEXT run, and succeeds', async () => {
  // The whole point. Nothing about the WooCommerce order changes between the two runs: the only
  // thing that comes back for it is the sweep.
  reset()
  state.held.push(heldRow({ id: 'hold-1', entityId: 'so-1' }))
  state.orders.push({ id: 'so-1', invoiceNumber: '164981', accountingInvoiceId: null })
  state.enqueueNoOps = true

  const first = await sweep()
  assert.equal(first.stillStuck, 1)
  assert.equal(first.released, 0)
  assert.equal(state.held[0].status, 'PENDING', 'a hold that produced no sync row must stay owed')
  assert.match(
    state.held[0].errorMessage ?? '',
    /produced no accounting sync row/,
    'and it must stop claiming to be waiting for a number that has already arrived',
  )

  state.enqueueNoOps = false
  const second = await sweep()

  assert.equal(second.released, 1)
  assert.equal(state.held[0].status, 'SYNCED')
  assert.equal(state.queued.length, 1, 'the deterministic key means the retry adds one row, not two')
})

test('a stuck hold raises ONE warning naming the total, not one per order per run', async () => {
  reset()
  for (const n of [1, 2, 3]) {
    state.held.push(heldRow({ id: `hold-${n}`, entityId: `so-${n}` }))
    state.orders.push({ id: `so-${n}`, invoiceNumber: `16498${n}`, accountingInvoiceId: null })
  }
  state.enqueueNoOps = true

  await sweep()

  const warnings = state.activity.filter((a) => a.action.startsWith('sales_invoice_release'))
  assert.equal(warnings.length, 1, 'a connector outage must not write one warning per held order per cron tick')
  assert.equal(warnings[0].action, 'sales_invoice_release_still_stuck')
  assert.match(warnings[0].description, /^3 WooCommerce order\(s\)/)
})

test('an order WooCommerce has not numbered yet is left alone — waiting is not failing', async () => {
  reset()
  state.held.push(heldRow({ id: 'hold-1', entityId: 'so-1' }))
  state.orders.push({ id: 'so-1', invoiceNumber: null, accountingInvoiceId: null })

  const result = await sweep()

  assert.equal(result.stillWaiting, 1)
  assert.equal(result.released, 0)
  assert.equal(state.queued.length, 0, 'nothing may be queued for an order with no number')
  assert.equal(state.held[0].status, 'PENDING')
})

test('an order that has since been invoiced is CLOSED, never released into a second document', async () => {
  reset()
  state.held.push(heldRow({ id: 'hold-1', entityId: 'so-1' }))
  state.orders.push({ id: 'so-1', invoiceNumber: '164981', accountingInvoiceId: 'xero-id-1' })

  const result = await sweep()

  assert.equal(result.closed, 1)
  assert.equal(result.released, 0)
  assert.equal(state.queued.length, 0)
  assert.equal(state.held[0].status, 'SYNCED')
  assert.match(state.held[0].errorMessage ?? '', /already carries ledger document xero-id-1/)
})

test('a hold whose order is gone is FAILED, so it cannot sit at the head of the scan forever', async () => {
  // The starvation the pending-FX queue documents: an oldest-first scan with a bounded page is
  // starved by rows that can never leave it, and every newer hold behind them is never reached.
  reset()
  state.held.push(heldRow({ id: 'hold-dead', entityId: 'so-deleted' }))
  state.held.push(heldRow({ id: 'hold-live', entityId: 'so-1', createdAt: new Date('2026-08-02T00:00:00Z') }))
  state.orders.push({ id: 'so-1', invoiceNumber: '164981', accountingInvoiceId: null })

  const result = await sweep()

  assert.equal(result.closed, 1)
  assert.equal(result.released, 1, 'the live hold behind the dead one must still be reached')
  assert.equal(state.held[0].status, 'FAILED')
  assert.match(state.held[0].errorMessage ?? '', /cannot be found/)
  // And the next run does not see it at all.
  const second = await sweep()
  assert.equal(second.scanned, 0)
})

test('the sweep is WIRED to the reconcile cron — an unreached sweep is not a driver', () => {
  // The r7 lesson from o3d-batch-payidx: a guard that inspects nothing passes unconditionally.
  // This one reads the call itself, in the function the cron route invokes.
  // Comments are STRIPPED FIRST. A scan that reads the raw source passes just as happily when the
  // call has been commented out, which is the r7 defect itself: the searched text is still there.
  const src = withoutComments(readFileSync('lib/connectors/woocommerce/sync/reconcile.ts', 'utf8'))
  assert.doesNotMatch(src, /\/\/ *results\.heldSalesInvoices/, 'comment stripping must actually strip')
  const start = src.indexOf('export async function runWcReconcile(')
  assert.ok(start > 0, 'runWcReconcile must exist — it is what app/api/cron/wc-reconcile calls')
  const body = src.slice(start)
  assert.match(
    body,
    /await retryHeldWcSalesInvoiceReleases\(/,
    'the held-invoice release sweep must be called from the cron-driven reconcile, or nothing retries a failed release',
  )
  // Not behind the order-poll branch: a hold stuck behind a disconnected accounting connector must
  // be retried whether or not WooCommerce order polling is due.
  const call = body.indexOf('await retryHeldWcSalesInvoiceReleases(')
  const reconcileDue = body.indexOf('reconcileDue')
  assert.ok(call > 0 && (reconcileDue < 0 || call > body.indexOf('results.orders')), 'the sweep must run on its own')
  const route = withoutComments(readFileSync('app/api/cron/wc-reconcile/route.ts', 'utf8'))
  assert.match(route, /runWcReconcile\(\)/, 'and the cron route must be what runs it')
})
