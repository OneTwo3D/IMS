import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { INVOICED_ORDER_WHERE } from '@/lib/domain/sales/invoiced-revenue-basis'

/**
 * The reorder forecast ranks products A/B/C by REVENUE, so that ranking uses the shared invoiced
 * basis. Its demand history (SALE_DISPATCH stock movements, in units) is demand, not turnover, and is
 * deliberately not on that basis.
 *
 * One product per order. Counted: D 200, C 100, B 70, A 50 (total 420). Cumulative share in that
 * order is 47.6% (A class), 71.4% (A), 88.1% (B), 100% (C). The old rule ranked only shipped or
 * completed orders (C and D): D 66.7% (A) and C 100% (C).
 */

mock.module('@/lib/auth/server', { namedExports: { requirePermission: async () => ({ user: { id: 'u1' } }) } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })

const status = { A: 'PENDING_PAYMENT', B: 'ALLOCATED', C: 'SHIPPED', D: 'COMPLETED', X: 'DRAFT', Y: 'PENDING_PAYMENT', Z: 'CANCELLED' } as const
const invoice = { A: { invoiceNumber: 'INV-1' }, B: { accountingInvoiceId: 'x' }, C: { invoiceNumber: 'INV-3' }, D: { invoiceNumber: 'INV-4' }, X: { invoiceNumber: 'INV-5' }, Y: {}, Z: { invoiceNumber: 'INV-6' } } as const
const value = { A: 50, B: 70, C: 100, D: 200, X: 11, Y: 13, Z: 17 } as const
type K = keyof typeof status
const KEYS = Object.keys(status) as K[]

function ok(k: K): boolean {
  const o = invoice[k] as { invoiceNumber?: string; accountingInvoiceId?: string }
  const w = INVOICED_ORDER_WHERE as { status: { notIn: string[] } }
  return !w.status.notIn.includes(status[k]) && Boolean(o.invoiceNumber || o.accountingInvoiceId)
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => null },
      product: {
        findMany: async () => KEYS.map((k) => ({
          id: `p${k}`, sku: `S${k}`, name: k, imageUrl: null, parent: null, stockUnit: 'pcs',
          preferredSupplierId: null, preferredSupplier: null, stockLevels: [],
        })),
      },
      stockMovement: { findMany: async () => [] },
      purchaseOrder: { findMany: async () => [] },
      salesOrderLine: {
        findMany: async (args: { where: { order: unknown } }) => {
          // The old per-report status list or the shared fragment: evaluate whichever it is.
          const cond = args.where.order as { status?: { in?: string[]; notIn?: string[] } }
          return KEYS.filter((k) => {
            if (cond.status?.in) return cond.status.in.includes(status[k])
            return ok(k)
          }).map((k) => ({ productId: `p${k}`, totalBase: value[k] }))
        },
      },
    },
  },
})

test('forecast ABC ranks products by invoiced revenue', async () => {
  const { generateForecasts } = await import('@/app/actions/forecasting')
  const rows = await generateForecasts({})
  const abc = Object.fromEntries(rows.map((r) => [r.sku, r.abcClass]))
  assert.equal(abc.SD, 'A')
  assert.equal(abc.SC, 'A')
  assert.equal(abc.SB, 'B')
  assert.equal(abc.SA, 'C')
})
