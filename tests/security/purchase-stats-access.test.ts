import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { before, mock } from 'node:test'

import { createRecordingDb } from './recording-db'

/**
 * /analytics/purchase-stats and its server actions returned supplier names and unit/landed costs to any
 * role holding `analytics` (READONLY included). The same Admin/Manager/Finance policy as the other
 * purchasing analytics now applies to the page, to every purchase-stats action, and to the po_* report
 * types of the analytics CSV export.
 */

type Role = 'ADMIN' | 'MANAGER' | 'FINANCE' | 'WAREHOUSE' | 'READONLY' | 'SUPPLIER'
let currentRole: Role = 'ADMIN'

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({ user: { id: 'u1', email: 'u@example.test', name: 'U', role: currentRole } }),
  },
})
const recorder = createRecordingDb([])
mock.module('@/lib/db', { namedExports: { db: recorder.db } })

const ACTIONS = ['getPurchaseProductStats', 'getReceivedGoods', 'getPurchaseBills', 'getSupplierAging', 'getPurchaseDetails'] as const

before(async () => {
  currentRole = 'FINANCE'
  const mod = await import('@/app/actions/purchase-stats')
  await recorder.prove(async () => { try { await mod.getReceivedGoods() } catch { /* shape of the empty result is not the point */ } })
})

for (const name of ACTIONS) {
  for (const role of ['READONLY', 'WAREHOUSE', 'SUPPLIER'] as const) {
    test(`${name} refuses a ${role} session without reading`, async () => {
      currentRole = role
      recorder.reset()
      const mod = await import('@/app/actions/purchase-stats')
      await assert.rejects(() => mod[name](), /Forbidden/)
      recorder.assertNoReads(`${role} calling ${name}`)
    })
  }
}

test('the purchase-stats page redirects READONLY before loading anything', async () => {
  currentRole = 'READONLY'
  recorder.reset()
  const { default: Page } = await import('@/app/(dashboard)/analytics/purchase-stats/page')
  await assert.rejects(() => Page(), (e: unknown) => e instanceof Error && /NEXT_REDIRECT/.test(`${e.message} ${(e as { digest?: string }).digest ?? ''}`))
  recorder.assertNoReads('READONLY opening /analytics/purchase-stats')
})

test('the analytics CSV export refuses po_* report types for READONLY and still serves other types', async () => {
  const { GET } = await import('@/app/api/export/analytics/route')
  const { NextRequest } = await import('next/server')
  currentRole = 'READONLY'
  for (const type of ['po_products', 'po_received', 'po_bills', 'po_aging', 'po_details']) {
    recorder.reset()
    const res = await GET(new NextRequest(`https://ims.test/api/export/analytics?type=${type}`))
    assert.equal(res.status, 403, type)
    recorder.assertNoReads(`READONLY exporting ${type}`)
  }
})

test('every exported purchase-stats action is behind the purchasing gate', () => {
  const source = readFileSync(join(process.cwd(), 'app/actions/purchase-stats.ts'), 'utf8')
  const total = [...source.matchAll(/export async function/g)].length
  const gated = [...source.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{\n\s*assertPurchasingAnalyticsAccess\(\(await requirePermission\('analytics'\)\)\.user\.role\)/g)]
  assert.equal(gated.length, total, 'an exported action does not open with the purchasing gate')
})
