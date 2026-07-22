import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { PRE_COMMITMENT_PO_STATUSES } from '@/lib/domain/inventory/po-status-sets'

// o3d-27l: getPurchaseProductStats must count only COMMITTED purchase history — the pre-commitment
// quote pipeline (DRAFT/RFQ_SENT/QUOTE_RECEIVED) and CANCELLED must not appear, so every column
// (Qty Ordered, spend, avg cost, Incoming) shares one committed population.

mock.module('@/lib/auth/server', {
  namedExports: { requirePermission: async () => ({ user: { id: 'u1' } }) },
})

function po(status: string, sku: string) {
  return {
    id: `po-${sku}`, supplierId: 'sup-1', createdAt: new Date('2026-01-01T00:00:00Z'),
    status,
    supplier: { name: 'Acme' },
    lines: [{
      productId: `prod-${sku}`, qty: 10, qtyReceived: 0, qtyReturned: 0,
      totalBase: 100, landedUnitCostBase: 0,
      product: { sku, name: `Product ${sku}`, type: 'SIMPLE', stockUnit: 'ea', barcode: null, mpn: null },
    }],
  }
}

const ALL_POS = [
  po('DRAFT', 'DRAFT-SKU'),
  po('RFQ_SENT', 'RFQ-SKU'),
  po('QUOTE_RECEIVED', 'QUOTE-SKU'),
  po('CANCELLED', 'CANCELLED-SKU'),
  po('PO_SENT', 'SENT-SKU'),
  po('SHIPPED', 'SHIPPED-SKU'),
  po('PARTIALLY_RECEIVED', 'PARTIAL-SKU'),
  po('RECEIVED', 'RECEIVED-SKU'),
  po('CLOSED', 'CLOSED-SKU'),
]

let lastWhere: Record<string, unknown> | undefined

mock.module('@/lib/db', {
  namedExports: {
    db: {
      purchaseOrder: {
        // Apply the where.status.notIn filter the way Prisma would, so the test exercises
        // the real filter the action passes rather than trusting it blindly.
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          lastWhere = where
          const notIn = ((where.status as { notIn?: string[] })?.notIn) ?? []
          return ALL_POS.filter((p) => p.status && !notIn.includes(p.status))
        },
      },
    },
  },
})

async function loadStats() {
  return (await import('@/app/actions/purchase-stats')).getPurchaseProductStats
}

test('the query excludes the pre-commitment quote pipeline and CANCELLED (o3d-27l)', async () => {
  const getPurchaseProductStats = await loadStats()
  const rows = await getPurchaseProductStats()

  const skus = rows.map((r) => r.sku).sort()
  assert.deepEqual(
    skus,
    ['CLOSED-SKU', 'PARTIAL-SKU', 'RECEIVED-SKU', 'SENT-SKU', 'SHIPPED-SKU'].sort(),
    'only committed statuses appear; RFQ/QUOTE/DRAFT/CANCELLED are excluded',
  )

  // The action must actually pass the pre-commitment statuses to the query.
  const notIn = (lastWhere?.status as { notIn?: string[] })?.notIn ?? []
  for (const s of PRE_COMMITMENT_PO_STATUSES) {
    assert.ok(notIn.includes(s), `where.status.notIn must exclude ${s}`)
  }
  assert.ok(notIn.includes('CANCELLED'), 'CANCELLED must remain excluded')
})

test('PRE_COMMITMENT_PO_STATUSES is exactly the not-yet-ordered set', () => {
  assert.deepEqual(
    [...PRE_COMMITMENT_PO_STATUSES].sort(),
    ['DRAFT', 'QUOTE_RECEIVED', 'RFQ_SENT'],
  )
})
