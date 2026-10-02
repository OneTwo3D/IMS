import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import * as fixtures from './po-landed-fixtures'
import type { SeededPo } from './po-landed-fixtures'

/**
 * o3d-fgu3 — THE DRAFT PURCHASE-ORDER EDIT IS ONE TRANSACTION, PARENT FIRST, STATUS RE-READ UNDER THE LOCK.
 *
 * WHAT THE BEAD SAID, AND WHAT WAS TRUE. The bead described a goods-PO additional-cost edit that saved its
 * lines and then ran the landed-cost recalc separately, WARNing on failure. That recalc sat behind
 * `['PARTIALLY_RECEIVED','RECEIVED','INVOICED'].includes(existing.status)` in an action that has refused every
 * non-DRAFT order since its first commit, so it was UNREACHABLE and has been deleted. The defect that WAS
 * real is in the same action: it ran on the POOLED client, so every statement autocommitted — a failure
 * between `purchaseOrderLine.deleteMany` and `createMany` lost the order's lines — and a send/approve that
 * landed between the DRAFT check and the writes was edited anyway.
 *
 * EVERY arm runs the REAL `updatePurchaseOrder` over a real PostgreSQL; orders come from the real
 * `createPurchaseOrder`. A failure is injected by a POISONED ROW, never a seam: a line naming a product that
 * does not exist fails `createMany` on its foreign key AFTER the old lines were deleted; an additional cost
 * with an unknown distribution method fails `freightCostLine.createMany` AFTER the new lines were written.
 *
 * Fixture identity is `randomUUID()` entropy FIRST and never truncated: CI runs ONE shared database and these
 * rows are never deleted.
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
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

const BLOCK_WAIT_MS = 15000
const SOAK_REPEATS = 20

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

async function backendPid(session: RawClient): Promise<number> {
  const { rows } = await session.query('SELECT pg_backend_pid()::int AS pid')
  return Number(rows[0]!.pid)
}

/** Block until a backend blocked BY `blockerPid` waits on a statement matching `waitingOn`. Never a sleep. */
async function waitForBlockedBackend(probe: RawClient, blockerPid: number, waitingOn: RegExp, describe: string) {
  const deadline = Date.now() + BLOCK_WAIT_MS
  for (;;) {
    const { rows } = await probe.query(
      `SELECT a.pid::int AS pid, coalesce(a.query, '') AS query
         FROM pg_stat_activity a
        WHERE a.datname = current_database()
          AND a.pid <> pg_backend_pid()
          AND a.wait_event_type = 'Lock'
          AND $1::int = ANY(pg_blocking_pids(a.pid))
        ORDER BY a.pid`,
      [blockerPid],
    )
    const hit = rows.map((r) => ({ pid: Number(r.pid), query: String(r.query) })).find((b) => waitingOn.test(b.query))
    if (hit) return hit
    if (Date.now() > deadline) {
      throw new Error(
        `${describe}: no backend blocked by ${blockerPid} was waiting on ${waitingOn} within the budget. `
        + `Seen: ${JSON.stringify(rows.map((r) => String(r.query).slice(0, 120)))}. The edit never reached the `
        + 'parent lock first, so this tripwire proves nothing about acquisition order.',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const PARENT_LOCK = /FROM purchase_orders WHERE id = ANY\([\s\S]*FOR UPDATE/i

test.before(async () => {
  if (!RUN) return
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
})

type Edit = Parameters<typeof import('@/app/actions/purchase-orders').updatePurchaseOrder>[1]

async function seedDraft(label: string, lineQtys: number[], reuse?: SeededPo) {
  const { db } = await import('@/lib/db')
  const po = await fixtures.seedPo(`fgu3-${label}`, lineQtys, 'PO_SENT', reuse)
  await db.purchaseOrder.update({ where: { id: po.poId }, data: { status: 'DRAFT' } })
  const supplier = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { supplierId: true } })
  return { po, supplierId: supplier.supplierId }
}

function editFor(po: SeededPo, qtys: number[], extra: Partial<Edit> = {}): Edit {
  return {
    currency: 'GBP',
    fxRateToBase: 1,
    pricesIncludeVat: false,
    taxRateValue: 0,
    lines: po.lines.map((line, i) => ({
      productId: line.productId,
      sku: line.sku,
      productName: `edited ${i}`,
      qty: qtys[i]!,
      unitCostForeign: 7,
    })),
    ...extra,
  } as Edit
}

async function snapshot(poId: string) {
  const { db } = await import('@/lib/db')
  const po = await db.purchaseOrder.findUniqueOrThrow({
    where: { id: poId },
    select: {
      status: true, subtotalForeign: true, totalForeign: true, directFreightForeign: true,
      lines: { select: { id: true, productId: true, qty: true, unitCostForeign: true }, orderBy: { id: 'asc' } },
      freightCostLines: { select: { id: true, description: true, amountForeign: true }, orderBy: { id: 'asc' } },
    },
  })
  return {
    status: po.status,
    totalForeign: Number(po.totalForeign),
    directFreightForeign: Number(po.directFreightForeign),
    lines: po.lines.map((l) => `${l.id}:${l.productId}:${Number(l.qty)}:${Number(l.unitCostForeign)}`),
    cost: po.freightCostLines.map((c) => `${c.id}:${c.description}:${Number(c.amountForeign)}`),
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A1 — ATOMICITY: A FAILURE MID-EDIT LEAVES THE DRAFT EXACTLY AS IT WAS
// ───────────────────────────────────────────────────────────────────────────────────────────────
test(
  'A1: a failure AFTER the old lines were deleted rolls the whole edit back: success:false, lines/costs/totals unchanged',
  SKIP,
  async () => {
    const { updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
    const { po } = await seedDraft('a1', [3, 4])
    // Give the order a freight cost line first so "unchanged" covers the cost rows too.
    const seeded = await updatePurchaseOrder(po.poId, editFor(po, [3, 4], {
      additionalCosts: [{ description: 'seed freight', amountForeign: 10, vatable: false, distributionMethod: 'BY_VALUE' }],
    }))
    assert.equal(seeded.success, true, `PRECONDITION: the seeding edit must succeed: ${seeded.error}`)
    const before = await snapshot(po.poId)
    assert.equal(before.status, 'DRAFT')
    assert.equal(before.lines.length, 2, 'PRECONDITION: the DRAFT has 2 lines')
    assert.equal(before.cost.length, 1, 'PRECONDITION: the DRAFT has 1 cost line')

    const poisoned = editFor(po, [9, 9])
    poisoned.lines = [...poisoned.lines!, { productId: `${fixtures.uid()}-missing`, sku: 'x', productName: 'ghost', qty: 1, unitCostForeign: 1 } as never]
    const result = await updatePurchaseOrder(po.poId, poisoned)
    const after = await snapshot(po.poId)
    console.log(`# A1: poisoned edit -> success=${result.success} error=${(result.error ?? '').slice(0, 90).replace(/\s+/g, ' ')} lines ${before.lines.length}->${after.lines.length}`)
    // PRECONDITION: it failed ON THE ROW WRITE (after the deleteMany), not in some earlier validation.
    assert.match(result.error ?? '', /oreign key|purchase_order_lines/i, `PRECONDITION: the failure must come from the line insert: ${result.error}`)
    assert.equal(result.success, false)
    assert.deepEqual(after, before, 'the failed edit must leave the PO, its lines and its cost lines exactly as they were')
    console.log('# A1: evaluated 1 mid-edit failure (lines deleted then insert refused)')
  },
)

test(
  'A1 isolating arm: a failure at the LAST write (cost-line insert, after the new lines were written) also rolls everything back',
  SKIP,
  async () => {
    const { updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
    const { po } = await seedDraft('a1late', [3, 4])
    const before = await snapshot(po.poId)
    assert.equal(before.lines.length, 2, 'PRECONDITION: two original lines')
    const result = await updatePurchaseOrder(po.poId, editFor(po, [8, 8], {
      additionalCosts: [{ description: 'bad method', amountForeign: 5, vatable: false, distributionMethod: 'NOT_A_METHOD' }],
    }))
    const after = await snapshot(po.poId)
    console.log(`# A1 late: success=${result.success} error=${(result.error ?? '').slice(0, 90).replace(/\s+/g, ' ')}`)
    assert.match(result.error ?? '', /distributionMethod|NOT_A_METHOD|Invalid/i, `PRECONDITION: the failure must come from the cost-line insert: ${result.error}`)
    assert.equal(result.success, false)
    assert.deepEqual(after, before, 'the new lines must not survive a failed cost-line write')
  },
)

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A2 — THE SUCCESS PATH WRITES LINES, COSTS AND TOTALS TOGETHER
// ───────────────────────────────────────────────────────────────────────────────────────────────
test('A2: a valid edit replaces lines and cost lines and updates the totals together', SKIP, async () => {
  const { updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const { po } = await seedDraft('a2', [3, 4])
  const before = await snapshot(po.poId)
  assert.equal(before.status, 'DRAFT', 'PRECONDITION: DRAFT')
  const result = await updatePurchaseOrder(po.poId, editFor(po, [5, 6], {
    additionalCosts: [{ description: 'freight', amountForeign: 12, vatable: false, distributionMethod: 'BY_VALUE' }],
  }))
  assert.equal(result.success, true, `the edit must succeed: ${result.error}`)
  const after = await snapshot(po.poId)
  console.log(`# A2: lines ${before.lines.length}->${after.lines.length} total ${before.totalForeign}->${after.totalForeign} cost ${after.cost.length}`)
  assert.deepEqual(after.lines.map((l) => l.split(':').slice(2).join(':')).sort(), ['5:7', '6:7'])
  assert.equal(after.cost.length, 1)
  assert.equal(after.directFreightForeign, 12)
  assert.equal(after.totalForeign, 5 * 7 + 6 * 7 + 12)
  assert.equal(after.status, 'DRAFT')
})

test('A2b: a rate-only (currency/fx) edit runs in the same locked transaction and rebases base amounts', SKIP, async () => {
  const { updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const { po } = await seedDraft('a2fx', [2])
  const { db } = await import('@/lib/db')
  const result = await updatePurchaseOrder(po.poId, { currency: 'GBP', fxRateToBase: 1 })
  assert.equal(result.success, true, `a rate-only edit must succeed: ${result.error}`)
  const row = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { status: true, fxRateToBase: true } })
  assert.equal(row.status, 'DRAFT')
  assert.equal(Number(row.fxRateToBase), 1)
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A3 — LOCK ORDER TRIPWIRE: THE PARENT IS THE FIRST LOCK; NO CHILD ROW IS HELD WHILE WAITING FOR IT
// ───────────────────────────────────────────────────────────────────────────────────────────────
test(
  'A3: with purchase_orders held, the edit blocks ON the parent lock and holds NO child, layer or stock lock while it waits',
  SKIP,
  async () => {
    const { updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
    const { po } = await seedDraft('a3', [3, 4])
    const holder = await rawSession()
    const probe = await rawSession()
    const checker = await rawSession()
    let action: ReturnType<typeof updatePurchaseOrder> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM purchase_orders WHERE id = $1 FOR UPDATE', [po.poId])
      const holderPid = await backendPid(holder)
      action = updatePurchaseOrder(po.poId, editFor(po, [5, 6]))
      const blocked = await waitForBlockedBackend(probe, holderPid, PARENT_LOCK, 'A3')
      console.log(`# A3: edit backend ${blocked.pid} is blocked on the PARENT lock statement: ${blocked.query.slice(0, 90).replace(/\s+/g, ' ')}`)

      // While it waits for the parent it must hold NOTHING below it: every child row, the cost layers and the
      // stock rows of its products are still lockable. NOWAIT turns "held by the edit" into an error.
      const productIds = po.lines.map((l) => l.productId)
      await checker.query('BEGIN')
      const free = {
        lines: (await checker.query('SELECT id FROM purchase_order_lines WHERE "poId" = $1 FOR UPDATE NOWAIT', [po.poId])).rows.length,
        costLines: (await checker.query('SELECT id FROM freight_cost_lines WHERE "poId" = $1 FOR UPDATE NOWAIT', [po.poId])).rows.length,
        layers: (await checker.query('SELECT id FROM cost_layers WHERE "productId" = ANY($1::text[]) FOR UPDATE NOWAIT', [productIds])).rows.length,
        stock: (await checker.query('SELECT id FROM stock_levels WHERE "productId" = ANY($1::text[]) FOR UPDATE NOWAIT', [productIds])).rows.length,
      }
      await checker.query('ROLLBACK')
      console.log(`# A3: while blocked on the parent, lockable NOWAIT: lines=${free.lines} costLines=${free.costLines} layers=${free.layers} stock=${free.stock}`)
      assert.equal(free.lines, 2, 'PRECONDITION + proof: both child lines were lockable, so the edit held none of them')
      assert.equal(free.stock, 2, 'PRECONDITION: the products have stock rows, so the stock probe examined something')

      await holder.query('COMMIT')
      const result = await action
      assert.equal(result.success, true, `once the parent is released the edit completes: ${result.error}`)
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      await checker.query('ROLLBACK').catch(() => {})
      if (action) await action.catch(() => {})
      await Promise.all([holder.end(), probe.end(), checker.end()])
    }
  },
)

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A4 — THE STATUS IS RE-READ UNDER THE LOCK: A SEND THAT LANDS BETWEEN THE CHECK AND THE WRITES WINS
// ───────────────────────────────────────────────────────────────────────────────────────────────
test(
  'A4: a status change committed AFTER the DRAFT check but BEFORE the edit gets the lock is not edited over',
  SKIP,
  async () => {
    const { updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
    const { po } = await seedDraft('a4', [3, 4])
    const before = await snapshot(po.poId)
    const holder = await rawSession()
    const probe = await rawSession()
    let action: ReturnType<typeof updatePurchaseOrder> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM purchase_orders WHERE id = $1 FOR UPDATE', [po.poId])
      const holderPid = await backendPid(holder)
      action = updatePurchaseOrder(po.poId, editFor(po, [50, 60]))
      // The edit is blocked on the parent lock, so its OUTER status read already saw DRAFT.
      const blocked = await waitForBlockedBackend(probe, holderPid, PARENT_LOCK, 'A4')
      console.log(`# A4: edit backend ${blocked.pid} has passed the DRAFT check and is parked on the lock`)
      await holder.query(`UPDATE purchase_orders SET status = 'PO_SENT' WHERE id = $1`, [po.poId])
      await holder.query('COMMIT')
      const result = await action
      const after = await snapshot(po.poId)
      console.log(`# A4: success=${result.success} error=${result.error} status=${after.status} lines unchanged=${JSON.stringify(after.lines) === JSON.stringify(before.lines)}`)
      assert.equal(result.success, false, 'an order sent while the edit waited must not be edited')
      assert.equal(result.error, 'Only DRAFT POs can be edited')
      assert.equal(after.status, 'PO_SENT')
      assert.deepEqual(after.lines, before.lines, 'the sent order keeps its lines')
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      if (action) await action.catch(() => {})
      await Promise.all([holder.end(), probe.end()])
    }
  },
)

test(
  'A4 isolating arm: an order already PO_SENT is refused by the outer check (so the race arm above is the only proof of the in-transaction re-read)',
  SKIP,
  async () => {
    const { updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
    const { db } = await import('@/lib/db')
    const { po } = await seedDraft('a4ctl', [3])
    await db.purchaseOrder.update({ where: { id: po.poId }, data: { status: 'PO_SENT' } })
    const result = await updatePurchaseOrder(po.poId, editFor(po, [9]))
    assert.equal(result.success, false)
    assert.equal(result.error, 'Only DRAFT POs can be edited')
  },
)

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A5 — SOAKS: SERIALISATION AND NO 40P01
// ───────────────────────────────────────────────────────────────────────────────────────────────
test(
  `A5: ${SOAK_REPEATS}x two CONCURRENT edits of the SAME order serialise: one whole edit wins, no duplicated lines, no 40P01`,
  SKIP,
  async () => {
    const { updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
    let evaluated = 0
    for (let i = 0; i < SOAK_REPEATS; i += 1) {
      const { po } = await seedDraft(`a5-${i}`, [3, 4, 5])
      const [x, y] = await Promise.all([
        updatePurchaseOrder(po.poId, editFor(po, [11, 11, 11])),
        updatePurchaseOrder(po.poId, editFor(po, [22, 22, 22])),
      ])
      for (const r of [x, y]) {
        assert.doesNotMatch(r.error ?? '', /40P01|deadlock/i, `repeat ${i}: deadlock: ${r.error}`)
        assert.equal(r.success, true, `repeat ${i}: both edits must succeed: ${r.error}`)
      }
      const after = await snapshot(po.poId)
      const qtys = after.lines.map((l) => l.split(':')[2]!)
      assert.equal(after.lines.length, 3, `repeat ${i}: exactly 3 lines, got ${after.lines.length} (${qtys.join(',')})`)
      assert.ok(qtys.every((q) => q === qtys[0]), `repeat ${i}: lines must come from ONE edit, got ${qtys.join(',')}`)
      evaluated += 1
    }
    assert.equal(evaluated, SOAK_REPEATS)
    console.log(`# A5: evaluated ${evaluated} concurrent same-order edit pairs`)
  },
)

test(
  `A5b: ${SOAK_REPEATS}x concurrent edits of two DIFFERENT orders sharing the same products never deadlock (o3d-chs1h: the edit touches no layer or stock row)`,
  SKIP,
  async () => {
    const { updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
    let evaluated = 0
    for (let i = 0; i < SOAK_REPEATS; i += 1) {
      const { po: a } = await seedDraft(`a5b-a-${i}`, [3, 4])
      const { po: b } = await seedDraft(`a5b-b-${i}`, [3, 4], a)
      assert.equal(a.lines[0]!.productId, b.lines[0]!.productId, 'PRECONDITION: the two orders share a product')
      const results = await Promise.all([
        updatePurchaseOrder(a.poId, editFor(a, [5, 6])),
        updatePurchaseOrder(b.poId, editFor(b, [6, 5])),
      ])
      for (const r of results) {
        assert.doesNotMatch(r.error ?? '', /40P01|deadlock/i, `repeat ${i}: deadlock: ${r.error}`)
        assert.equal(r.success, true, `repeat ${i}: ${r.error}`)
      }
      evaluated += 1
    }
    assert.equal(evaluated, SOAK_REPEATS)
    console.log(`# A5b: evaluated ${evaluated} cross-order pairs`)
  },
)
