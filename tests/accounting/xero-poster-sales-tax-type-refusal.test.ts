import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * The POSTER's own refusal of a sales document with no decided tax type. Drives the REAL `processClaimedEntry` for SALES_INVOICE,
 * SALES_INVOICE_UPDATE and CREDIT_NOTE with the Xero transport modules doubled: the refusal must come back as an ordinary failed
 * entry with the document's own words, before the connector, the claim fence or any send. Controls prove a fully typed payload
 * goes PAST the refusal (the lease fence is reached), so the refusals are not passing because nothing can pass.
 */

const sent: string[] = []
const record = (name: string) => async () => { sent.push(name); return { success: true, invoiceId: 'X-1', creditNoteId: 'C-1' } }
for (const [module, names] of [
  ['@/lib/connectors/xero/invoices', ['pushSalesInvoice', 'updateSalesInvoice']],
  ['@/lib/connectors/xero/bills', ['pushPurchaseBill', 'updatePurchaseBill']],
  ['@/lib/connectors/xero/credit-notes', ['pushCreditNote', 'pushPurchaseCreditNote', 'allocatePurchaseCreditNote']],
  ['@/lib/connectors/xero/journals', ['pushManualJournal', 'postPreparedManualJournal']],
] as const) {
  mock.module(module, { namedExports: Object.fromEntries(names.map((name) => [name, record(name)])) })
}

let fenced = 0
const lease = { fenceBeforeRemoteWrite: async () => { fenced += 1; throw new Error('reached the pre-write fence') } } as never

async function run(type: string, payload: Record<string, unknown>) {
  sent.length = 0
  fenced = 0
  const { processClaimedEntry } = await import('@/lib/connectors/xero/sync-processor')
  try {
    return { result: await processClaimedEntry('entry-1', type as never, 'SalesOrder', 'so-1', { _postingMode: 'submitted', ...payload } as never, lease, { attemptRevision: 1 } as never), threw: null as string | null }
  } catch (error) {
    return { result: null, threw: error instanceof Error ? error.message : String(error) }
  }
}

const line = { description: 'Widget', quantity: 1, unitAmount: 10, accountCode: '200', taxType: 'OUTPUT2' }
const base = { contactName: 'C', date: '2026-11-02', currency: 'GBP' }
const invoice = (extra: Record<string, unknown> = {}) => ({ ...base, invoiceNumber: 'INV-1', accountingInvoiceId: 'xero-inv-1', lines: [line], ...extra })
const credit = (extra: Record<string, unknown> = {}) => ({ ...base, creditNoteNumber: 'CN-1', lines: [line], ...extra })

const CASES: Array<[string, string, (extra: Record<string, unknown>) => Record<string, unknown>, RegExp]> = [
  ['SALES_INVOICE', 'invoice', invoice, /Sales invoice INV-1 was refused/],
  ['SALES_INVOICE_UPDATE', 'invoice', invoice, /Sales invoice INV-1 was refused/],
  ['CREDIT_NOTE', 'credit', credit, /Credit note CN-1 was refused/],
]
const BAD: Array<[string, Record<string, unknown>]> = [
  ['a line with no TaxType', { lines: [{ ...line, taxType: undefined }] }],
  ['an explicit NONE on an ordinary line', { lines: [{ ...line, taxType: 'NONE' }] }],
  ['an explicit NONE with an unknown kind', { lines: [{ ...line, taxType: 'NONE', noTaxKind: 'whatever' }] }],
]

for (const [type, , build, words] of CASES) {
  for (const [label, extra] of BAD) {
    test(`${type}: ${label} is refused by the poster with the document's words; nothing is sent and the fence is not reached`, async () => {
      const { result, threw } = await run(type, build(extra))
      assert.equal(threw, null, 'the function returned')
      assert.equal(result!.success, false)
      assert.match(String(result!.error), /^NOTHING WAS SENT\./)
      assert.match(String(result!.error), words)
      assert.deepEqual(sent, [])
      assert.equal(fenced, 0)
    })
  }
  test(`${type}: CONTROL, a fully typed document (and a named NONE fee) goes past the refusal`, async () => {
    const { result, threw } = await run(type, build({ lines: [line, { ...line, description: 'Duty', taxType: 'NONE', noTaxKind: 'fee-no-tax' }] }))
    const text = `${threw ?? ''} ${result?.error ?? ''}`
    assert.doesNotMatch(text, /NOTHING WAS SENT\. (Sales invoice|Credit note)/)
  })
}

for (const type of ['SALES_INVOICE', 'SALES_INVOICE_UPDATE']) {
  test(`${type}: shipping and the order discount with no type, or an explicit NONE, are refused by the poster`, async () => {
    for (const extra of [
      { shippingAmount: 4, shippingAccountCode: '300' },
      { shippingAmount: 4, shippingAccountCode: '300', shippingTaxType: 'NONE' },
      { discountAmount: 2, discountAccountCode: '310' },
      { discountAmount: 2, discountAccountCode: '310', discountTaxType: 'NONE' },
    ]) {
      const { result } = await run(type, invoice(extra))
      assert.equal(result?.success, false, JSON.stringify(extra))
      assert.match(String(result?.error), /^NOTHING WAS SENT\. Sales invoice INV-1 was refused/)
    }
    assert.deepEqual(sent, [])
  })
}
