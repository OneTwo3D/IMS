/**
 * THE FIRST-LOAD MINTSOFT ARCHIVE WRITER: the one Mintsoft write of the first-load archive command (scripts/first-load-mintsoft-archive.ts), which sets a
 * product discontinued (`DisCont`) for each product the owner set to Archived on the lifecycle review sheet. A ONE-OFF OPERATOR WRITE at the cut-over,
 * never run by the application: ownership-map row `mintsoft / product.discontinue` (lib/security/writer-ownership-map.ts).
 *
 * THE REQUEST SHAPE WAS VERIFIED on the live tenant with the owner's approval (2026-11-21, one zero-stock product, restored afterwards):
 *   - `POST /api/Product` with ONLY `{ID, SKU, DisCont}` changes `DisCont` and nothing else (every other field of `GET /api/Product/{id}` identical, but
 *     `LastUpdated` and `LastUpdatedByUser`). Mintsoft answers HTTP 200 with `{Success, Message, ...}`; success is `Success === true` ('Product
 *     Successfully Updated!'). A FULL product body is refused with HTTP 200 and `Success: false` ('One or more pallet sizes are not valid!'), so HTTP 200
 *     alone proves nothing and the full body is never sent.
 *   - `GET /api/Product/{id}` returns the whole product, with `ID`, `SKU`, `ClientId`, `Bundle` and `DisCont`, so each write is verified on the one product.
 *   - Mintsoft's edge answers 403 to a request without a User-Agent: every request here names one.
 *
 * WHAT IT CAN SEND, judged on every hop before anything leaves (`archiveHopRefusal`, and the producer hold's own per-hop gate `mintsoftHopGate`):
 * `GET /api/Product/{digits}`, `GET /api/Product/StockLevels?WarehouseId=<digits>` and `POST /api/Product` with no parameter, to the connection's own
 * origin, no redirect. The transport's outbound-write grant applies as to every Mintsoft write: the POST is refused (`OutboundWriteHeldError`, nothing
 * sent) unless the operator's process environment carries `MINTSOFT_WRITE_ALLOWED=<base URL>|<client id>` for exactly this tenant. `POST /api/Auth` is
 * unreachable: the key is the fixed key of the operator's credentials file (the same file the lifecycle review reads), never exchanged.
 *
 * Requests are sequential and paced (`MIN_INTERVAL_MS` between any two). Every failure is a short reason without the key, a URL or a response body;
 * Mintsoft's own `Message` is passed on, cut to 200 printable characters.
 */
import { connectorFetch, type ConnectorFetchOptions } from '@/lib/security/connector-fetch'
import { OutboundWriteHeldError } from '@/lib/security/outbound-write-grant'
import type { WmsArchiveWriter, WmsProductRead, WmsStep } from '@/lib/first-load/wms-discontinue/execute'
import { classifyMintsoftRequest } from './api/read-allowlist'
import { normalizeMintsoftStockLevels } from './api/normalizers'
import type { MintsoftReviewConfig } from './lifecycle-review-read'
import { mintsoftEgressHold, mintsoftHopGate } from './producer-egress'

export const ARCHIVE_USER_AGENT = 'onetwo3d-ims-first-load-archive/1'
export const MIN_INTERVAL_MS = 1000
const REQUEST_TIMEOUT_MS = 60_000
/** Fields any accepted update moves; they are not compared after the write. `DisCont` is compared on its own. */
export const FIELDS_ANY_UPDATE_MOVES = ['LastUpdated', 'LastUpdatedByUser'] as const
const DISCONTINUED_FIELD = 'DisCont'

const DIGITS = /^[1-9][0-9]{0,17}$/

/**
 * The decision for one hop, exported so a test drives it directly. A string refuses the hop (nothing is sent).
 */
export function archiveHopRefusal(base: URL, hop: { method: string; url: URL; redirectCount: number }): string | null {
  if (hop.redirectCount !== 0) return 'redirect'
  if (hop.url.origin !== base.origin || hop.url.username || hop.url.password || hop.url.hash) return 'origin'
  const prefix = base.pathname.replace(/\/+$/, '')
  if (!hop.url.pathname.startsWith(`${prefix}/`)) return 'path'
  const relative = hop.url.pathname.slice(prefix.length)
  const method = hop.method.toUpperCase()
  const params = [...hop.url.searchParams]
  if (method === 'GET' && /^\/api\/Product\/[1-9][0-9]{0,17}$/.test(relative)) {
    if (classifyMintsoftRequest('GET', relative).class !== 'read') return 'path'
    return params.length === 0 ? null : 'parameter'
  }
  if (method === 'GET' && relative === '/api/Product/StockLevels') {
    if (classifyMintsoftRequest('GET', relative).class !== 'read') return 'path'
    return params.length === 1 && params[0]![0] === 'WarehouseId' && DIGITS.test(params[0]![1]) ? null : 'parameter'
  }
  if (method === 'POST' && relative === '/api/Product') return params.length === 0 ? null : 'parameter'
  return method === 'GET' || method === 'POST' ? 'path' : 'method'
}

export interface MintsoftArchiveWriterDeps {
  /** Test seam: the environment the transport and the producer hold judge (the e2e loopback allowance, the outbound-write grant). Absent = the process environment. */
  env?: ConnectorFetchOptions['env']
  sleep?: (ms: number) => Promise<void>
  minIntervalMs?: number
  timeoutMs?: number
}

type Sent = { status: number; json: unknown | undefined }

/**
 * ONE request of the archive writer: through the connector fetch seam with the transport's outbound-write grant (the POST is a write), the producer
 * hold's per-hop gate and this writer's own exact-path gate, the fixed key in `ms-apikey`, a User-Agent, no redirect. Never throws a body, URL or key.
 */
export async function sendMintsoftArchiveRequest(config: MintsoftReviewConfig, method: 'GET' | 'POST', relativePath: string, params: Record<string, string>, body: unknown, deps: MintsoftArchiveWriterDeps): Promise<Sent> {
  const base = new URL(config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`)
  const url = new URL(relativePath.replace(/^\/+/, ''), base)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  const headers: Record<string, string> = { 'ms-apikey': config.apiKey, Accept: 'application/json', 'User-Agent': ARCHIVE_USER_AGENT }
  if (method === 'POST') headers['Content-Type'] = 'application/json'
  const response = await connectorFetch(url, {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
  }, {
    connectorName: 'Mintsoft',
    allowE2eLocalHttp: true,
    env: deps.env,
    refuseRedirects: true,
    outboundWriteContext: { writeScopeId: config.clientId },
    hopGate: (hop) => archiveHopRefusal(new URL(config.baseUrl), hop) ?? mintsoftHopGate(hop),
  })
  const type = response.headers.get('content-type') ?? ''
  let json: unknown | undefined
  if (type.includes('application/json')) {
    try {
      json = await response.json()
    } catch {
      json = undefined
    }
  } else {
    await response.arrayBuffer().catch(() => undefined)
  }
  return { status: response.status, json }
}

const record = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const idOf = (v: unknown): string | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? String(v) : typeof v === 'string' && DIGITS.test(v) ? v : null)
/** Mintsoft's own message, printable and short (it is shown to the operator; it never carries the key). */
export function mintsoftMessage(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') return '(no message)'
  const clean = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffd\ufffe\uffff]/gu, ' ').trim()
  return clean.length > 200 ? `${clean.slice(0, 200)}...` : clean
}

/** The fields of two product answers that differ, but `DisCont` and the fields any update moves. A field present in only one answer differs. */
export function changedMintsoftProductFields(before: unknown, after: unknown): string[] {
  const a = record(before)
  const b = record(after)
  if (a === null || b === null) return ['(the product answer is not an object)']
  const skip = new Set<string>([DISCONTINUED_FIELD, ...FIELDS_ANY_UPDATE_MOVES])
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !skip.has(k)).sort()
  return names.filter((k) => !(Object.prototype.hasOwnProperty.call(a, k) && Object.prototype.hasOwnProperty.call(b, k) && stableJson(a[k]) === stableJson(b[k])))
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const r = record(value)
  if (r !== null) return `{${Object.keys(r).sort().map((k) => `${JSON.stringify(k)}:${stableJson(r[k])}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}

/** The discontinue request itself: `POST /api/Product` with exactly `{ID, SKU, DisCont: true}` (the verified partial body). */
export async function discontinueMintsoftProduct(config: MintsoftReviewConfig, productId: string, sku: string, deps: MintsoftArchiveWriterDeps): Promise<WmsStep<{ accepted: boolean; message: string }>> {
  if (!DIGITS.test(productId)) return { ok: false, problem: 'the product id is not a whole number' }
  // The producer hold first, as mintsoftRequest does: while it is enforced and Mintsoft is not live, nothing is sent (the per-hop gate refuses it too).
  if (mintsoftEgressHold(deps.env === undefined ? undefined : { env: deps.env as never }).held) return { ok: false, problem: 'held before it left IMS: the producer hold is enforced for Mintsoft and this installation is not in its live phase, so nothing was sent' }
  let sent: Sent
  try {
    sent = await sendMintsoftArchiveRequest(config, 'POST', '/api/Product', {}, { ID: Number(productId), SKU: sku, DisCont: true }, deps)
  } catch (error) {
    // The outbound-write hold's text says nothing was sent; any other error may have left after the request was sent.
    return { ok: false, problem: error instanceof OutboundWriteHeldError ? 'held before it left IMS: the outbound-write grant MINTSOFT_WRITE_ALLOWED does not name this tenant, so nothing was sent' : 'the request failed (it may or may not have reached Mintsoft)' }
  }
  if (sent.status !== 200) return { ok: false, problem: `Mintsoft answered HTTP ${sent.status}` }
  const body = record(sent.json)
  if (body === null || typeof body.Success !== 'boolean') return { ok: false, problem: 'Mintsoft answered HTTP 200 without a {Success, Message} body' }
  return { ok: true, value: { accepted: body.Success === true, message: mintsoftMessage(body.Message) } }
}

/** The writer the first-load archive command drives (lib/first-load/wms-discontinue/execute.ts). Every request is paced. */
export function createMintsoftArchiveWriter(config: MintsoftReviewConfig, deps: MintsoftArchiveWriterDeps = {}): WmsArchiveWriter {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let requests = 0
  const paced = async <T>(run: () => Promise<T>): Promise<T> => {
    if (requests > 0) await sleep(deps.minIntervalMs ?? MIN_INTERVAL_MS)
    requests++
    return run()
  }
  const client = Number(config.clientId)
  return {
    label: 'Mintsoft',
    async readProduct(productId: string): Promise<WmsStep<WmsProductRead>> {
      if (!DIGITS.test(productId)) return { ok: false, problem: 'the product id is not a whole number' }
      let sent: Sent
      try {
        sent = await paced(() => sendMintsoftArchiveRequest(config, 'GET', `/api/Product/${productId}`, {}, undefined, deps))
      } catch {
        return { ok: false, problem: 'the request failed' }
      }
      if (sent.status !== 200) return { ok: false, problem: `Mintsoft answered HTTP ${sent.status}` }
      const raw = record(sent.json)
      if (raw === null) return { ok: false, problem: 'the answer is not a product object' }
      const id = idOf(raw.ID)
      if (id === null || typeof raw.SKU !== 'string') return { ok: false, problem: 'the answer carries no usable ID and SKU' }
      return {
        ok: true,
        value: {
          productId: id,
          sku: raw.SKU,
          bundle: typeof raw.Bundle === 'boolean' ? raw.Bundle : null,
          discontinued: typeof raw.DisCont === 'boolean' ? raw.DisCont : null,
          ownClient: raw.ClientId === client,
          snapshot: raw,
        },
      }
    },
    async readStock(productId: string, sku: string): Promise<WmsStep<{ stockRow: boolean; onHand: number }>> {
      let stockRow = false
      let onHand = 0
      for (const warehouse of config.warehouseIds) {
        let sent: Sent
        try {
          sent = await paced(() => sendMintsoftArchiveRequest(config, 'GET', '/api/Product/StockLevels', { WarehouseId: warehouse }, undefined, deps))
        } catch {
          return { ok: false, problem: `the stock of warehouse ${warehouse} could not be read` }
        }
        if (sent.status !== 200 || sent.json === undefined) return { ok: false, problem: `the stock of warehouse ${warehouse} could not be read (HTTP ${sent.status})` }
        let lines
        try {
          lines = normalizeMintsoftStockLevels(sent.json)
        } catch {
          return { ok: false, problem: `the stock of warehouse ${warehouse} is unreadable` }
        }
        let rows = 0
        for (const line of lines) {
          const raw = record(line.raw)
          if (raw === null || idOf(raw.ProductId) !== productId) continue
          if (raw.WarehouseId !== Number(warehouse) || raw.ClientId !== client) return { ok: false, problem: `a stock row of warehouse ${warehouse} for product ${productId} does not name that warehouse and our client` }
          if (line.sku !== sku.trim()) return { ok: false, problem: `the stock of warehouse ${warehouse} names product ${productId} under another SKU` }
          rows++
          onHand += line.onHand
        }
        if (rows > 1) return { ok: false, problem: `product ${productId} appears more than once in the stock of warehouse ${warehouse}` }
        if (rows === 1) stockRow = true
      }
      return { ok: true, value: { stockRow, onHand } }
    },
    async setDiscontinued(productId: string, sku: string) {
      return paced(() => discontinueMintsoftProduct(config, productId, sku, deps))
    },
    changedFields: changedMintsoftProductFields,
  }
}
