import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { NextRequest } from 'next/server'

import { handleShoppingInvoicePdfRoute } from '../../app/api/shopping/[connector]/invoice-pdf/route.ts'
import { WC_INVOICE_DOCUMENT_META_KEY, WC_INVOICE_DOCUMENT_META_VALUE } from '../../lib/domain/invoice-documents/storefront-contract.ts'
import {
  createShoppingInvoicePdfRequestBody,
  parseShoppingInvoicePdfRequest,
  SHOPPING_INVOICE_PDF_TTL_SECONDS,
  signShoppingInvoicePdfRequestBody,
} from '../../lib/shopping-invoice-pdf.ts'

/**
 * THE HELPER-PLUGIN CONTRACT, pinned from both sides. The WooCommerce plugin is not changed or run here (the owner rule: only the IMS is
 * worked on); this test reads its source as shipped in the repository and the fixture beside it, and checks that what the plugin reads
 * from an order, what it sends to IMS and what it expects back is exactly what IMS writes, parses and answers. No network, no database.
 */

type Contract = {
  orderMeta: {
    downloadFlag: { key: string; valueThatShowsTheButton: string }
    accountingUrl: { key: string }
    imsWritesOnPublish: { meta_data: Array<{ key: string; value: string }> }
    flaglessHistoricOrders: { invoiceNumberMetaIMSReads: string; imsEndpointAnswersFlaglessOrders: boolean }
  }
  signedRequest: { endpointPath: string; creditNoteEndpointPath: string; signatureHeader: string; bodyKeysTheInvoiceRequestSends: string[]; additionalKeyOfACreditNoteRequest: string; ttlSecondsMax: number }
  answers: { served: { status: number }; preparing: { status: number; bodyKeys: string[]; statusValue: string; headers: string[] }; busy: { status: number }; notAvailable: { status: number } }
}

const FIXTURE: Contract = JSON.parse(readFileSync('tests/fixtures/woo-helper-invoice-contract.json', 'utf8'))
const PHP = readFileSync('lib/connectors/woocommerce/wp-plugin/onetwoinventory-helper.php', 'utf8')
const NOW = new Date('2026-06-10T12:00:00.000Z')
const SECRET = 'placeholder-secret'

function phpFunction(name: string): string {
  const start = PHP.indexOf(`function ${name}(`)
  assert.ok(start > 0, `${name} exists in the plugin`)
  const next = PHP.indexOf('\nif (!function_exists(', start)
  return PHP.slice(start, next > 0 ? next : undefined)
}

test('the plugin shows the button only for the flag value and key IMS writes', () => {
  const reader = phpFunction('oti_order_has_invoice_pdf')
  assert.match(reader, new RegExp(`oti_get_order_meta\\(\\$order_id, '${FIXTURE.orderMeta.downloadFlag.key}'\\) === '${FIXTURE.orderMeta.downloadFlag.valueThatShowsTheButton}'`))
  assert.equal(WC_INVOICE_DOCUMENT_META_KEY, FIXTURE.orderMeta.downloadFlag.key, 'IMS writes the key the plugin reads')
  assert.equal(WC_INVOICE_DOCUMENT_META_VALUE, FIXTURE.orderMeta.downloadFlag.valueThatShowsTheButton)
  assert.deepEqual(FIXTURE.orderMeta.imsWritesOnPublish.meta_data, [{ key: WC_INVOICE_DOCUMENT_META_KEY, value: WC_INVOICE_DOCUMENT_META_VALUE }])
})

test('every order meta key the plugin reads for the invoice is in the fixture, and nothing else', () => {
  // The invoice module of the plugin only (the plugin reads other meta for its warehouse-status module, which is not this contract).
  const invoiceModule = PHP.slice(PHP.indexOf('Module 1 — Invoice Buttons'), PHP.indexOf('Module 1b'))
  assert.ok(invoiceModule.length > 100, 'the invoice module was found')
  const read = [...invoiceModule.matchAll(/oti_get_order_meta\(\$order_id, '([^']+)'\)/g)].map((m) => m[1]).sort()
  const expected = [FIXTURE.orderMeta.downloadFlag.key, FIXTURE.orderMeta.accountingUrl.key].sort()
  assert.deepEqual([...new Set(read)], expected, 'the plugin reads a meta key the contract does not list (or stopped reading one it lists)')
})

test('the plugin sends exactly the body keys IMS parses, and signs it with the signature header IMS verifies', () => {
  const proxy = phpFunction('oti_proxy_invoice_pdf')
  const payload = proxy.slice(proxy.indexOf('$payload = ['), proxy.indexOf('];', proxy.indexOf('$payload = [')))
  const keys = [...payload.matchAll(/'([A-Za-z]+)'\s*=>/g)].map((m) => m[1])
  assert.deepEqual(keys, FIXTURE.signedRequest.bodyKeysTheInvoiceRequestSends)
  assert.match(proxy, new RegExp(`'${FIXTURE.signedRequest.signatureHeader}'\\s*=>\\s*hash_hmac\\('sha256', \\$body, \\$secret\\)`), 'HMAC-SHA256 of the raw body')
  assert.match(proxy, new RegExp(`'expiresAt'\\s*=>\\s*\\$now \\+ ${FIXTURE.signedRequest.ttlSecondsMax}`))
  assert.equal(SHOPPING_INVOICE_PDF_TTL_SECONDS, FIXTURE.signedRequest.ttlSecondsMax)
  assert.match(PHP, new RegExp(`\\$base \\. '${FIXTURE.signedRequest.endpointPath.replace(/\//g, '\\/')}'`), 'the plugin builds the endpoint IMS serves')
  // A body built from those keys is accepted by the IMS parser as it is.
  const body = createShoppingInvoicePdfRequestBody({ connector: 'woocommerce', externalOrderId: '1', externalCustomerId: '2', externalOrderKey: 'wc_order_placeholder', now: NOW, nonce: 'n' })
  assert.deepEqual(Object.keys(JSON.parse(body)).sort(), [...FIXTURE.signedRequest.bodyKeysTheInvoiceRequestSends].sort())
  assert.equal(parseShoppingInvoicePdfRequest(body, 'woocommerce', { now: NOW }).valid, true)
})

test('a credit note request is the invoice request plus the refund id', () => {
  const body = createShoppingInvoicePdfRequestBody({ connector: 'woocommerce', externalOrderId: '1', externalCustomerId: '2', externalRefundId: 7, now: NOW, nonce: 'n' })
  assert.ok(FIXTURE.signedRequest.additionalKeyOfACreditNoteRequest in JSON.parse(body))
  const parsed = parseShoppingInvoicePdfRequest(body, 'woocommerce', { now: NOW })
  assert.equal(parsed.valid && parsed.request.externalRefundId, '7')
})

test('the plugin streams only a 200 and turns anything else into an error (so a "preparing" answer needs no new plugin code to be safe)', () => {
  const proxy = phpFunction('oti_proxy_invoice_pdf')
  assert.match(proxy, /if \(\$code !== 200 \|\| \$pdf === ''\)/)
  assert.match(proxy, /\$code >= 400 \? \$code : 502/)
  assert.equal(FIXTURE.answers.served.status, 200)
})

function fixtureRequest(): NextRequest {
  const body = createShoppingInvoicePdfRequestBody({ connector: 'woocommerce', externalOrderId: '123', externalCustomerId: '456', now: NOW, nonce: 'n-1' })
  return new NextRequest('https://ims.example.test' + FIXTURE.signedRequest.endpointPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [FIXTURE.signedRequest.signatureHeader]: signShoppingInvoicePdfRequestBody(body, SECRET) },
    body,
  })
}

function routeDeps(over: { path: string | null; outcome: unknown }) {
  return {
    async getPluginEnabled() { return true },
    async getSecret() { return SECRET },
    async findOrder() { return { orderId: 'so-1', invoiceNumber: 'INV-1', invoicePdfPath: over.path } },
    async consumeNonce() { return true },
    async loadInvoicePdf() { return Buffer.from('%PDF-1.4 placeholder') },
    async auditAttempt() {},
    requestInvoiceOnDemand: async () => over.outcome as never,
    now: NOW,
  }
}

test('IMS answers exactly as the contract says: served, preparing, busy, not available', async () => {
  // The flag-less historic order is answered by the same endpoint: its order row has no stored PDF yet.
  assert.equal(FIXTURE.orderMeta.flaglessHistoricOrders.imsEndpointAnswersFlaglessOrders, true)
  const preparing = await handleShoppingInvoicePdfRoute(fixtureRequest(), { connector: 'woocommerce' }, routeDeps({ path: null, outcome: { status: 'preparing', queued: true, retryAfterSeconds: 900 } }))
  assert.equal(preparing.status, FIXTURE.answers.preparing.status)
  assert.deepEqual(Object.keys(await preparing.json()), FIXTURE.answers.preparing.bodyKeys)
  for (const header of FIXTURE.answers.preparing.headers) assert.ok(preparing.headers.get(header), `${header} is set`)
  assert.equal(preparing.headers.get('X-IMS-Invoice-Status'), FIXTURE.answers.preparing.statusValue)

  const busy = await handleShoppingInvoicePdfRoute(fixtureRequest(), { connector: 'woocommerce' }, routeDeps({ path: null, outcome: { status: 'throttled', retryAfterSeconds: 60 } }))
  assert.equal(busy.status, FIXTURE.answers.busy.status)
  assert.ok(busy.headers.get('Retry-After'))

  const missing = await handleShoppingInvoicePdfRoute(fixtureRequest(), { connector: 'woocommerce' }, routeDeps({ path: null, outcome: { status: 'unavailable', reason: 'x' } }))
  assert.equal(missing.status, FIXTURE.answers.notAvailable.status)

  const served = await handleShoppingInvoicePdfRoute(fixtureRequest(), { connector: 'woocommerce' }, routeDeps({ path: 'invoice-pdfs/so-1.pdf', outcome: { status: 'unavailable', reason: 'unused' } }))
  assert.equal(served.status, FIXTURE.answers.served.status)
  assert.equal(served.headers.get('content-type'), 'application/pdf')
})

test('the fixture holds no customer data', () => {
  const text = readFileSync('tests/fixtures/woo-helper-invoice-contract.json', 'utf8')
  assert.doesNotMatch(text, /@[a-z0-9-]+\./i, 'no e-mail address')
  assert.doesNotMatch(text, /\b\d{6,}\b/, 'no long number that could be an id or a phone')
})
