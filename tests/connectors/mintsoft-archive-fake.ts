/**
 * A FAKE Mintsoft tenant on a LOOPBACK HTTP server, for the first-load archive writer and command tests (no real network: tests/no-outbound-network.cjs
 * refuses anything but loopback). It holds synthetic products and stock, records every request, and implements the answers verified on the live tenant
 * on 2026-11-21: a partial {ID, SKU, DisCont} POST is applied and answered Success:true; a full product body (it carries PalletSizes) is answered HTTP 200
 * Success:false 'One or more pallet sizes are not valid!'; a request without a User-Agent is answered 403. Hooks let a test make it misbehave.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { MintsoftReviewConfig } from '../../lib/connectors/mintsoft/lifecycle-review-read.ts'
import { bridgePayloadFromReport, parseBridgeStatusOutput } from '../../lib/domain/writer-attestation/bridge-status.ts'
import type { ArchiveRetirementRow, ArchiveSwitchoverCheckRow } from '../../lib/first-load/wms-discontinue/execute.ts'
import { sampleReport } from '../ops/bridge-status-fixtures.ts'

export const KEY = 'ms_fixed_key_archive_0123456789_test_only'
export const CLIENT = 89

export type Seen = { method: string; url: string; apikey: string | undefined; ua: string | undefined; body: string }
export type FakeTenant = {
  products: Map<string, Record<string, unknown>>
  stock: Record<string, Array<Record<string, unknown>>>
  /** The warehouse list (`GET /api/Warehouse`); default: warehouse 5 only. */
  warehouses?: Array<Record<string, unknown>>
  /**
   * Called on a partial POST before it is applied; return a body to answer instead (the write is then NOT applied), `text` to answer a raw body with
   * its own content type, or 'drop' to destroy the connection without an answer.
   */
  onPost?: (body: Record<string, unknown>) => { status?: number; body: unknown } | { status?: number; text: string; contentType: string } | 'drop' | undefined
  /** Called after an accepted write instead of setting DisCont (a write Mintsoft reports as done that did not take). */
  ignoreDisCont?: boolean
  /** Called after an accepted write, to change the stored product further (a write that touched other fields). */
  afterWrite?: (product: Record<string, unknown>) => void
  /** Called on each stock read. */
  onStock?: (warehouse: string, rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>
}
export type Rig = { seen: Seen[]; base: string; tenant: FakeTenant; close: () => Promise<void> }

export function syntheticProduct(id: number, sku: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    SKU: sku, Name: `synthetic ${sku}`, PalletSizes: 'synthetic-pallets', Description: null, Weight: 0.25, Bundle: false, DisCont: false, Price: 1.5,
    CommodityCode: { Code: '0000000000' }, ProductPrices: [], ProductCustomFields: [{ Name: 'f', Value: 'v' }], ClientId: CLIENT, ID: id,
    LastUpdated: '2026-01-01T00:00:00.000', LastUpdatedByUser: 'synthetic-user', ...extra,
  }
}

/** A fake Mintsoft tenant on loopback. */
export async function fakeMintsoft(tenant: FakeTenant, track: Rig[]): Promise<Rig> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', apikey: req.headers['ms-apikey'] as string | undefined, ua: req.headers['user-agent'] as string | undefined, body })
      const json = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) }
      const url = new URL(req.url ?? '/', 'http://x')
      if (!req.headers['user-agent']) return json({ Message: 'Forbidden' }, 403)
      if (/\/api\/Auth/i.test(url.pathname)) return json({}, 500)
      if (req.method === 'GET' && url.pathname === '/api/Warehouse') return json(tenant.warehouses ?? [{ ID: 5, Name: 'synthetic main' }])
      const one = /^\/api\/Product\/(\d+)$/.exec(url.pathname)
      if (req.method === 'GET' && one) {
        const p = tenant.products.get(one[1]!)
        return p ? json(p) : json({ Message: 'not found' }, 404)
      }
      if (req.method === 'GET' && url.pathname === '/api/Product/StockLevels') {
        const w = url.searchParams.get('WarehouseId') ?? ''
        const rows = tenant.stock[w] ?? []
        return json(tenant.onStock ? tenant.onStock(w, rows) : rows)
      }
      if (req.method === 'POST' && url.pathname === '/api/Product') {
        const sent = JSON.parse(body) as Record<string, unknown>
        // Mintsoft's own validation: a full product body (it carries PalletSizes from GET) is refused with a 200.
        if ('PalletSizes' in sent) return json({ Success: false, Message: 'One or more pallet sizes are not valid!', ID: sent.ID })
        const override = tenant.onPost?.(sent)
        if (override === 'drop') { req.socket.destroy(); return }
        if (override && 'text' in override) { res.writeHead(override.status ?? 200, { 'content-type': override.contentType }); res.end(override.text); return }
        if (override) return json(override.body, override.status ?? 200)
        const p = tenant.products.get(String(sent.ID))
        if (!p || p.SKU !== sent.SKU) return json({ Success: false, Message: 'Product not found' })
        if (!tenant.ignoreDisCont) p.DisCont = sent.DisCont
        p.LastUpdated = '2026-11-21T23:59:59.000'
        p.LastUpdatedByUser = 'synthetic-api'
        tenant.afterWrite?.(p)
        return json({ Success: true, Message: 'Product Successfully Updated!', ID: sent.ID })
      }
      json({ Message: 'nothing here' }, 404)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const rig: Rig = { seen, tenant, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections() }) }
  track.push(rig)
  return rig
}

export const configOf = (rig: Rig, warehouseIds = ['5']): MintsoftReviewConfig => ({ baseUrl: rig.base, apiKey: KEY, clientId: String(CLIENT), warehouseIds })
/** The transport's environment: the e2e loopback allowance and the outbound-write grant for exactly this fake tenant. */
export const grantedEnv = (rig: Rig) => ({ E2E_TEST_MODE: '1', NODE_ENV: 'test', MINTSOFT_WRITE_ALLOWED: `${rig.base}|${CLIENT}` })
/** The TARGET installation at the cut-over: the grant for exactly this tenant and the Mintsoft step's live-from instant reached. */
export const LIVE_FROM = '2026-01-01T00:00:00Z'
export const liveEnv = (rig: Rig) => ({ ...grantedEnv(rig), MINTSOFT_WRITES_LIVE_FROM: LIVE_FROM })
export const stockRow = (id: number, sku: string, level: number, warehouse = 5) => ({ SKU: sku, ProductId: id, WarehouseId: warehouse, ClientId: CLIENT, Bundle: false, TotalStockLevel: level, Level: level })


/** An ISO instant in the bridge report's own format (whole seconds, Z). */
export const reportInstant = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z')

/**
 * The target's newest `bridge-units-masked` attestation as the command reads it (#1128 R2 MED-A): by default a clean report (units masked and inactive,
 * last trigger before LIVE_FROM) generated an hour before `now` and recorded five minutes later. Options make it say otherwise.
 */
export function retirementRow(options: { now?: number; generatedAt?: string; attestedAt?: string; lastTrigger?: string; units?: Record<string, string> } = {}): ArchiveRetirementRow {
  const now = options.now ?? Date.now()
  const generatedAt = options.generatedAt ?? reportInstant(now - 3_600_000)
  const raw = sampleReport({ generatedAt, lastTrigger: options.lastTrigger ?? '2025-12-31T23:55:01Z', units: options.units })
  const parsed = parseBridgeStatusOutput(raw)
  if (!parsed.ok) throw new Error(`the synthetic bridge report does not parse: ${parsed.error}`)
  return { attestedAt: options.attestedAt ?? new Date(Date.parse(generatedAt) + 5 * 60_000).toISOString(), payload: bridgePayloadFromReport(parsed.report, raw) }
}

/**
 * The target's newest scheduled writers:check record as the command reads it (#1129 R1 MED-1): by default a PASSING check (level INFO, verdict ok,
 * phase P2-M, step M live since LIVE_FROM) generated ten minutes before `now`. `report` overrides fields of the stored report.
 */
export function switchoverCheckRow(options: { now?: number; level?: string; generatedAt?: string; report?: Record<string, unknown> } = {}): ArchiveSwitchoverCheckRow {
  const now = options.now ?? Date.now()
  const generatedAt = options.generatedAt ?? new Date(now - 10 * 60_000).toISOString()
  return {
    level: options.level ?? 'INFO',
    createdAt: generatedAt,
    metadata: { report: { schemaVersion: 1, generatedAt, phase: 'P2-M', verdict: 'ok', steps: [{ step: 'mintsoft', env: 'MINTSOFT_WRITES_LIVE_FROM', liveFrom: new Date(LIVE_FROM).toISOString(), state: 'live' }, { step: 'woocommerce', env: 'WC_WRITES_LIVE_FROM', liveFrom: null, state: 'unset' }, { step: 'xero', env: 'XERO_WRITES_LIVE_FROM', liveFrom: null, state: 'unset' }], findings: [], ...options.report } },
  }
}
