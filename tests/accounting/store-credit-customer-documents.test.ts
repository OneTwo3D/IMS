import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

import { storeCreditInvoiceDocumentRefusal } from '@/lib/domain/accounting/store-credit-invoice-refusal'

/**
 * Store credit must never reach a CUSTOMER-FACING INVOICE total.
 *
 * The local invoice renderers print `SalesOrder.totalForeign` (what WooCommerce charged AFTER the credit) as the
 * invoice Total. An invoice for a credit order would therefore go to the customer reduced by the credit. So the
 * invoice documents (invoice email in either flavour, queued or manual, and the on-the-fly invoice download) are
 * REFUSED for an order with credit or held for review, and the order documents that show a total (order
 * confirmation, sales-order PDF) show the credit as its own line so their figures add up.
 *
 * This census lists EVERY place that renders or sends a customer document, found by scanning the tree, and fails
 * when a new one appears that nobody classified.
 */

function grepFiles(pattern: string): string[] {
  try {
    return execFileSync('grep', ['-rlE', pattern, 'app', 'lib', '--include=*.ts', '--include=*.tsx'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).sort()
  } catch { return [] }
}
const read = (f: string) => readFileSync(f, 'utf8')
function precondition(name: string, facts: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`PRECONDITION ${name}: ${JSON.stringify(facts)}`)
}

type Verdict = { guarded: string | null; exempt: string | null }
const GUARDED = (needle: string): Verdict => ({ guarded: needle, exempt: null })
const EXEMPT = (reason: string): Verdict => ({ guarded: null, exempt: reason })

test('CENSUS 1: every file that RENDERS a PDF document is classified', () => {
  const table: Record<string, Verdict> = {
    'lib/order-email.ts': GUARDED('assertNoStoreCreditInvoiceDocument(so)'),
    'app/api/invoice/[id]/route.ts': GUARDED('storeCreditInvoiceDocumentRefusal(creditBlock)'),
    'app/api/sales-order/[id]/route.ts': GUARDED("doc.text('Store credit:'"),
    'lib/pdf.ts': EXEMPT('the createPdfDocument definition; renders nothing itself'),
    'app/api/packing-slip/[id]/route.ts': EXEMPT('packing slip: lines and quantities, no money totals'),
    'app/api/preview/document/route.ts': EXEMPT('template preview with sample data, not an order'),
    'app/api/manufacturing-order/[id]/route.ts': EXEMPT('manufacturing order: no customer, no sales order'),
    'app/api/rfq/[id]/route.ts': EXEMPT('request for quotation to a supplier: no sales order'),
  }
  const found = grepFiles('createPdfDocument\\(')
  const guarded = Object.values(table).filter((v) => v.guarded).length
  precondition('pdf renderers', { found: found.length, guarded, exempt: found.length - guarded })
  assert.ok(found.length >= 6, 'precondition: the scan found the renderers')
  assert.deepEqual(found, Object.keys(table).sort(), 'an unclassified document renderer (or a classified one is gone)')
  for (const [file, v] of Object.entries(table)) {
    if (v.guarded) assert.ok(read(file).includes(v.guarded), `${file} must carry ${v.guarded}`)
    else assert.ok(v.exempt!.length > 15, `${file} needs a real reason`)
  }
})

test('CENSUS 2: every place a STORED invoice PDF is served is the accounting system\'s own document (exempt), and every email kind is classified', () => {
  const loaders = grepFiles('loadInvoicePdf\\(')
  precondition('stored PDF servers', { files: loaders })
  assert.deepEqual(loaders, [
    'app/api/invoice/[id]/route.ts', 'app/api/invoices/[id]/route.ts', 'app/api/shopping/[connector]/invoice-pdf/route.ts',
    'lib/invoice-pdf.ts', 'lib/order-email.ts',
  ].sort(), 'a new place serves a stored invoice PDF: classify it')
  // Stored PDFs are written only by the Xero INVOICE_PDF follow-up (saveInvoicePdf), which never runs for a credit order.
  assert.ok(read('lib/connectors/xero/sync-processor.ts').includes('saveInvoicePdf'))

  const kinds = new Map<string, Verdict>([
    ['SALES_ORDER_CONFIRMATION', EXEMPT('order confirmation: shows the credit as its own line, so it adds up (census 1)')],
    ['INVOICE', GUARDED('getInvoiceQueueData(orderId)')],
    ['ACCOUNTING_INVOICE', GUARDED('getAccountingInvoiceQueueData(orderId)')],
  ])
  const queued = [...new Set(
    [...read('app/actions/email.ts').matchAll(/kind: '([A-Z_]+)'/g), ...read('lib/accounting-email.ts').matchAll(/kind: '([A-Z_]+)'/g)].map((m) => m[1]),
  )].sort()
  precondition('queued email kinds', { queued, dispatch: 'SHIPMENT_DISPATCHED (lib/dispatch-email.ts)' })
  assert.deepEqual(queued, [...kinds.keys()].sort())
  const prepared = [...read('lib/order-email.ts').matchAll(/kind === '([A-Z_]+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(prepared, ['ACCOUNTING_INVOICE', 'INVOICE', 'SALES_ORDER_CONFIRMATION', 'SHIPMENT_DISPATCHED'], 'a new outbox kind is prepared: classify it')
  assert.ok(read('lib/order-email.ts').slice(read('lib/order-email.ts').indexOf('async function buildDispatchEmail')).includes('itemLines'), 'the dispatch email lists items and tracking only')
  assert.doesNotMatch(read('lib/order-email.ts').slice(read('lib/order-email.ts').indexOf('async function buildDispatchEmail'), read('lib/order-email.ts').indexOf('export async function getSalesOrderConfirmationQueueData')), /totalForeign/, 'SHIPMENT_DISPATCHED shows no total')
  const email = read('app/actions/email.ts')
  const sendInvoice = email.slice(email.indexOf('export async function sendInvoiceEmail'))
  assert.ok(sendInvoice.indexOf('getInvoiceQueueData(orderId)') > 0 && sendInvoice.indexOf('getInvoiceQueueData(orderId)') < sendInvoice.indexOf('queueEmail('), 'the manual invoice send consults the guarded data function BEFORE it queues')
  const acct = read('lib/accounting-email.ts')
  assert.ok(acct.indexOf('getAccountingInvoiceQueueData(orderId)') < acct.indexOf('queueEmail('))
})

test('the on-the-fly invoice download refuses AFTER the stored accounting PDF branch and BEFORE it renders', () => {
  const route = read('app/api/invoice/[id]/route.ts')
  const stored = route.indexOf('if (so.invoicePdfPath)')
  const refuse = route.indexOf('storeCreditBlock(so)')
  const render = route.indexOf('createPdfDocument(')
  precondition('invoice route order', { stored, refuse, render })
  assert.ok(stored > 0 && refuse > stored && render > refuse)
  assert.match(route, /status: 409/)
})

test('the order documents show the credit beside the Total, so their figures add up', () => {
  for (const file of ['lib/order-email.ts', 'app/api/sales-order/[id]/route.ts']) {
    const src = read(file)
    const row = src.indexOf("'Store credit:'")
    const total = src.indexOf("'Total:'", row)
    precondition(`credit row ${file}`, { row, total })
    assert.ok(row > 0 && total > row, `${file}: a Store credit row precedes the Total row`)
  }
})

// ---------------------------------------------------------------------------------------------------
// Behaviour: the guarded data functions and the outbox preparation step.
// ---------------------------------------------------------------------------------------------------

const state: { row: Record<string, unknown> | null } = { row: null }
mock.module('@/lib/db', { namedExports: { db: { salesOrder: { findUnique: async () => state.row } } } })

const base = { id: 'o1', invoiceNumber: 'INV-1', customerEmail: 'a@b.c', invoicePdfPath: '/x.pdf', orderNumber: 'SO-1', externalOrderNumber: '1' }

test('queue data and the outbox PREPARATION refuse a credit / review / unassessed-credit / unreadable order, with the single-sourced text', async () => {
  const { getInvoiceQueueData, getAccountingInvoiceQueueData, prepareQueuedEmail } = await import('@/lib/order-email')
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ['credit', { storeCreditForeign: '12.0000', storeCreditAssessment: 'ASSESSED' }, true],
    ['review, credit 0', { storeCreditForeign: '0.0000', storeCreditAssessment: 'REVIEW_REQUIRED' }, true],
    ['credit, not assessed', { storeCreditForeign: '12.0000', storeCreditAssessment: null }, true],
    ['unreadable credit', { storeCreditForeign: 'garbage', storeCreditAssessment: 'ASSESSED' }, true],
    ['no credit (control)', { storeCreditForeign: '0.0000', storeCreditAssessment: 'ASSESSED' }, false],
  ]
  const rows: string[] = []
  for (const [name, over, refused] of cases) {
    state.row = { ...base, ...over }
    for (const [label, fn] of [['getInvoiceQueueData', () => getInvoiceQueueData('o1')], ['getAccountingInvoiceQueueData', () => getAccountingInvoiceQueueData('o1')]] as const) {
      let error: string | null = null
      try { await fn() } catch (e) { error = (e as Error).message }
      rows.push(`${name} / ${label}: ${error ? 'refused' : 'ok'}`)
      assert.equal(error !== null, refused, `${name} / ${label}`)
      if (refused) assert.match(error!, /^NOTHING WAS GENERATED OR SENT\./)
    }
    for (const kind of ['INVOICE', 'ACCOUNTING_INVOICE']) {
      if (!refused) continue
      // Prepared at SEND time: a row queued before the order was held, or retried later, is refused as well.
      await assert.rejects(() => prepareQueuedEmail(kind, 'SalesOrder', 'o1'), /^Error: NOTHING WAS GENERATED OR SENT\./, `${name} / outbox ${kind}`)
    }
  }
  // eslint-disable-next-line no-console
  console.log(`PRECONDITION customer document matrix:\n  ${rows.join('\n  ')}`)
  assert.ok(storeCreditInvoiceDocumentRefusal('CREDIT').includes('order confirmation is unaffected'))
  assert.match(storeCreditInvoiceDocumentRefusal('REVIEW'), /held for store-credit review/)
})
