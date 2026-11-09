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

function deps(over: { onDemand?: (orderId: string) => Promise<boolean>; nonceOk?: boolean; log: string[] }) {
  return {
    async getPluginEnabled() { return true },
    async getSecret() { return SECRET },
    async findOrder() { return { orderId: 'so-1', invoiceNumber: 'INV-1', invoicePdfPath: null } },
    async consumeNonce() { over.log.push('nonce'); return over.nonceOk ?? true },
    async loadInvoicePdf() { over.log.push('load'); return Buffer.from('%PDF-1.4 test') },
    async auditAttempt() {},
    ...(over.onDemand ? { ensureInvoiceOnDemand: async (orderId: string) => { over.log.push('lazy'); return over.onDemand!(orderId) } } : {}),
    now: NOW,
  }
}

test('an order with no stored PDF is fetched on demand after the nonce is spent, then served', async () => {
  const log: string[] = []
  const response = await handleShoppingInvoicePdfRoute(request(), { connector: 'woocommerce' }, deps({ log, onDemand: async (id) => { assert.equal(id, 'so-1'); return true } }))
  assert.equal(response.status, 200)
  assert.deepEqual(log, ['nonce', 'lazy', 'load'], 'the one-time nonce is spent BEFORE the ledger is asked')
})

test('a failed or declined on-demand fetch is the same 404 as before', async () => {
  const log: string[] = []
  const response = await handleShoppingInvoicePdfRoute(request(), { connector: 'woocommerce' }, deps({ log, onDemand: async () => false }))
  assert.equal(response.status, 404)
  assert.deepEqual(log, ['nonce', 'lazy'])
  const thrown: string[] = []
  const r2 = await handleShoppingInvoicePdfRoute(request(), { connector: 'woocommerce' }, deps({ log: thrown, onDemand: async () => { throw new Error('ledger down') } }))
  assert.equal(r2.status, 404)
})

test('a replayed request never reaches the ledger', async () => {
  const log: string[] = []
  const response = await handleShoppingInvoicePdfRoute(request(), { connector: 'woocommerce' }, deps({ log, nonceOk: false, onDemand: async () => true }))
  assert.equal(response.status, 403)
  assert.deepEqual(log, ['nonce'])
})

test('without an on-demand hook the old behaviour holds: 404 and the nonce is not spent', async () => {
  const log: string[] = []
  const response = await handleShoppingInvoicePdfRoute(request(), { connector: 'woocommerce' }, deps({ log }))
  assert.equal(response.status, 404)
  assert.deepEqual(log, [])
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
