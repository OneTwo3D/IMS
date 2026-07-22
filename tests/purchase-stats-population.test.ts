import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import {
  COMMITTED_PURCHASE_ORDER_WHERE,
  ORDERED_EVIDENCE_PO_STATUSES,
} from '@/lib/domain/inventory/po-status-sets'

// o3d-27l: getPurchaseProductStats must count only COMMITTED purchase history — a PO that was actually
// ordered (poSentAt stamped, or a status that proves an order), never the DRAFT/RFQ_SENT/QUOTE_RECEIVED
// quote pipeline, a quote abandoned straight to CLOSED, or a CANCELLED PO. Incoming is gated to the
// still-incoming statuses so a terminal PO carries no phantom balance.

mock.module('@/lib/auth/server', {
  namedExports: { requirePermission: async () => ({ user: { id: 'u1' } }) },
})

// A minimal, faithful evaluator of the WHERE the action actually passes, so the test exercises the
// real filter rather than a hard-coded copy. Supports the shape COMMITTED_PURCHASE_ORDER_WHERE emits
// (type, status.not, OR[{poSentAt.not:null},{status.in}]).
type WhereShape = {
  type?: string
  status?: { not?: string; in?: string[] }
  OR?: Array<{ poSentAt?: { not?: null }; status?: { in?: string[] } }>
}
type PoShape = { type: string; status: string; poSentAt: Date | null }

function matchesWhere(where: WhereShape, po: PoShape): boolean {
  if (where.type && po.type !== where.type) return false
  if (where.status?.not && po.status === where.status.not) return false
  if (Array.isArray(where.OR)) {
    const ok = where.OR.some((clause) => {
      if (clause.poSentAt && clause.poSentAt.not === null) return po.poSentAt != null
      if (clause.status?.in) return clause.status.in.includes(po.status)
      return false
    })
    if (!ok) return false
  }
  return true
}

function po(sku: string, status: string, poSentAt: Date | null, qtyReceived = 0) {
  return {
    id: `po-${sku}`, supplierId: 'sup-1', createdAt: new Date('2026-01-01T00:00:00Z'),
    type: 'GOODS', status, poSentAt,
    supplier: { name: 'Acme' },
    lines: [{
      productId: `prod-${sku}`, qty: 10, qtyReceived, qtyReturned: 0,
      totalBase: 100, landedUnitCostBase: 0,
      product: { sku, name: `Product ${sku}`, type: 'SIMPLE', stockUnit: 'ea', barcode: null, mpn: null },
    }],
  }
}

const SENT = new Date('2026-01-02T00:00:00Z')
const ALL_POS = [
  po('DRAFT', 'DRAFT', null),                         // pre-commit -> excluded
  po('RFQ', 'RFQ_SENT', null),                        // pre-commit -> excluded
  po('QUOTE', 'QUOTE_RECEIVED', null),                // pre-commit -> excluded
  po('CANCELLED', 'CANCELLED', SENT),                 // sent then cancelled -> excluded
  po('CLOSED-RFQ', 'CLOSED', null),                   // abandoned quote (RFQ->CLOSED) -> EXCLUDED (o3d-27l F1)
  po('CLOSED-SENT', 'CLOSED', SENT),                  // real PO_SENT->CLOSED -> included
  po('SENT', 'PO_SENT', SENT),                        // incoming -> included
  po('SHIPPED', 'SHIPPED', SENT),                     // incoming -> included
  po('PARTIAL', 'PARTIALLY_RECEIVED', SENT),          // incoming -> included
  po('RECEIVED-LEGACY', 'RECEIVED', null),            // legacy null poSentAt, proven by status -> included
]

let lastWhere: WhereShape | undefined

mock.module('@/lib/db', {
  namedExports: {
    db: {
      purchaseOrder: {
        findMany: async ({ where }: { where: WhereShape }) => {
          lastWhere = where
          return ALL_POS.filter((p) => matchesWhere(where, p))
        },
      },
    },
  },
})

async function loadStats() {
  return (await import('@/app/actions/purchase-stats')).getPurchaseProductStats
}

test('only committed POs appear; the quote pipeline and abandoned CLOSED quotes are excluded (o3d-27l)', async () => {
  const getPurchaseProductStats = await loadStats()
  const rows = await getPurchaseProductStats()

  const skus = rows.map((r) => r.sku).sort()
  assert.deepEqual(
    skus,
    ['CLOSED-SENT', 'PARTIAL', 'RECEIVED-LEGACY', 'SENT', 'SHIPPED'].sort(),
    'included: PO_SENT/SHIPPED/PARTIALLY_RECEIVED, PO_SENT->CLOSED, and legacy RECEIVED; ' +
    'excluded: DRAFT/RFQ/QUOTE, CANCELLED, and the RFQ->CLOSED abandoned quote',
  )

  // The action must actually pass the committed fragment (not a naive status filter).
  assert.equal(lastWhere?.status?.not, 'CANCELLED')
  assert.ok(Array.isArray(lastWhere?.OR), 'committed predicate uses poSentAt OR ordered-evidence')
})

test('Incoming is gated to still-incoming statuses — terminal POs carry no phantom balance (o3d-27l)', async () => {
  const getPurchaseProductStats = await loadStats()
  const rows = await getPurchaseProductStats()
  const bySku = new Map(rows.map((r) => [r.sku, r]))

  // Incoming (not-yet-received) counts only for PO_SENT/SHIPPED/PARTIALLY_RECEIVED.
  assert.equal(bySku.get('SENT')!.incomingQty, 10)
  assert.equal(bySku.get('SHIPPED')!.incomingQty, 10)
  assert.equal(bySku.get('PARTIAL')!.incomingQty, 10)
  // Terminal committed POs still count in history but NOT as Incoming, even with an un-received balance.
  assert.equal(bySku.get('RECEIVED-LEGACY')!.incomingQty, 0)
  assert.equal(bySku.get('CLOSED-SENT')!.incomingQty, 0)
  // ...but their ordered qty is still committed history.
  assert.equal(bySku.get('RECEIVED-LEGACY')!.qtyOrdered, 10)
})

test('COMMITTED_PURCHASE_ORDER_WHERE excludes CANCELLED and CLOSED-without-order-evidence', () => {
  assert.equal((COMMITTED_PURCHASE_ORDER_WHERE.status as { not?: string })?.not, 'CANCELLED')
  assert.ok(!ORDERED_EVIDENCE_PO_STATUSES.includes('CLOSED' as never), 'CLOSED is not order-proof on its own')
  assert.ok(ORDERED_EVIDENCE_PO_STATUSES.includes('RECEIVED' as never))
})
