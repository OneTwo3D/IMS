import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * ACC-H3: the POSTER's own refusal of a supplier bill or supplier credit note with no decided tax type. Drives the REAL
 * `processClaimedEntry` for PURCHASE_INVOICE, PURCHASE_INVOICE_UPDATE and PURCHASE_CREDIT_NOTE with the Xero transport modules doubled
 * (the purchase twin of xero-poster-sales-tax-type-refusal.test.ts). The refusal must come back as an ordinary failed entry with the
 * document's own words, before the connector, the claim fence or any send. Controls prove a decided payload goes PAST the refusal.
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

let authDoubled = false
async function doubleScopeRead() {
  if (authDoubled) return
  authDoubled = true
  const actual = await import('@/lib/connectors/xero/auth')
  mock.module('@/lib/connectors/xero/auth', { namedExports: { ...actual, getGrantedScopes: async () => null } })
}

let fenced = 0
const lease = { fenceBeforeRemoteWrite: async () => { fenced += 1; throw new Error('reached the pre-write fence') } } as never

async function run(type: string, payload: Record<string, unknown>) {
  sent.length = 0
  fenced = 0
  await doubleScopeRead()
  const { processClaimedEntry } = await import('@/lib/connectors/xero/sync-processor')
  try {
    return { result: await processClaimedEntry('entry-1', type as never, 'PurchaseInvoice', 'pi-1', { _postingMode: 'submitted', ...payload } as never, lease, { attemptRevision: 1 } as never), threw: null as string | null }
  } catch (error) {
    return { result: null, threw: error instanceof Error ? error.message : String(error) }
  }
}

const line = { description: 'Goods', quantity: 1, unitAmount: 10, accountCode: '631', taxType: 'INPUT2' }
const base = { contactName: 'Supplier', date: '2026-11-02', currency: 'GBP' }
const bill = (extra: Record<string, unknown> = {}) => ({ ...base, invoiceNumber: 'SUP-1', accountingInvoiceId: 'xero-bill-1', lines: [line], ...extra })
const supplierCredit = (extra: Record<string, unknown> = {}) => ({ ...base, creditNoteNumber: 'SCN-1', lines: [line], ...extra })

const CASES: Array<[string, (extra: Record<string, unknown>) => Record<string, unknown>, RegExp]> = [
  ['PURCHASE_INVOICE', bill, /Purchase bill SUP-1 was refused/],
  ['PURCHASE_INVOICE_UPDATE', bill, /Purchase bill SUP-1 was refused/],
  ['PURCHASE_CREDIT_NOTE', supplierCredit, /Supplier credit note SCN-1 was refused/],
]
const BAD: Array<[string, Record<string, unknown>]> = [
  ['a line with no TaxType', { lines: [{ ...line, taxType: undefined }] }],
  ['a line with a blank TaxType', { lines: [{ ...line, taxType: '  ' }] }],
  ['an explicit NONE that names no reason', { lines: [{ ...line, taxType: 'NONE' }] }],
  ['an explicit NONE with an unknown kind', { lines: [{ ...line, taxType: 'NONE', noTaxKind: 'whatever' }] }],
  ['a SALES kind on a purchase line', { lines: [{ ...line, taxType: 'NONE', noTaxKind: 'fee-no-tax' }] }],
]

for (const [type, build, words] of CASES) {
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
  test(`${type}: CONTROL, a decided document (and a named NONE line) goes past the refusal`, async () => {
    const { result, threw } = await run(type, build({
      lines: [line, { ...line, description: 'Duty', taxType: 'NONE', noTaxKind: 'cost-not-vatable' }, { ...line, description: 'Zero', taxType: 'NONE', noTaxKind: 'no-vat-rate' }],
    }))
    const text = `${threw ?? ''} ${result?.error ?? ''}`
    assert.doesNotMatch(text, /NOTHING WAS SENT\. (Purchase bill|Supplier credit note)/)
  })
}
