import { createHmac, timingSafeEqual } from 'node:crypto'

import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'
import { getSettingValue } from '@/lib/settings-store'

export const SHOPPING_INVOICE_PDF_TTL_SECONDS = 5 * 60
const SHOPPING_INVOICE_PDF_CLOCK_SKEW_SECONDS = 5 * 60

const SHOPPING_INVOICE_SECRET_SETTING: Record<ShoppingConnectorId, string> = {
  woocommerce: 'wc_webhook_secret',
  shopify: 'shopify_webhook_secret',
}

export type ShoppingInvoicePdfRequest = {
  connector: ShoppingConnectorId
  externalOrderId: string
  externalCustomerId?: string
  issuedAt: number
  expiresAt: number
  nonce: string
}

export type ShoppingInvoicePdfRequestFailureReason =
  | 'malformed'
  | 'connector_mismatch'
  | 'not_yet_valid'
  | 'ttl_exceeded'
  | 'expired'

export type ShoppingInvoicePdfRequestParseResult =
  | { valid: true; request: ShoppingInvoicePdfRequest }
  | { valid: false; reason: ShoppingInvoicePdfRequestFailureReason }

function hmacHex(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, 'utf8')
  const bBuffer = Buffer.from(b, 'utf8')
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer)
}

function nowSeconds(now: Date | number = Date.now()): number {
  const millis = now instanceof Date ? now.getTime() : now
  return Math.floor(millis / 1000)
}

function parseString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function parseSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

export async function getShoppingInvoicePdfSecret(connector: ShoppingConnectorId): Promise<string | null> {
  return getSettingValue(SHOPPING_INVOICE_SECRET_SETTING[connector])
}

export function signShoppingInvoicePdfRequestBody(body: string, secret: string): string {
  return hmacHex(body, secret)
}

export function verifyShoppingInvoicePdfSignature(body: string, signature: string | null | undefined, secret: string): boolean {
  if (!signature) return false
  return constantTimeEqual(hmacHex(body, secret), signature)
}

export function parseShoppingInvoicePdfRequest(
  body: string,
  connector: ShoppingConnectorId,
  options: { now?: Date | number } = {},
): ShoppingInvoicePdfRequestParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(body) as unknown
  } catch {
    return { valid: false, reason: 'malformed' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { valid: false, reason: 'malformed' }
  const payload = raw as Record<string, unknown>

  const payloadConnector = parseString(payload.connector)
  const externalOrderId = parseString(payload.externalOrderId)
  const externalCustomerId = payload.externalCustomerId === undefined ? undefined : parseString(payload.externalCustomerId)
  const issuedAt = parseSafeInteger(payload.issuedAt)
  const expiresAt = parseSafeInteger(payload.expiresAt)
  const nonce = parseString(payload.nonce)

  if (!payloadConnector || !externalOrderId || issuedAt === null || expiresAt === null || !nonce) {
    return { valid: false, reason: 'malformed' }
  }
  if (payloadConnector !== connector) return { valid: false, reason: 'connector_mismatch' }
  if (payload.externalCustomerId !== undefined && !externalCustomerId) return { valid: false, reason: 'malformed' }
  if (issuedAt > expiresAt) return { valid: false, reason: 'malformed' }
  if (expiresAt - issuedAt > SHOPPING_INVOICE_PDF_TTL_SECONDS) {
    return { valid: false, reason: 'ttl_exceeded' }
  }

  const now = nowSeconds(options.now)
  if (issuedAt > now + SHOPPING_INVOICE_PDF_CLOCK_SKEW_SECONDS) {
    return { valid: false, reason: 'not_yet_valid' }
  }
  if (now >= expiresAt) return { valid: false, reason: 'expired' }

  return {
    valid: true,
    request: {
      connector,
      externalOrderId,
      externalCustomerId: externalCustomerId ?? undefined,
      issuedAt,
      expiresAt,
      nonce,
    },
  }
}

export function createShoppingInvoicePdfRequestBody(input: {
  connector: ShoppingConnectorId
  externalOrderId: string
  externalCustomerId?: string | number | null
  now?: Date | number
  ttlSeconds?: number
  nonce: string
}): string {
  const issuedAt = nowSeconds(input.now)
  const ttlSeconds = input.ttlSeconds ?? SHOPPING_INVOICE_PDF_TTL_SECONDS
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > SHOPPING_INVOICE_PDF_TTL_SECONDS) {
    throw new Error(`Shopping invoice PDF request TTL must be between 1 and ${SHOPPING_INVOICE_PDF_TTL_SECONDS} seconds`)
  }
  return JSON.stringify({
    connector: input.connector,
    externalOrderId: input.externalOrderId,
    ...(input.externalCustomerId !== undefined && input.externalCustomerId !== null
      ? { externalCustomerId: String(input.externalCustomerId) }
      : {}),
    issuedAt,
    expiresAt: issuedAt + ttlSeconds,
    nonce: input.nonce,
  })
}
