import { createHmac, timingSafeEqual } from 'crypto'
import { db } from '@/lib/db'
import { getMintsoftSettings } from '@/lib/connectors/mintsoft/settings/schema'

function normalizeSignatureValue(signature: string): string {
  return signature.trim().replace(/^sha256=/i, '')
}

function safeCompareSignature(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8')
  const providedBuffer = Buffer.from(provided, 'utf8')
  if (expectedBuffer.length !== providedBuffer.length) return false
  return timingSafeEqual(expectedBuffer, providedBuffer)
}

export function normalizeMintsoftBaseUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  try {
    const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const url = new URL(withProtocol)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

export async function getMintsoftConnectionRecord() {
  return db.wmsConnection.findUnique({
    where: { connector: 'mintsoft' },
  })
}

export async function getMintsoftApiConfiguration() {
  const [connection, settings] = await Promise.all([
    getMintsoftConnectionRecord(),
    getMintsoftSettings(),
  ])

  return {
    baseUrl: normalizeMintsoftBaseUrl(connection?.baseUrl ?? '') ?? '',
    apiKey: settings.mintsoft_api_key.trim(),
    webhookSecret: settings.mintsoft_webhook_secret.trim(),
    orderLookupConnector: connection?.orderLookupConnector ?? null,
  }
}

export async function isMintsoftConfigured(): Promise<boolean> {
  const config = await getMintsoftApiConfiguration()
  return Boolean(config.baseUrl && config.apiKey)
}

export function verifyMintsoftWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  const normalizedProvided = signatureHeader ? normalizeSignatureValue(signatureHeader) : ''
  const normalizedSecret = secret.trim()

  if (!normalizedProvided || !normalizedSecret) return false

  const expectedHex = createHmac('sha256', normalizedSecret).update(rawBody, 'utf8').digest('hex')
  const expectedBase64 = createHmac('sha256', normalizedSecret).update(rawBody, 'utf8').digest('base64')

  return safeCompareSignature(expectedHex, normalizedProvided)
    || safeCompareSignature(expectedBase64, normalizedProvided)
}
