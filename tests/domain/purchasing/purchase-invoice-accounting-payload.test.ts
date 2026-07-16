import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPurchaseInvoiceAccountingPayload } from '@/lib/domain/purchasing/purchase-invoice-edit'

/**
 * Which of our two numbers goes into Xero's InvoiceNumber is not cosmetic — it decides whether a
 * second bill is a NEW document or an OVERWRITE of the first (o3d-6l3).
 *
 * Xero's POST /Invoices UPSERTS on InvoiceNumber. Sending the PO reference — identical for every
 * bill raised against that PO — meant the second instalment silently replaced the first and
 * returned its InvoiceID: two GBP 25 bills collapsed into one GBP 25 bill carrying the later
 * reference, no error anywhere, both recorded SYNCED. Payables understated by every instalment
 * but the last. Proven against the live Demo ledger before this was changed.
 *
 * The supplier's invoice number is unique per bill by nature, which is exactly why Xero treats it
 * as the ACCPAY natural key.
 */

const LINE = { description: 'PO-1 line', quantity: 1, unitAmount: 10, accountCode: '632' }

function build(over: Partial<Parameters<typeof buildPurchaseInvoiceAccountingPayload>[0]> = {}) {
  return buildPurchaseInvoiceAccountingPayload({
    poReference: 'PO-20260716-ABCD',
    contactName: 'A Supplier',
    date: '2026-07-16',
    currency: 'GBP',
    fxRateToBase: 1,
    reference: 'SUPPLIER-INV-9001',
    lines: [LINE],
    ...over,
  })
}

test('the SUPPLIER invoice number becomes Xero InvoiceNumber, the PO ref becomes Reference', () => {
  const p = build()
  assert.equal(p.invoiceNumber, 'SUPPLIER-INV-9001', 'Xero ACCPAY InvoiceNumber means THEIR document')
  assert.equal(p.reference, 'PO-20260716-ABCD', 'our PO ref is the Reference — the trail back from the ledger')
})

test('two bills on ONE po get DIFFERENT InvoiceNumbers — the whole point', () => {
  // The regression: both instalments used to carry the PO ref, so the second upserted over the
  // first. Different supplier numbers cannot collide.
  const first = build({ reference: 'SUPPLIER-INV-9001' })
  const second = build({ reference: 'SUPPLIER-INV-9002' })
  assert.notEqual(first.invoiceNumber, second.invoiceNumber, 'a second bill must not overwrite the first')
  assert.equal(first.reference, second.reference, 'while both still trace to the same PO')
})

test('a missing supplier number OMITS InvoiceNumber rather than falling back to the PO ref', () => {
  // The field is optional (the Create Bill form requires the date, not this). Falling back to the
  // PO reference would restore the collision exactly; omitting it is safe, because Xero cannot
  // upsert on a value that is not there, and honest, because we genuinely do not know their number.
  const p = build({ reference: null })
  assert.equal(p.invoiceNumber, undefined)
  assert.equal(p.reference, 'PO-20260716-ABCD', 'the PO trail survives even with no supplier number')
})

test('a blank/whitespace supplier number is treated as absent, not sent as an empty InvoiceNumber', () => {
  // '' would be falsy at the bills.ts send site anyway, but '   ' would not — and an InvoiceNumber
  // of spaces is a value Xero can upsert on, which would resurrect the bug for every bill whose
  // number was typed as a space.
  assert.equal(build({ reference: '   ' }).invoiceNumber, undefined)
  assert.equal(build({ reference: '' }).invoiceNumber, undefined)
})
