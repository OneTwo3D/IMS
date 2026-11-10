import assert from 'node:assert/strict'
import test from 'node:test'

import {
  validateRecordSupplierCreditNote,
  buildSupplierCreditNoteSyncPayload,
  resolveSupplierCreditNoteTaxType,
  resolveSupplierCreditNoteTransitBase,
} from '@/lib/domain/purchasing/supplier-credit-note'

// 6oyu.4 (khdw): the NET base amount a credit note posts to the transit account (for
// the transit subledger). A standard credit posts INCLUSIVE (gross) → transit gets the
// net after Xero's VAT split; a reverse-charge/NONE credit is already net.
test('resolveSupplierCreditNoteTransitBase: standard credit nets out the bill VAT ratio', () => {
  // £120 gross credit against a 20%-VAT bill (subtotal 100, tax 20) → £100 net to transit.
  assert.equal(
    resolveSupplierCreditNoteTransitBase({ grossBase: 120, billSubtotalForeign: 100, billTaxForeign: 20 }),
    100,
  )
})

test('resolveSupplierCreditNoteTransitBase: no-VAT / reverse-charge / untied credit passes through as net', () => {
  // billTaxForeign 0 (NONE, reverse-charge, or untied): the amount is already net.
  assert.equal(resolveSupplierCreditNoteTransitBase({ grossBase: 80, billSubtotalForeign: 80, billTaxForeign: 0 }), 80)
  assert.equal(resolveSupplierCreditNoteTransitBase({ grossBase: 80, billSubtotalForeign: 0, billTaxForeign: 0 }), 80)
})

// audit-g5u2.3: a supplier credit note can only be recorded against a billed PO,
// and its Xero payload reverses the freight bill on the transit/clearing account.

test('record validation: requires a positive amount', () => {
  assert.equal(
    validateRecordSupplierCreditNote({ amountForeign: 0, hasInvoice: true, selectedInvoiceBelongsToPo: null }),
    'Credit note amount must be greater than 0',
  )
  assert.equal(
    validateRecordSupplierCreditNote({ amountForeign: -5, hasInvoice: true, selectedInvoiceBelongsToPo: null }),
    'Credit note amount must be greater than 0',
  )
})

test('record validation: requires the PO to have a recorded invoice', () => {
  assert.equal(
    validateRecordSupplierCreditNote({ amountForeign: 100, hasInvoice: false, selectedInvoiceBelongsToPo: null }),
    'Record the supplier invoice before crediting it',
  )
})

test('record validation: rejects an invoice that belongs to another PO', () => {
  assert.equal(
    validateRecordSupplierCreditNote({ amountForeign: 100, hasInvoice: true, selectedInvoiceBelongsToPo: false }),
    'The selected invoice does not belong to this purchase order',
  )
})

test('record validation: passes for a valid request', () => {
  assert.equal(validateRecordSupplierCreditNote({ amountForeign: 120, hasInvoice: true, selectedInvoiceBelongsToPo: true }), null)
  assert.equal(validateRecordSupplierCreditNote({ amountForeign: 120, hasInvoice: true, selectedInvoiceBelongsToPo: null }), null)
})

test('record validation: rejects over-crediting the bill (Codex review)', () => {
  // 80 remaining, asking for 100 → blocked.
  assert.match(
    validateRecordSupplierCreditNote({ amountForeign: 100, hasInvoice: true, selectedInvoiceBelongsToPo: true, remainingCreditableForeign: 80 }) ?? '',
    /exceeds the remaining creditable amount/,
  )
  // Exactly the remaining amount is allowed (within epsilon).
  assert.equal(
    validateRecordSupplierCreditNote({ amountForeign: 80, hasInvoice: true, selectedInvoiceBelongsToPo: true, remainingCreditableForeign: 80 }),
    null,
  )
  // No cap supplied → no over-credit check.
  assert.equal(
    validateRecordSupplierCreditNote({ amountForeign: 9999, hasInvoice: true, selectedInvoiceBelongsToPo: true, remainingCreditableForeign: null }),
    null,
  )
})

test('sync payload reverses on the transit account with the supplier contact', () => {
  const payload = buildSupplierCreditNoteSyncPayload({
    creditNoteId: 'scn-1',
    creditNoteNumber: 'CN-77',
    reference: 'PO-9',
    reason: 'Duplicate freight bill',
    supplierName: 'Freight Co',
    supplierId: 'sup-1',
    currency: 'EUR',
    fxRateToBase: 0.85,
    amountForeign: 120,
    transitAccount: '1250',
    taxType: 'INPUT2',
    date: '2026-06-13',
  })
  assert.equal(payload.contactName, 'Freight Co')
  assert.equal(payload.supplierId, 'sup-1')
  assert.equal(payload.currency, 'EUR')
  assert.equal(payload.currencyRateToBase, 0.85)
  assert.equal(payload.creditNoteNumber, 'SCN-scn-1', 'the LEDGER document number is minted from the row id, never from free text')
  const lines = payload.lines as Array<Record<string, unknown>>
  assert.equal(lines.length, 1)
  assert.equal(lines[0].accountCode, '1250')
  assert.equal(lines[0].unitAmount, 120)
  assert.equal(lines[0].description, 'Duplicate freight bill')
  assert.equal(lines[0].taxType, 'INPUT2') // audit-oy5p: mirrors the bill's tax type
  // audit-oy5p: the entered amount is gross → post tax-inclusive so Xero splits VAT.
  assert.equal(payload.lineAmountsIncludeTax, true)
  // audit-v08m: no bill external id supplied → no allocation hints in the payload.
  assert.equal(payload.allocateToInvoiceId, undefined)
  assert.equal(payload.allocateAmount, undefined)
})

test('sync payload carries allocation hints when the bill has an external id (audit-v08m)', () => {
  const base = {
    creditNoteId: 'scn-1', creditNoteNumber: 'CN-77', reference: 'PO-9', reason: 'Dup freight',
    supplierName: 'Freight Co', supplierId: 'sup-1', currency: 'EUR', fxRateToBase: 0.85,
    amountForeign: 120, transitAccount: '1250', taxType: 'NONE', date: '2026-06-14',
  }
  // Bill has an external id → carry the id + default the allocate amount to the credit total.
  const withBill = buildSupplierCreditNoteSyncPayload({ ...base, allocateToInvoiceId: 'xero-inv-1' })
  assert.equal(withBill.allocateToInvoiceId, 'xero-inv-1')
  assert.equal(withBill.allocateAmount, 120)
  // Explicit allocate amount is preserved.
  const explicit = buildSupplierCreditNoteSyncPayload({ ...base, allocateToInvoiceId: 'xero-inv-1', allocateAmount: 50 })
  assert.equal(explicit.allocateAmount, 50)
  // No bill id → hints omitted even if an amount is passed.
  const noBill = buildSupplierCreditNoteSyncPayload({ ...base, allocateToInvoiceId: null, allocateAmount: 50 })
  assert.equal(noBill.allocateToInvoiceId, undefined)
  assert.equal(noBill.allocateAmount, undefined)
})

const taxedLine = { taxType: 'INPUT2', rate: 0.2, taxRateId: 'r-std' }
const exemptLine = { taxType: 'NONE', rate: 0 }
const tax = (p: Parameters<typeof resolveSupplierCreditNoteTaxType>[0]) => resolveSupplierCreditNoteTaxType(p).taxType

test('credit-note tax type mirrors the SELECTED BILL\'s booked lines: the code its VAT-bearing lines posted on, NONE only when the bill carried no VAT', () => {
  assert.deepEqual(resolveSupplierCreditNoteTaxType({ billHadTax: true, billLines: [taxedLine] }), { taxType: 'INPUT2', taxRateId: 'r-std' })
  // A taxable bill is credited on the bill's code even when the supplier's CURRENT default is NONE (the resolver never sees the supplier).
  assert.equal(tax({ billHadTax: true, billLines: [taxedLine, exemptLine] }), 'INPUT2', 'a non-vatable line on a taxable bill does not turn the credit into NONE')
  assert.equal(tax({ billHadTax: false, billLines: [exemptLine] }), 'NONE', 'a bill with only non-vatable lines: NONE')
  assert.equal(tax({ billHadTax: false, billLines: [] }), 'NONE')
  // Bill carried VAT but nothing shows what code: UNDECIDED, never NONE (the poster refuses it).
  assert.equal(tax({ billHadTax: true, billLines: [] }), undefined)
  assert.equal(tax({ billHadTax: true, billLines: [{ taxType: undefined, rate: 0.2 }] }), undefined)
  assert.equal(tax({ billHadTax: true, billLines: [{ taxType: 'NONE', rate: 0.2 }] }), undefined, 'a NONE line that carried a rate is not a decided credit')
  // One amount cannot mirror two VAT codes.
  assert.equal(tax({ billHadTax: true, billLines: [taxedLine, { taxType: 'INPUT5', rate: 0.05 }] }), undefined)
  assert.equal(tax({ billHadTax: true, billLines: [taxedLine, { taxType: 'INPUT2', rate: 0.2 }] }), 'INPUT2', 'two lines on one code are one code')
})

test('credit-note tax type: reverse-charge goods credit reverses on the RC tax type, not NONE', () => {
  assert.equal(tax({ billHadTax: false, billLines: [taxedLine], isReverseCharge: true, reverseChargeTaxType: 'REVERSECHARGES' }), 'REVERSECHARGES')
  assert.equal(tax({ billHadTax: true, billLines: [taxedLine], isReverseCharge: true, reverseChargeTaxType: 'REVERSECHARGES' }), 'REVERSECHARGES')
  // RC but no configured RC tax type: the type the bill's lines posted on (NOT NONE).
  assert.equal(tax({ billHadTax: false, billLines: [taxedLine], isReverseCharge: true, reverseChargeTaxType: '' }), 'INPUT2')
  // RC, no RC tax type and nothing the bill posted on: undecided.
  assert.equal(tax({ billHadTax: false, billLines: [], isReverseCharge: true, reverseChargeTaxType: '' }), undefined)
})

test('sync payload posts EXCLUSIVE for reverse-charge (net amount), INCLUSIVE otherwise', () => {
  const base = {
    creditNoteId: 'scn-rc', creditNoteNumber: 'CN-RC', reference: 'PO-RC', reason: 'RC return',
    supplierName: 'EU Supplier', supplierId: 'sup-eu', currency: 'EUR', fxRateToBase: 0.85,
    amountForeign: 100, transitAccount: '1250', taxType: 'REVERSECHARGES', date: '2026-06-16',
  }
  // Default (standard/freight): inclusive.
  assert.equal(buildSupplierCreditNoteSyncPayload(base).lineAmountsIncludeTax, true)
  // Reverse charge: exclusive so Xero adds the notional VAT to the net amount.
  assert.equal(buildSupplierCreditNoteSyncPayload({ ...base, lineAmountsIncludeTax: false }).lineAmountsIncludeTax, false)
})

test('a BLANK credit-note number never becomes the PO reference — two on one PO would collide (o3d-tfri)', () => {
  // `recordSupplierCreditNote` sets `reference` to the PO's reference whenever the operator leaves
  // the number blank, and several credit notes per PO is a supported flow. The number used to fall
  // back to that reference, so two blank-numbered credits on PO-ABC both posted as
  // `CreditNoteNumber: 'PO-ABC'` — and Xero's create-or-update on that number meant the second
  // REPLACED the first in the ledger. Each now gets its own row-id-derived number.
  const common = {
    reference: 'PO-ABC', reason: null, creditNoteNumber: null,
    supplierName: 'S', supplierId: 's', currency: 'GBP', fxRateToBase: 1, amountForeign: 10,
    transitAccount: 'T', taxType: 'NONE', date: '2026-06-13',
  }
  const first = buildSupplierCreditNoteSyncPayload({ ...common, creditNoteId: 'scn-2' })
  const second = buildSupplierCreditNoteSyncPayload({ ...common, creditNoteId: 'scn-9' })

  assert.equal(first.creditNoteNumber, 'SCN-scn-2')
  assert.equal(second.creditNoteNumber, 'SCN-scn-9')
  assert.notEqual(
    first.creditNoteNumber,
    second.creditNoteNumber,
    'two blank-numbered credit notes on ONE purchase order must not share a CreditNoteNumber',
  )
  // The PO linkage is not lost — it just stops being the document number.
  assert.equal(first.reference, 'PO-ABC')
  assert.equal(second.reference, 'PO-ABC')
  assert.equal((first.lines as Array<Record<string, unknown>>)[0].description, 'Supplier credit note')
})

test('an operator-supplied number never becomes the LEDGER document number — it travels as the reference (o3d-tfri r2)', () => {
  // Production shape: recordSupplierCreditNote stores `reference = creditNoteNumber || po.reference`,
  // so an operator-typed number arrives here in BOTH fields. Only one of them may reach Xero's
  // CreditNoteNumber, because a number nothing makes unique is what forced the create-only verb —
  // and a create-only verb duplicates the credit note after a lost response.
  const numbered = buildSupplierCreditNoteSyncPayload({
    creditNoteId: 'scn-4', creditNoteNumber: 'SUPPLIER-CN-77', reference: 'SUPPLIER-CN-77', reason: null,
    supplierName: 'S', supplierId: 's', currency: 'GBP', fxRateToBase: 1, amountForeign: 10, transitAccount: 'T', taxType: 'NONE', date: '2026-06-13',
  })
  assert.equal(numbered.creditNoteNumber, 'SCN-scn-4', 'unique by construction, from this row\'s primary key')
  assert.equal(numbered.reference, 'SUPPLIER-CN-77', 'and the supplier\'s own number still reaches the ledger')

  // Two credit notes on ONE purchase order whose supplier reused their own reference: distinct
  // documents in the ledger, which is what they are.
  const twin = buildSupplierCreditNoteSyncPayload({
    creditNoteId: 'scn-5', creditNoteNumber: 'SUPPLIER-CN-77', reference: 'SUPPLIER-CN-77', reason: null,
    supplierName: 'S', supplierId: 's', currency: 'GBP', fxRateToBase: 1, amountForeign: 10, transitAccount: 'T', taxType: 'NONE', date: '2026-06-13',
  })
  assert.notEqual(twin.creditNoteNumber, numbered.creditNoteNumber)

  const noRef = buildSupplierCreditNoteSyncPayload({
    creditNoteId: 'scn-3', creditNoteNumber: null, reference: null, reason: null,
    supplierName: 'S', supplierId: 's', currency: 'GBP', fxRateToBase: 1, amountForeign: 10, transitAccount: 'T', taxType: 'NONE', date: '2026-06-13',
  })
  assert.equal(noRef.creditNoteNumber, 'SCN-scn-3')
  assert.equal(noRef.reference, undefined)
})

/**
 * o3d-tfri r3 retracted the claim that a number unique on OUR side makes a Xero retry CONVERGE — the
 * verb is not the fence, the pre-create lookup is. The claim survived in one doc comment, which is
 * how a retraction quietly un-retracts itself.
 */
test('the withdrawn "unique number makes the retry converge" claim stays withdrawn', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/domain/purchasing/supplier-credit-note.ts', 'utf8')
  const builderDoc = src.slice(
    src.indexOf('THE DOCUMENT NUMBER IS ALWAYS'),
    src.indexOf('export function buildSupplierCreditNoteSyncPayload'),
  )
  assert.ok(builderDoc.length > 0, 'the builder doc must still be there, or this scan measures nothing')
  assert.doesNotMatch(
    builderDoc,
    /premise\s*\n?\s*\*?\s*that lets the poster go back to the upserting verb and converge on a retry/,
    'a number unique by construction on OUR side is not evidence that Xero matches a re-post on it',
  )
  assert.match(builderDoc, /RECOGNISABILITY|recognisab/i,
    'what the minted number actually buys is that a document under it can only be THIS credit note')
})

test('wiring: the supplier credit note poster reads the SELECTED bill\'s lines and treatment, not the supplier default type', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync('app/actions/purchase-orders.ts', 'utf8')
  assert.match(source, /billLineTaxTreatments\(\{\s*billLines: billLinesBooked/)
  assert.doesNotMatch(source, /supplierTaxType: baseTaxType/)
})
