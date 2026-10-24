import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { afterEach } from 'node:test'

import { runPackCli, type PackCliDeps } from '../../scripts/reconciliation-pack.ts'
import type { ImsQueryClient } from '../../lib/reconciliation-pack/ims-readers.ts'
import { fakeBasisPort, goodState, healthyLiveness } from './basis-fixtures.ts'
import { NOW, cleanup, realEvidence, scratchDir } from './helpers.ts'
import { ASOF, productsCsv, writeExport } from './qoblex-fixtures.ts'
import { PROBE_WH5, PROBE_WH6, cuid } from './wms-fixtures.ts'
import { fakeStore } from './woo-fixtures.ts'

/**
 * R14's Mintsoft leg END TO END, against a LOOPBACK Mintsoft that fails any non-GET and any /api/Auth: the census R1 reads, shared.
 * Mutations are listed in the PR.
 */

const bases: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  cleanup(bases)
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
  delete process.env.E2E_TEST_MODE
})

const SID = '7000000000000000001'
const KEY = 'ms_cov_fixed_key_value_0123456789'
type Seen = { method: string; url: string }

async function mintsoft(omit: string[] = []): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const keep = (rows: typeof PROBE_WH6) => rows.filter((r) => !omit.includes(r.SKU))
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '' })
    const url = new URL(req.url ?? '/', 'http://x')
    const headers = { 'content-type': 'application/json' }
    if (req.method !== 'GET' || url.pathname === '/api/Auth') { res.writeHead(500, headers); res.end('{}'); return }
    if (url.pathname === '/api/Product/StockLevels') { res.writeHead(200, headers); res.end(JSON.stringify(keep(url.searchParams.get('WarehouseId') === '5' ? PROBE_WH5 : PROBE_WH6))); return }
    if (url.pathname === '/api/Product/List') {
      const limit = Number(url.searchParams.get('Limit')); const page = Number(url.searchParams.get('PageNo'))
      res.writeHead(limit > 100 ? 400 : 200, headers)
      res.end(JSON.stringify(limit > 100 ? {} : keep(PROBE_WH6).slice((page - 1) * limit, page * limit).map((r) => ({ ID: r.ProductId, SKU: r.SKU, ClientId: r.ClientId, Bundle: r.Bundle }))))
      return
    }
    res.writeHead(404, headers); res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

const ALL = PROBE_WH6.map((r) => r.SKU)
type Rig = { out: string[]; err: string[]; deps: Partial<PackCliDeps> }
function rig(base: string, config: { mode?: string; wooSkus?: string[] } = {}): Rig {
  const r: Rig = { out: [], err: [], deps: {} }
  const bindings = [
    { connector: 'mintsoft', warehouse_id: cuid(5), warehouse_code: 'EAR2', external_id: '5', active: true, mode: 'NOTIFICATION_ONLY', confirmed: false },
    { connector: 'mintsoft', warehouse_id: cuid(6), warehouse_code: 'MIL1', external_id: '6', active: true, mode: 'NOTIFICATION_ONLY', confirmed: false },
  ]
  const products = PROBE_WH6.map((row, index) => ({ id: cuid(1000 + index), sku: row.SKU, type: row.Bundle ? 'KIT' : 'SIMPLE', active: true, lifecycle: 'ACTIVE' }))
  const plain = products.filter((_, index) => !PROBE_WH6[index]!.Bundle)
  const links = plain.map((p) => ({ connector: 'mintsoft', product_id: p.id, external_id: String(PROBE_WH6.find((row) => row.SKU === p.sku)!.ProductId) }))
  const levels = bindings.flatMap((b, bi) => plain.map((p, index) => {
    const wh = (b.external_id === '5' ? PROBE_WH5 : PROBE_WH6).find((row) => row.SKU === p.sku)!
    return { id: cuid(5000 + bi * 100 + index), product_id: p.id, sku: p.sku, product_type: 'SIMPLE', warehouse_id: b.warehouse_id, warehouse_code: b.warehouse_code, quantity: String(wh.TotalStockLevel), reserved: '0' }
  }))
  const client: ImsQueryClient = {
    async query(sql, values) {
      if (/pg_current_snapshot/.test(sql)) return { rows: [{ snapshot: '10:20:', read_only: 'on', isolation: 'repeatable read' }] }
      if (/transaction_read_only/.test(sql)) return { rows: [{ read_only: 'on' }] }
      if (/pg_control_system/.test(sql)) return { rows: [{ sid: SID, db: 'ims' }] }
      if (/key = ANY/.test(sql) && JSON.stringify(values).includes('mintsoft_auth_mode')) return { rows: [{ key: 'mintsoft_auth_mode', value: config.mode ?? 'api_key' }, { key: 'mintsoft_static_api_key', value: KEY }, { key: 'mintsoft_client_id', value: '89' }] }
      if (/FROM wms_connections/.test(sql)) return { rows: [{ base_url: base }] }
      if (/FROM external_wms_bindings/.test(sql)) return { rows: bindings.map((b) => ({ ...b })) }
      if (/FROM wms_product_links/.test(sql)) return { rows: links.map((l) => ({ ...l })) }
      if (/FROM stock_levels/.test(sql)) return { rows: levels.map((l) => ({ ...l })) }
      if (/FROM products ORDER BY/.test(sql)) return { rows: products.map((p) => ({ ...p })) }
      return { rows: [] }
    },
  }
  const store = fakeStore({ products: (config.wooSkus ?? ALL).map((sku, i) => ({ id: i + 1, sku, status: 'publish', type: 'simple' })) })
  r.deps = { now: () => NOW, openIms: async () => ({ client, close: async () => undefined }), runInvariant: async () => realEvidence(), disconnect: async () => undefined, liveness: healthyLiveness(), basis: fakeBasisPort(goodState()), woo: store }
  return r
}
const run = (r: Rig, argv: string[]) => runPackCli({ argv, env: { DATABASE_URL: 'postgresql://ims@127.0.0.1:1/x' }, uid: 1000, checkoutOwnerUid: 1000, repoRoot: process.cwd(), keepProcessEnv: true, deps: r.deps, stdout: (t) => r.out.push(t), stderr: (t) => r.err.push(t) })
const args = (items: string, ...more: string[]) => ['--phase', 'P1', '--as-of', ASOF, '--items', items, '--report-dir', scratchDir(bases), '--vendor-reads-only', ...more]
const line = (r: Rig, id: string) => r.out.find((l) => l.startsWith(`${id} `))
const exportOf = (skus: string[] = ALL) => writeExport(bases, { products: productsCsv(skus.map((sku) => ({ sku }))) })

// [mutation: the SKU port not wired by default / a second Mintsoft reader / the leg dropped from the sources]
test('R14 passes four-way against a loopback Mintsoft: the census SKUs (bundles included) are present in Qoblex, WooCommerce, Mintsoft and IMS; GET only, never /api/Auth', async () => {
  process.env.E2E_TEST_MODE = '1'
  const double = await mintsoft()
  const r = rig(double.base)
  await run(r, args('R14', '--qoblex-export', exportOf()))
  assert.equal(line(r, 'R14'), 'R14 pass -')
  assert.deepEqual([...new Set(double.seen.map((s) => s.method))], ['GET'])
  assert.ok(double.seen.every((s) => /^\/api\/Product\/(StockLevels|List)\?/.test(s.url) && !s.url.includes(KEY)))
  assert.ok(!double.seen.some((s) => /\/api\/Auth/i.test(s.url)))
  assert.ok(![...r.out, ...r.err].join('\n').includes(KEY))
})

test('a SKU missing only from Mintsoft is a finding: R14 fails', async () => {
  process.env.E2E_TEST_MODE = '1'
  const missing = PROBE_WH6.find((row) => !row.Bundle && row.TotalStockLevel === 0 && row.SKU === '22771122402-02')!.SKU
  const double = await mintsoft([missing])
  const r = rig(double.base)
  await run(r, args('R14', '--qoblex-export', exportOf()))
  assert.equal(line(r, 'R14'), 'R14 fail DIFFERENCES')
})

// [mutation: a source failure treated as an empty list / as a pass]
test('Mintsoft unusable (an auth mode the reader refuses) makes the leg unavailable with the source\'s own reason: R14 never passes and no request is made', async () => {
  process.env.E2E_TEST_MODE = '1'
  const double = await mintsoft()
  const r = rig(double.base, { mode: 'oauth' })
  await run(r, args('R14', '--qoblex-export', exportOf()))
  assert.match(line(r, 'R14') ?? '', /^R14 inconclusive LEG_UNAVAILABLE,/)
  assert.equal(double.seen.length, 0)
  // and a finding among the other three legs still fails it
  const woo = rig(double.base, { mode: 'oauth', wooSkus: ALL.slice(1) })
  await run(woo, args('R14', '--qoblex-export', exportOf()))
  assert.match(line(woo, 'R14') ?? '', /^R14 fail DIFFERENCES,LEG_UNAVAILABLE/)
})

// [mutation: R14 reads the census itself instead of the run's shared read]
test('R1 and R14 in one run make EXACTLY the requests R1 alone makes', async () => {
  process.env.E2E_TEST_MODE = '1'
  const alone = await mintsoft()
  const r1 = rig(alone.base)
  await run(r1, args('R1'))
  assert.ok(alone.seen.length >= 8)
  const both = await mintsoft()
  const r2 = rig(both.base)
  await run(r2, args('R1,R14', '--qoblex-export', exportOf()))
  assert.equal(line(r2, 'R14'), 'R14 pass -')
  assert.deepEqual(both.seen, alone.seen)
  assert.ok(line(r2, 'R1'))
})
