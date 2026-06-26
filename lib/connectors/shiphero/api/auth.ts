import { createHash, createHmac, timingSafeEqual } from 'crypto'
import { db } from '@/lib/db'
import {
  DEFAULT_SHIPHERO_CONNECTION_LABEL,
  SHIPHERO_AUTH_PATH,
  SHIPHERO_DEFAULT_BASE_URL,
  getShipheroSettings,
} from '@/lib/connectors/shiphero/settings/schema'
import { connectorFetch } from '@/lib/security/connector-fetch'
import { validateExternalBaseUrl } from '@/lib/security/external-url-safety'
import { getSettingValue, serializeSettingValue } from '@/lib/settings-store'

// The cached short-lived ShipHero bearer lives in this setting slot. The
// refresh token (the renewable source) stays in shiphero_refresh_token.
export const SHIPHERO_ACCESS_TOKEN_KEY = 'shiphero_access_token'

// ShipHero access tokens are long-lived (~28 days) but we never trust the
// declared lifetime blindly: refresh this far before the declared expiry to
// buffer clock skew and mid-roundtrip expiry. Mirrors the reference sweep's
// 300s buffer.
const AUTH_TOKEN_REFRESH_BUFFER_MS = 15 * 60 * 1000
// Fallback lifetime when the refresh response omits expires_in.
const AUTH_TOKEN_FALLBACK_TTL_MS = 24 * 60 * 60 * 1000

let shipheroAuthRefreshInFlight: Promise<string> | null = null

function normalizeSignatureValue(signature: string): string {
  return signature.trim().replace(/^sha256=/i, '')
}

function safeCompareSignature(expected: string, provided: string): boolean {
  const expectedBuffer = createHash('sha256').update(expected, 'utf8').digest()
  const providedBuffer = createHash('sha256').update(provided, 'utf8').digest()
  return timingSafeEqual(expectedBuffer, providedBuffer) && expected === provided
}

export function validateShipheroBaseUrl(value: string) {
  return validateExternalBaseUrl(value, {
    connectorName: 'ShipHero',
    allowMissingProtocol: true,
    allowE2eLocalHttp: true,
  })
}

export function normalizeShipheroBaseUrl(value: string): string | null {
  const validated = validateShipheroBaseUrl(value)
  return validated.ok ? validated.normalizedUrl : null
}

function buildShipheroRequestUrl(path: string, baseUrl: string): URL {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const normalizedPath = path.replace(/^\/+/, '')
  return new URL(normalizedPath, normalizedBaseUrl)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Pull the bearer + lifetime out of a ShipHero /auth/refresh response. */
export function extractShipheroAuthToken(value: unknown): { token: string; expiresInSeconds: number | null } | null {
  const record = asRecord(value)
  if (!record) return null

  const tokenRaw = record.access_token ?? record.accessToken ?? record.token
  const token = typeof tokenRaw === 'string' && tokenRaw.trim() ? tokenRaw.trim() : null
  if (!token) return null

  const expiresRaw = record.expires_in ?? record.expiresIn
  const expiresInSeconds = typeof expiresRaw === 'number' && Number.isFinite(expiresRaw) && expiresRaw > 0
    ? expiresRaw
    : typeof expiresRaw === 'string' && /^\d+$/.test(expiresRaw.trim())
      ? Number(expiresRaw.trim())
      : null

  return { token, expiresInSeconds }
}

function shipheroAuthExpiry(expiresInSeconds: number | null, now = Date.now()): Date {
  const ttlMs = expiresInSeconds != null ? expiresInSeconds * 1000 : AUTH_TOKEN_FALLBACK_TTL_MS
  return new Date(now + ttlMs)
}

function isShipheroAuthTokenFresh(token: string | null, expiresAt: Date | null, now = Date.now()): boolean {
  if (!token || !expiresAt) return false
  return expiresAt.getTime() - AUTH_TOKEN_REFRESH_BUFFER_MS > now
}

async function persistShipheroAuthSession(token: string, expiresAt: Date): Promise<void> {
  const now = new Date()

  await db.$transaction(async (tx) => {
    await tx.setting.upsert({
      where: { key: SHIPHERO_ACCESS_TOKEN_KEY },
      create: { key: SHIPHERO_ACCESS_TOKEN_KEY, value: serializeSettingValue(SHIPHERO_ACCESS_TOKEN_KEY, token) },
      update: { value: serializeSettingValue(SHIPHERO_ACCESS_TOKEN_KEY, token) },
    })

    // Upsert on the (connector, label) unique key so two concurrent refreshes
    // (e.g. across app instances) can't both create the row and trip the unique
    // constraint — the findFirst+create pattern was racy.
    await tx.wmsConnection.upsert({
      where: { connector_label: { connector: 'shiphero', label: DEFAULT_SHIPHERO_CONNECTION_LABEL } },
      create: {
        connector: 'shiphero',
        label: DEFAULT_SHIPHERO_CONNECTION_LABEL,
        baseUrl: SHIPHERO_DEFAULT_BASE_URL,
        tokenExpiresAt: expiresAt,
        lastAuthAt: now,
      },
      update: { tokenExpiresAt: expiresAt, lastAuthAt: now },
    })
  })
}

async function requestShipheroAuthSession(
  baseUrl: string,
  refreshToken: string,
): Promise<{ token: string; expiresAt: Date }> {
  const response = await connectorFetch(buildShipheroRequestUrl(SHIPHERO_AUTH_PATH, baseUrl), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
    cache: 'no-store',
  }, {
    connectorName: 'ShipHero',
    allowE2eLocalHttp: true,
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
    // Never echo the response body — a ShipHero auth error can reflect the
    // refresh token back, and that secret must not reach a log line.
    throw new Error(`ShipHero auth failed with status ${response.status}`)
  }

  const extracted = extractShipheroAuthToken(parsedBody)
  if (!extracted) {
    throw new Error('ShipHero auth response did not include an access token')
  }

  return { token: extracted.token, expiresAt: shipheroAuthExpiry(extracted.expiresInSeconds) }
}

export async function testShipheroConnectionSettings(
  baseUrl: string,
  refreshToken: string,
): Promise<{ expiresAt: Date }> {
  const session = await requestShipheroAuthSession(baseUrl, refreshToken)
  return { expiresAt: session.expiresAt }
}

export async function getShipheroConnectionRecord() {
  return db.wmsConnection.findFirst({
    where: { connector: 'shiphero' },
    orderBy: [{ createdAt: 'asc' }],
  })
}

export async function getShipheroApiConfiguration() {
  const [connection, settings] = await Promise.all([
    getShipheroConnectionRecord(),
    getShipheroSettings(),
  ])

  return {
    baseUrl: normalizeShipheroBaseUrl(connection?.baseUrl ?? '') ?? SHIPHERO_DEFAULT_BASE_URL,
    refreshToken: settings.shiphero_refresh_token.trim(),
    webhookSecret: settings.shiphero_webhook_secret.trim(),
    accountId: settings.shiphero_account_id.trim(),
    adminOrderUrlTemplate: settings.shiphero_admin_order_url_template.trim(),
    orderLookupConnector: connection?.orderLookupConnector ?? null,
  }
}

export async function invalidateShipheroAccessToken(): Promise<void> {
  shipheroAuthRefreshInFlight = null

  await db.$transaction([
    db.setting.deleteMany({ where: { key: SHIPHERO_ACCESS_TOKEN_KEY } }),
    db.wmsConnection.updateMany({
      where: { connector: 'shiphero' },
      data: { tokenExpiresAt: null, lastAuthAt: null },
    }),
  ])
}

export async function getShipheroAccessToken(options?: { forceRefresh?: boolean }): Promise<string> {
  const forceRefresh = options?.forceRefresh ?? false
  const [connection, config, storedToken] = await Promise.all([
    getShipheroConnectionRecord(),
    getShipheroApiConfiguration(),
    getSettingValue(SHIPHERO_ACCESS_TOKEN_KEY),
  ])

  if (!forceRefresh && isShipheroAuthTokenFresh(storedToken, connection?.tokenExpiresAt ?? null)) {
    return storedToken as string
  }

  if (!config.refreshToken) {
    if (storedToken) return storedToken
    throw new Error('ShipHero refresh token is not configured')
  }

  if (!shipheroAuthRefreshInFlight) {
    const tracked = (async () => {
      const session = await requestShipheroAuthSession(config.baseUrl, config.refreshToken)
      await persistShipheroAuthSession(session.token, session.expiresAt)
      return session.token
    })()
    shipheroAuthRefreshInFlight = tracked
    // Clear the slot once the refresh settles — resolve OR reject — comparing
    // against the exact promise stored in the slot so it always nulls out. The
    // earlier `.finally()` compared against a different (pre-`.finally`) promise,
    // so it never matched and a failed refresh leaked permanently.
    void tracked.finally(() => {
      if (shipheroAuthRefreshInFlight === tracked) {
        shipheroAuthRefreshInFlight = null
      }
    })
  }

  return shipheroAuthRefreshInFlight
}

export async function isShipheroConfigured(): Promise<boolean> {
  const [config, cachedAccessToken] = await Promise.all([
    getShipheroApiConfiguration(),
    getSettingValue(SHIPHERO_ACCESS_TOKEN_KEY),
  ])

  return Boolean(config.refreshToken || cachedAccessToken)
}

/**
 * Verify an inbound ShipHero webhook. Mirrors the Mintsoft scheme: HMAC-SHA256
 * of the raw body with the shared secret, compared in hex or base64. The exact
 * header/timestamp binding is finalised in the webhook phase (h02x.3).
 */
export function verifyShipheroWebhookSignature(
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
