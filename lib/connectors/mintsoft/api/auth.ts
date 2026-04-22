import { createHash, createHmac, timingSafeEqual } from 'crypto'
import { db } from '@/lib/db'
import { getMintsoftSettings } from '@/lib/connectors/mintsoft/settings/schema'
import { getSettingValue, serializeSettingValue } from '@/lib/settings-store'

// The cached 24-hour Mintsoft API key lives in the same setting slot that older
// code treated as the credential itself. That keeps one canonical "current API
// key" row in storage while username/password remain the renewable source.
export const MINTSOFT_AUTH_TOKEN_KEY = 'mintsoft_api_key'
export const DEFAULT_MINTSOFT_CONNECTION_LABEL = 'Primary'

const AUTH_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
const AUTH_TOKEN_REFRESH_BUFFER_MS = 15 * 60 * 1000

let mintsoftAuthRefreshInFlight: Promise<string> | null = null

function normalizeSignatureValue(signature: string): string {
  return signature.trim().replace(/^sha256=/i, '')
}

function safeCompareSignature(expected: string, provided: string): boolean {
  const expectedBuffer = createHash('sha256').update(expected, 'utf8').digest()
  const providedBuffer = createHash('sha256').update(provided, 'utf8').digest()
  return timingSafeEqual(expectedBuffer, providedBuffer) && expected === provided
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

function buildMintsoftAuthHeaders(baseUrl: string): HeadersInit {
  const url = buildMintsoftRequestUrl('/', baseUrl)
  const e2eSecret = process.env.E2E_ROUTE_SECRET?.trim()

  return {
    Accept: 'application/json, text/plain;q=0.9',
    'Content-Type': 'application/json',
    ...(e2eSecret && url.pathname.startsWith('/api/e2e/mintsoft')
      ? { 'x-e2e-secret': e2eSecret }
      : {}),
  }
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

export function extractMintsoftAuthToken(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  const record = asRecord(value)
  if (!record) return null

  return getFirstString(record, ['apiKey', 'ApiKey', 'key', 'Key', 'token', 'Token', 'accessToken', 'AccessToken'])
}

function getMintsoftAuthExpiry(now = Date.now()): Date {
  return new Date(now + AUTH_TOKEN_TTL_MS)
}

function isMintsoftAuthTokenFresh(token: string | null, expiresAt: Date | null, now = Date.now()): boolean {
  if (!token || !expiresAt) return false
  return expiresAt.getTime() - AUTH_TOKEN_REFRESH_BUFFER_MS > now
}

async function persistMintsoftAuthSession(token: string, expiresAt: Date): Promise<void> {
  const now = new Date()

  await db.$transaction(async (tx) => {
    await tx.setting.upsert({
      where: { key: MINTSOFT_AUTH_TOKEN_KEY },
      create: {
        key: MINTSOFT_AUTH_TOKEN_KEY,
        value: serializeSettingValue(MINTSOFT_AUTH_TOKEN_KEY, token),
      },
      update: {
        value: serializeSettingValue(MINTSOFT_AUTH_TOKEN_KEY, token),
      },
    })

    const existingConnection = await tx.wmsConnection.findFirst({
      where: { connector: 'mintsoft' },
      orderBy: [{ createdAt: 'asc' }],
      select: { id: true },
    })

    if (existingConnection) {
      await tx.wmsConnection.update({
        where: { id: existingConnection.id },
        data: {
          tokenExpiresAt: expiresAt,
          lastAuthAt: now,
        },
      })
      return
    }

    await tx.wmsConnection.create({
      data: {
        connector: 'mintsoft',
        label: DEFAULT_MINTSOFT_CONNECTION_LABEL,
        tokenExpiresAt: expiresAt,
        lastAuthAt: now,
      },
    })
  })
}

async function requestMintsoftAuthSession(
  baseUrl: string,
  username: string,
  password: string,
): Promise<{ token: string; expiresAt: Date }> {
  const response = await fetch(buildMintsoftRequestUrl('/api/Auth', baseUrl), {
    method: 'POST',
    headers: buildMintsoftAuthHeaders(baseUrl),
    body: JSON.stringify({
      Username: username,
      Password: password,
    }),
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

  const token = extractMintsoftAuthToken(parsedBody)
  if (!token) {
    throw new Error('Mintsoft auth response did not include an API key')
  }

  return {
    token,
    expiresAt: getMintsoftAuthExpiry(),
  }
}

export async function getMintsoftConnectionRecord() {
  return db.wmsConnection.findFirst({
    where: { connector: 'mintsoft' },
    orderBy: [{ createdAt: 'asc' }],
  })
}

export async function getMintsoftApiConfiguration() {
  const [connection, settings] = await Promise.all([
    getMintsoftConnectionRecord(),
    getMintsoftSettings(),
  ])

  return {
    baseUrl: normalizeMintsoftBaseUrl(connection?.baseUrl ?? '') ?? '',
    username: settings.mintsoft_username.trim(),
    password: settings.mintsoft_password.trim(),
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
      data: {
        tokenExpiresAt: null,
        lastAuthAt: null,
      },
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

  if (!config.baseUrl) {
    throw new Error('Mintsoft connection is not configured')
  }

  if (!forceRefresh && isMintsoftAuthTokenFresh(storedToken, connection?.tokenExpiresAt ?? null)) {
    return storedToken as string
  }

  const hasRenewableCredentials = Boolean(config.username && config.password)
  if (!hasRenewableCredentials) {
    if (storedToken) return storedToken
    throw new Error('Mintsoft username and password are not configured')
  }

  if (!mintsoftAuthRefreshInFlight) {
    const refreshPromise = (async () => {
      const session = await requestMintsoftAuthSession(config.baseUrl, config.username, config.password)
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
  const [config, cachedApiKey] = await Promise.all([
    getMintsoftApiConfiguration(),
    getSettingValue(MINTSOFT_AUTH_TOKEN_KEY),
  ])

  return Boolean(
    config.baseUrl
      && (
        ((config.username && config.password))
        || cachedApiKey
      ),
  )
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
