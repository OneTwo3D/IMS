import { createHmac, timingSafeEqual } from 'crypto'
import { db } from '@/lib/db'
import { getMintsoftSettings } from '@/lib/connectors/mintsoft/settings/schema'
import { getSettingValue, serializeSettingValue } from '@/lib/settings-store'

export const MINTSOFT_AUTH_TOKEN_KEY = 'mintsoft_auth_token'

const AUTH_TOKEN_TTL_MS = 23 * 60 * 60 * 1000
const AUTH_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000

let mintsoftAuthRefreshInFlight: Promise<string> | null = null

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

function buildMintsoftRequestUrl(path: string, baseUrl: string): URL {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const normalizedPath = path.replace(/^\/+/, '')
  return new URL(normalizedPath, normalizedBaseUrl)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function getFirstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }

  return null
}

function getFirstDate(record: Record<string, unknown>, keys: readonly string[]): Date | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value !== 'string' || !value.trim()) continue

    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }

  return null
}

export function extractMintsoftAuthSession(value: unknown): { token: string; expiresAt: Date | null } | null {
  if (typeof value === 'string' && value.trim()) {
    return {
      token: value.trim(),
      expiresAt: null,
    }
  }

  const record = asRecord(value)
  if (!record) return null

  const token = getFirstString(record, ['token', 'Token', 'accessToken', 'AccessToken', 'jwt', 'Jwt', 'key', 'Key'])
  if (!token) return null

  return {
    token,
    expiresAt: getFirstDate(record, ['expiresAt', 'ExpiresAt', 'expiry', 'Expiry', 'validTo', 'ValidTo']),
  }
}

function getMintsoftAuthExpiry(expiresAt: Date | null, now = Date.now()): Date {
  if (expiresAt && !Number.isNaN(expiresAt.getTime())) return expiresAt
  return new Date(now + AUTH_TOKEN_TTL_MS)
}

function isMintsoftAuthTokenFresh(token: string | null, expiresAt: Date | null, now = Date.now()): boolean {
  if (!token || !expiresAt) return false
  return expiresAt.getTime() - AUTH_TOKEN_REFRESH_BUFFER_MS > now
}

async function persistMintsoftAuthSession(token: string, expiresAt: Date): Promise<void> {
  const now = new Date()

  await db.$transaction([
    db.setting.upsert({
      where: { key: MINTSOFT_AUTH_TOKEN_KEY },
      create: {
        key: MINTSOFT_AUTH_TOKEN_KEY,
        value: serializeSettingValue(MINTSOFT_AUTH_TOKEN_KEY, token),
      },
      update: {
        value: serializeSettingValue(MINTSOFT_AUTH_TOKEN_KEY, token),
      },
    }),
    db.wmsConnection.upsert({
      where: { connector: 'mintsoft' },
      create: {
        connector: 'mintsoft',
        tokenExpiresAt: expiresAt,
        lastAuthAt: now,
      },
      update: {
        tokenExpiresAt: expiresAt,
        lastAuthAt: now,
      },
    }),
  ])
}

async function requestMintsoftAuthSession(baseUrl: string, apiKey: string): Promise<{ token: string; expiresAt: Date }> {
  const response = await fetch(buildMintsoftRequestUrl('/api/Auth', baseUrl), {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain;q=0.9',
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ apiKey }),
    cache: 'no-store',
  })

  const bodyText = await response.text()
  const parsedBody = (() => {
    if (!bodyText.trim()) return null

    try {
      return JSON.parse(bodyText) as unknown
    } catch {
      return bodyText
    }
  })()

  if (!response.ok) {
    const details = typeof parsedBody === 'string' && parsedBody.trim()
      ? `: ${parsedBody.trim()}`
      : ''
    throw new Error(`Mintsoft auth failed with status ${response.status}${details}`)
  }

  const session = extractMintsoftAuthSession(parsedBody)
  if (!session?.token) {
    throw new Error('Mintsoft auth response did not include a token')
  }

  return {
    token: session.token,
    expiresAt: getMintsoftAuthExpiry(session.expiresAt),
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

export async function invalidateMintsoftAccessToken(): Promise<void> {
  mintsoftAuthRefreshInFlight = null

  await db.$transaction([
    db.setting.deleteMany({
      where: { key: MINTSOFT_AUTH_TOKEN_KEY },
    }),
    db.wmsConnection.updateMany({
      where: { connector: 'mintsoft' },
      data: { tokenExpiresAt: null },
    }),
  ])
}

export async function getMintsoftAccessToken(options?: { forceRefresh?: boolean }): Promise<string> {
  const forceRefresh = options?.forceRefresh ?? false
  const [connection, config, storedToken] = await Promise.all([
    getMintsoftConnectionRecord(),
    getMintsoftApiConfiguration(),
    getSettingValue(MINTSOFT_AUTH_TOKEN_KEY),
  ])

  if (!config.baseUrl || !config.apiKey) {
    throw new Error('Mintsoft connection is not configured')
  }

  if (!forceRefresh && isMintsoftAuthTokenFresh(storedToken, connection?.tokenExpiresAt ?? null)) {
    return storedToken as string
  }

  if (!mintsoftAuthRefreshInFlight) {
    const refreshPromise = (async () => {
      const session = await requestMintsoftAuthSession(config.baseUrl, config.apiKey)
      await persistMintsoftAuthSession(session.token, session.expiresAt)
      return session.token
    })()

    mintsoftAuthRefreshInFlight = refreshPromise.finally(() => {
      if (mintsoftAuthRefreshInFlight === refreshPromise) {
        mintsoftAuthRefreshInFlight = null
      }
    })
  }

  return mintsoftAuthRefreshInFlight
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
