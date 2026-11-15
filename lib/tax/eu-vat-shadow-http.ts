/**
 * THE READ-ONLY TRANSPORT OF THE EU VAT SHADOW REPORT. Nothing here can write, in this system or in a vendor.
 *
 * WHY NOT THE NORMAL CLIENTS. `xeroGet` resolves its token through `getAccessToken`, which REFRESHES an expiring token (a POST to Xero plus a write of the new token to the database) and on a failed refresh logs
 * activity and notifies; `readStoredToken` also re-encrypts a plaintext token row. `getSettingValues` (behind `getWcCredentials`) re-encrypts a plaintext credential setting. The shadow report must be provably free of
 * all of that, so it reads the stored rows itself, with `findUnique`/`findMany` only, and sends GETs through `connectorFetch` (the transport every connector uses; for a GET it only sends).
 *
 *   Xero         the stored access token is used ONLY if it has not expired. An expired, missing or blocked token fails closed with a message; it is never refreshed. Open IMS Sync once to refresh, then rerun.
 *   WooCommerce  the stored credentials are read and decrypted without the settings store's migrate-on-read.
 *
 * What a vendor says is reduced to a closed code. A response body, header or error text is never returned.
 */
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/secrets'
import { connectorFetch } from '@/lib/security/connector-fetch'
import { deserializeSettingValue } from '@/lib/settings-store'
import { getStoredTenantBlockReason } from '@/lib/connectors/xero/auth'
import { WC_CREDENTIAL_SETTING_KEYS, resolveWcCredentials } from '@/lib/connectors/woocommerce/credentials'

const XERO_BASE_URL = 'https://api.xero.com/api.xro/2.0'
/** A token that expires within this long is treated as expired: the request may be in flight when it does. */
export const SHADOW_TOKEN_SAFETY_MS = 60_000

export const XERO_TOKEN_EXPIRED_MESSAGE = 'Xero access token expired; open IMS Sync once to refresh, then rerun'

export type ShadowXeroGrant = { ok: true; accessToken: string; tenantId: string } | { ok: false; code: 'xero_not_connected' | 'xero_token_expired' | 'xero_tenant_blocked' | 'xero_token_unreadable'; message: string }

/** The stored Xero token, if it is still valid. Reads only; never refreshes, logs or notifies. */
export async function readShadowXeroGrant(now: Date): Promise<ShadowXeroGrant> {
  const row = await db.accountingToken.findUnique({ where: { connector: 'xero' }, select: { accessToken: true, expiresAt: true, tenantId: true } })
  if (!row) return { ok: false, code: 'xero_not_connected', message: 'Xero is not connected' }
  if (row.expiresAt.getTime() < now.getTime() + SHADOW_TOKEN_SAFETY_MS) return { ok: false, code: 'xero_token_expired', message: XERO_TOKEN_EXPIRED_MESSAGE }
  let blocked: string | null
  try { blocked = await getStoredTenantBlockReason() } catch { return { ok: false, code: 'xero_tenant_blocked', message: 'the stored Xero connection could not be checked against the tenant guard' } }
  if (blocked !== null) return { ok: false, code: 'xero_tenant_blocked', message: 'the stored Xero connection is refused by the tenant guard' }
  let accessToken: string
  try { accessToken = decryptSecret(row.accessToken) } catch { return { ok: false, code: 'xero_token_unreadable', message: 'the stored Xero token could not be read' } }
  return { ok: true, accessToken, tenantId: row.tenantId }
}

export type ReadResult = { ok: true; data: unknown } | { ok: false; code: string }

const statusCode = (status: number): string => `http_${status}`

async function readJson(res: Response): Promise<ReadResult> {
  if (!res.ok) return { ok: false, code: statusCode(res.status) }
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return { ok: false, code: 'not_json' }
  try { return { ok: true, data: await res.json() } } catch { return { ok: false, code: 'unreadable' } }
}

/** ONE Xero GET with a grant already in hand. No retry (a 429 is `http_429`), no redirect, no body. `path` is relative to the accounting API. */
export async function xeroReadOnlyGet(grant: Extract<ShadowXeroGrant, { ok: true }>, path: string): Promise<ReadResult> {
  try {
    const res = await connectorFetch(`${XERO_BASE_URL}/${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${grant.accessToken}`, 'Xero-Tenant-Id': grant.tenantId, Accept: 'application/json' },
    }, { connectorName: 'Xero', refuseRedirects: true })
    return await readJson(res)
  } catch { return { ok: false, code: 'request_failed' } }
}

export type ShadowWcCredentials = { ok: true; url: string; key: string; secret: string } | { ok: false; code: 'wc_not_configured' | 'wc_credentials_unreadable' }

/** The stored WooCommerce credentials. `findMany` only: no migrate-on-read, no write. */
export async function readShadowWcCredentials(): Promise<ShadowWcCredentials> {
  try {
    const rows = await db.setting.findMany({ where: { key: { in: [...WC_CREDENTIAL_SETTING_KEYS] } }, select: { key: true, value: true } })
    const byKey = new Map(rows.map((r) => [r.key, deserializeSettingValue(r.key, r.value)]))
    const resolution = resolveWcCredentials({ url: byKey.get('wc_url'), key: byKey.get('wc_consumer_key'), secret: byKey.get('wc_consumer_secret') })
    if (!resolution.ok) return { ok: false, code: resolution.reason === 'not_configured' ? 'wc_not_configured' : 'wc_credentials_unreadable' }
    return { ok: true, url: resolution.credentials.url, key: resolution.credentials.key, secret: resolution.credentials.secret }
  } catch { return { ok: false, code: 'wc_credentials_unreadable' } }
}

/** ONE WooCommerce GET of an order by id. */
export async function wcReadOnlyGetOrder(creds: Extract<ShadowWcCredentials, { ok: true }>, externalOrderId: string): Promise<ReadResult> {
  if (!/^\d{1,12}$/.test(externalOrderId)) return { ok: false, code: 'bad_external_id' }
  try {
    const res = await connectorFetch(`${creds.url}/wp-json/wc/v3/orders/${externalOrderId}`, {
      method: 'GET',
      headers: { Authorization: `Basic ${Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(60_000),
    }, { connectorName: 'WooCommerce', refuseRedirects: true })
    return await readJson(res)
  } catch { return { ok: false, code: 'request_failed' } }
}
