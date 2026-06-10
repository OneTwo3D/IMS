import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import test from 'node:test'

import { NextRequest } from 'next/server'

import { handleInvoicePdfRoute } from '../../app/api/invoices/[id]/route.ts'
import {
  signPdfToken,
  verifyPdfTokenDetailed,
  type InvoicePdfTokenBinding,
  type InvoicePdfTokenPayload,
  type PdfTokenVerificationResult,
} from '../../lib/invoice-pdf.ts'
import { withEnvPatch } from '../helpers/env.ts'

const SECRET = 'invoice-pdf-test-secret'
const NOW = new Date('2026-05-27T10:00:00.000Z')
const NOW_SECONDS = seconds(NOW)
const BINDING: InvoicePdfTokenBinding = {
  sessionId: 'user-1:2:1770000000',
  clientIp: '203.0.113.10',
}

async function withInvoiceTokenEnv<T>(
  env: Record<string, string | undefined>,
  run: () => Promise<T> | T,
): Promise<T> {
  return withEnvPatch({
    AUTH_SECRET: SECRET,
    NEXTAUTH_SECRET: undefined,
    INVOICE_PDF_TOKEN_TTL_SECONDS: undefined,
    ...env,
  }, run)
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000)
}

function signedPayload(payload: Record<string, unknown>): string {
  // Test helper for validly signed malformed/forged payloads. Real callers must use signPdfToken().
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', SECRET).update(encodedPayload, 'utf8').digest('hex')
  return `${encodedPayload}.${signature}`
}

function bareDeterministicToken(orderId: string): string {
  return createHmac('sha256', SECRET).update(orderId, 'utf8').digest('hex')
}

function validPayload(overrides: Partial<InvoicePdfTokenPayload> = {}): InvoicePdfTokenPayload {
  return {
    v: 1,
    sub: 'order-1',
    purpose: 'invoice-pdf',
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 60,
    nonce: 'nonce-1',
    ...overrides,
  }
}

test('invoice PDF tokens verify while inside their configured TTL', async () => {
  await withInvoiceTokenEnv({ INVOICE_PDF_TOKEN_TTL_SECONDS: '120' }, () => {
    const token = signPdfToken('order-1', { now: NOW, nonce: 'nonce-1', binding: BINDING })
    const result = verifyPdfTokenDetailed('order-1', token, {
      now: new Date(NOW.getTime() + 119_000),
      binding: BINDING,
      requireBinding: true,
    })

    assert.equal(result.valid, true)
    assert.equal(result.payload.v, 1)
    assert.equal(result.payload.sub, 'order-1')
    assert.equal(result.payload.purpose, 'invoice-pdf')
    assert.equal(result.payload.iat, NOW_SECONDS)
    assert.equal(result.payload.exp, NOW_SECONDS + 120)
    assert.equal(result.payload.nonce, 'nonce-1')
    assert.equal(result.payload.sid?.includes(BINDING.sessionId), false)
    assert.equal(result.payload.ip?.includes(BINDING.clientIp), false)
  })
})

test('invoice PDF token signing is deterministic when the nonce and clock are fixed', async () => {
  await withInvoiceTokenEnv({ INVOICE_PDF_TOKEN_TTL_SECONDS: '120' }, () => {
    const first = signPdfToken('order-1', { now: NOW, nonce: 'nonce-1', binding: BINDING })
    const second = signPdfToken('order-1', { now: NOW, nonce: 'nonce-1', binding: BINDING })

    assert.equal(first, second)
  })
})

test('invoice PDF tokens expire at the expiry boundary', async () => {
  await withInvoiceTokenEnv({}, () => {
    const token = signPdfToken('order-1', { now: NOW, ttlSeconds: 10, nonce: 'nonce-1', binding: BINDING })
    const result = verifyPdfTokenDetailed('order-1', token, {
      now: new Date(NOW.getTime() + 10_000),
      binding: BINDING,
      requireBinding: true,
    })

    assert.deepEqual(result, { valid: false, reason: 'expired' })
  })
})

test('invoice PDF token signing rejects invalid TTL options', async () => {
  await withInvoiceTokenEnv({}, () => {
    assert.throws(
      () => signPdfToken('order-1', { now: NOW, ttlSeconds: 0, nonce: 'nonce-1' }),
      /positive integer/,
    )
    assert.throws(
      () => signPdfToken('order-1', { now: NOW, ttlSeconds: 10 * 60 + 1, nonce: 'nonce-1' }),
      /must not exceed/,
    )
  })
})

test('invoice PDF token verification rejects copied tokens from another session or IP', async () => {
  await withInvoiceTokenEnv({}, () => {
    const token = signPdfToken('order-1', { now: NOW, nonce: 'nonce-1', binding: BINDING })

    assert.deepEqual(
      verifyPdfTokenDetailed('order-1', token, {
        now: NOW,
        requireBinding: true,
        binding: { ...BINDING, sessionId: 'user-2:2:1770000000' },
      }),
      { valid: false, reason: 'wrong_session' },
    )
    assert.deepEqual(
      verifyPdfTokenDetailed('order-1', token, {
        now: NOW,
        requireBinding: true,
        binding: { ...BINDING, clientIp: '203.0.113.11' },
      }),
      { valid: false, reason: 'wrong_ip' },
    )
    assert.deepEqual(
      verifyPdfTokenDetailed('order-1', token, { now: NOW, requireBinding: true }),
      { valid: false, reason: 'missing_binding' },
    )
  })
})

test('invoice PDF route rejects validly signed but unbound tokens before storage access', async () => {
  await withInvoiceTokenEnv({}, async () => {
    const token = signPdfToken('order-1', { now: NOW, nonce: 'nonce-1' })
    let loaded = false
    const response = await handleInvoicePdfRoute(
      new NextRequest(`http://ims.test/api/invoices/order-1?token=${token}`),
      { id: 'order-1' },
      {
        async loadInvoicePdf() {
          loaded = true
          return Buffer.from('%PDF-1.4 test')
        },
        verifyPdfToken: verifyPdfTokenDetailed,
        async auditTokenAttempt() {},
        async getTokenBinding() {
          return BINDING
        },
      },
    )

    assert.equal(response.status, 403)
    assert.equal(loaded, false)
  })
})

test('invoice PDF token verification rejects wrong purpose and wrong order ids', async () => {
  await withInvoiceTokenEnv({}, () => {
    assert.deepEqual(
      verifyPdfTokenDetailed(
        'order-1',
        signedPayload({ ...validPayload(), purpose: 'packing-slip' }),
        { now: NOW },
      ),
      { valid: false, reason: 'wrong_purpose' },
    )

    const token = signedPayload(validPayload())
    assert.deepEqual(
      verifyPdfTokenDetailed('order-2', token, { now: NOW }),
      { valid: false, reason: 'wrong_order' },
    )
  })
})

test('invoice PDF token verification rejects malformed signed payloads', async () => {
  await withInvoiceTokenEnv({}, () => {
    assert.deepEqual(
      verifyPdfTokenDetailed('order-1', signedPayload({ ...validPayload(), purpose: 123 }), { now: NOW }),
      { valid: false, reason: 'malformed' },
    )
    assert.deepEqual(
      verifyPdfTokenDetailed('order-1', signedPayload(validPayload({ sub: '' })), { now: NOW }),
      { valid: false, reason: 'malformed' },
    )
    assert.deepEqual(
      verifyPdfTokenDetailed('order-1', signedPayload(validPayload({ iat: NOW_SECONDS + 61 })), { now: NOW }),
      { valid: false, reason: 'malformed' },
    )
  })
})

test('invoice PDF token verification rejects invalid version and TTL windows', async () => {
  await withInvoiceTokenEnv({}, () => {
    assert.deepEqual(
      verifyPdfTokenDetailed('order-1', signedPayload({ ...validPayload(), v: 2 }), { now: NOW }),
      { valid: false, reason: 'wrong_version' },
    )
    assert.deepEqual(
      verifyPdfTokenDetailed(
        'order-1',
        signedPayload(validPayload({ exp: NOW_SECONDS + 30 * 24 * 60 * 60 + 1 })),
        { now: NOW },
      ),
      { valid: false, reason: 'ttl_exceeded' },
    )
    assert.deepEqual(
      verifyPdfTokenDetailed(
        'order-1',
        signedPayload(validPayload({
          iat: NOW_SECONDS + 6 * 60,
          exp: NOW_SECONDS + 6 * 60 + 60,
        })),
        { now: NOW },
      ),
      { valid: false, reason: 'not_yet_valid' },
    )
  })
})

test('invoice PDF token verification rejects malformed token envelopes and tampered payloads', async () => {
  await withInvoiceTokenEnv({}, () => {
    const token = signPdfToken('order-1', { now: NOW, ttlSeconds: 60, nonce: 'nonce-1' })
    const [encodedPayload, signature] = token.split('.')
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as InvoicePdfTokenPayload
    const tamperedPayload = Buffer.from(JSON.stringify({ ...payload, sub: 'order-2' }), 'utf8').toString('base64url')

    assert.deepEqual(
      verifyPdfTokenDetailed('order-1', `${tamperedPayload}.${signature}`, { now: NOW }),
      { valid: false, reason: 'bad_signature' },
    )
    assert.deepEqual(
      verifyPdfTokenDetailed('order-1', `${encodedPayload}.${signature}.extra`, { now: NOW }),
      { valid: false, reason: 'malformed' },
    )
  })
})

test('old deterministic invoice PDF tokens are rejected as malformed tokens', async () => {
  await withInvoiceTokenEnv({}, () => {
    assert.deepEqual(
      verifyPdfTokenDetailed('order-1', bareDeterministicToken('order-1'), { now: NOW }),
      { valid: false, reason: 'malformed' },
    )
  })
})

test('invoice PDF route audits rejected token attempts without logging token values', async () => {
  const token = `secret-token-value-${randomBytes(8).toString('hex')}`
  const audits: Array<{
    orderId: string
    verification: PdfTokenVerificationResult
    tokenPresent: boolean
    tokenLength: number
  }> = []
  const response = await handleInvoicePdfRoute(
    new NextRequest(`http://ims.test/api/invoices/order-1?token=${token}`),
    { id: 'order-1' },
    {
      async loadInvoicePdf() {
        throw new Error('PDF storage should not be reached for rejected tokens')
      },
      verifyPdfToken() {
        return { valid: false, reason: 'bad_signature' }
      },
      async auditTokenAttempt(input) {
        audits.push(input)
      },
    },
  )

  assert.equal(response.status, 403)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(audits.length, 1)
  assert.equal(audits[0].orderId, 'order-1')
  assert.equal(audits[0].tokenPresent, true)
  assert.equal(audits[0].tokenLength, token.length)
  assert.deepEqual(audits[0].verification, { valid: false, reason: 'bad_signature' })
  assert.doesNotMatch(JSON.stringify(audits), /secret-token-value/)
})

test('invoice PDF route audits accepted tokens and serves PDFs with no-store caching', async () => {
  const audits: Array<{
    orderId: string
    verification: PdfTokenVerificationResult
    tokenPresent: boolean
    tokenLength: number
  }> = []
  const response = await handleInvoicePdfRoute(
    new NextRequest('http://ims.test/api/invoices/order-1?token=valid-token'),
    { id: 'order-1' },
    {
      async loadInvoicePdf(orderId) {
        assert.equal(orderId, 'order-1')
        return Buffer.from('%PDF-1.4 test')
      },
      verifyPdfToken(orderId) {
        assert.equal(orderId, 'order-1')
        return {
          valid: true,
          payload: validPayload(),
        }
      },
      async auditTokenAttempt(input) {
        audits.push(input)
      },
    },
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(audits.length, 1)
  assert.equal(audits[0].orderId, 'order-1')
  assert.equal(audits[0].tokenPresent, true)
  assert.equal(audits[0].tokenLength, 'valid-token'.length)
  assert.equal(audits[0].verification.valid, true)
  if (audits[0].verification.valid) {
    assert.equal(audits[0].verification.payload.sub, 'order-1')
  }
  assert.doesNotMatch(JSON.stringify(audits), /valid-token/)
})

test('invoice PDF route sanitizes the Content-Disposition filename', async () => {
  const unsafeId = 'order"\r\nSet-Cookie:x'
  const response = await handleInvoicePdfRoute(
    new NextRequest('http://ims.test/api/invoices/order?token=valid-token'),
    { id: unsafeId },
    {
      async loadInvoicePdf(orderId) {
        assert.equal(orderId, unsafeId)
        return Buffer.from('%PDF-1.4 test')
      },
      verifyPdfToken(orderId) {
        assert.equal(orderId, unsafeId)
        return { valid: true, payload: validPayload({ sub: unsafeId, nonce: 'download-nonce-1' }) }
      },
      async auditTokenAttempt() {},
    },
  )

  assert.equal(response.status, 200)
  assert.equal(
    response.headers.get('content-disposition'),
    'inline; filename="invoice-download-nonce-1.pdf"',
  )
})

test('invoice PDF route audit failures do not block accepted downloads', async () => {
  const originalWarn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args: unknown[]) => {
    warnings.push(args)
  }
  try {
    const response = await handleInvoicePdfRoute(
      new NextRequest('http://ims.test/api/invoices/order-1?token=valid-token'),
      { id: 'order-1' },
      {
        async loadInvoicePdf() {
          return Buffer.from('%PDF-1.4 test')
        },
        verifyPdfToken() {
          return { valid: true, payload: validPayload() }
        },
        async auditTokenAttempt() {
          throw new Error('audit unavailable')
        },
      },
    )

    assert.equal(response.status, 200)
    assert.match(JSON.stringify(warnings), /token audit failed/)
    assert.doesNotMatch(JSON.stringify(warnings), /valid-token/)
  } finally {
    console.warn = originalWarn
  }
})

test('invoice PDF route audit failures do not block rejected token responses', async () => {
  const originalWarn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args: unknown[]) => {
    warnings.push(args)
  }
  try {
    const response = await handleInvoicePdfRoute(
      new NextRequest('http://ims.test/api/invoices/order-1?token=bad-token'),
      { id: 'order-1' },
      {
        async loadInvoicePdf() {
          throw new Error('PDF storage should not be reached for rejected tokens')
        },
        verifyPdfToken() {
          return { valid: false, reason: 'bad_signature' }
        },
        async auditTokenAttempt() {
          throw new Error('audit unavailable')
        },
      },
    )

    assert.equal(response.status, 403)
    assert.match(JSON.stringify(warnings), /token audit failed/)
    assert.doesNotMatch(JSON.stringify(warnings), /bad-token/)
  } finally {
    console.warn = originalWarn
  }
})

test('invoice PDF route applies request rate limiting before token verification', async () => {
  let verifyCalled = false
  const response = await handleInvoicePdfRoute(
    new NextRequest('http://ims.test/api/invoices/order-1?token=valid-token'),
    { id: 'order-1' },
    {
      async loadInvoicePdf() {
        throw new Error('PDF storage should not be reached when rate limited')
      },
      verifyPdfToken() {
        verifyCalled = true
        return { valid: true, payload: validPayload() }
      },
      async auditTokenAttempt() {
        throw new Error('Audit should not be reached when rate limited')
      },
      async checkRateLimit(key, max, windowMs) {
        assert.equal(key, 'invoice-pdf:unknown')
        assert.equal(max, 30)
        assert.equal(windowMs, 60_000)
        return { allowed: false, retryAfterSec: 42, remaining: 0 }
      },
    },
  )

  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '42')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(verifyCalled, false)
})
