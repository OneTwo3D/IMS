import assert from 'node:assert/strict'
import test from 'node:test'

import { NextRequest } from 'next/server'

import { handleShoppingInvoicePdfRoute } from '../../app/api/shopping/[connector]/invoice-pdf/route.ts'
import { createShoppingInvoicePdfRequestBody, signShoppingInvoicePdfRequestBody } from '../../lib/shopping-invoice-pdf.ts'

const SECRET = 'shopping-invoice-secret'
const NOW = new Date('2026-06-10T12:00:00.000Z')

function request(): NextRequest {
  const body = createShoppingInvoicePdfRequestBody({ connector: 'woocommerce', externalOrderId: '123', externalCustomerId: '456', now: NOW, nonce: 'nonce-1' })
  return new NextRequest('https://ims.example.test/api/shopping/woocommerce/invoice-pdf', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-oti-signature': signShoppingInvoicePdfRequestBody(body, SECRET) },
    body,
  })
}

type Outcome = { status: 'preparing'; queued: boolean; retryAfterSeconds: number } | { status: 'throttled'; retryAfterSeconds: number } | { status: 'unavailable'; reason: string }

function deps(over: { onDemand?: (orderId: string) => Promise<Outcome>; nonceOk?: boolean; log: string[] }) {
  return {
    async getPluginEnabled() { return true },
    async getSecret() { return SECRET },
    async findOrder() { return { orderId: 'so-1', invoiceNumber: 'INV-1', invoicePdfPath: null } },
    async consumeNonce() { over.log.push('nonce'); return over.nonceOk ?? true },
    async loadInvoicePdf() { over.log.push('load'); return Buffer.from('%PDF-1.4 test') },
    async auditAttempt() {},
    ...(over.onDemand ? { requestInvoiceOnDemand: async (orderId: string) => { over.log.push('queue'); return over.onDemand!(orderId) } } : {}),
    now: NOW,
  }
}

test('an order with no stored PDF is QUEUED after the nonce is spent and answered "preparing": nothing is served, nothing is loaded', async () => {
  const log: string[] = []
  const response = await handleShoppingInvoicePdfRoute(request(), { connector: 'woocommerce' }, deps({ log, onDemand: async (id) => { assert.equal(id, 'so-1'); return { status: 'preparing', queued: true, retryAfterSeconds: 900 } } }))
  assert.equal(response.status, 202)
  assert.equal(response.headers.get('retry-after'), '900')
  assert.equal(response.headers.get('x-ims-invoice-status'), 'preparing')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await response.json(), { status: 'preparing', retryAfterSeconds: 900 }, 'no document and no customer data in the answer')
  assert.deepEqual(log, ['nonce', 'queue'], 'the one-time nonce is spent BEFORE anything is queued, and the PDF is not loaded')
})

test('a click that finds the request already queued is the same "preparing" answer (the queue de-duplicates)', async () => {
  const log: string[] = []
  const response = await handleShoppingInvoicePdfRoute(request(), { connector: 'woocommerce' }, deps({ log, onDemand: async () => ({ status: 'preparing', queued: false, retryAfterSeconds: 600 }) }))
  assert.equal(response.status, 202)
  assert.equal(response.headers.get('retry-after'), '600')
})

test('a full queue answers 429 with Retry-After and nothing else', async () => {
  const log: string[] = []
  const response = await handleShoppingInvoicePdfRoute(request(), { connector: 'woocommerce' }, deps({ log, onDemand: async () => ({ status: 'throttled', retryAfterSeconds: 3600 }) }))
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '3600')
})

test('a declined or failed queueing is the same 404 as before', async () => {
  const log: string[] = []
  const response = await handleShoppingInvoicePdfRoute(request(), { connector: 'woocommerce' }, deps({ log, onDemand: async () => ({ status: 'unavailable', reason: 'off' }) }))
  assert.equal(response.status, 404)
  assert.deepEqual(log, ['nonce', 'queue'])
  const thrown: string[] = []
  const r2 = await handleShoppingInvoicePdfRoute(request(), { connector: 'woocommerce' }, deps({ log: thrown, onDemand: async () => { throw new Error('database down') } }))
  assert.equal(r2.status, 404)
})

test('a replayed request never reaches the queue', async () => {
  const log: string[] = []
  const response = await handleShoppingInvoicePdfRoute(request(), { connector: 'woocommerce' }, deps({ log, nonceOk: false, onDemand: async () => ({ status: 'preparing', queued: true, retryAfterSeconds: 900 }) }))
  assert.equal(response.status, 403)
  assert.deepEqual(log, ['nonce'])
})

test('without an on-demand hook the old behaviour holds: 404 and the nonce is not spent', async () => {
  const log: string[] = []
  const response = await handleShoppingInvoicePdfRoute(request(), { connector: 'woocommerce' }, deps({ log }))
  assert.equal(response.status, 404)
  assert.deepEqual(log, [])
})

test('a LATER click, once the PDF is stored, is served it (no queueing)', async () => {
  const log: string[] = []
  const base = deps({ log, onDemand: async () => { throw new Error('must not be asked when a PDF is stored') } })
  const served = { ...base, async findOrder() { return { orderId: 'so-1', invoiceNumber: 'INV-1', invoicePdfPath: 'invoice-pdfs/so-1.pdf' } } }
  const response = await handleShoppingInvoicePdfRoute(request(), { connector: 'woocommerce' }, served)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  assert.deepEqual(log, ['nonce', 'load'])
})

test('a stored PDF is looked at again (the ledger may have amended it) after the nonce is spent, and a failure there still serves what is stored', async () => {
  const log: string[] = []
  const base = deps({ log })
  const withStored = {
    ...base,
    async findOrder() { return { orderId: 'so-1', invoiceNumber: 'INV-1', invoicePdfPath: 'invoice-pdfs/so-1.pdf' } },
    async refreshStaleInvoice(orderId: string) { log.push(`refresh:${orderId}`) },
  }
  const ok = await handleShoppingInvoicePdfRoute(request(), { connector: 'woocommerce' }, withStored)
  assert.equal(ok.status, 200)
  assert.deepEqual(log, ['nonce', 'refresh:so-1', 'load'])

  const failing = { ...withStored, async refreshStaleInvoice() { throw new Error('ledger down') } }
  const still = await handleShoppingInvoicePdfRoute(request(), { connector: 'woocommerce' }, failing)
  assert.equal(still.status, 200, 'the stored PDF is served')
})
