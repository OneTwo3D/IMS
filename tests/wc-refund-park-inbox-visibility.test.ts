import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { WcRefund } from '@/lib/connectors/woocommerce/sync/types'

// ---------------------------------------------------------------------------
// o3d-xnwu r7 (Codex HIGH) — A VALID REFUND REASON HID THE PARK FROM THE INBOX.
//
// The exception inbox used to select refund parks by EXCLUDING every row whose payload's top-level
// `reason` was `missing_fx_rate`, to keep the pending-FX import queue out of the list. But a refund
// park persists the RAW WOOCOMMERCE REFUND, and `reason` on a WooCommerce refund is free text a
// human types when they issue it. So an operator who typed that string hid their own park — from the
// inbox, from `retryRefundSyncPark`, and from `recoverRefundSyncPark`, all three of which read the
// same predicate.
//
// And this branch made a FOREIGN park HOLD the refund delivery: the cross-order guard refuses and
// waits for the "Wrong order" recovery. A park nobody can see is a recovery nobody can perform, so
// the hold is permanent. A cosmetic collision became a stuck order.
//
// This is the end-to-end regression: ONE park store, three real production paths over it —
//
//   1. INBOX        getExceptionInboxData / getExceptionInboxSummary must LIST and COUNT it;
//   2. REASSIGNMENT recoverRefundSyncPark must find it and move it to its true owner;
//   3. REDELIVERY   syncWcRefund on that owner must no longer be held by it, and must apply.
//
// plus the control that the thing the exclusion was aimed at is still told apart — by a column IMS
// writes, not by a string an operator types.
// ---------------------------------------------------------------------------

/** The refund reason that used to be fatal. It is an ordinary thing for a person to type. */
const HOSTILE_REFUND_REASON = 'missing_fx_rate'

type ParkRow = {
  id: string
  connector: string
  direction: string
  entityType: string
  status: string
  /** o3d-xnwu r8: the column that says WHICH family this row is — a park, or an invoice hold. */
  recordKind: string | null
  entityId: string | null
  externalId: string | null
  errorMessage: string | null
  payload: unknown
  syncedAt: Date | null
  createdAt: Date
}

const state = {
  permissions: new Set<string>(['sync']),
  /** THE ONE STORE every layer below reads and writes. That sharing is what makes this end-to-end. */
  parks: [] as ParkRow[],
  refunds: [] as Array<{ id: string; externalRefundId: number; orderId: string }>,
  links: [] as Array<{ orderId: string; connector: string; externalOrderId: string }>,
  orders: new Set<string>(),
  activity: [] as Array<Record<string, unknown>>,
  /** WooCommerce's own answer, per WC order id — the authority the reassignment is verified against. */
  wcRefundsByOrder: new Map<number, number[]>(),
  createRefundCalls: 0,
}

// --- a where-interpreter that refuses to guess ---------------------------------------------------
// It THROWS on an operator it does not implement. A double that quietly matched everything would
// turn "the park is visible" into an assertion about the double rather than about the predicate.

function jsonPath(value: unknown, path: string[]): unknown {
  let cursor = value
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(condition as Array<Record<string, unknown>>).some((branch) => matches(row, branch))) return false
      continue
    }
    if (key === 'NOT') {
      if (matches(row, condition as Record<string, unknown>)) return false
      continue
    }
    const value = row[key] ?? null
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const test = condition as Record<string, unknown>
      for (const op of Object.keys(test)) {
        if (op === 'in') {
          if (!(test.in as unknown[]).includes(value)) return false
        } else if (op === 'not') {
          if (test.not === null ? value === null : value === test.not) return false
        } else if (op === 'path') {
          if (!('equals' in test)) throw new Error('test double: payload path without equals')
        } else if (op === 'equals') {
          if (test.path) {
            if (jsonPath(value, test.path as string[]) !== test.equals) return false
          } else if (value !== test.equals) {
            return false
          }
        } else {
          throw new Error(`test double does not implement where operator ${op}`)
        }
      }
      continue
    }
    if (value !== condition) return false
  }
  return true
}

function project(row: Record<string, unknown>, select?: Record<string, unknown>) {
  if (!select) return { ...row }
  return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]))
}

const shoppingSyncLog = {
  async findFirst({ where, select }: { where?: Record<string, unknown>; select?: Record<string, unknown> } = {}) {
    const row = state.parks.find((park) => matches(park as unknown as Record<string, unknown>, where ?? {}))
    return row ? project(row as unknown as Record<string, unknown>, select) : null
  },
  async findMany({ where, select }: { where?: Record<string, unknown>; select?: Record<string, unknown> } = {}) {
    return state.parks
      .filter((park) => matches(park as unknown as Record<string, unknown>, where ?? {}))
      .map((park) => project(park as unknown as Record<string, unknown>, select))
  },
  async count({ where }: { where?: Record<string, unknown> } = {}) {
    return state.parks.filter((park) => matches(park as unknown as Record<string, unknown>, where ?? {})).length
  },
  async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
    const row = state.parks.find((park) => park.id === where.id)
    if (!row) throw new Error(`test double: no park ${where.id}`)
    Object.assign(row, data)
    return { ...row }
  },
  async updateMany({ where, data }: { where?: Record<string, unknown>; data: Record<string, unknown> }) {
    const hits = state.parks.filter((park) => matches(park as unknown as Record<string, unknown>, where ?? {}))
    for (const hit of hits) Object.assign(hit, data)
    return { count: hits.length }
  },
  async create({ data }: { data: Record<string, unknown> }) {
    const row = { id: `log-${state.parks.length + 1}`, syncedAt: null, createdAt: new Date(), payload: null, errorMessage: null, ...data } as unknown as ParkRow
    state.parks.push(row)
    return { ...row }
  },
  async deleteMany() { return { count: 0 } },
}

/**
 * Everything else this page reads answers "nothing here". The subject is the refund-park predicate;
 * an inbox with no other exceptions in it is the cleanest place to watch it.
 */
const emptyModel = {
  async findMany() { return [] },
  async findFirst() { return null },
  async findUnique() { return null },
  async count() { return 0 },
  async updateMany() { return { count: 0 } },
  async update() { return {} },
  async aggregate() { return {} },
  async groupBy() { return [] },
}

const salesOrder = {
  ...emptyModel,
  async findMany() {
    return [...state.orders].map((id) => ({
      id,
      orderNumber: `SO-${id}`,
      currency: 'GBP',
      taxRateName: 'UK Standard Rate',
      shippingForeign: 0,
      shippingService: null,
      shoppingLinks: [{ connector: 'woocommerce' }],
      taxForeign: 2.5,
      discountAmount: 0,
      lines: [],
    }))
  },
  async findFirst() {
    return {
      id: 'so-A',
      externalOrderNumber: 'WC-1001',
      fxRateToBase: 1,
      currency: 'GBP',
      taxRateName: 'UK Standard Rate',
      totalBase: 15,
      taxBase: 2.5,
      taxRatePercent: 0.2,
      shippingBase: 0,
      lines: [{
        id: 'line-1',
        productId: 'product-1',
        externalLineItemId: 501,
        description: 'Widget',
        qty: 1,
        totalBase: 12.5,
        taxBase: 2.5,
        taxRate: { rate: 0.2, reverseCharge: false },
      }],
    }
  },
}

const shoppingOrderLink = {
  ...emptyModel,
  async findFirst({ where, select }: { where?: Record<string, unknown>; select?: Record<string, unknown> } = {}) {
    const row = state.links.find((link) => matches(link as unknown as Record<string, unknown>, where ?? {}))
    return row ? project(row as unknown as Record<string, unknown>, select) : null
  },
  async findMany({ where, select }: { where?: Record<string, unknown>; select?: Record<string, unknown> } = {}) {
    const orderIds = ((where?.orderId as { in?: string[] })?.in) ?? null
    return state.links
      .filter((link) => link.connector === 'woocommerce' && (!orderIds || orderIds.includes(link.orderId)))
      .map((link) => project(link as unknown as Record<string, unknown>, select))
  },
}

const salesOrderRefund = {
  ...emptyModel,
  async findFirst({ where, select }: { where?: Record<string, unknown>; select?: Record<string, unknown> } = {}) {
    const row = state.refunds.find((refund) => matches(refund as unknown as Record<string, unknown>, where ?? {}))
    return row ? project(row as unknown as Record<string, unknown>, select) : null
  },
}

const client: Record<string, unknown> = {
  shoppingSyncLog,
  salesOrder,
  salesOrderRefund,
  shoppingOrderLink,
  warehouse: { ...emptyModel, async findFirst() { return { id: 'return-wh' } } },
  async $executeRaw() { return 1 },
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    if (/FROM "sales_orders"/.test(strings.join(''))) {
      const id = values[0] as string
      return state.orders.has(id) ? [{ id }] : []
    }
    return []
  },
  async $transaction(fn: (tx: unknown) => Promise<unknown>) {
    const snapshot = state.parks.map((park) => ({ ...park }))
    try {
      return await fn(db)
    } catch (error) {
      state.parks = snapshot
      throw error
    }
  },
}

/**
 * Any model this page reaches for that is not named above answers "nothing", rather than throwing.
 * The alternative is a test that fails whenever an unrelated section is added to the inbox, which
 * would make the regression this file exists for the FIRST thing anybody deleted.
 */
const db = new Proxy(client, {
  get(target, property: string) {
    if (property in target) return target[property]
    return emptyModel
  },
})

mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: string) => {
      if (!state.permissions.has(permission)) throw new Error(`Forbidden: missing permission ${permission}`)
      return { user: { id: 'op-1' } }
    },
    requireFreshPermission: async (permission: string) => {
      if (!state.permissions.has(permission)) throw new Error(`Forbidden: missing permission ${permission}`)
      return { user: { id: 'op-1' } }
    },
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) },
    // o3d-xnwu r14: the recovery's witness is written INSIDE its transaction now, so this seam has
    // to exist here too — the real one does not catch, and neither does this.
    logActivityInTransaction: async (_tx: unknown, entry: Record<string, unknown>) => { state.activity.push(entry) },
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, params: Record<string, string> = {}) => {
      const match = /^\/orders\/(\d+)\/refunds$/.exec(path)
      if (!match) throw new Error(`test double does not implement WC path ${path}`)
      const all = state.wcRefundsByOrder.get(Number(match[1])) ?? []
      const perPage = Math.min(Number(params.per_page ?? '10'), 100)
      const page = Number(params.page ?? '1')
      return {
        data: all.slice((page - 1) * perPage, page * perPage).map((id) => ({ id })),
        totalPages: Math.max(1, Math.ceil(all.length / perPage)),
        totalItems: all.length,
      }
    },
  },
})

/** The WooCommerce refund as the store sent it — reason and all. This is what a park stores. */
function wcRefund(overrides: Partial<WcRefund> = {}): WcRefund {
  return {
    id: 7001,
    parent_id: 1001,
    date_created: '2026-08-05T10:00:00',
    date_created_gmt: '2026-08-05T10:00:00',
    // GROSS, as WooCommerce reports it: the 12.50 net line plus its 2.50 of VAT. The sync reconciles
    // the refund against the order's own money, so a figure that did not add up would fail this
    // chain for a reason that has nothing to do with the park.
    amount: '15.00',
    // THE WHOLE FINDING, in one field. An operator typed it into WooCommerce's refund dialog.
    reason: HOSTILE_REFUND_REASON,
    refunded_by: 1,
    refunded_payment: true,
    meta_data: [],
    line_items: [{
      id: 601,
      name: 'Widget',
      product_id: 10,
      variation_id: 0,
      quantity: -1,
      tax_class: '',
      subtotal: '-12.50',
      subtotal_tax: '-2.50',
      total: '-12.50',
      total_tax: '-2.50',
      sku: 'WIDGET',
      meta_data: [{ id: 1, key: '_refunded_item_id', value: '501' }],
      refund_total: 12.5,
    }],
    ...overrides,
  } as WcRefund
}

function parkRow(over: Partial<ParkRow> = {}): ParkRow {
  return {
    id: 'log-1',
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    entityType: 'SalesOrder',
    status: 'FAILED',
    recordKind: 'WC_REFUND_PARK',
    // Parked against the WRONG order — the state the "Wrong order" recovery exists for.
    entityId: 'so-B',
    externalId: '7001',
    errorMessage: 'WooCommerce refund 7001 amount mismatch',
    payload: wcRefund(),
    syncedAt: null,
    createdAt: new Date('2026-08-05T10:00:00.000Z'),
    ...over,
  }
}

test.beforeEach(() => {
  state.permissions = new Set(['sync'])
  state.parks = [parkRow()]
  state.refunds = []
  state.links = [
    { orderId: 'so-A', connector: 'woocommerce', externalOrderId: '1001' },
    { orderId: 'so-B', connector: 'woocommerce', externalOrderId: '2002' },
  ]
  state.orders = new Set(['so-A', 'so-B'])
  state.activity = []
  // WooCommerce says refund 7001 is on order 1001 — the order the park is NOT on.
  state.wcRefundsByOrder = new Map([[1001, [7001]], [2002, [9001]]])
  state.createRefundCalls = 0
})

async function inbox() {
  return await import('@/app/actions/sync-exceptions')
}

test('[o3d-xnwu r7] a park whose refund reason is the FX marker is still listed and counted by the inbox', async () => {
  // Leg 1. Before the fix the park was filtered out of both the list and the count, so the page an
  // operator is sent to by the hold showed nothing at all.
  //
  // (Revert evidence: restore the `OR: [{ payload DbNull }, { NOT: payload.reason == 'missing_fx_rate' }]`
  // clause on REFUND_PARK_WHERE and this fails with 0 parks and a total of 0.)
  const { getExceptionInboxData, getExceptionInboxSummary } = await inbox()

  const summary = await getExceptionInboxSummary()
  assert.equal(summary.refundSyncParks, 1, 'the park must be COUNTED — the badge is what sends an operator to the page')
  assert.equal(summary.total, 1)

  const data = await getExceptionInboxData()
  assert.equal(data.refundSyncParks.length, 1, 'and LISTED, or there is nothing on the page to act on')
  assert.equal(data.refundSyncParks[0].id, 'log-1')
  assert.equal(data.refundSyncParks[0].externalRefundId, '7001')
  assert.equal(data.refundSyncParks[0].orderId, 'so-B', 'shown against the order it is wrongly sitting on')
  assert.equal(data.refundSyncParks[0].wcOrderId, '2002', 'with that order\'s WooCommerce id, which is how a human spots the mismatch')
})

test('[o3d-xnwu r7] the same park can be REASSIGNED to its true owner', async () => {
  // Leg 2. The recovery reads the same predicate, so a hidden park was also an unrecoverable one:
  // it answered "that refund park no longer exists or is already resolved" about a row sitting
  // right there in the table.
  //
  // (Revert evidence: restore the payload-reason exclusion and this fails with code
  // 'park_not_actionable'.)
  const { recoverRefundSyncPark } = await inbox()

  const result = await recoverRefundSyncPark('log-1', { observedOrderId: 'so-B', outcome: 'REASSIGN', wcOrderId: 1001 })

  assert.deepEqual(result, { success: true, outcome: 'REASSIGN', targetOrderId: 'so-A' })
  const park = state.parks[0]
  assert.equal(park.entityId, 'so-A', 'the park now sits on the order WooCommerce named')
  assert.equal(park.status, 'PENDING', 'as PENDING — the one actionable status the sweep dedup does not skip')
})

test('[o3d-xnwu r7] and the next delivery on the true owner is no longer held by it', async () => {
  // Leg 3, the reason legs 1 and 2 matter. A FOREIGN park HOLDS the delivery: the cross-order guard
  // refuses and waits for the recovery. Once the park has been moved, the same delivery falls
  // through and the refund is applied — which is the whole chain the hidden park broke.
  const { recoverRefundSyncPark } = await inbox()
  const { syncWcRefund } = await import('@/lib/connectors/woocommerce/sync/refund-sync')

  const dependencies = {
    db: db as never,
    createRefund: (async (_orderId: string, _lines: unknown, _reason: unknown, _wh: unknown, options?: { externalRefundId?: number }) => {
      state.createRefundCalls += 1
      state.refunds.push({ id: 'refund-1', externalRefundId: options?.externalRefundId ?? 0, orderId: 'so-A' })
      return { success: true }
    }) as never,
    logActivity: (async (entry: Record<string, unknown>) => { state.activity.push(entry) }) as never,
  }

  // BEFORE the recovery: the delivery for the true owner is held, not settled and not applied.
  const held = await syncWcRefund(1001, wcRefund(), dependencies)
  assert.equal(held.outcome, 'cross-order-park-resolvable', 'a foreign park HOLDS the delivery — that is the branch this depends on')
  assert.equal(state.createRefundCalls, 0)

  // The operator does the one thing the product offers, on the page they can now see it.
  const recovered = await recoverRefundSyncPark('log-1', { observedOrderId: 'so-B', outcome: 'REASSIGN', wcOrderId: 1001 })
  assert.equal(recovered.success, true)

  // AFTER: the redelivery applies.
  const applied = await syncWcRefund(1001, wcRefund(), dependencies)
  assert.notEqual(applied.outcome, 'cross-order-park-resolvable', 'the hold is gone')
  assert.equal(state.createRefundCalls, 1, 'and the refund the hold was protecting is finally recorded')
})

test('[o3d-xnwu r7] the pending-FX queue is still told apart — by a column IMS writes, not a string an operator types', async () => {
  // The control. The exclusion existed to keep the missing-FX import queue out of the inbox, and
  // dropping it must not put it back. It does not: a queued order has no IMS order yet, which is why
  // it is queued, and that is what both predicates now turn on.
  //
  // (Revert evidence: drop `entityId: null` from pendingFxQueueWhere and the last assertion fails —
  // the FX retry sweep would select the refund park and stamp it FAILED over its own error text.)
  const { getExceptionInboxData } = await inbox()
  const { pendingFxQueueWhere } = await import('@/lib/connectors/woocommerce/sync/order-import')

  // PENDING, because that is the state the collision is worst in — and it is not a contrived one: a
  // retryable park is PENDING, and a park the operator has just REASSIGNED is PENDING by design
  // (REASSIGNED_REFUND_PARK_STATUS). The FX retry sweep selects PENDING rows.
  state.parks[0].status = 'PENDING'

  const queueRow: ParkRow = {
    id: 'fx-1',
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    entityType: 'SalesOrder',
    status: 'PENDING',
    recordKind: null,
    entityId: null,
    externalId: '1001',
    errorMessage: 'waiting for a EUR rate',
    payload: { reason: 'missing_fx_rate', connector: 'woocommerce', externalOrderId: '1001', externalOrderNumber: '1001', currency: 'EUR', asOf: null, order: { id: 1001 } },
    syncedAt: null,
    createdAt: new Date('2026-08-05T09:00:00.000Z'),
  }
  state.parks.push(queueRow)

  const data = await getExceptionInboxData()
  assert.deepEqual(data.refundSyncParks.map((row) => row.id), ['log-1'], 'the queue row is not a refund park')

  const fxWhere = pendingFxQueueWhere() as unknown as Record<string, unknown>
  assert.equal(matches(queueRow as unknown as Record<string, unknown>, fxWhere), true, 'and the queue row IS the FX queue')
  assert.equal(
    matches(state.parks[0] as unknown as Record<string, unknown>, fxWhere),
    false,
    'while the refund park is NOT — otherwise the FX retry sweep stamps it FAILED over its own error text',
  )
})

// ---------------------------------------------------------------------------
// o3d-xnwu r8 (Codex HIGH) — THE POSITIVE DEFINITION WAS NOT A REFUND DEFINITION.
//
// r7 above replaced an exclusion with a positive predicate, which was the right move. But every
// clause in it — connector, direction, entityType 'SalesOrder', an actionable status, entityId NOT
// NULL — is also written by `holdWcSalesInvoiceForMissingNumber`, the hold that keeps a sales
// invoice back until WooCommerce assigns it a number. So an invoice hold was admitted as an
// ACTIONABLE REFUND PARK: listed in the recovery inbox, counted in its badge, and offered "Wrong
// order" and "Dismiss".
//
// Neither of those is survivable. A REASSIGN moves the row onto another IMS order as a PENDING
// park — an invoice payload attached to a stranger's order, and the true order's hold gone. A
// DISMISS flips it SYNCED, which is precisely how a hold is retired once its invoice was released;
// the release sweep then finds nothing, and the order is never invoiced.
//
// AND THE COLLISION RUNS BOTH WAYS, with the write on the other side. `heldSalesInvoiceQueueWhere`
// told holds apart by `payload.reason`, and a park's payload is the RAW WOOCOMMERCE REFUND whose
// `reason` is free text a human types — the same fact r7 was about. A park whose reason read
// `missing_wc_invoice_number` was selected by the hold's own findFirst-and-update.
//
// The fix is a column IMS writes and the store cannot reach: `recordKind`.
// ---------------------------------------------------------------------------

/** The reason string that makes the collision run in the OTHER direction. Also ordinary to type. */
const HOSTILE_INVOICE_HOLD_REASON = 'missing_wc_invoice_number'

/**
 * A held sales invoice, exactly as `holdWcSalesInvoiceForMissingNumber` writes it — same connector,
 * same direction, same entity type, PENDING, and the IMS order id in `entityId`. Only `recordKind`
 * differs from a park, which is the whole point.
 */
function heldInvoiceRow(over: Partial<ParkRow> = {}): ParkRow {
  return {
    id: 'hold-1',
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    entityType: 'SalesOrder',
    status: 'PENDING',
    recordKind: 'WC_HELD_SALES_INVOICE',
    entityId: 'so-A',
    // The WooCommerce ORDER id — a hold is keyed to the order, a park to the refund.
    externalId: '1001',
    errorMessage: 'Waiting for _wcpdf_invoice_number on WooCommerce order 1001 before the sales invoice can be posted.',
    payload: {
      reason: HOSTILE_INVOICE_HOLD_REASON,
      connector: 'woocommerce',
      externalOrderId: '1001',
      externalOrderNumber: '1001',
      salesOrderId: 'so-A',
      orderNumber: 'SO-1001',
      metaKey: '_wcpdf_invoice_number',
      accountingPayload: { total: '15.00' },
    },
    syncedAt: null,
    createdAt: new Date('2026-08-05T11:00:00.000Z'),
    ...over,
  }
}

test('[o3d-xnwu r8] a held sales invoice is NOT listed or counted as an actionable refund park', async () => {
  // (Revert evidence: drop `recordKind` from activeRefundParkWhere and this fails with 2 parks and
  // a total of 2 — the invoice hold appears in the recovery inbox as a refund.)
  state.parks.push(heldInvoiceRow())

  const { getExceptionInboxData, getExceptionInboxSummary } = await inbox()

  const summary = await getExceptionInboxSummary()
  assert.equal(summary.refundSyncParks, 1, 'the genuine park, and only it')
  assert.equal(summary.total, 1)

  const data = await getExceptionInboxData()
  assert.deepEqual(data.refundSyncParks.map((row) => row.id), ['log-1'], 'the invoice hold is not a refund park')
})

test('[o3d-xnwu r8] and the recovery refuses to act on one, so no invoice is reassigned or dismissed', async () => {
  // The list is only half of it: `recoverRefundSyncPark` reads the SAME predicate, so a hold the
  // inbox showed was a hold the recovery would have moved or closed.
  //
  // (Revert evidence: drop `recordKind` from activeRefundParkWhere and this fails — the DISMISS
  // succeeds and the hold is stamped SYNCED, which is exactly how a released hold is retired, so
  // the release sweep never comes back for it and the order is never invoiced.)
  state.parks.push(heldInvoiceRow())
  const { recoverRefundSyncPark } = await inbox()

  const dismissed = await recoverRefundSyncPark('hold-1', { observedOrderId: 'so-A', outcome: 'DISMISS' })
  assert.equal(dismissed.success, false)
  assert.equal((dismissed as { code?: string }).code, 'park_not_actionable')

  const reassigned = await recoverRefundSyncPark('hold-1', { observedOrderId: 'so-A', outcome: 'REASSIGN', wcOrderId: 2002 })
  assert.equal(reassigned.success, false)
  assert.equal((reassigned as { code?: string }).code, 'park_not_actionable')

  const hold = state.parks.find((row) => row.id === 'hold-1')
  assert.equal(hold?.status, 'PENDING', 'the hold is untouched — still waiting for its number')
  assert.equal(hold?.entityId, 'so-A', 'and still on its own order')
  assert.equal(hold?.errorMessage, heldInvoiceRow().errorMessage, 'with its own text, not a recovery note')
})

test('[o3d-xnwu r8] and the hold queue does not select a refund park, whatever the store typed as the reason', async () => {
  // THE OTHER DIRECTION, AND IT IS THE ONE THAT WRITES. holdWcSalesInvoiceForMissingNumber does a
  // findFirst on this predicate and UPDATES what it finds; the release sweep rewrites the
  // errorMessage of what it finds. Selecting on the store's `reason` meant a park could be either.
  //
  // (Revert evidence: drop `recordKind` from heldSalesInvoiceQueueWhere and the first assertion
  // fails — the park matches the hold queue on its own order, and the next import of that order
  // overwrites the refund evidence with an invoice payload.)
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')

  // A park whose operator typed the hold's marker into WooCommerce's refund dialog, sitting on the
  // very order an import would look for a hold on.
  const hostilePark = parkRow({
    id: 'log-2',
    status: 'PENDING',
    entityId: 'so-A',
    payload: wcRefund({ reason: HOSTILE_INVOICE_HOLD_REASON }),
  })
  state.parks.push(hostilePark)
  state.parks.push(heldInvoiceRow())

  const holdWhere = heldSalesInvoiceQueueWhere({ salesOrderId: 'so-A' }) as unknown as Record<string, unknown>

  assert.equal(
    matches(hostilePark as unknown as Record<string, unknown>, holdWhere),
    false,
    'a refund park is never the invoice-hold queue, however its reason reads',
  )
  assert.equal(
    matches(heldInvoiceRow() as unknown as Record<string, unknown>, holdWhere),
    true,
    'and the genuine hold still is — the control, or the predicate could just be broken',
  )

  // …and the park is still a park, on the same store, at the same time.
  const { getExceptionInboxData } = await inbox()
  const data = await getExceptionInboxData()
  assert.deepEqual(data.refundSyncParks.map((row) => row.id).sort(), ['log-1', 'log-2'])
})

// ---------------------------------------------------------------------------
// o3d-xnwu r8 CUTOVER (Codex HIGH) — THE DISCRIMINATOR IS ONLY SAFE ONCE THE OLD WRITER IS STOPPED.
//
// The steady state above is sound. What is NOT safe is the window in which the migration has been
// applied and the PREDECESSOR BINARY IS STILL SERVING. That binary selects held sales invoices by
// `payload.reason` alone — the operator-controlled string this whole finding is about — so it can
// recreate the exact collision `recordKind` exists to remove, AFTER the backfill has run.
//
// The migration now states quiescence as a REQUIREMENT with two verification queries that must both
// return zero. These two tests pin the behaviour under a BOTCHED cutover so it is a known quantity
// rather than an assumption, and they are deliberately the two cases Codex named:
//
//   (a) an old-binary-created NULL hold — invisible to both new predicates, and REPAIRABLE by
//       re-running the backfill, which is what the verification queries are for;
//   (b) an old writer OVERWRITING an already-stamped park — NOT repairable, invisible to both
//       verification queries, and the r8 defect back in full.
//
// AUTOMATING THE DEPLOY SEQUENCE IS NOT THIS BRANCH'S WORK. It is o3d-2sm1.1 ("the deploy script
// migrates before stopping the predecessor"), and this migration is recorded on that issue.
// ---------------------------------------------------------------------------

/**
 * THE PREDECESSOR'S OWN PREDICATE, copied deliberately: `heldSalesInvoiceQueueWhere` as it reads in
 * the binary that is still serving during the cutover — every clause of today's version EXCEPT
 * `recordKind`. It is a literal here rather than an import because the point is that it belongs to
 * a version of the code this worktree no longer contains, and it must not silently acquire the fix.
 */
const OLD_HELD_INVOICE_QUEUE_WHERE = {
  connector: 'woocommerce',
  direction: 'FROM_CONNECTOR',
  status: 'PENDING',
  entityType: 'SalesOrder',
  entityId: 'so-A',
  payload: { path: ['reason'], equals: HOSTILE_INVOICE_HOLD_REASON },
}

/**
 * VERIFICATION QUERY 2 from the migration, in this table's Prisma vocabulary: "no unstamped park".
 * It is the wider of the two — every actionable row that has not named its family — so an unstamped
 * HOLD is counted by it as well, which is exactly what the SQL does.
 */
const UNSTAMPED_ACTIONABLE_WHERE = {
  recordKind: null,
  connector: 'woocommerce',
  direction: 'FROM_CONNECTOR',
  entityType: 'SalesOrder',
  entityId: { not: null },
  status: { in: ['PENDING', 'FAILED', 'QUARANTINED'] },
}

function unstampedActionableCount() {
  return state.parks.filter((row) => matches(row as unknown as Record<string, unknown>, UNSTAMPED_ACTIONABLE_WHERE)).length
}

test('[o3d-xnwu r8 cutover] a hold the OLD binary wrote is unstamped, lost by both queues, and repairable', async () => {
  // CASE (a). The migration is applied, the backfill has run, and the predecessor is still serving:
  // it writes a hold that knows nothing about `recordKind`. Both new predicates ask for the stamp BY
  // NAME, so the row falls out of everything — the invoice is never released and nothing lists it.
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const legacyHold = heldInvoiceRow({ id: 'hold-legacy', recordKind: null })
  state.parks = [legacyHold]

  const holdWhere = heldSalesInvoiceQueueWhere({ salesOrderId: 'so-A' }) as unknown as Record<string, unknown>
  assert.equal(
    matches(legacyHold as unknown as Record<string, unknown>, holdWhere),
    false,
    'the release sweep cannot see it, so the order stays PROCESSING and permanently un-invoiced',
  )

  const { getExceptionInboxData } = await inbox()
  assert.deepEqual(
    (await getExceptionInboxData()).refundSyncParks.map((row) => row.id),
    [],
    'and the recovery inbox does not list it either — it is invisible everywhere, not merely misfiled',
  )

  // THE VERIFICATION QUERY IS WHAT CATCHES IT, which is why the migration makes a non-zero answer a
  // hard stop rather than a note.
  assert.equal(unstampedActionableCount(), 1, 'verification query 2 returns non-zero — the cutover has failed')

  // …AND IT IS REPAIRABLE: re-running the backfill stamps the cell (statement 1 recognises the hold
  // by a shape the store cannot forge), and the queue finds it again.
  legacyHold.recordKind = 'WC_HELD_SALES_INVOICE'
  assert.equal(unstampedActionableCount(), 0, 'both verification queries return 0 once the backfill is re-run')
  assert.equal(
    matches(legacyHold as unknown as Record<string, unknown>, holdWhere),
    true,
    'and the invoice is released after all — case (a) costs a repair, not the evidence',
  )
})

test('[o3d-xnwu r8 cutover] the OLD writer overwrites an already-stamped park, and no backfill can repair it', async () => {
  // CASE (b), AND THIS IS THE ONE THAT MAKES QUIESCENCE A REQUIREMENT. The park is already stamped —
  // the backfill ran, everything looks correct — and the predecessor's hold queue selects it anyway,
  // because its only discriminator is a `reason` string the operator typed into WooCommerce.
  const stampedPark = parkRow({
    id: 'log-1',
    status: 'PENDING',
    entityId: 'so-A',
    payload: wcRefund({ reason: HOSTILE_INVOICE_HOLD_REASON }),
  })
  state.parks = [stampedPark]

  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  assert.equal(
    matches(stampedPark as unknown as Record<string, unknown>, OLD_HELD_INVOICE_QUEUE_WHERE),
    true,
    'the OLD binary selects the stamped park — the stamp means nothing to a predicate that never asks for it',
  )
  assert.equal(
    matches(stampedPark as unknown as Record<string, unknown>, heldSalesInvoiceQueueWhere({ salesOrderId: 'so-A' }) as unknown as Record<string, unknown>),
    false,
    'while the NEW binary does not — the control, or this test would be about a fix that never worked',
  )

  // THE OLD BINARY'S WRITE: holdWcSalesInvoiceForMissingNumber does a findFirst on the predicate
  // above and UPDATES what it finds. It does not know the column exists, so it leaves it alone.
  const hold = heldInvoiceRow()
  Object.assign(stampedPark, {
    status: 'PENDING',
    externalId: hold.externalId,
    errorMessage: hold.errorMessage,
    payload: hold.payload,
  })

  assert.equal(stampedPark.recordKind, 'WC_REFUND_PARK', 'THE STAMP NOW LIES: it says park, the row is a hold')
  assert.equal(
    (stampedPark.payload as { metaKey?: string }).metaKey,
    '_wcpdf_invoice_number',
    'and the WooCommerce refund evidence this park existed to hold is simply gone',
  )

  // NOT REPAIRABLE, AND NOT DETECTABLE. The backfill statements only ever write a NULL cell, and
  // both verification queries ask for a NULL cell, so the cutover check passes over the wreckage.
  assert.equal(unstampedActionableCount(), 0, 'both verification queries return 0 — they cannot see case (b)')

  // AND THE r8 DEFECT IS BACK IN FULL: an invoice hold listed as an actionable refund park, with
  // "Wrong order" and "Dismiss" offered on it.
  const { getExceptionInboxData, recoverRefundSyncPark } = await inbox()
  assert.deepEqual(
    (await getExceptionInboxData()).refundSyncParks.map((row) => row.id),
    ['log-1'],
    'the recovery inbox lists an invoice hold as a refund park — exactly the defect recordKind removed',
  )

  const dismissed = await recoverRefundSyncPark('log-1', { observedOrderId: 'so-A', outcome: 'DISMISS' })
  assert.equal(dismissed.success, true, 'and the DISMISS is allowed, on a row that is not a refund at all')
  assert.equal(
    state.parks[0].status,
    'SYNCED',
    'which is precisely how a RELEASED hold is retired — so the release sweep never returns and the order is never invoiced',
  )
})
