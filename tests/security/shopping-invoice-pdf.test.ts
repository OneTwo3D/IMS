import assert from 'node:assert/strict'
import test from 'node:test'

import { NextRequest } from 'next/server'

import { handleShoppingInvoicePdfRoute } from '../../app/api/shopping/[connector]/invoice-pdf/route.ts'
import {
  createShoppingInvoicePdfRequestBody,
  parseShoppingInvoicePdfRequest,
  signShoppingInvoicePdfRequestBody,
} from '../../lib/shopping-invoice-pdf.ts'

const SECRET = 'shopping-invoice-secret'
const NOW = new Date('2026-06-10T12:00:00.000Z')

function signedRequest(body: string, signature = signShoppingInvoicePdfRequestBody(body, SECRET)): NextRequest {
  return new NextRequest('https://ims.example.test/api/shopping/woocommerce/invoice-pdf', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-oti-signature': signature,
    },
    body,
  })
}

function validBody(overrides: Partial<{
  externalOrderId: string
  externalCustomerId: string | null
  now: Date
  nonce: string
}> = {}): string {
  return createShoppingInvoicePdfRequestBody({
    connector: 'woocommerce',
    externalOrderId: overrides.externalOrderId ?? '123',
    externalCustomerId: overrides.externalCustomerId ?? '456',
    now: overrides.now ?? NOW,
    nonce: overrides.nonce ?? 'nonce-1',
  })
}

test('shopping invoice PDF requests parse only for matching connector and current request windows', () => {
  const body = validBody()

  assert.equal(parseShoppingInvoicePdfRequest(body, 'woocommerce', { now: NOW }).valid, true)
  assert.deepEqual(
    parseShoppingInvoicePdfRequest(body, 'shopify', { now: NOW }),
    { valid: false, reason: 'connector_mismatch' },
  )
  assert.deepEqual(
    parseShoppingInvoicePdfRequest(body, 'woocommerce', { now: new Date(NOW.getTime() + 301_000) }),
    { valid: false, reason: 'expired' },
  )
})

test('shopping invoice PDF route serves PDFs only after connector signature and order lookup pass', async () => {
  const audits: unknown[] = []
  const response = await handleShoppingInvoicePdfRoute(
    signedRequest(validBody()),
    { connector: 'woocommerce' },
    {
      async getPluginEnabled(connector) {
        assert.equal(connector, 'woocommerce')
        return true
      },
      async getSecret(connector) {
        assert.equal(connector, 'woocommerce')
        return SECRET
      },
      async findOrder(request) {
        assert.equal(request.connector, 'woocommerce')
        assert.equal(request.externalOrderId, '123')
        assert.equal(request.externalCustomerId, '456')
        return {
          orderId: 'so-1',
          invoiceNumber: 'INV/2026-001',
          invoicePdfPath: 'invoice-pdfs/so-1.pdf',
        }
      },
      async loadInvoicePdf(orderId) {
        assert.equal(orderId, 'so-1')
        return Buffer.from('%PDF-1.4 test')
      },
      async auditAttempt(input) {
        audits.push(input)
      },
      now: NOW,
    },
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('content-disposition'), 'inline; filename="invoice-INV_2026-001.pdf"')
  assert.deepEqual(audits, [{
    connector: 'woocommerce',
    accepted: true,
    externalOrderId: '123',
    orderId: 'so-1',
    reason: null,
  }])
})

test('shopping invoice PDF route rejects bad signatures before order lookup', async () => {
  let lookedUp = false
  const response = await handleShoppingInvoicePdfRoute(
    signedRequest(validBody(), 'bad-signature'),
    { connector: 'woocommerce' },
    {
      async getPluginEnabled() {
        return true
      },
      async getSecret() {
        return SECRET
      },
      async findOrder() {
        lookedUp = true
        return null
      },
      async loadInvoicePdf() {
        throw new Error('PDF storage should not be reached')
      },
      async auditAttempt(input) {
        assert.equal(input.accepted, false)
        assert.equal(input.reason, 'bad_signature')
      },
      now: NOW,
    },
  )

  assert.equal(response.status, 403)
  assert.equal(lookedUp, false)
  assert.deepEqual(await response.json(), { error: 'Invoice PDF is not available' })
})

test('shopping invoice PDF route rejects oversized request bodies before secret lookup', async () => {
  let secretRead = false
  const response = await handleShoppingInvoicePdfRoute(
    new NextRequest('https://ims.example.test/api/shopping/woocommerce/invoice-pdf', {
      method: 'POST',
      headers: {
        'content-length': '4097',
        'x-oti-signature': 'signature',
      },
      body: '{}',
    }),
    { connector: 'woocommerce' },
    {
      async getPluginEnabled() {
        return true
      },
      async getSecret() {
        secretRead = true
        return SECRET
      },
      async findOrder() {
        throw new Error('Order lookup should not be reached')
      },
      async loadInvoicePdf() {
        throw new Error('PDF storage should not be reached')
      },
      async auditAttempt() {},
      now: NOW,
    },
  )

  assert.equal(response.status, 413)
  assert.equal(secretRead, false)
  assert.deepEqual(await response.json(), { error: 'Shopping invoice PDF request body is too large.' })
})

test('shopping invoice PDF route rejects missing order links before loading storage', async () => {
  let loaded = false
  const response = await handleShoppingInvoicePdfRoute(
    signedRequest(validBody({ externalCustomerId: '999' })),
    { connector: 'woocommerce' },
    {
      async getPluginEnabled() {
        return true
      },
      async getSecret() {
        return SECRET
      },
      async findOrder(request) {
        assert.equal(request.externalCustomerId, '999')
        return null
      },
      async loadInvoicePdf() {
        loaded = true
        return Buffer.from('%PDF-1.4 test')
      },
      async auditAttempt(input) {
        assert.equal(input.accepted, false)
        assert.equal(input.reason, 'order_not_found')
      },
      now: NOW,
    },
  )

  assert.equal(response.status, 403)
  assert.equal(loaded, false)
})
