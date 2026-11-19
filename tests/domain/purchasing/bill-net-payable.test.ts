import assert from 'node:assert/strict'
import test from 'node:test'

import type { PurchaseOrderStatus } from '@/app/generated/prisma/client'
import { payableOutstanding } from '@/lib/accounting-fx-revaluation'
import { billNetPayableBase, billNetPayableForeign, billReverseChargeVatForeign } from '@/lib/domain/purchasing/bill-net-payable'
import { cancelPurchaseOrderService, type CancelPurchaseOrderServiceDeps } from '@/lib/domain/purchasing/cancellation-service'
import { computeReturnCreditNoteDraft } from '@/lib/domain/purchasing/return-credit-note'

/**
 * o3d-hqvrp.399 (owner decision): a reverse-charge bill KEEPS its stored totals (net 100 shows 120, the VAT return needs it) but what is owed to the
 * supplier is the net payable (100). Every reader of "how much is owed" uses it. Pure; nothing touches a network or a database.
 */
const RC_LINE = { totalForeign: '100', taxRateValue: '0.2', taxReverseCharge: true }
const STD_LINE = { totalForeign: '50', taxRateValue: '0.2', taxReverseCharge: false }

test('net payable is the stored total less the VAT of reverse-charge lines only', () => {
  assert.equal(billReverseChargeVatForeign([RC_LINE, STD_LINE], 'GBP').toNumber(), 20)
  assert.equal(billNetPayableForeign({ totalForeign: '180', totalBase: '180', lines: [RC_LINE, STD_LINE] }, 'GBP').toNumber(), 160)
  // no reverse-charge line (or lines booked before the treatment was recorded): the stored total
  assert.equal(billNetPayableForeign({ totalForeign: '60', totalBase: '60', lines: [STD_LINE] }, 'GBP').toNumber(), 60)
  assert.equal(billNetPayableForeign({ totalForeign: '60', totalBase: '60', lines: [{ totalForeign: '50', taxRateValue: null, taxReverseCharge: null }] }, 'GBP').toNumber(), 60)
  assert.equal(billNetPayableForeign({ totalForeign: '60', totalBase: '60' }, 'GBP').toNumber(), 60)
})

test('net payable base prorates the stored base total (one rate per bill)', () => {
  assert.equal(billNetPayableBase({ totalForeign: '120', totalBase: '96', lines: [RC_LINE] }, 'EUR').toNumber(), 80)
  assert.equal(billNetPayableBase({ totalForeign: '60', totalBase: '48', lines: [STD_LINE] }, 'EUR').toNumber(), 48)
})

test('supplier-payable reconciliation: the open balance is the net payable, not the stored total', () => {
  const bill = { totalForeign: '120', totalBase: '96', supplierCreditNotes: [], currency: 'EUR', lines: [RC_LINE] }
  const p = payableOutstanding(bill)
  assert.equal(p.outstandingForeign, 100)
  assert.equal(p.bookedBase, 80)
  // a credit of 40 leaves 60 owed (not 80)
  assert.equal(payableOutstanding({ ...bill, supplierCreditNotes: [{ amountForeign: '40' }] }).outstandingForeign, 60)
  // callers that pass no currency/lines keep the stored-total behaviour
  assert.equal(payableOutstanding({ totalForeign: '120', totalBase: '96', supplierCreditNotes: [] }).outstandingForeign, 120)
})

test('return-draft credit: grossed up to and capped at the net payable of a reverse-charge bill', () => {
  const bill = {
    invoiceId: 'b1', subtotalForeign: '100', totalForeign: '120', netPayableForeign: '100', fxRateToBase: '1',
    alreadyCreditedForeign: 0, alreadyReturnCreditedForeign: 0, createdAt: 1,
    lines: [{ poLineId: 'l1', qtyBilled: '10', totalForeign: '100' }],
  }
  const poLines = [{ poLineId: 'l1', qtyReceived: '10', qtyReturned: '10' }] // all 10 returned: the whole 100 net is over-billed
  const withNet = computeReturnCreditNoteDraft({ poLines, bills: [bill] })
  assert.equal(withNet.draft?.amountForeign, 100, 'the whole bill is credited at what is owed (100), not 120')
  const withoutNet = computeReturnCreditNoteDraft({ poLines, bills: [{ ...bill, netPayableForeign: undefined }] })
  assert.equal(withoutNet.draft?.amountForeign, 120, 'without the net payable the draft over-credits by the self-accounted VAT')
})

test('cancellation credit gate: a reverse-charge bill credited for what is owed is fully offset', async () => {
  const po = { status: 'PO_SENT' as PurchaseOrderStatus, reference: 'FRT-RC' }
  const tx = {
    $queryRaw: async () => [],
    purchaseOrder: {
      findUnique: async () => ({
        status: po.status, reference: po.reference, type: 'FREIGHT', currency: 'GBP',
        invoices: [{ id: 'inv-1', totalBase: '120', totalForeign: '120', lines: [RC_LINE] }],
        supplierCreditNotes: [{ purchaseInvoiceId: 'inv-1', amountBase: '100', amountForeign: '100', fxRateToBase: '1' }],
      }),
      update: async () => ({ id: 'frt-rc' }),
    },
  }
  const deps = {
    findPurchaseOrderFast: async () => ({ status: po.status, reference: po.reference }),
    transaction: async (fn: (t: never) => unknown) => fn(tx as never),
    logActivity: async () => undefined,
    retirePurchaseOrderLocked: async () => { throw new Error('unused') },
    recalculateLandedCosts: async () => ({ revalidatePoIds: [], auditRunIds: [], cogsAdjustments: [], inventoryTransitAdjustments: [], warnings: [] }),
    queueLandedCostAdjustmentJournals: async () => ({ owed: 0 }),
    readAccountingChart: async () => ({ ok: true, chart: { connector: 'xero' } }),
  } as unknown as CancelPurchaseOrderServiceDeps
  const result = await cancelPurchaseOrderService('frt-rc', deps)
  assert.equal(result.success, true, String(result.error))
})
