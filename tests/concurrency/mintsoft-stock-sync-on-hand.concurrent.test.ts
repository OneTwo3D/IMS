import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import * as realRegistryNs from '@/lib/connectors/wms/registry'
import { normalizeMintsoftStockLevels } from '@/lib/connectors/mintsoft/api/normalizers'
import { PROBE_ROWS } from '@/tests/helpers/mintsoft-stock-probe-rows'

/**
 * o3d-4pzls — THE STOCK SYNC COMPARES IMS ON-HAND WITH MINTSOFT ON-HAND (TotalStockLevel), NOT AVAILABLE (Level).
 *
 * The real `runStockSyncForBinding` runs on a real PostgreSQL. Only the transport is a double: the
 * registry hands it a connector whose `fetchStockLevels` runs the REAL Mintsoft normaliser over rows
 * copied from the live probe (no network). IMS holds each SKU's ON-HAND figure (TotalStockLevel), so a
 * sync that reads on-hand finds ZERO discrepancies; one that reads Level finds a discrepancy on every
 * SKU where units are allocated (4 of the 5 probe rows) and records the wrong externalQty snapshot.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {}, logActivityInTransaction: async () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

let responseBody: unknown = []
const connectorDouble = {
  id: 'mintsoft',
  fetchStockLevels: async () => normalizeMintsoftStockLevels(responseBody),
}
mock.module('@/lib/connectors/wms/registry', {
  namedExports: { ...realRegistryNs, getWmsConnector: () => connectorDouble },
})

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

async function seed(prefix: string, imsQuantityOf: (row: { Level: number; TotalStockLevel: number }) => number) {
  const { db } = await import('@/lib/db')
  const uid = randomUUID().replace(/-/g, '')
  const warehouse = await db.warehouse.create({ data: { code: `${uid}-${prefix}`, name: `${prefix} wh`, type: 'STANDARD' }, select: { id: true } })
  const connection = await db.wmsConnection.create({ data: { connector: 'mintsoft', label: `${uid}-${prefix}`, active: true }, select: { id: true } })
  const binding = await db.externalWmsBinding.create({
    data: { connectionId: connection.id, warehouseId: warehouse.id, connector: 'mintsoft', externalWarehouseId: `ext-${uid}`, active: true, stockSyncMode: 'NOTIFICATION_ONLY' },
    select: { id: true },
  })
  const productIds: Record<string, string> = {}
  const rows = PROBE_ROWS.map((row) => ({ ...row, SKU: `${uid}-${row.SKU}` }))
  for (const row of rows) {
    const product = await db.product.create({ data: { sku: row.SKU, name: `on-hand ${row.SKU}`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
    productIds[row.SKU] = product.id
    await db.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, quantity: String(imsQuantityOf(row)), reservedQty: '0' } })
  }
  return { db, warehouseId: warehouse.id, bindingId: binding.id, rows, productIds }
}

test('IMS on-hand == Mintsoft TotalStockLevel: the sync finds NO discrepancy and snapshots on-hand (not Level)', SKIP, async () => {
  loadEnv()
  const { runStockSyncForBinding } = await import('@/lib/connectors/mintsoft/sync/stock-sync')
  const s = await seed('match', (row) => row.TotalStockLevel)
  responseBody = s.rows
  const result = await runStockSyncForBinding(s.bindingId, 'test')
  assert.equal(result.status, 'SUCCEEDED', String(result.skippedReason))
  assert.equal(result.totalChecked, 5)
  assert.equal(result.matched, 5, 'every SKU matches on on-hand; Level would mismatch the 4 with allocated units')
  assert.equal(result.mismatched, 0)
  const open = await s.db.wmsStockDiscrepancy.findMany({ where: { warehouseId: s.warehouseId, status: 'OPEN' } })
  assert.deepEqual(open, [])
  const snapshots = await s.db.wmsStockSnapshot.findMany({ where: { warehouseId: s.warehouseId } })
  assert.equal(snapshots.length, 5)
  for (const row of s.rows) {
    const snap = snapshots.find((x) => x.productId === s.productIds[row.SKU])
    assert.equal(Number(snap?.externalQty), row.TotalStockLevel, `${row.SKU} externalQty is on-hand`)
  }
  const stock = await s.db.stockLevel.findMany({ where: { warehouseId: s.warehouseId } })
  for (const level of stock) {
    const row = s.rows.find((x) => s.productIds[x.SKU] === level.productId)!
    assert.equal(Number(level.quantity), row.TotalStockLevel, 'IMS stock untouched')
  }
})

test('IMS holding AVAILABLE (Level) is now the discrepancy: reported against on-hand with the on-hand wmsValue', SKIP, async () => {
  loadEnv()
  const { runStockSyncForBinding } = await import('@/lib/connectors/mintsoft/sync/stock-sync')
  const s = await seed('level', (row) => row.Level)
  responseBody = s.rows
  const result = await runStockSyncForBinding(s.bindingId, 'test')
  assert.equal(result.status, 'SUCCEEDED', String(result.skippedReason))
  assert.equal(result.mismatched, 4)
  assert.equal(result.matched, 1)
  const target = s.rows.find((r) => r.ProductId === 264511)!
  const disc = await s.db.wmsStockDiscrepancy.findFirst({ where: { warehouseId: s.warehouseId, productId: s.productIds[target.SKU], status: 'OPEN' } })
  assert.equal(disc?.wmsValue, '36')
  assert.equal(disc?.imsValue, '28')
  assert.equal(Number(disc?.delta), 8)
})

test('a response with a row lacking TotalStockLevel fails the whole run closed: nothing snapshotted, nothing flagged, IMS untouched', SKIP, async () => {
  loadEnv()
  const { runStockSyncForBinding } = await import('@/lib/connectors/mintsoft/sync/stock-sync')
  const s = await seed('closed', (row) => row.TotalStockLevel)
  const broken = s.rows.map((r) => ({ ...r }))
  delete (broken[2] as Partial<(typeof broken)[number]>).TotalStockLevel
  responseBody = broken
  const result = await runStockSyncForBinding(s.bindingId, 'test')
  assert.equal(result.status, 'FAILED')
  assert.match(String(result.skippedReason), /TotalStockLevel \(on hand\) is missing/)
  assert.equal(await s.db.wmsStockSnapshot.count({ where: { warehouseId: s.warehouseId } }), 0)
  assert.equal(await s.db.wmsStockDiscrepancy.count({ where: { warehouseId: s.warehouseId } }), 0)
  const stock = await s.db.stockLevel.findMany({ where: { warehouseId: s.warehouseId } })
  for (const level of stock) {
    assert.equal(Number(level.quantity), s.rows.find((x) => s.productIds[x.SKU] === level.productId)!.TotalStockLevel)
  }
})
