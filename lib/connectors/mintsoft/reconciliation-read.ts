/**
 * THE RECONCILIATION PACK'S READER OF MINTSOFT: GET only, the stored FIXED API KEY only, through the connector fetch seam.
 *
 * Mintsoft (ClientId 89) is a LIVE fulfilment system shared with other integrations, and `POST /api/Auth` is not a login in the ordinary
 * sense: it MINTS A NEW TENANT KEY and invalidates the one the order sweep and the label service use (see auth-lock.ts). So this reader
 * has no code path that can reach /api/Auth at all, and refuses before any request unless the stored configuration is the fixed-key mode:
 *
 *   - CREDENTIALS are three settings rows plus the connection's address, read in a READ ONLY REPEATABLE READ transaction on a connection
 *     the command already opened (never the application's client: lib/settings-store imports it). `mintsoft_auth_mode` must be exactly
 *     `api_key` (absent means the default, `credentials`, which logs in: refused; any other value is refused, never mapped to a mode), the
 *     fixed key `mintsoft_static_api_key` must be present and decrypts, `mintsoft_client_id` must be a positive whole number (every row is
 *     checked against it: Mintsoft is a shared 3PL tenant), and exactly one Mintsoft connection must carry a valid address. Anything
 *     else is a closed reason (VENDOR_AUTH_REFUSED or SOURCE_UNREADABLE) and NO request is made.
 *     The environment fallbacks the application honours (MINTSOFT_AUTH_MODE, MINTSOFT_STATIC_API_KEY) are NOT: the pack's environment is a
 *     short whitelist, so an installation configured through the environment alone is refused, never guessed.
 *   - REQUESTS are GET, to exactly `/api/Product/StockLevels?WarehouseId=<n>` and `/api/Product/List?PageNo=<n>&Limit=<n≤100>` on the
 *     connection's own origin; the seam is given a gate that refuses, before anything is sent, any other method, path (judged against
 *     MINTSOFT_READ_ALLOWLIST as well), parameter or origin, and `refuseRedirects`, so a redirect (Mintsoft mutates through GET) is an
 *     error and its target is never requested. The method is not a parameter of anything here. A 401 is NOT retried or refreshed.
 *   - RESPONSES are read by the connector's own strict stock reader (normalizeMintsoftStockLevels: exact fields, fails closed, no summing)
 *     and by exact-field product rows; nothing about a response but the validated rows is returned, and the key, the URL and any body or
 *     message never reach a result.
 */

import type { WmsPortResult, WmsProductRow, WmsReadPort, WmsStockRow } from '@/lib/reconciliation-pack/wms-source'
import type { PackReasonCode } from '@/lib/reconciliation-pack/constants'
import { connectorFetch, type ConnectorFetchOptions } from '@/lib/security/connector-fetch'
import { decryptSettingValue } from '@/lib/security/encrypted-settings'
import { validateExternalBaseUrl } from '@/lib/security/external-url-safety'
import { classifyMintsoftRequest } from './api/read-allowlist'
import { extractMintsoftArrayPayloadStrict, normalizeMintsoftStockLevels } from './api/normalizers'

export const MINTSOFT_PACK_SETTING_KEYS = ['mintsoft_auth_mode', 'mintsoft_static_api_key', 'mintsoft_client_id'] as const
const SENSITIVE_PACK_KEY = 'mintsoft_static_api_key'
/** The only auth mode the pack reads under. Every other value, and absence, would (or might) log in. */
const FIXED_KEY_MODE = 'api_key'
const REQUEST_TIMEOUT_MS = 60_000
const PRODUCT_LIST_MAX_LIMIT = 100
const MAX_PAGE_NO = 100_000

export type MintsoftPackCredentials = { baseUrl: string; apiKey: string; clientId: string }
export type MintsoftPackCredentialRead =
  | { ok: true; value: MintsoftPackCredentials }
  | { ok: false; reason: Extract<PackReasonCode, 'VENDOR_AUTH_REFUSED' | 'SOURCE_UNREADABLE'> }

/** The slice of a `pg` client this needs. */
export interface MintsoftQueryClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

const refused = (reason: 'VENDOR_AUTH_REFUSED' | 'SOURCE_UNREADABLE'): MintsoftPackCredentialRead => ({ ok: false, reason })

export async function readMintsoftPackCredentials(client: MintsoftQueryClient, env: Readonly<Record<string, string | undefined>> = process.env): Promise<MintsoftPackCredentialRead> {
  let open = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    open = true
    const mode = await client.query(`SELECT current_setting('transaction_read_only') AS read_only`)
    if (mode.rows.length !== 1 || mode.rows[0]!.read_only !== 'on') return refused('SOURCE_UNREADABLE')
    const read = await client.query('SELECT key, value FROM settings WHERE key = ANY($1::text[])', [[...MINTSOFT_PACK_SETTING_KEYS]])
    const values = new Map<string, string>()
    for (const row of read.rows) {
      if (typeof row.key !== 'string' || typeof row.value !== 'string' || values.has(row.key) || !(MINTSOFT_PACK_SETTING_KEYS as readonly string[]).includes(row.key)) return refused('SOURCE_UNREADABLE')
      values.set(row.key, row.key === SENSITIVE_PACK_KEY ? decryptSettingValue(row.key, row.value) : row.value)
    }
    // THE AUTH MODE FIRST, before the key is even looked at: anything that is not the fixed-key mode logs in (or might), and a login
    // replaces the key every other integration of the tenant uses.
    if ((values.get('mintsoft_auth_mode') ?? '').trim().toLowerCase() !== FIXED_KEY_MODE) return refused('VENDOR_AUTH_REFUSED')
    const apiKey = (values.get(SENSITIVE_PACK_KEY) ?? '').trim()
    if (apiKey.length === 0) return refused('VENDOR_AUTH_REFUSED')
    const clientId = (values.get('mintsoft_client_id') ?? '').trim()
    if (!/^[1-9][0-9]{0,8}$/.test(clientId)) return refused('SOURCE_UNREADABLE')
    const connections = await client.query('SELECT "baseUrl" AS base_url FROM wms_connections WHERE connector = $1', ['mintsoft'])
    if (connections.rows.length !== 1 || typeof connections.rows[0]!.base_url !== 'string') return refused('SOURCE_UNREADABLE')
    const validated = validateExternalBaseUrl(connections.rows[0]!.base_url, { connectorName: 'Mintsoft', allowMissingProtocol: true, allowE2eLocalHttp: true, env })
    if (!validated.ok) return refused('SOURCE_UNREADABLE')
    return { ok: true, value: { baseUrl: validated.normalizedUrl, apiKey, clientId } }
  } catch {
    return refused('SOURCE_UNREADABLE')
  } finally {
    if (open) { try { await client.query('ROLLBACK') } catch { /* nothing was written; the caller closes the connection */ } }
  }
}

const DIGITS = /^[0-9]{1,9}$/

/** The decision the hop gate makes for one hop. A string refuses the hop (nothing is sent). Exported so a test drives it directly. */
export function mintsoftReadHopRefusal(base: URL, hop: { method: string; url: URL; redirectCount: number }): string | null {
  if (hop.redirectCount !== 0) return 'redirect'
  if (hop.method !== 'GET') return 'method'
  if (hop.url.origin !== base.origin || hop.url.username || hop.url.password || hop.url.hash) return 'origin'
  const prefix = base.pathname.replace(/\/+$/, '')
  if (!hop.url.pathname.startsWith(`${prefix}/`)) return 'path'
  const relative = hop.url.pathname.slice(prefix.length)
  // Two exact paths, AND the connector's own read classification must agree (a path the allow-list does not list is a write).
  const names = relative === '/api/Product/StockLevels' ? ['WarehouseId'] : relative === '/api/Product/List' ? ['PageNo', 'Limit'] : null
  if (names === null || classifyMintsoftRequest('GET', relative).class !== 'read') return 'path'
  const seen = new Map<string, string>()
  for (const [name, value] of hop.url.searchParams) {
    if (!names.includes(name) || seen.has(name) || !DIGITS.test(value)) return 'parameter'
    seen.set(name, value)
  }
  if (seen.size !== names.length) return 'parameter'
  if (relative === '/api/Product/StockLevels') return Number(seen.get('WarehouseId')) >= 1 ? null : 'parameter'
  const limit = Number(seen.get('Limit'))
  const pageNo = Number(seen.get('PageNo'))
  return limit >= 1 && limit <= PRODUCT_LIST_MAX_LIMIT && pageNo >= 1 && pageNo <= MAX_PAGE_NO ? null : 'parameter'
}

export type MintsoftReadPortDeps = {
  /** Reads the credentials on first use. A refusal is carried as its reason and no request is made. */
  readCredentials: () => Promise<MintsoftPackCredentialRead>
  /** Test seam: the environment the fetch seam judges (E2E loopback). Absent = the process environment. */
  env?: ConnectorFetchOptions['env']
  /** Test seam: the fetch seam itself. */
  fetchImpl?: typeof connectorFetch
  timeoutMs?: number
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function wholeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null
}

export function createMintsoftReadPort(deps: MintsoftReadPortDeps): WmsReadPort {
  const send = deps.fetchImpl ?? connectorFetch
  let credentials: Promise<MintsoftPackCredentialRead> | null = null

  async function get(creds: MintsoftPackCredentials, relativePath: string, params: Record<string, string>): Promise<unknown> {
    const base = new URL(creds.baseUrl.endsWith('/') ? creds.baseUrl : `${creds.baseUrl}/`)
    const url = new URL(relativePath.replace(/^\/+/, ''), base)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    const response = await send(url, {
      method: 'GET',
      headers: { 'ms-apikey': creds.apiKey, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
    }, {
      connectorName: 'Mintsoft',
      allowE2eLocalHttp: true,
      env: deps.env,
      refuseRedirects: true,
      hopGate: (hop) => mintsoftReadHopRefusal(new URL(creds.baseUrl), hop),
    })
    // Exactly 200 with JSON: a 204, a 3xx that was not followed, a 401 (never refreshed) and every error are unreadable.
    if (response.status !== 200) throw new Error('status')
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) throw new Error('type')
    return await response.json()
  }

  async function credentialsOnce(): Promise<MintsoftPackCredentialRead> {
    credentials ??= deps.readCredentials().catch((): MintsoftPackCredentialRead => refused('SOURCE_UNREADABLE'))
    return credentials
  }

  return {
    async stockLevels(externalWarehouseId: string): Promise<WmsPortResult<WmsStockRow[]>> {
      try {
        if (typeof externalWarehouseId !== 'string' || !/^[1-9][0-9]{0,8}$/.test(externalWarehouseId)) return { ok: false, reason: 'BAD_KEY' }
        const creds = await credentialsOnce()
        if (!creds.ok) return { ok: false, reason: creds.reason }
        const body = await get(creds.value, '/api/Product/StockLevels', { WarehouseId: externalWarehouseId })
        // The strict reader: exact fields, fails closed on a malformed body, an unreadable row, a missing TotalStockLevel or a duplicate SKU.
        const lines = normalizeMintsoftStockLevels(body)
        const seenIds = new Set<number>()
        const rows = lines.map((line): WmsStockRow => {
          const raw = record(line.raw)
          const productId = wholeNumber(raw?.ProductId)
          // Every row must belong to the warehouse asked about and to OUR client (a shared tenant), and say whether it is a bundle.
          if (raw === null || productId === null || raw.WarehouseId !== Number(externalWarehouseId) || raw.ClientId !== Number(creds.value.clientId) || typeof raw.Bundle !== 'boolean') throw new Error('row')
          if (seenIds.has(productId)) throw new Error('duplicate')
          seenIds.add(productId)
          return { sku: line.sku, productId: String(productId), onHand: line.onHand, bundle: raw.Bundle }
        })
        return { ok: true, value: rows }
      } catch {
        return { ok: false, reason: 'SOURCE_UNREADABLE' }
      }
    },

    async productPage(pageNo: number, limit: number): Promise<WmsPortResult<WmsProductRow[]>> {
      try {
        if (!Number.isSafeInteger(pageNo) || pageNo < 1 || pageNo > MAX_PAGE_NO) return { ok: false, reason: 'BAD_KEY' }
        // CLAMPED, never passed through: Mintsoft answers 400 above 100.
        const clamped = Math.min(PRODUCT_LIST_MAX_LIMIT, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : PRODUCT_LIST_MAX_LIMIT))
        const creds = await credentialsOnce()
        if (!creds.ok) return { ok: false, reason: creds.reason }
        const body = await get(creds.value, '/api/Product/List', { PageNo: String(pageNo), Limit: String(clamped) })
        const items = extractMintsoftArrayPayloadStrict(body, 'Product/List')
        const rows = items.map((item): WmsProductRow => {
          const raw = record(item)
          if (raw === null) throw new Error('row')
          const idKeys = ['ID', 'Id', 'id'].filter((name) => raw[name] !== undefined)
          if (idKeys.length !== 1) throw new Error('id')
          const idValue = raw[idKeys[0]!]
          const id = typeof idValue === 'string' && /^[1-9][0-9]{0,17}$/.test(idValue) ? Number(idValue) : wholeNumber(idValue)
          const sku = typeof raw.SKU === 'string' ? raw.SKU.trim() : ''
          if (id === null || sku.length === 0) throw new Error('row')
          // A shared tenant: a row that names another client is not ours, and a row that names none is read as ours (the key is the scope).
          if (raw.ClientId !== undefined && raw.ClientId !== null && raw.ClientId !== Number(creds.value.clientId)) throw new Error('client')
          return { id: String(id), sku }
        })
        return { ok: true, value: rows }
      } catch {
        return { ok: false, reason: 'SOURCE_UNREADABLE' }
      }
    },
  }
}
