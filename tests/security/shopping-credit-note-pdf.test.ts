import assert from 'node:assert/strict'
import test from 'node:test'

import { NextRequest } from 'next/server'

import { handleShoppingCreditNotePdfRoute } from '../../app/api/shopping/[connector]/credit-note-pdf/route.ts'
import { createShoppingInvoicePdfRequestBody, parseShoppingInvoicePdfRequest, signShoppingInvoicePdfRequestBody } from '../../lib/shopping-invoice-pdf.ts'

/**
 * The customer credit note route. Pure: every dependency is a double, so no database and no network is touched. The properties are the
 * invoice route's (signature, window, one-time nonce, ownership of the ORDER) plus the one this document adds: the refund must be one of
 * THAT order, and a refund of anybody else's order is "not found", never served.
 */

const SECRET = 'shopping-invoice-secret'
const NOW = new Date('2026-06-10T12:00:00.000Z')
const PDF = Buffer.from('%PDF-1.4 credit note test')

function body(over: { externalRefundId?: string | null; nonce?: string } = {}): string {
  return createShoppingInvoicePdfRequestBody({
    connector: 'woocommerce',
    externalOrderId: '123',
    externalCustomerId: '456',
    ...(over.externalRefundId === null ? {} : { externalRefundId: over.externalRefundId ?? '9' }),
    now: NOW,
    nonce: over.nonce ?? 'nonce-1',
  })
}

function request(raw = body(), signature?: string): NextRequest {
  return new NextRequest('https://ims.example.test/api/shopping/woocommerce/credit-note-pdf', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-oti-signature': signature ?? signShoppingInvoicePdfRequestBody(raw, SECRET) },
    body: raw,
  })
}

type Outcome = { status: 'preparing'; queued: boolean; retryAfterSeconds: number } | { status: 'throttled'; retryAfterSeconds: number } | { status: 'unavailable'; reason: string }

function deps(over: {
  log: string[]
  order?: { orderId: string; invoiceNumber: string | null; invoicePdfPath: string | null } | null
  refund?: { refundId: string; creditNoteNumber: string | null } | null
  pdf?: Buffer | null
  nonceOk?: boolean
  queue?: (orderId: string, refundId: string) => Promise<Outcome>
  enabled?: boolean
}) {
  return {
    async getPluginEnabled() { return over.enabled ?? true },
    async getSecret() { return SECRET },
    async findOrder() { over.log.push('order'); return over.order === undefined ? { orderId: 'so-1', invoiceNumber: 'INV-1', invoicePdfPath: 'x' } : over.order },
    async findRefund(orderId: string, externalRefundId: string) {
      over.log.push(`refund:${orderId}:${externalRefundId}`)
      return over.refund === undefined ? { refundId: 'rf-1', creditNoteNumber: 'CN-0001' } : over.refund
    },
    async consumeNonce() { over.log.push('nonce'); return over.nonceOk ?? true },
    async loadCreditNotePdf(orderId: string, refundId: string) { over.log.push(`load:${orderId}:${refundId}`); return over.pdf === undefined ? PDF : over.pdf },
    ...(over.queue ? { requestCreditNoteOnDemand: async (orderId: string, refundId: string) => { over.log.push('queue'); return over.queue!(orderId, refundId) } } : {}),
    async auditAttempt(input: { accepted: boolean; reason?: string | null; document?: string }) { over.log.push(`audit:${input.accepted ? 'ok' : 'no'}:${input.reason ?? ''}:${input.document ?? ''}`) },
    now: NOW,
  }
}

test('the signed request carries the refund id and the parser hands it on; an invoice request has none', () => {
  const parsed = parseShoppingInvoicePdfRequest(body(), 'woocommerce', { now: NOW })
  assert.equal(parsed.valid && parsed.request.externalRefundId, '9')
  const plain = parseShoppingInvoicePdfRequest(body({ externalRefundId: null }), 'woocommerce', { now: NOW })
  assert.equal(plain.valid && plain.request.externalRefundId, undefined)
  const bad = JSON.stringify({ ...JSON.parse(body()), externalRefundId: '' })
  assert.deepEqual(parseShoppingInvoicePdfRequest(bad, 'woocommerce', { now: NOW }), { valid: false, reason: 'malformed' })
})

test('a stored credit note is served to the owner of the order, as its own document', async () => {
  const log: string[] = []
  const response = await handleShoppingCreditNotePdfRoute(request(), { connector: 'woocommerce' }, deps({ log }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.match(response.headers.get('content-disposition') ?? '', /credit-note-CN-0001\.pdf/)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PDF)
  assert.deepEqual(log, ['order', 'refund:so-1:9', 'nonce', 'load:so-1:rf-1', 'audit:ok::credit_note'])
})

test('OWNERSHIP: an order the caller does not own is refused before any refund is read or any document loaded', async () => {
  const log: string[] = []
  const response = await handleShoppingCreditNotePdfRoute(request(), { connector: 'woocommerce' }, deps({ log, order: null }))
  assert.equal(response.status, 403)
  assert.deepEqual(log, ['order', 'audit:no:order_not_found:credit_note'])
})

test('OWNERSHIP: a refund that is not on the proved order is "not found" and is never loaded or queued', async () => {
  const log: string[] = []
  const response = await handleShoppingCreditNotePdfRoute(request(), { connector: 'woocommerce' }, deps({
    log, refund: null, queue: async () => { throw new Error('must not queue a refund of another order') },
  }))
  assert.equal(response.status, 404)
  assert.deepEqual(log, ['order', 'refund:so-1:9', 'audit:no:refund_not_found:credit_note'])
  assert.ok(!log.some((entry) => entry.startsWith('load') || entry === 'nonce' || entry === 'queue'))
})

test('the lookup is scoped by the proved order id, never by the refund id alone', async () => {
  const log: string[] = []
  await handleShoppingCreditNotePdfRoute(request(), { connector: 'woocommerce' }, deps({ log, order: { orderId: 'so-OWN', invoiceNumber: null, invoicePdfPath: null } }))
  assert.ok(log.includes('refund:so-OWN:9'), 'the refund is asked for inside the proved order')
  assert.ok(log.includes('load:so-OWN:rf-1'), 'and the document is loaded for that same order')
})

test('a request without a refund id is refused (the invoice is never served in its place)', async () => {
  const log: string[] = []
  const response = await handleShoppingCreditNotePdfRoute(request(body({ externalRefundId: null })), { connector: 'woocommerce' }, deps({ log }))
  assert.equal(response.status, 403)
  assert.deepEqual(log, ['audit:no:refund_id_missing:credit_note'])
})

test('a bad signature, a replayed nonce, a disabled connector and an unknown connector are refused', async () => {
  const log: string[] = []
  assert.equal((await handleShoppingCreditNotePdfRoute(request(body(), 'deadbeef'), { connector: 'woocommerce' }, deps({ log }))).status, 403)
  assert.deepEqual(log, ['audit:no:bad_signature:credit_note'])
  const replay: string[] = []
  assert.equal((await handleShoppingCreditNotePdfRoute(request(), { connector: 'woocommerce' }, deps({ log: replay, nonceOk: false }))).status, 403)
  assert.ok(!replay.some((entry) => entry.startsWith('load')))
  assert.equal((await handleShoppingCreditNotePdfRoute(request(), { connector: 'woocommerce' }, deps({ log: [], enabled: false }))).status, 423)
  assert.equal((await handleShoppingCreditNotePdfRoute(request(), { connector: 'nope' }, deps({ log: [] }))).status, 404)
})

test('a credit note IMS does not hold is QUEUED and answered "preparing"; a later click is served', async () => {
  const log: string[] = []
  const first = await handleShoppingCreditNotePdfRoute(request(), { connector: 'woocommerce' }, deps({
    log, pdf: null, queue: async (orderId, refundId) => { assert.deepEqual([orderId, refundId], ['so-1', 'rf-1']); return { status: 'preparing', queued: true, retryAfterSeconds: 900 } },
  }))
  assert.equal(first.status, 202)
  assert.equal(first.headers.get('retry-after'), '900')
  assert.deepEqual(await first.json(), { status: 'preparing', retryAfterSeconds: 900 })
  const later = await handleShoppingCreditNotePdfRoute(request(body({ nonce: 'nonce-2' })), { connector: 'woocommerce' }, deps({ log: [], pdf: PDF }))
  assert.equal(later.status, 200)
})

test('a full queue is 429, and an unavailable or failing queue is 404', async () => {
  assert.equal((await handleShoppingCreditNotePdfRoute(request(), { connector: 'woocommerce' }, deps({ log: [], pdf: null, queue: async () => ({ status: 'throttled', retryAfterSeconds: 60 }) }))).status, 429)
  assert.equal((await handleShoppingCreditNotePdfRoute(request(), { connector: 'woocommerce' }, deps({ log: [], pdf: null, queue: async () => ({ status: 'unavailable', reason: 'off' }) }))).status, 404)
  assert.equal((await handleShoppingCreditNotePdfRoute(request(), { connector: 'woocommerce' }, deps({ log: [], pdf: null, queue: async () => { throw new Error('down') } }))).status, 404)
  assert.equal((await handleShoppingCreditNotePdfRoute(request(), { connector: 'woocommerce' }, deps({ log: [], pdf: null }))).status, 404)
})
