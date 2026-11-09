import './scratch-database-setup' // FIRST: refuses to load unless the scratch database was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import * as fixtures from './po-landed-fixtures'

/**
 * A manual purchase-order receipt is refused for a line that still has a LIVE warehouse ASN (the book-in goes through the
 * ASN), and the refusal is decided in the receipt's own transaction under the purchase_orders row lock.
 *
 * Every arm runs the real `receivePurchaseOrder` and `processBookedInEvent` over a real PostgreSQL. Mintsoft is never
 * contacted. Fixture identity is randomUUID entropy (CI shares one database and these rows stay).
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async () => {}, logActivityInTransaction: async () => {} },
})
mock.module('@/lib/fulfillment/backorder-allocator', { namedExports: { allocateBackordersForProducts: async () => ({}) } })
mock.module('@/lib/fulfillment/overallocation-rebalancer', { namedExports: { releaseOverallocations: async () => ({}) } })

const { loadEnv, enableStockReceiptPosting, seedPo, addAsn, receive, bookIn, snapshotOf } = fixtures

test.before(async () => {
  if (!RUN) return
  loadEnv()
  await enableStockReceiptPosting()
})

async function waitForReceiptBlockedBy(holderPid: number, timeoutMs = 20_000): Promise<number> {
  const { db } = await import('@/lib/db')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = await db.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND ${holderPid}::int = ANY (pg_blocking_pids(pid))
        AND query ILIKE '%purchase_orders%'`
    if (rows.length > 0) return rows[0]!.pid
    if (Date.now() > deadline) throw new Error(`no backend is blocked by pid ${holderPid} on a purchase_orders statement`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const MATRIX: Array<{ status: string; closed: boolean; refused: boolean; attempted?: boolean }> = [
  { status: 'CREATE_PENDING', closed: false, refused: false }, // never claimed: no remote ASN was ever requested
  { status: 'CREATE_PENDING', closed: false, refused: true, attempted: true }, // demoted from a claimed create: the warehouse may hold the ASN
  { status: 'CREATE_PENDING', closed: true, refused: false, attempted: true }, // ...unless the creator has since retired it
  { status: 'CREATE_IN_FLIGHT', closed: false, refused: true }, // the remote ASN may already exist
  { status: 'OPEN', closed: false, refused: true },
  { status: 'PARTIALLY_BOOKED_IN', closed: false, refused: true },
  { status: 'BOOKED_IN', closed: false, refused: true }, // mapped to an ASN the warehouse had already received: reconciliation still owed
  { status: 'BOOKED_IN', closed: true, refused: false },
  { status: 'OPEN', closed: true, refused: false }, // retired / discarded
  { status: 'PARTIALLY_BOOKED_IN', closed: true, refused: false },
]

for (const row of MATRIX) {
  test(`live-ASN guard: ${row.status}${row.closed ? ' (closed)' : ''}${row.attempted ? ' (claimed before)' : ''} -> manual receipt ${row.refused ? 'REFUSED' : 'allowed'}`, SKIP, async () => {
    const po = await seedPo(`g-${row.status.toLowerCase().slice(0, 8)}${row.closed ? 'c' : ''}${row.attempted ? 'a' : ''}`, [10])
    const line = po.lines[0]!
    await addAsn(po, line, { expectedQty: 10, status: row.status, closed: row.closed, attempted: row.attempted })
    const result = await receive(po, line, 4)
    const after = await snapshotOf(po, line)
    if (row.refused) {
      assert.equal(result.success, false)
      assert.match(result.error ?? '', /open warehouse ASN/)
      assert.match(result.error ?? '', /^Cannot receive by hand on /, 'the operator sees the plain message, not a stringified Error')
      assert.match(result.error ?? '', new RegExp(line.sku))
      assert.equal(after.stock, 0, 'a refusal moves no stock')
      assert.equal(after.qtyReceived, 0)
    } else {
      assert.equal(result.success, true, result.error)
      assert.equal(after.stock, 4)
    }
  })
}

test('live-ASN guard is per line: another line of the same order is still received by hand', SKIP, async () => {
  const po = await seedPo('g-perline', [10, 10])
  const [blocked, free] = [po.lines[0]!, po.lines[1]!]
  await addAsn(po, blocked, { expectedQty: 10 })
  const ok = await receive(po, free, 3)
  assert.equal(ok.success, true, ok.error)
  assert.equal((await snapshotOf(po, free)).stock, 3)
  const refused = await receive(po, blocked, 3)
  assert.equal(refused.success, false)
  assert.equal((await snapshotOf(po, blocked)).stock, 0)
})

test('live-ASN guard: a retry of a receipt that already committed still reports success (idempotency is checked first)', SKIP, async () => {
  const { receivePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const po = await seedPo('g-retry', [10])
  const line = po.lines[0]!
  const token = `tok-${fixtures.uid()}`
  const input = [{ poLineId: line.poLineId, qtyReceived: 4, warehouseId: po.warehouseId }]
  const first = await receivePurchaseOrder(po.poId, input, undefined, { idempotencyToken: token })
  assert.equal(first.success, true, first.error)
  await addAsn(po, line, { expectedQty: 6 })
  // The early read is skipped for a call with a token, and the in-transaction idempotency check runs BEFORE the refusal.
  const retry = await receivePurchaseOrder(po.poId, input, undefined, { idempotencyToken: token })
  assert.equal(retry.success, true, retry.error)
  assert.equal((await snapshotOf(po, line)).stock, 4, 'the retry never books a second 4')
  const fresh = await receivePurchaseOrder(po.poId, input, undefined, { idempotencyToken: `tok-${fixtures.uid()}` })
  assert.equal(fresh.success, false, 'a NEW receipt with a token is still refused, by the in-transaction check')
  assert.match(fresh.error ?? '', /open warehouse ASN/)
  assert.match(fresh.error ?? '', /^Cannot receive by hand on /, 'the in-transaction refusal reaches the operator as the plain message')
})

test('booked-in FIRST then manual receipt: the ASN closes, the remainder is received by hand, stock is added once each', SKIP, async () => {
  const po = await seedPo('g-bookfirst', [10])
  const line = po.lines[0]!
  const asn = await addAsn(po, line, { expectedQty: 6 })
  const refused = await receive(po, line, 4)
  assert.equal(refused.success, false, 'while the ASN is open the manual receipt is refused')
  assert.equal(await bookIn(asn, line, 6, 6), 'processed')
  assert.equal((await snapshotOf(po, line)).stock, 6)
  const rest = await receive(po, line, 4)
  assert.equal(rest.success, true, rest.error)
  assert.equal((await snapshotOf(po, line)).stock, 10)
})

// A receipt that starts while the ASN is still open is refused by its early read, so "booked-in commits while the receipt waits
// at the lock" cannot end in an acceptance; the arm that matters is the ASN appearing AFTER the early read (below). This arm pins
// that the two paths running together neither deadlock nor double-book, whichever commits first.
test('booked-in vs manual receipt RACE: no deadlock, and the stock always equals exactly what was accepted', SKIP, async () => {
  let refusedRuns = 0
  let acceptedRuns = 0
  for (let i = 0; i < 6; i += 1) {
    const po = await seedPo(`g-race${i}`, [10])
    const line = po.lines[0]!
    const asn = await addAsn(po, line, { expectedQty: 6 })
    const [booked, manual] = await Promise.all([bookIn(asn, line, 6, 6), receive(po, line, 4)])
    assert.equal(booked, 'processed')
    const after = await snapshotOf(po, line)
    if (manual.success) {
      acceptedRuns += 1
      assert.equal(after.stock, 10, 'booked-in won the PO lock: the ASN was closed, the manual 4 is the remainder')
    } else {
      refusedRuns += 1
      assert.match(manual.error ?? '', /open warehouse ASN/)
      assert.equal(after.stock, 6, 'the receipt won the PO lock: it was refused and only the book-in added stock')
    }
  }
  console.log(`# live-ASN race: ${acceptedRuns} accepted after the book-in, ${refusedRuns} refused`)
})

test('ASN creation vs manual receipt: an ASN committed while the receipt waits for the PO lock refuses it', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const po = await seedPo('g-asnwins', [10])
  const line = po.lines[0]!
  let receipt: Promise<{ success: boolean; error?: string }> | null = null
  await db.$transaction(async (tx) => {
    // The ASN creators lock the parent first. Hold it: the receipt passes its unlocked early check (no ASN yet) and
    // then WAITS for this lock inside its transaction.
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${po.poId} FOR UPDATE`
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
    receipt = receive(po, line, 4)
    await waitForReceiptBlockedBy(pid)
    await tx.wmsAsnMap.create({
      data: {
        connector: 'mintsoft', // wms-connector-boundary-ok: a test fixture row, not a core flow branch
        externalAsnId: `${fixtures.uid()}-g-asn`,
        sourceType: 'PURCHASE_ORDER',
        sourceId: po.poId,
        warehouseId: po.warehouseId,
        status: 'OPEN',
        lines: { create: [{ externalAsnLineId: `${fixtures.uid()}-1`, sourceType: 'PURCHASE_ORDER_LINE', sourceLineId: line.poLineId, productId: line.productId, sku: line.sku, expectedQty: '10.0000' }] },
      },
    })
  }, { timeout: 30_000 })
  const result = await receipt!
  assert.equal(result.success, false, 'the in-transaction read sees the ASN the creator just committed')
  assert.match(result.error ?? '', /open warehouse ASN/)
  assert.equal((await snapshotOf(po, line)).stock, 0)
})

test('manual receipt FIRST, then ASN creation: the receipt stands (the creator sizes against it)', SKIP, async () => {
  const po = await seedPo('g-receiptwins', [10])
  const line = po.lines[0]!
  const ok = await receive(po, line, 4)
  assert.equal(ok.success, true, ok.error)
  const asn = await addAsn(po, line, { expectedQty: 6 })
  // What the ASN creators record under the PO lock: the units already received by hand and not yet reconciled.
  const { db } = await import('@/lib/db')
  await db.wmsAsnLineMap.update({ where: { id: asn.asnLineMapId }, data: { manualQtyBaseline: '4.0000' } })
  assert.equal(await bookIn(asn, line, 6, 6), 'processed')
  assert.equal((await snapshotOf(po, line)).stock, 10, 'no double entry for the manual 4')
})

/** The one data statement of the migration that introduced remoteCreateAttemptedAt, read from the file so the test cannot drift from it. */
async function legacyStampStatement(): Promise<string> {
  const { readFileSync } = await import('node:fs')
  const sql = readFileSync('prisma/migrations/20261109120000_wms_asn_remote_create_attempted/migration.sql', 'utf8')
  const statement = sql.split('\n').find((line) => line.startsWith('UPDATE "wms_asn_maps" SET "remoteCreateAttemptedAt"'))
  assert.ok(statement, 'the migration stamps existing unclosed CREATE_PENDING rows')
  return statement!
}

test('migration: a LEGACY CREATE_PENDING row (no stamp, from the previous build) blocks a manual receipt once the migration has stamped it; closed and other rows are untouched', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const legacy = await seedPo('g-legacy', [10])
  const legacyLine = legacy.lines[0]!
  const legacyAsn = await addAsn(legacy, legacyLine, { expectedQty: 10, status: 'CREATE_PENDING' })
  const closedPo = await seedPo('g-legacyc', [10])
  const closedAsn = await addAsn(closedPo, closedPo.lines[0]!, { expectedQty: 10, status: 'CREATE_PENDING', closed: true })
  const openPo = await seedPo('g-legacyo', [10])
  const openAsn = await addAsn(openPo, openPo.lines[0]!, { expectedQty: 10, status: 'OPEN' })

  // BEFORE the migration's UPDATE the legacy row reads as never claimed (the gap the statement closes).
  const stampOf = async (asnId: string) => (await db.wmsAsnMap.findUniqueOrThrow({ where: { id: asnId }, select: { remoteCreateAttemptedAt: true } })).remoteCreateAttemptedAt
  assert.equal(await stampOf(legacyAsn.asnId), null)

  await db.$executeRawUnsafe(await legacyStampStatement())

  assert.notEqual(await stampOf(legacyAsn.asnId), null, 'the unclosed CREATE_PENDING row is stamped')
  assert.equal(await stampOf(closedAsn.asnId), null, 'a closed row is untouched')
  assert.equal(await stampOf(openAsn.asnId), null, 'a row in another status is untouched')
  const refused = await receive(legacy, legacyLine, 4)
  assert.equal(refused.success, false, 'the legacy reservation now blocks the manual receipt')
  assert.match(refused.error ?? '', /open warehouse ASN/)
  assert.equal((await snapshotOf(legacy, legacyLine)).stock, 0)
})
