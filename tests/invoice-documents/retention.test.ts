import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * SIX YEARS, NO AUTOMATIC DELETE. The stored invoice and credit note PDFs are a statutory record. Nothing in
 * IMS may delete a document row or a stored PDF file; a retention job is an owner decision and, if ever built,
 * must change this test on purpose.
 */
const ROOTS = ['lib', 'app', 'scripts']

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'generated') continue
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) sources(full, out)
    else if (/\.(ts|tsx|mjs|mts)$/.test(entry)) out.push(full)
  }
  return out
}

const files = ROOTS.flatMap((root) => sources(root))

test('no code deletes invoice document rows or fetch state through the client', () => {
  const offenders = files.filter((file) => /\b(salesOrderInvoiceDocument|invoiceDocumentFetchState)\s*\.\s*(delete|deleteMany)\b/.test(readFileSync(file, 'utf8')))
  assert.deepEqual(offenders, [])
})

test('no raw SQL deletes from the document tables', () => {
  const offenders = files.filter((file) => /(DELETE\s+FROM|TRUNCATE)\s+"?(sales_order_invoice_documents|invoice_document_fetch_states)\b/i.test(readFileSync(file, 'utf8')))
  assert.deepEqual(offenders, [])
})

test('the invoice PDF storage module never removes a file', () => {
  const source = readFileSync('lib/invoice-pdf.ts', 'utf8')
  assert.doesNotMatch(source, /\b(unlink|rm|rmdir|rmSync|unlinkSync)\b/)
})

test('the document fetch never touches the ledger link column or writes to a ledger or storefront', () => {
  for (const file of [
    'lib/domain/invoice-documents/fetch-service.ts',
    'lib/domain/invoice-documents/sweep.ts',
    'lib/connectors/xero/invoice-document-source.ts',
  ]) {
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /accountingInvoiceId\s*:/, `${file} must not write accountingInvoiceId`)
    assert.doesNotMatch(source, /\b(xeroPost|xeroPut|xeroUploadAttachment|wcPost|wcPut)\b/, `${file} must stay read-only toward every vendor`)
  }
})

test('nothing publishes an invoice through the mutable flat file: the fetch never writes it, and every reader resolves the current document', () => {
  const service = readFileSync('lib/domain/invoice-documents/fetch-service.ts', 'utf8')
  assert.doesNotMatch(service, /saveInvoicePdfFile/, 'the fetch writes only immutable, hash-named files')
  const promotion = service.slice(service.indexOf('db.$transaction'), service.indexOf("if (recorded.kind === 'lost')"))
  assert.match(promotion, /leaseHolder: token/, 'the promotion is fenced by the lease token')
  assert.match(promotion, /invoicePdfPath: storedPath/, 'the compatibility pointer is written inside that same transaction')
  assert.doesNotMatch(service, /\bdb\.salesOrder\.update\(/, 'and never by a separate write outside the transaction')
  for (const reader of ['app/api/shopping/[connector]/invoice-pdf/route.ts', 'app/api/invoices/[id]/route.ts', 'app/api/invoice/[id]/route.ts', 'lib/order-email.ts']) {
    const source = readFileSync(reader, 'utf8')
    assert.match(source, /loadCurrentInvoicePdf/, `${reader} reads the current document`)
    assert.doesNotMatch(source, /import \{[^}]*\bloadInvoicePdf\b[^}]*\} from '@\/lib\/invoice-pdf'/, `${reader} does not read the flat file directly`)
  }
})
