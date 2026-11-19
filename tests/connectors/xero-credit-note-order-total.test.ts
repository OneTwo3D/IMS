import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { CreditNoteData } from '@/lib/connectors/types'

/**
 * o3d-hqvrp.389 (review finding): with `xero_round_to_order_total_enabled` ON the invoice carries a Rounding line and totals the ORDER total (0.06 for the two 0.025 lines at 20%,
 * where per-line rounding gives 0.08). A credit note that fully reverses it used to be planned against the per-line model only (0.08), so it did not match the invoice it clears and
 * Xero refused the allocation or left a residual. A full-refund or chargeback credit note now carries the same order total and the same Rounding line. Xero is never contacted.
 */
const sent: Array<{ url: string; body: Record<string, unknown> }> = []
const RATES: Record<string, number> = { OUTPUT2: 20, NONE: 0 }
const rateOf = (taxType: string): number | null => RATES[taxType] ?? null

mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP', resolveBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async () => ({ ok: true, status: 200, data: { CreditNotes: [] } }),
    xeroPost: async (path: string, body: Record<string, unknown>) => { sent.push({ url: path, body }); return { ok: true, status: 200, data: { CreditNotes: [{ CreditNoteID: 'cn-1' }] } } },
    xeroPut: async (path: string, body: Record<string, unknown>) => { sent.push({ url: path, body }); return { ok: true, status: 200, data: { CreditNotes: [{ CreditNoteID: 'cn-1' }] } } },
  },
})
mock.module('@/lib/connectors/xero/contacts', { namedExports: { findOrCreateContact: async () => ({ success: true, contactId: 'contact-1' }) } })
mock.module('@/lib/connectors/xero/items', { namedExports: { findOrCreateItem: async (code: string) => ({ success: true, itemId: `item-${code}`, isTracked: false }) } })
mock.module('@/lib/connectors/xero/settings', { namedExports: { getXeroSettings: async () => ({ xero_rounding_difference_account: '860' }) } })
mock.module('@/lib/connectors/xero/tax-rate-lookup', { namedExports: { loadStoredXeroRateOf: async () => ({ ok: true, rateOf }) } })

test.beforeEach(() => { sent.length = 0 })

type Wire = { Quantity: number; UnitAmount: number; TaxType?: string; Description?: string }
const credit = (extra: Partial<CreditNoteData> = {}): CreditNoteData => ({
  creditNoteNumber: 'CN-1', contactName: 'C', date: '2026-08-20', currency: 'GBP',
  lines: [
    { description: 'A', quantity: 1, unitAmount: 0.025, accountCode: '200', taxType: 'OUTPUT2' },
    { description: 'B', quantity: 1, unitAmount: 0.025, accountCode: '200', taxType: 'OUTPUT2' },
  ],
  ...extra,
})

test('a full-reversal credit note carrying the order total gets the same Rounding line as the invoice and totals 0.06, not 0.08', async () => {
  const { pushCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  const { predictXeroDocumentTotal } = await import('@/lib/connectors/xero/write-path')
  assert.equal((await pushCreditNote(credit({ orderTotal: 0.06 }), 'AUTHORISED')).success, true)
  const items = sent[0]!.body.LineItems as Wire[]
  assert.equal(items.length, 3)
  assert.equal(items[2]!.Description, 'Rounding adjustment')
  assert.equal(items[2]!.UnitAmount, -0.02)
  const total = predictXeroDocumentTotal(items.map((l) => ({ quantity: l.Quantity, unitAmount: l.UnitAmount, taxType: l.TaxType })), false, rateOf)
  assert.ok(total.ok && total.total.toNumber() === 0.06, 'matches the rounded invoice total, so its allocation cannot fail')
})

test('a credit note without the order total (a partial refund, or the setting off) is exactly what it was: no Rounding line', async () => {
  const { pushCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  assert.equal((await pushCreditNote(credit(), 'AUTHORISED')).success, true)
  assert.equal((sent[0]!.body.LineItems as Wire[]).length, 2)
})
