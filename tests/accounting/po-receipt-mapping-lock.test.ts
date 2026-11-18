/**
 * o3d-nne7i: a manual purchase-order receipt posts its STOCK_RECEIPT journal on the account codes read INSIDE its transaction, under the accounting
 * mapping lock, not on the pooled pre-transaction read. Real scratch PostgreSQL, real `receivePurchaseOrder`; Xero is never reached (the outbox is
 * only read) and the network is blocked by the harness.
 *
 * The arm holds the mapping lock from a second connection, remaps the inventory account and commits while the receipt is in flight. Before the
 * fix the receipt never waited and queued the OLD code; now it waits for the lock and queues the NEW one.
 * [mutation: restore the pooled `accountingSettings.inventoryAccount` / `transitAccount` in the receipt payload, or drop the lock call]
 */
import assert from 'node:assert/strict'
import test, { after, before, mock } from 'node:test'
import { startScratch, type Scratch } from '../first-load/apply-scratch'

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/connectors/xero/books-lock-date', { namedExports: { refreshXeroBooksLockDate: async () => ({ lockDate: null, refreshed: false }) } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

let s: Scratch

before(async () => { s = await startScratch('ims-po-map-lock') })
after(async () => { await s?.stop() })

test('a remap committed while the manual receipt is in flight is posted on the NEW codes (o3d-nne7i)', async () => {
  const { createPurchaseOrder, receivePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const settings: Array<[string, string]> = [
    ['plugin_xero_enabled', 'true'], ['xero_sync_enabled', 'true'], ['xero_sync_stock_receipt', 'submitted'],
    ['xero_inventory_account', '630'], ['xero_transit_account', '631'],
  ]
  for (const [key, value] of settings) await s.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  const productId = (await s.db.product.create({ data: { sku: 'MAPLOCK-1', name: 'Map lock 1', type: 'SIMPLE' }, select: { id: true } })).id
  const supplierId = (await s.db.supplier.create({ data: { name: 'Map lock supplier', currency: 'GBP', prepaid: false }, select: { id: true } })).id
  const warehouseId = (await s.db.warehouse.findFirstOrThrow({ where: { availableForSale: true }, select: { id: true } })).id
  const reference = `MAPLOCK-PO-${Date.now()}`
  const created = await createPurchaseOrder({
    reference, supplierId, currency: 'GBP', destinationWarehouseId: warehouseId, pricesIncludeVat: false, taxRateValue: 0,
    lines: [{ productId, sku: 'MAPLOCK-1', productName: 'Map lock 1', qty: 10, unitCostForeign: 5 }],
  } as never)
  assert.equal(created.success, true, String(created.error))
  const po = await s.db.purchaseOrder.findUniqueOrThrow({ where: { reference }, select: { id: true, lines: { select: { id: true } } } })
  await s.db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PO_SENT' } })

  // A first receipt on the OLD mapping: it warms the action's lazy imports (so the timing below is the lock, not a cold start) and is the control.
  const first = await receivePurchaseOrder(po.id, [{ poLineId: po.lines[0]!.id, qtyReceived: 1, warehouseId }])
  assert.equal(first.success, true, first.error)
  // The holder is its OWN connection (a second connection that holds the accounting selection lock).
  const { Client } = await import('pg')
  const { ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY } = await import('@/lib/db/advisory-locks')
  const holder = new Client({ connectionString: s.url })
  await holder.connect()
  let receipt: Promise<{ success: boolean; error?: string }>
  try {
    await holder.query('BEGIN')
    await holder.query('SELECT pg_advisory_xact_lock($1)', [String(ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY)])
    const { rows: [{ pid }] } = await holder.query('SELECT pg_backend_pid() AS pid')
    receipt = receivePurchaseOrder(po.id, [{ poLineId: po.lines[0]!.id, qtyReceived: 4, warehouseId }])
    let settled: { success: boolean; error?: string } | null = null
    void receipt.then((value) => { settled = value })
    // The receipt must come to WAIT on the lock the holder has. Before the fix it did not, and committed on the old codes.
    const deadline = Date.now() + 20_000
    for (;;) {
      if (settled) throw new Error(`the receipt finished without waiting on the accounting mapping lock: ${JSON.stringify(settled)}`)
      const { rows } = await holder.query(
        `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND $1::int = ANY (pg_blocking_pids(pid))`,
        [pid],
      )
      if (rows.length > 0) break
      if (Date.now() > deadline) {
        const act = await holder.query(`SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers, left(query, 100) AS q FROM pg_stat_activity WHERE datname = current_database()`)
        throw new Error(`the receipt never waited on the accounting mapping lock; holder ${pid}; ${JSON.stringify(act.rows)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await holder.query(`UPDATE settings SET value = '640' WHERE key = 'xero_inventory_account'`)
    await holder.query('COMMIT')
  } finally {
    await holder.end()
  }

  const result = await receipt!
  assert.equal(result.success, true, result.error)
  const rows = await s.db.accountingSyncLog.findMany({ where: { type: 'STOCK_RECEIPT', referenceId: po.id }, orderBy: { createdAt: 'asc' }, select: { payload: true } })
  assert.equal(rows.length, 2)
  type Lines = { lines: Array<{ accountCode: string; debit?: number; credit?: number }> }
  assert.equal((rows[0]!.payload as Lines).lines.find((l) => l.debit)?.accountCode, '630', 'control: the first receipt posted on the mapping then in force')
  const lines = (rows[1]!.payload as Lines).lines
  assert.equal(lines.find((l) => l.debit)?.accountCode, '640', 'the inventory debit is on the code committed before this transaction read it')
  assert.equal(lines.find((l) => l.credit)?.accountCode, '631')
})
