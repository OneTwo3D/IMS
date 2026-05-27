/**
 * Generic invoice PDF helpers — loading, serving, and signing.
 * These are not Xero-specific; any accounting connector can save PDFs to disk.
 * Xero-specific download logic stays in lib/connectors/xero/invoice-pdf.ts.
 *
 * Invoice PDF tokens are replayable within their TTL by design: they are
 * shareable signed links, not single-use capabilities. The nonce gives each
 * generated link unique entropy for auditing and cache isolation, not one-shot
 * consumption semantics.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { parsePositiveIntegerEnv } from '@/lib/env'

const PDF_DIR = join(process.cwd(), 'data', 'invoices')
const INVOICE_PDF_TOKEN_PURPOSE = 'invoice-pdf'
const INVOICE_PDF_TOKEN_VERSION = 1
const DEFAULT_INVOICE_PDF_TOKEN_TTL_SECONDS = 3 * 24 * 60 * 60
const MAX_INVOICE_PDF_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
const INVOICE_PDF_TOKEN_CLOCK_SKEW_SECONDS = 5 * 60

export type InvoicePdfTokenPayload = {
  v: typeof INVOICE_PDF_TOKEN_VERSION
  sub: string
  purpose: typeof INVOICE_PDF_TOKEN_PURPOSE
  iat: number
  exp: number
  nonce: string
}

export type PdfTokenVerificationFailureReason =
  | 'missing'
  | 'malformed'
  | 'bad_signature'
  | 'wrong_version'
  | 'wrong_purpose'
  | 'wrong_order'
  | 'not_yet_valid'
  | 'ttl_exceeded'
  | 'expired'

export type PdfTokenVerificationResult =
  | {
      valid: true
      payload: InvoicePdfTokenPayload
    }
  | {
      valid: false
      reason: PdfTokenVerificationFailureReason
    }

type TokenTime = Date | number

type TokenOptions = {
  now?: TokenTime
  ttlSeconds?: number
  nonce?: string
  env?: Record<string, string | undefined>
}

function getSigningSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET
  if (!secret) {
    throw new Error('AUTH_SECRET (or NEXTAUTH_SECRET) must be set — invoice PDF token signing requires a secret')
  }
  return secret
}

function nowSeconds(now: TokenTime = Date.now()): number {
  const millis = now instanceof Date ? now.getTime() : now
  return Math.floor(millis / 1000)
}

function getTokenTtlSeconds(env: Record<string, string | undefined> = process.env): number {
  return parsePositiveIntegerEnv(
    env.INVOICE_PDF_TOKEN_TTL_SECONDS,
    DEFAULT_INVOICE_PDF_TOKEN_TTL_SECONDS,
  )
}

function hmacHex(value: string): string {
  return createHmac('sha256', getSigningSecret()).update(value, 'utf8').digest('hex')
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, 'utf8')
  const bBuffer = Buffer.from(b, 'utf8')
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer)
}

function encodePayload(payload: InvoicePdfTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function parsePayload(encoded: string): InvoicePdfTokenPayload | null {
  try {
    const raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

    const payload = raw as Partial<Record<keyof InvoicePdfTokenPayload, unknown>>
    if (typeof payload.v !== 'number' || !Number.isSafeInteger(payload.v)) return null
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null
    if (typeof payload.purpose !== 'string' || payload.purpose.length === 0) return null
    if (typeof payload.iat !== 'number' || !Number.isSafeInteger(payload.iat)) return null
    if (typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp)) return null
    if (typeof payload.nonce !== 'string' || payload.nonce.length === 0) return null

    return {
      v: payload.v as typeof INVOICE_PDF_TOKEN_VERSION,
      sub: payload.sub,
      purpose: payload.purpose as typeof INVOICE_PDF_TOKEN_PURPOSE,
      iat: payload.iat,
      exp: payload.exp,
      nonce: payload.nonce,
    }
  } catch {
    return null
  }
}

/** Get the file path for a saved invoice PDF */
export function getInvoicePdfPath(orderId: string): string {
  return join(PDF_DIR, `${orderId}.pdf`)
}

/** Load a saved invoice PDF from disk */
export async function loadInvoicePdf(orderId: string): Promise<Buffer | null> {
  try {
    return await readFile(getInvoicePdfPath(orderId))
  } catch {
    return null
  }
}

/** Generate an expiring HMAC-signed token for public PDF download. */
export function signPdfToken(orderId: string, options: TokenOptions = {}): string {
  const issuedAt = nowSeconds(options.now)
  const ttlSeconds = options.ttlSeconds ?? getTokenTtlSeconds(options.env)
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('Invoice PDF token TTL must be a positive integer')
  }
  if (ttlSeconds > MAX_INVOICE_PDF_TOKEN_TTL_SECONDS) {
    throw new Error(`Invoice PDF token TTL must not exceed ${MAX_INVOICE_PDF_TOKEN_TTL_SECONDS} seconds`)
  }

  const payload: InvoicePdfTokenPayload = {
    v: INVOICE_PDF_TOKEN_VERSION,
    sub: orderId,
    purpose: INVOICE_PDF_TOKEN_PURPOSE,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    nonce: options.nonce ?? randomBytes(16).toString('base64url'),
  }
  const encodedPayload = encodePayload(payload)
  return `${encodedPayload}.${hmacHex(encodedPayload)}`
}

/** Verify an expiring invoice PDF token and return a safe, token-free failure reason. */
export function verifyPdfTokenDetailed(
  orderId: string,
  token: string | null | undefined,
  options: Pick<TokenOptions, 'now'> = {},
): PdfTokenVerificationResult {
  if (!token) return { valid: false, reason: 'missing' }

  const segments = token.split('.')
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    return { valid: false, reason: 'malformed' }
  }

  const [encodedPayload, signature] = segments
  if (!constantTimeEqual(hmacHex(encodedPayload), signature)) {
    return { valid: false, reason: 'bad_signature' }
  }

  const payload = parsePayload(encodedPayload)
  if (!payload) return { valid: false, reason: 'malformed' }
  if (payload.v !== INVOICE_PDF_TOKEN_VERSION) {
    return { valid: false, reason: 'wrong_version' }
  }
  if (payload.purpose !== INVOICE_PDF_TOKEN_PURPOSE) {
    return { valid: false, reason: 'wrong_purpose' }
  }
  if (payload.sub !== orderId) return { valid: false, reason: 'wrong_order' }

  const now = nowSeconds(options.now)
  if (payload.iat > payload.exp) return { valid: false, reason: 'malformed' }
  if (payload.iat > now + INVOICE_PDF_TOKEN_CLOCK_SKEW_SECONDS) {
    return { valid: false, reason: 'not_yet_valid' }
  }
  if (payload.exp - payload.iat > MAX_INVOICE_PDF_TOKEN_TTL_SECONDS) {
    return { valid: false, reason: 'ttl_exceeded' }
  }
  if (now >= payload.exp) return { valid: false, reason: 'expired' }

  return { valid: true, payload }
}

/** Get a signed public URL for downloading the invoice PDF */
export function getInvoiceDownloadUrl(orderId: string): string {
  const token = signPdfToken(orderId)
  return `/api/invoices/${orderId}?token=${token}`
}
