/**
 * Generic invoice PDF helpers — loading, serving, and signing.
 * These are not Xero-specific; any accounting connector can save PDFs to disk.
 * Xero-specific download logic stays in lib/connectors/xero/invoice-pdf.ts.
 *
 * Invoice PDF tokens are replayable within their short TTL by design, but
 * generated links are bound to the IMS session context and client IP so copied
 * tokens cannot be replayed from another browser/session boundary.
 */

import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, realpath, rename, writeFile } from 'fs/promises'
import path from 'path'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { parsePositiveIntegerEnv } from '@/lib/env'

const INVOICE_PDF_STORED_PATH_PREFIX = 'invoice-pdfs'
const SAFE_INVOICE_PDF_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const MAX_INVOICE_PDF_ID_LENGTH = 256
const INVOICE_PDF_TOKEN_PURPOSE = 'invoice-pdf'
const INVOICE_PDF_TOKEN_VERSION = 1
const DEFAULT_INVOICE_PDF_TOKEN_TTL_SECONDS = 10 * 60
const DEFAULT_INVOICE_PDF_TOKEN_MAX_TTL_SECONDS = 30 * 24 * 60 * 60
const ABSOLUTE_INVOICE_PDF_TOKEN_MAX_TTL_SECONDS = 30 * 24 * 60 * 60
const INVOICE_PDF_TOKEN_CLOCK_SKEW_SECONDS = 5 * 60

export type InvoicePdfTokenPayload = {
  v: typeof INVOICE_PDF_TOKEN_VERSION
  sub: string
  purpose: typeof INVOICE_PDF_TOKEN_PURPOSE
  iat: number
  exp: number
  nonce: string
  sid?: string
  ip?: string
}

export type PdfTokenVerificationFailureReason =
  | 'missing'
  | 'malformed'
  | 'bad_signature'
  | 'wrong_version'
  | 'wrong_purpose'
  | 'wrong_order'
  | 'missing_binding'
  | 'wrong_session'
  | 'wrong_ip'
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
  binding?: InvoicePdfTokenBinding
}

export type InvoicePdfTokenBinding = {
  sessionId: string
  clientIp: string
}

type VerifyTokenOptions = Pick<TokenOptions, 'now'> & {
  binding?: InvoicePdfTokenBinding | null
  requireBinding?: boolean
  env?: Record<string, string | undefined>
}

function configuredInvoicePdfStorageDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.INVOICE_PDF_STORAGE_DIR?.trim()
  const fallback = path.join(process.cwd(), 'data', 'invoices')
  return path.resolve(configured && configured.length > 0 ? configured : fallback)
}

function invoicePdfFilename(orderId: string): string | null {
  // Keep both explicit path-separator checks and the allowlist: the redundancy
  // makes the traversal boundary obvious if the filename regex changes later.
  if (orderId.length > MAX_INVOICE_PDF_ID_LENGTH) return null
  if (!orderId || orderId.includes('\0') || orderId.includes('/') || orderId.includes('\\')) return null
  if (!SAFE_INVOICE_PDF_ID.test(orderId)) return null
  return `${orderId}.pdf`
}

function isWithinDirectory(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function isSameOrWithinDirectory(root: string, filePath: string): boolean {
  return root === filePath || isWithinDirectory(root, filePath)
}

async function resolveRealInvoicePdfPath(filePath: string): Promise<string | null> {
  try {
    const [realRoot, realFilePath] = await Promise.all([
      realpath(configuredInvoicePdfStorageDir()),
      realpath(filePath),
    ])
    return isWithinDirectory(realRoot, realFilePath) ? realFilePath : null
  } catch {
    return null
  }
}

async function ensureInvoicePdfStorageDir(filePath: string): Promise<void> {
  const root = configuredInvoicePdfStorageDir()
  if (process.env.NODE_ENV === 'production') {
    await access(root, constants.W_OK)
  } else {
    await mkdir(root, { recursive: true })
  }

  const [realRoot, realParent] = await Promise.all([
    realpath(root),
    realpath(path.dirname(filePath)),
  ])
  if (!isSameOrWithinDirectory(realRoot, realParent)) {
    throw new Error('Invoice PDF storage path resolved outside configured directory')
  }

  try {
    const existing = await lstat(filePath)
    if (existing.isSymbolicLink()) {
      throw new Error('Invoice PDF target path must not be a symlink')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function resolveInvoicePdfPath(orderId: string): string | null {
  const filename = invoicePdfFilename(orderId)
  if (!filename) return null

  const root = configuredInvoicePdfStorageDir()
  const filePath = path.resolve(root, filename)
  if (!isWithinDirectory(root, filePath)) return null
  return filePath
}

function invoicePdfStoredPath(orderId: string): string {
  const filename = invoicePdfFilename(orderId)
  if (!filename) throw new Error('Invalid invoice PDF order id for stored path')
  // Logical marker stored in SalesOrder.invoicePdfPath. The actual on-disk path
  // is derived at read time via loadInvoicePdf(orderId), so storage can move
  // without rewriting database rows.
  return path.posix.join(INVOICE_PDF_STORED_PATH_PREFIX, filename)
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

function getTokenMaxTtlSeconds(env: Record<string, string | undefined> = process.env): number {
  return Math.min(
    parsePositiveIntegerEnv(
      env.INVOICE_PDF_TOKEN_MAX_TTL_SECONDS,
      DEFAULT_INVOICE_PDF_TOKEN_MAX_TTL_SECONDS,
    ),
    ABSOLUTE_INVOICE_PDF_TOKEN_MAX_TTL_SECONDS,
  )
}

function hmacHex(value: string): string {
  return createHmac('sha256', getSigningSecret()).update(value, 'utf8').digest('hex')
}

function bindingDigest(kind: 'session' | 'ip', value: string): string {
  return hmacHex(`${kind}:${value}`)
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
    if (payload.sid !== undefined && (typeof payload.sid !== 'string' || payload.sid.length === 0)) return null
    if (payload.ip !== undefined && (typeof payload.ip !== 'string' || payload.ip.length === 0)) return null

    return {
      v: payload.v as typeof INVOICE_PDF_TOKEN_VERSION,
      sub: payload.sub,
      purpose: payload.purpose as typeof INVOICE_PDF_TOKEN_PURPOSE,
      iat: payload.iat,
      exp: payload.exp,
      nonce: payload.nonce,
      sid: payload.sid,
      ip: payload.ip,
    }
  } catch {
    return null
  }
}

/** Get the file path for a saved invoice PDF */
export function getInvoicePdfPath(orderId: string): string {
  const filePath = resolveInvoicePdfPath(orderId)
  if (!filePath) throw new Error('Invalid invoice PDF order id for storage path')
  return filePath
}

/** Get the configured directory for saved invoice PDFs. */
export function getInvoicePdfStorageDir(): string {
  return configuredInvoicePdfStorageDir()
}

/** Load a saved invoice PDF from disk */
export async function loadInvoicePdf(orderId: string): Promise<Buffer | null> {
  const filePath = resolveInvoicePdfPath(orderId)
  if (!filePath) return null
  const realFilePath = await resolveRealInvoicePdfPath(filePath)
  if (!realFilePath) return null
  try {
    return await readFile(realFilePath)
  } catch {
    return null
  }
}

/** Save an invoice PDF to configured persistent storage and return its logical stored path. */
export async function saveInvoicePdfFile(orderId: string, buffer: Buffer): Promise<string> {
  const filePath = getInvoicePdfPath(orderId)
  await ensureInvoicePdfStorageDir(filePath)
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`)
  // Connector PDFs are idempotently re-fetchable, so atomic rename is enough
  // here; this intentionally does not fsync the directory for crash durability.
  await writeFile(tempPath, buffer)
  await rename(tempPath, filePath)
  return invoicePdfStoredPath(orderId)
}

/** Generate an expiring HMAC-signed token for public PDF download. */
export function signPdfToken(orderId: string, options: TokenOptions = {}): string {
  const issuedAt = nowSeconds(options.now)
  const ttlSeconds = options.ttlSeconds ?? getTokenTtlSeconds(options.env)
  const maxTtlSeconds = getTokenMaxTtlSeconds(options.env)
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('Invoice PDF token TTL must be a positive integer')
  }
  if (ttlSeconds > maxTtlSeconds) {
    throw new Error(`Invoice PDF token TTL must not exceed ${maxTtlSeconds} seconds`)
  }

  const payload: InvoicePdfTokenPayload = {
    v: INVOICE_PDF_TOKEN_VERSION,
    sub: orderId,
    purpose: INVOICE_PDF_TOKEN_PURPOSE,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    nonce: options.nonce ?? randomBytes(16).toString('base64url'),
    sid: options.binding ? bindingDigest('session', options.binding.sessionId) : undefined,
    ip: options.binding ? bindingDigest('ip', options.binding.clientIp) : undefined,
  }
  const encodedPayload = encodePayload(payload)
  return `${encodedPayload}.${hmacHex(encodedPayload)}`
}

/** Verify an expiring invoice PDF token and return a safe, token-free failure reason. */
export function verifyPdfTokenDetailed(
  orderId: string,
  token: string | null | undefined,
  options: VerifyTokenOptions = {},
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
  const hasBinding = Boolean(payload.sid && payload.ip)
  if (options.requireBinding && !hasBinding) {
    return { valid: false, reason: 'missing_binding' }
  }
  if (hasBinding) {
    if (!options.binding) return { valid: false, reason: 'missing_binding' }
    if (payload.sid !== bindingDigest('session', options.binding.sessionId)) {
      return { valid: false, reason: 'wrong_session' }
    }
    if (payload.ip !== bindingDigest('ip', options.binding.clientIp)) {
      return { valid: false, reason: 'wrong_ip' }
    }
  }

  const now = nowSeconds(options.now)
  if (payload.iat > payload.exp) return { valid: false, reason: 'malformed' }
  if (payload.iat > now + INVOICE_PDF_TOKEN_CLOCK_SKEW_SECONDS) {
    return { valid: false, reason: 'not_yet_valid' }
  }
  if (payload.exp - payload.iat > getTokenMaxTtlSeconds(options.env)) {
    return { valid: false, reason: 'ttl_exceeded' }
  }
  if (now >= payload.exp) return { valid: false, reason: 'expired' }

  return { valid: true, payload }
}

/** Get a signed public URL for downloading the invoice PDF */
export function getInvoiceDownloadUrl(orderId: string, binding: InvoicePdfTokenBinding): string {
  const token = signPdfToken(orderId, { binding })
  return `/api/invoices/${orderId}?token=${token}`
}
