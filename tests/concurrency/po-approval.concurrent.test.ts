import './scratch-database-setup' // FIRST: refuses to load unless the scratch database was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import * as fixtures from './po-landed-fixtures'
import type { SeededPo } from './po-landed-fixtures'
import { hasPermission } from '@/lib/permissions'

/**
 * PURCHASE ORDER APPROVAL over a real PostgreSQL: the real createPurchaseOrder, updatePurchaseOrder, approvePurchaseOrder,
 * advancePoStatus, confirmAndSendPurchaseOrder and sendPurchaseOrderEmail. The signed-in user is switchable and the permission check is the REAL
 * role matrix. Nothing contacts a supplier, Xero, WooCommerce or Mintsoft: the PO email switch stays off, so a send that passes the approval
 * gate is queued nowhere. The PO row race is ORDERED with a held row lock, never slept.
 *
 * A seeded order is GOODS, GBP, no VAT, UNIT_COST (5) per unit, so qty 30 is 150 and qty 10 is 50 ex VAT. The threshold used is 100.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

let currentUser = { id: 'maker-1', role: 'MANAGER' }
const as = (id: string, role: string) => { currentUser = { id, role } }
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: Parameters<typeof hasPermission>[1]) => {
      if (!hasPermission(currentUser.role, permission)) throw new Error(`Forbidden: missing permission ${permission}`)
      return { user: { ...currentUser } }
    },
    requireInternalUser: async () => ({ user: { ...currentUser } }),
    requireRole: async () => ({ user: { ...currentUser } }),
    requireApiAuth: async () => ({ user: { ...currentUser } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/fulfillment/backorder-allocator', { namedExports: { allocateBackordersForProducts: async () => ({}) } })
mock.module('@/lib/fulfillment/overallocation-rebalancer', { namedExports: { releaseOverallocations: async () => ({}) } })

const THRESHOLD_KEY = 'po_approval_threshold_base'

test.before(async () => {
  if (!RUN) return
  fixtures.loadEnv()
  as('maker-1', 'MANAGER')
})
test.after(async () => {
  if (!RUN) return
  const { db } = await import('@/lib/db')
  await db.setting.deleteMany({ where: { key: THRESHOLD_KEY } })
})

async function setThreshold(value: string | null) {
  const { db } = await import('@/lib/db')
  if (value === null) await db.setting.deleteMany({ where: { key: THRESHOLD_KEY } })
  else await db.setting.upsert({ where: { key: THRESHOLD_KEY }, create: { key: THRESHOLD_KEY, value }, update: { value } })
}

async function actions() {
  return import('@/app/actions/purchase-orders')
}

/** A DRAFT goods order created by `maker-1` through the real creation path. */
async function draft(label: string, qty: number): Promise<SeededPo> {
  as('maker-1', 'MANAGER')
  const po = await fixtures.seedPo(label, [qty])
  const { db } = await import('@/lib/db')
  await db.purchaseOrder.update({ where: { id: po.poId }, data: { status: 'DRAFT' } })
  return po
}

type Edit = Parameters<Awaited<ReturnType<typeof actions>>['updatePurchaseOrder']>[1]
function editQty(po: SeededPo, qty: number, extra: Partial<Edit> = {}): Edit {
  return {
    currency: 'GBP', pricesIncludeVat: false, taxRateValue: 0,
    lines: [{ poLineId: po.lines[0]!.poLineId, productId: po.lines[0]!.productId, sku: po.lines[0]!.sku, productName: 'edited', qty, unitCostForeign: fixtures.UNIT_COST }],
    ...extra,
  } as Edit
}

async function row(poId: string) {
  const { db } = await import('@/lib/db')
  return db.purchaseOrder.findUniqueOrThrow({
    where: { id: poId },
    select: { status: true, createdById: true, approvedById: true, approvedAt: true, approvedTotalBase: true, totalBase: true, poSentAt: true },
  })
}

const NEEDS_APPROVAL = /needs approval before it can be sent/

test('unset threshold: nothing changes (a large order advances with no approval)', SKIP, async () => {
  const { advancePoStatus, approvePurchaseOrder } = await actions()
  await setThreshold(null)
  const po = await draft('ap-unset', 200)
  const advanced = await advancePoStatus(po.poId, 'PO_SENT')
  assert.equal(advanced.success, true, String(advanced.error))
  assert.equal((await row(po.poId)).status, 'PO_SENT')
  const approve = await approvePurchaseOrder(po.poId)
  assert.equal(approve.success, false)
  assert.match(approve.error ?? '', /does not need approval/)
  for (const off of ['0', '0.00', '', 'junk']) {
    await setThreshold(off)
    const other = await draft(`ap-off-${off || 'blank'}`, 200)
    assert.equal((await advancePoStatus(other.poId, 'PO_SENT')).success, true, `threshold "${off}" is no gate`)
  }
})

test('below the threshold nothing changes; at and above it every send path is refused', SKIP, async () => {
  const { advancePoStatus, confirmAndSendPurchaseOrder, sendPurchaseOrderEmail } = await actions()
  await setThreshold('100')

  const small = await draft('ap-below', 10)
  assert.equal((await confirmAndSendPurchaseOrder(small.poId)).success, true, '50 < 100 sends')

  // Exactly at the threshold (20 x 5 = 100) is gated: the comparison is "at or above".
  const exact = await draft('ap-exact', 20)
  const exactAdvance = await advancePoStatus(exact.poId, 'PO_SENT')
  assert.equal(exactAdvance.success, false)
  assert.match(exactAdvance.error ?? '', NEEDS_APPROVAL)

  const big = await draft('ap-above', 30)
  const advance = await advancePoStatus(big.poId, 'PO_SENT')
  assert.equal(advance.success, false)
  assert.match(advance.error ?? '', NEEDS_APPROVAL)
  assert.doesNotMatch(advance.error ?? '', /^Error:/, 'a clean operator message, not a stringified Error')
  const confirm = await confirmAndSendPurchaseOrder(big.poId)
  assert.equal(confirm.success, false)
  assert.match(confirm.error ?? '', NEEDS_APPROVAL)
  assert.equal((await row(big.poId)).status, 'DRAFT', 'refusals leave the order alone')
  assert.equal((await row(big.poId)).poSentAt, null)

  // The email path on an order that is already PO_SENT but unapproved (sent before the threshold was set, or approval since cleared).
  const { db } = await import('@/lib/db')
  await db.purchaseOrder.update({ where: { id: big.poId }, data: { status: 'PO_SENT', poSentAt: new Date() } })
  const email = await sendPurchaseOrderEmail(big.poId)
  assert.equal(email.success, false)
  assert.match(email.error ?? '', NEEDS_APPROVAL)
  const resend = await confirmAndSendPurchaseOrder(big.poId)
  assert.equal(resend.success, false, 'confirm-and-send on an already-sent, unapproved order is refused too')
  assert.match(resend.error ?? '', NEEDS_APPROVAL)
})

test('approve, then send succeeds; who and when are recorded and audited', SKIP, async () => {
  const { approvePurchaseOrder, confirmAndSendPurchaseOrder, sendPurchaseOrderEmail } = await actions()
  const { db } = await import('@/lib/db')
  await setThreshold('100')
  const po = await draft('ap-ok', 30)
  as('approver-1', 'MANAGER')
  const before = Date.now()
  const approved = await approvePurchaseOrder(po.poId)
  assert.equal(approved.success, true, String(approved.error))
  const state = await row(po.poId)
  assert.equal(state.approvedById, 'approver-1')
  assert.ok(state.approvedAt && state.approvedAt.getTime() >= before - 5000)
  assert.equal(Number(state.approvedTotalBase), 150)
  const entry = await db.activityLog.findFirst({ where: { entityType: 'PURCHASE_ORDER', entityId: po.poId, action: 'approved' } })
  assert.ok(entry, 'an activity entry records the approval')
  assert.match(entry.description, /Approved PO/)

  const idempotent = await approvePurchaseOrder(po.poId)
  assert.equal(idempotent.success, true)
  assert.equal(idempotent.alreadyApproved, true)

  as('maker-1', 'MANAGER')
  const sent = await confirmAndSendPurchaseOrder(po.poId)
  assert.equal(sent.success, true, String(sent.error))
  assert.equal((await row(po.poId)).status, 'PO_SENT')
  const email = await sendPurchaseOrderEmail(po.poId)
  assert.doesNotMatch(email.error ?? '', NEEDS_APPROVAL, 'an approved order passes the approval gate on the email path')
})

test('self-approval is refused, and a role without purchasing.approve is denied', SKIP, async () => {
  const { approvePurchaseOrder } = await actions()
  await setThreshold('100')
  const po = await draft('ap-self', 30)
  as('maker-1', 'ADMIN') // holds purchasing.approve, but created it
  const self = await approvePurchaseOrder(po.poId)
  assert.equal(self.success, false)
  assert.match(self.error ?? '', /you cannot approve it/)
  assert.equal((await row(po.poId)).approvedAt, null)

  for (const role of ['WAREHOUSE', 'FINANCE', 'READONLY', 'SUPPLIER']) {
    as(`other-${role}`, role)
    const denied = await approvePurchaseOrder(po.poId)
    assert.equal(denied.success, false, role)
    assert.match(denied.error ?? '', /missing permission purchasing\.approve/, role)
  }
  assert.equal((await row(po.poId)).approvedAt, null, 'no refusal approved anything')
})

test('an edit that raises the total, or changes the supplier, clears the approval; a lower total keeps it', SKIP, async () => {
  const { approvePurchaseOrder, updatePurchaseOrder, advancePoStatus } = await actions()
  const { db } = await import('@/lib/db')
  await setThreshold('100')
  const po = await draft('ap-edit', 30)
  as('approver-1', 'MANAGER')
  assert.equal((await approvePurchaseOrder(po.poId)).success, true)
  as('maker-1', 'MANAGER')

  const lower = await updatePurchaseOrder(po.poId, editQty(po, 28))
  assert.equal(lower.success, true, String(lower.error))
  assert.ok((await row(po.poId)).approvedAt, 'a lower total keeps the approval')

  const higher = await updatePurchaseOrder(po.poId, editQty(po, 40))
  assert.equal(higher.success, true, String(higher.error))
  const cleared = await row(po.poId)
  assert.equal(cleared.approvedAt, null)
  assert.equal(cleared.approvedById, null)
  const send = await advancePoStatus(po.poId, 'PO_SENT')
  assert.equal(send.success, false)
  assert.match(send.error ?? '', NEEDS_APPROVAL)
  assert.ok(await db.activityLog.findFirst({ where: { entityType: 'PURCHASE_ORDER', entityId: po.poId, action: 'approval_cleared' } }))

  // Supplier change.
  as('approver-1', 'MANAGER')
  assert.equal((await approvePurchaseOrder(po.poId)).success, true)
  as('maker-1', 'MANAGER')
  const supplier = await db.supplier.create({ data: { name: `${fixtures.uid()} other supplier`, currency: 'GBP' }, select: { id: true } })
  const moved = await updatePurchaseOrder(po.poId, editQty(po, 40, { supplierId: supplier.id }))
  assert.equal(moved.success, true, String(moved.error))
  assert.equal((await row(po.poId)).approvedAt, null, 'a supplier change clears the approval')
})

test('even if an approval were left in place, the send gate re-checks the snapshot (a total raised behind the approval does not send)', SKIP, async () => {
  const { approvePurchaseOrder, advancePoStatus } = await actions()
  const { db } = await import('@/lib/db')
  await setThreshold('100')
  const po = await draft('ap-snapshot', 30)
  as('approver-1', 'MANAGER')
  assert.equal((await approvePurchaseOrder(po.poId)).success, true)
  as('maker-1', 'MANAGER')
  // A write path that does not go through the edit action (a supplier quote, an FX rebase) moves the total.
  await db.purchaseOrder.update({ where: { id: po.poId }, data: { totalBase: '500', subtotalBase: '500' } })
  const send = await advancePoStatus(po.poId, 'PO_SENT')
  assert.equal(send.success, false)
  assert.match(send.error ?? '', NEEDS_APPROVAL)
})

test('concurrency: an approval racing an edit never leaves an approval that does not cover the order', SKIP, async () => {
  const { approvePurchaseOrder, updatePurchaseOrder, advancePoStatus } = await actions()
  const { db } = await import('@/lib/db')
  await setThreshold('100')

  // Arm 1: the approval takes the row lock first, then the raising edit. The edit clears it.
  const first = await draft('ap-race-a', 30)
  const [approveA, editA] = await raced(first.poId,
    async () => { as('approver-1', 'MANAGER'); return approvePurchaseOrder(first.poId) },
    async () => { as('maker-1', 'MANAGER'); return updatePurchaseOrder(first.poId, editQty(first, 40)) })
  assert.equal(approveA.success, true, String(approveA.error))
  assert.equal(editA.success, true, String(editA.error))
  const afterA = await row(first.poId)
  assert.equal(afterA.approvedAt, null, 'approve-then-edit: the edit cleared the approval')
  assert.equal(Number(afterA.totalBase), 200)

  // Arm 2: the raising edit takes the lock first, then the approval. The approval is of the EDITED order.
  const second = await draft('ap-race-b', 30)
  const [editB, approveB] = await raced(second.poId,
    async () => { as('maker-1', 'MANAGER'); return updatePurchaseOrder(second.poId, editQty(second, 40)) },
    async () => { as('approver-1', 'MANAGER'); return approvePurchaseOrder(second.poId) })
  assert.equal(editB.success, true, String(editB.error))
  assert.equal(approveB.success, true, String(approveB.error))
  const afterB = await row(second.poId)
  assert.ok(afterB.approvedAt)
  assert.equal(Number(afterB.approvedTotalBase), 200, 'the approval snapshots the edited total, not the one the approver was looking at')
  as('maker-1', 'MANAGER')
  assert.equal((await advancePoStatus(second.poId, 'PO_SENT')).success, true)

  // Arm 3: a send racing an approval. The send holds the lock first and is refused; the approval then lands.
  const third = await draft('ap-race-c', 30)
  const [sendC, approveC] = await raced(third.poId,
    async () => { as('maker-1', 'MANAGER'); return advancePoStatus(third.poId, 'PO_SENT') },
    async () => { as('approver-1', 'MANAGER'); return approvePurchaseOrder(third.poId) })
  assert.equal(sendC.success, false)
  assert.match(sendC.error ?? '', NEEDS_APPROVAL)
  assert.equal(approveC.success, true)
  assert.equal((await row(third.poId)).status, 'DRAFT')
  void db
})

// ---- ordered race helpers (the same shape as tests/concurrency/po-lifecycle.concurrent.test.ts) ----

type RawClient = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
  end: () => Promise<void>
}

async function rawSession(): Promise<RawClient> {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  return client as unknown as RawClient
}

async function waitForBlocked(probe: RawClient, count: number) {
  const deadline = Date.now() + 20_000
  for (;;) {
    const { rows } = await probe.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity a
        WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
          AND a.wait_event_type = 'Lock' AND a.query ILIKE '%purchase_orders%'`,
    )
    if (Number(rows[0]!.n) >= count) return
    if (Date.now() > deadline) throw new Error(`fewer than ${count} backends blocked on the purchase_orders row within the budget`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Hold the PO row, start `first` and see it blocked, start `second` and see it blocked, release: the lock queue makes `first` win. */
async function raced<A, B>(poId: string, first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
  const holder = await rawSession()
  const probe = await rawSession()
  try {
    await holder.query('BEGIN')
    await holder.query('SELECT id FROM purchase_orders WHERE id = $1 FOR UPDATE', [poId])
    const a = first()
    await waitForBlocked(probe, 1)
    const b = second()
    await waitForBlocked(probe, 2)
    await holder.query('COMMIT')
    return [await a, await b]
  } finally {
    await holder.query('ROLLBACK').catch(() => {})
    await Promise.all([holder.end(), probe.end()])
  }
}
