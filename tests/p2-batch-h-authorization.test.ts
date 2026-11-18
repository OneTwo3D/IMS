import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

// Regression tests for the P2 authorization batch H: stock adjustment edit scope, inventory.prices
// enforcement (product write, product read, CSV import), and write gates on forecast settings and shared views.

type Role = 'ADMIN' | 'MANAGER' | 'WAREHOUSE' | 'FINANCE' | 'READONLY'
let role: Role = 'READONLY'
const writes: string[] = []
let movementType = 'DISPATCH'

import { hasPermission } from '@/lib/permissions'

mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: {
    
    requireInternalUser: async () => ({ user: { id: 'u1', role } }),
    requirePermission: async (permission: Parameters<typeof hasPermission>[1]) => {
      if (!hasPermission(role, permission)) throw new Error(`Forbidden: missing permission ${permission}`)
      return { user: { id: 'u1', role } }
    },
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => { writes.push('log') } } })

const tx = {
  stockMovement: {
    findUnique: async () => ({
      id: 'm1', type: movementType, productId: 'p1', fromWarehouseId: 'w1', toWarehouseId: null,
      qty: 5, createdAt: new Date(), cogsEntries: [], adjustmentLayers: [],
    }),
    update: async () => { writes.push('movement.update') },
    count: async () => { writes.push('count'); return 0 },
  },
}
const db = new Proxy({
  $transaction: async (arg: unknown) => (typeof arg === 'function' ? (arg as (t: unknown) => unknown)(tx) : arg),
  setting: {
    findUnique: async () => null,
    upsert: async () => { writes.push('setting.upsert'); return {} },
  },
}, { get: (target, key) => (key in target ? (target as Record<string | symbol, unknown>)[key] : new Proxy({}, { get: () => async () => { writes.push('other-db') ; return null } })) })
mock.module('@/lib/db', { namedExports: { db } })

test('SEC-M11: updateAdjustmentMovement refuses a non-ADJUSTMENT movement', async () => {
  const { updateAdjustmentMovement } = await import('@/app/actions/stock')
  role = 'WAREHOUSE'
  movementType = 'DISPATCH'
  writes.length = 0
  const res = await updateAdjustmentMovement('m1', 9, 'x')
  assert.ok(res.message && /adjustment/i.test(res.message), JSON.stringify(res))
  assert.ok(!res.success)
  assert.deepEqual(writes.filter((w) => w !== 'log'), [])
})

test('SEC-M14: READONLY cannot save forecast settings, shared views or delete a view', async () => {
  const { saveForecastSettings } = await import('@/app/actions/forecasting')
  const { saveView, deleteView } = await import('@/app/actions/sales-stats')
  role = 'READONLY'
  writes.length = 0
  await assert.rejects(() => saveForecastSettings({
    serviceLevelPercent: 95, defaultLeadTimeDays: 14, reviewPeriodDays: 90, reorderQtyWeeks: 8, retentionMonths: 1,
  }), /Forbidden/)
  await assert.rejects(() => saveView({ id: 'v', name: 'n', tab: 't', columns: [], filters: [] }), /Forbidden/)
  await assert.rejects(() => deleteView('v'), /Forbidden/)
  assert.deepEqual(writes, [])
})

test('SEC-M14: a role that creates purchase orders can still save forecast settings', async () => {
  const { saveForecastSettings } = await import('@/app/actions/forecasting')
  role = 'MANAGER'
  writes.length = 0
  await saveForecastSettings({ serviceLevelPercent: 95, defaultLeadTimeDays: 14, reviewPeriodDays: 90, reorderQtyWeeks: 8, retentionMonths: 24 })
  assert.ok(writes.includes('setting.upsert'))
})

test('SEC-M13: a CSV import carrying price values is refused without inventory.prices, before any db access', async () => {
  const { importProductsCsv } = await import('@/app/actions/import')
  role = 'WAREHOUSE'
  writes.length = 0
  const fd = new FormData()
  fd.set('file', new File(['sku,name,type,salesPriceBase\nA1,Thing,SIMPLE,12.50\n'], 'p.csv', { type: 'text/csv' }))
  const res = await importProductsCsv(fd) as { success?: boolean; error?: string; errors?: string[] }
  assert.ok(JSON.stringify(res).includes('inventory.prices'), JSON.stringify(res))
  assert.deepEqual(writes, [])
})

test('SEC-M13: product reads and writes are gated on inventory.prices (source wiring)', () => {
  const src = readFileSync('app/actions/products.ts', 'utf8')
  assert.equal((src.match(/const canEditPrices = hasPermission\(session\.user\.role, 'inventory\.prices'\)/g) ?? []).length, 2)
  assert.equal((src.match(/const canSeePrices = hasPermission\(session\.user\.role, 'inventory\.prices'\)/g) ?? []).length, 2)
  assert.ok(!/salesPriceBase: p\.salesPriceBase\?\.toString\(\) \?\? null/.test(src), 'ungated list/detail price read')
  assert.ok(!/salesPriceBase: v\.salesPriceBase\?\.toString\(\) \?\? null/.test(src), 'ungated variant price read')
  assert.ok(!/^ {8}salesPriceBase: data\.salesPriceBase/m.test(src), 'ungated price write')
})

test('inventory.prices: WAREHOUSE lacks it, FINANCE and MANAGER hold it', () => {
  assert.equal(hasPermission('WAREHOUSE', 'inventory.prices'), false)
  assert.equal(hasPermission('FINANCE', 'inventory.prices'), true)
  assert.equal(hasPermission('MANAGER', 'inventory.prices'), true)
})
