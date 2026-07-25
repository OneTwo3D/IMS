import { createHash, createHmac, timingSafeEqual } from 'crypto'
import { db } from '@/lib/db'
import {
  getMintsoftSettings,
  resolveMintsoftAuthMode,
  type MintsoftAuthMode,
} from '@/lib/connectors/mintsoft/settings/schema'
import { connectorFetch } from '@/lib/security/connector-fetch'
import { validateExternalBaseUrl } from '@/lib/security/external-url-safety'
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
  const validated = validateMintsoftBaseUrl(value)
  return validated.ok ? validated.normalizedUrl : null
}

export function validateMintsoftBaseUrl(value: string) {
  return validateExternalBaseUrl(value, {
    connectorName: 'Mintsoft',
    allowMissingProtocol: true,
    allowE2eLocalHttp: true,
  })
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
      // Update by id (not by label): a Mintsoft connection can be renamed via the
      // connection-settings form, so a label-keyed write could miss the row if a
      // rename races this refresh and end up inserting a duplicate. Updating by id
      // is immune to that.
      await tx.wmsConnection.update({
        where: { id: existingConnection.id },
        data: { tokenExpiresAt: expiresAt, lastAuthAt: now },
      })
      return
    }

    // No connection yet: upsert on the default-label unique so two concurrent
    // first-time refreshes can't both create the row and trip the (connector,
    // label) unique constraint — the prior bare create was racy.
    await tx.wmsConnection.upsert({
      where: { connector_label: { connector: 'mintsoft', label: DEFAULT_MINTSOFT_CONNECTION_LABEL } },
      create: {
        connector: 'mintsoft',
        label: DEFAULT_MINTSOFT_CONNECTION_LABEL,
        tokenExpiresAt: expiresAt,
        lastAuthAt: now,
      },
      update: {
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
  const response = await connectorFetch(buildMintsoftRequestUrl('/api/Auth', baseUrl), {
    method: 'POST',
    headers: buildMintsoftAuthHeaders(baseUrl),
    body: JSON.stringify({
      Username: username,
      Password: password,
    }),
    cache: 'no-store',
  }, {
    connectorName: 'Mintsoft',
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

export async function testMintsoftConnectionSettings(
  baseUrl: string,
  username: string,
  password: string,
): Promise<{ expiresAt: Date }> {
  const session = await requestMintsoftAuthSession(baseUrl, username, password)
  return { expiresAt: session.expiresAt }
}

/**
 * Connection test for FIXED-KEY mode.
 *
 * The credentials test above works by logging in — which mints a new tenant key
 * and invalidates the current one. Running that to "test" a fixed-key
 * connection would therefore break the very key it is testing, plus the other
 * two integrations sharing it. So we instead make a cheap authenticated GET
 * with the fixed key and judge it on the response status (o3d-092).
 */
export async function testMintsoftFixedApiKey(
  baseUrl: string,
  apiKey: string,
): Promise<void> {
  const key = apiKey.trim()
  if (!key) {
    throw new Error('No Mintsoft API key configured to test')
  }

  const normalizedBaseUrl = normalizeMintsoftBaseUrl(baseUrl)
  if (!normalizedBaseUrl) {
    throw new Error('Mintsoft base URL is not valid')
  }

  const response = await connectorFetch(
    buildMintsoftRequestUrl('/api/Warehouse', normalizedBaseUrl),
    {
      method: 'GET',
      headers: { ...buildMintsoftAuthHeaders(normalizedBaseUrl), 'ms-apikey': key },
      cache: 'no-store',
    },
    { connectorName: 'Mintsoft', allowE2eLocalHttp: true },
  )

  if (response.status === 401 || response.status === 403) {
    throw new Error('Mintsoft rejected the API key (HTTP ' + response.status + ')')
  }

  if (!response.ok) {
    const body = (await response.text().catch(() => '')).trim()
    throw new Error(
      `Mintsoft API key test failed with status ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
    )
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
    // Fails CLOSED on a malformed value. This is on the read path of every
    // sync, so the tempting move is to swallow it and carry on — but "carry on"
    // here means username/password, i.e. a login that rotates the tenant key.
    // A typo cannot be assumed to be absent: mintsoft_auth_mode has an env
    // fallback (MINTSOFT_AUTH_MODE), so an invalid value can arrive without
    // ever passing through the validated settings action.
    authMode: resolveMintsoftAuthMode(settings.mintsoft_auth_mode),
    staticApiKey: settings.mintsoft_static_api_key.trim(),
    username: settings.mintsoft_username.trim(),
    password: settings.mintsoft_password.trim(),
    webhookSecret: settings.mintsoft_webhook_secret.trim(),
    orderLookupConnector: connection?.orderLookupConnector ?? null,
  }
}

/**
 * True when the connector is configured to use a fixed operator-supplied key.
 * In that mode NOTHING may call /api/Auth: a refresh would mint a new tenant
 * key and break the woocommerce-mintsoft-sync sweep and the shipping-label
 * service, which share the same tenant key (o3d-092).
 */
export async function isMintsoftFixedKeyMode(): Promise<boolean> {
  const config = await getMintsoftApiConfiguration()
  return config.authMode === 'api_key'
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

  // o3d-092: fixed-key mode short-circuits EVERYTHING below — the freshness
  // check, the forceRefresh override, and the single-flight login. /api/Auth
  // mints a new tenant key and invalidates the old one, so a refresh here
  // would break the woocommerce-mintsoft-sync sweep and the shipping-label
  // service, which share this tenant's key. Note this deliberately ignores
  // `forceRefresh`: the 401 retry path sets it, and honouring it would
  // reintroduce exactly the rotation this mode exists to prevent.
  if (config.authMode === 'api_key') {
    if (!config.staticApiKey) {
      throw new Error(
        'Mintsoft authentication is set to "Fixed API key" but no key is configured. ' +
        'Refusing to fall back to username/password: logging in would regenerate the ' +
        'tenant API key and break the other Mintsoft integrations. Set the key, or ' +
        'switch the connection back to username/password.',
      )
    }
    return config.staticApiKey
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
    const tracked = (async () => {
      const session = await requestMintsoftAuthSession(config.baseUrl, config.username, config.password)
      // Re-read the mode AFTER the round trip. An operator can switch to
      // api_key while this request is in flight; the switch clears the cached
      // token, and persisting ours afterwards would resurrect a rotating token
      // under a connection that is supposed to be on a fixed key.
      //
      // This cannot un-rotate the tenant key — that happened at Mintsoft the
      // moment the request landed, and no local code can recall it. What it
      // does is stop the local state from silently disagreeing with the chosen
      // mode. Closing the window properly needs a durable cross-process lock
      // around every /api/Auth call and mode transition: filed as follow-up.
      const modeNow = await getMintsoftApiConfiguration().catch(() => null)
      if (modeNow?.authMode === 'api_key') {
        throw new Error(
          'Mintsoft switched to fixed-key authentication while a credentials refresh was ' +
          'in flight. Discarding the newly minted token. NOTE: that refresh already ' +
          'regenerated the tenant API key, so the configured fixed key is now stale — ' +
          'issue a new key in Mintsoft and update all integrations.',
        )
      }
      await persistMintsoftAuthSession(session.token, session.expiresAt)
      return session.token
    })()
    mintsoftAuthRefreshInFlight = tracked
    // Clear the slot once the refresh settles — resolve OR reject — comparing
    // against the exact promise stored so it always nulls out (the earlier
    // `.finally()` compared against a different, pre-`.finally` promise, so it
    // never matched and a failed refresh leaked). `then(clear, clear)` fulfils on
    // both paths, so the discarded continuation can't surface an unhandled rejection.
    const clearSlot = () => {
      if (mintsoftAuthRefreshInFlight === tracked) {
        mintsoftAuthRefreshInFlight = null
      }
    }
    void tracked.then(clearSlot, clearSlot)
  }

  return mintsoftAuthRefreshInFlight
}

export async function isMintsoftConfigured(): Promise<boolean> {
  const [config, cachedApiKey] = await Promise.all([
    getMintsoftApiConfiguration(),
    getSettingValue(MINTSOFT_AUTH_TOKEN_KEY),
  ])

  if (!config.baseUrl) return false

  // In fixed-key mode the fixed key is the ONLY thing that counts. Falling
  // back to username/password or to a stale cached token here would report
  // "configured" for a connection that is about to throw on every call — and
  // worse, would imply the credentials are still load-bearing when the whole
  // point is that they are not.
  if (config.authMode === 'api_key') {
    return Boolean(config.staticApiKey)
  }

  return Boolean((config.username && config.password) || cachedApiKey)
}

/**
 * Drop the cached rotating token when switching INTO fixed-key mode.
 *
 * Without this the settings panel keeps showing a token (and an expiry) that
 * nothing uses, and a later switch back to credentials mode could hand out a
 * long-dead key from the cache before its freshness check catches up. The
 * operator's fixed key lives in a separate setting, so nothing is lost.
 */
export async function clearCachedMintsoftTokenForFixedKeyMode(
  mode: MintsoftAuthMode,
): Promise<void> {
  if (mode !== 'api_key') return
  await invalidateMintsoftAccessToken()
}

export function verifyMintsoftWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  options?: { timestamp?: string | null },
): boolean {
  const normalizedProvided = signatureHeader ? normalizeSignatureValue(signatureHeader) : ''
  const normalizedSecret = secret.trim()
  const timestamp = options?.timestamp?.trim()

  if (!normalizedProvided || !normalizedSecret || !timestamp) return false

  const signedPayload = `${timestamp}.${rawBody}`
  const expectedHex = createHmac('sha256', normalizedSecret).update(signedPayload, 'utf8').digest('hex')
  const expectedBase64 = createHmac('sha256', normalizedSecret).update(signedPayload, 'utf8').digest('base64')

  return safeCompareSignature(expectedHex, normalizedProvided)
    || safeCompareSignature(expectedBase64, normalizedProvided)
}
