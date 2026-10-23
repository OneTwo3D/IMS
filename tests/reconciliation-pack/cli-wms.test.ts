import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { afterEach } from 'node:test'

import { runPackCli, type PackCliDeps } from '../../scripts/reconciliation-pack.ts'
import type { ImsQueryClient } from '../../lib/reconciliation-pack/ims-readers.ts'
import { readPackChain } from '../../lib/reconciliation-pack/trend.ts'
import { D, fakeBasisPort, goodState, healthyLiveness } from './basis-fixtures.ts'
import { NOW, allFiles, cleanup, realEvidence, scratchDir } from './helpers.ts'
import { PROBE_WH5, PROBE_WH6, cuid } from './wms-fixtures.ts'

/**
 * THE COMMAND WITH THE WAREHOUSE-SYSTEM ITEM (R1): off by default (no request, no credential read), and on only with
 * --vendor-reads-only, against a LOOPBACK double of Mintsoft that fails any non-GET and any /api/Auth. Mutations are listed in the PR.
 */

const bases: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  cleanup(bases)
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
  delete process.env.E2E_TEST_MODE
})

const SID = '7000000000000000001'
const KEY = 'ms_cli_fixed_key_value_0123456789'
type Seen = { method: string; url: string; apikey: string | undefined }

async function mintsoft(): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', apikey: req.headers['ms-apikey'] as string | undefined })
    const url = new URL(req.url ?? '/', 'http://x')
    const headers = { 'content-type': 'application/json' }
    if (req.method !== 'GET' || url.pathname === '/api/Auth') { res.writeHead(500, headers); res.end('{}'); return }
    if (url.pathname === '/api/Product/StockLevels') { res.writeHead(200, headers); res.end(JSON.stringify(url.searchParams.get('WarehouseId') === '5' ? PROBE_WH5 : url.searchParams.get('WarehouseId') === '6' ? PROBE_WH6 : [])); return }
    if (url.pathname === '/api/Product/List') {
      const limit = Number(url.searchParams.get('Limit')); const page = Number(url.searchParams.get('PageNo'))
      res.writeHead(limit > 100 ? 400 : 200, headers)
      res.end(JSON.stringify(limit > 100 ? {} : PROBE_WH6.slice((page - 1) * limit, page * limit).map((r) => ({ ID: r.ProductId, SKU: r.SKU, ClientId: r.ClientId, Bundle: r.Bundle }))))
      return
    }
    res.writeHead(404, headers); res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

type Config = { mode?: string; ims?: 'equal' | 'short'; alignmentConfirmed?: boolean }
type Rig = { sent: string[]; credentialReads: number; out: string[]; err: string[]; deps: Partial<PackCliDeps> }
function rig(base: string, config: Config = {}): Rig {
  const r: Rig = { sent: [], credentialReads: 0, out: [], err: [], deps: {} }
  const plain = PROBE_WH6.filter((row) => !row.Bundle)
  const bindings = [
    { connector: 'mintsoft', warehouse_id: cuid(5), warehouse_code: 'EAR2', external_id: '5', active: true, mode: 'NOTIFICATION_ONLY', confirmed: false },
    { connector: 'mintsoft', warehouse_id: cuid(6), warehouse_code: 'MIL1', external_id: '6', active: true, mode: config.alignmentConfirmed ? 'ALIGN_TO_WMS' : 'NOTIFICATION_ONLY', confirmed: config.alignmentConfirmed === true },
  ]
  const products = plain.map((row, index) => ({ id: cuid(1000 + index), sku: row.SKU, type: 'SIMPLE', active: true, lifecycle: 'ACTIVE' }))
  const links = products.map((p, index) => ({ connector: 'mintsoft', product_id: p.id, external_id: String(plain[index]!.ProductId) }))
  const levels = bindings.flatMap((b, bi) => products.map((p, index) => {
    const wh = (b.external_id === '5' ? PROBE_WH5 : PROBE_WH6).find((row) => row.SKU === plain[index]!.SKU)!
    return { id: cuid(5000 + bi * 100 + index), product_id: p.id, sku: p.sku, product_type: 'SIMPLE', warehouse_id: b.warehouse_id, warehouse_code: b.warehouse_code, quantity: String(config.ims === 'short' && b.external_id === '6' && p.sku === '129552751' ? 35 : wh.TotalStockLevel), reserved: '0' }
  }))
  const client: ImsQueryClient = {
    async query(sql, values) {
      r.sent.push(sql)
      if (/pg_current_snapshot/.test(sql)) return { rows: [{ snapshot: '10:20:', read_only: 'on', isolation: 'repeatable read' }] }
      if (/transaction_read_only/.test(sql)) return { rows: [{ read_only: 'on' }] }
      if (/pg_control_system/.test(sql)) return { rows: [{ sid: SID, db: 'ims' }] }
      if (/key = ANY/.test(sql) && JSON.stringify(values).includes('mintsoft_auth_mode')) {
        r.credentialReads += 1
        return { rows: [{ key: 'mintsoft_auth_mode', value: config.mode ?? 'api_key' }, { key: 'mintsoft_static_api_key', value: KEY }, { key: 'mintsoft_client_id', value: '89' }] }
      }
      if (/FROM wms_connections/.test(sql)) return { rows: [{ base_url: base }] }
      if (/FROM external_wms_bindings/.test(sql)) return { rows: bindings.map((b) => ({ ...b })) }
      if (/FROM wms_product_links/.test(sql)) return { rows: links.map((l) => ({ ...l })) }
      if (/FROM stock_levels/.test(sql)) return { rows: levels.map((l) => ({ ...l })) }
      if (/FROM products ORDER BY/.test(sql)) return { rows: products.map((p) => ({ ...p })) }
      return { rows: [] }
    },
  }
  r.deps = { now: () => NOW, openIms: async () => ({ client, close: async () => undefined }), runInvariant: async () => realEvidence(), disconnect: async () => undefined, liveness: healthyLiveness(), basis: fakeBasisPort(goodState()) }
  return r
}
const run = (r: Rig, argv: string[]) => runPackCli({ argv, env: { DATABASE_URL: 'postgresql://ims@127.0.0.1:1/x' }, uid: 1000, checkoutOwnerUid: 1000, repoRoot: process.cwd(), keepProcessEnv: true, deps: r.deps, stdout: (t) => r.out.push(t), stderr: (t) => r.err.push(t) })
const argv = (dir: string, ...more: string[]) => ['--phase', 'P1', '--as-of', D, '--items', 'R1', '--report-dir', dir, ...more]
const line = (r: Rig, id: string) => r.out.find((l) => l.startsWith(`${id} `))

// [mutation: the vendor port built without the flag / the opt-in not passed to the run]
test('WITHOUT --vendor-reads-only the whole command makes NO request to Mintsoft, reads NO Mintsoft credential, reads NO link, and R1 is inconclusive VENDOR_READS_OFF', async () => {
  const double = await mintsoft()
  const r = rig(double.base)
  let touched = 0
  r.deps.wms = { stockLevels: async () => { touched += 1; return { ok: false, reason: 'SOURCE_UNREADABLE' } }, productPage: async () => { touched += 1; return { ok: false, reason: 'SOURCE_UNREADABLE' } } }
  assert.equal(await run(r, argv(scratchDir(bases))), 5)
  assert.equal(line(r, 'R1'), 'R1 inconclusive VENDOR_READS_OFF')
  assert.equal(double.seen.length, 0)
  assert.equal(touched, 0)
  assert.equal(r.credentialReads, 0)
  assert.ok(!r.sent.some((sql) => /mintsoft_|wms_connections|wms_product_links|external_wms_bindings/.test(sql)), 'and the IMS side of R1 was not read either')
})

test('WITH --vendor-reads-only: GET requests to Mintsoft only, the fixed key only in ms-apikey, R1 passes on the probe rows, and no key, URL or address reaches any output', async () => {
  process.env.E2E_TEST_MODE = '1'
  const double = await mintsoft()
  const r = rig(double.base)
  const dir = scratchDir(bases)
  assert.equal(await run(r, argv(dir, '--vendor-reads-only')), 5, 'the other items are not selected')
  assert.equal(line(r, 'R1'), 'R1 pass -')
  assert.equal(r.credentialReads, 1)
  assert.ok(double.seen.length >= 8)
  assert.deepEqual([...new Set(double.seen.map((s) => s.method))], ['GET'])
  assert.ok(double.seen.every((s) => /^\/api\/Product\/(StockLevels|List)\?/.test(s.url) && !s.url.includes(KEY) && s.apikey === KEY), 'only the two read paths, the key only in the header')
  assert.ok(!double.seen.some((s) => /\/api\/Auth/i.test(s.url)))
  assert.ok(!r.sent.some((sql) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|COMMIT)\b/i.test(sql)), 'and nothing was written to the database')
  // THE SECRETS-ABSENCE SCAN over every output: stdout, stderr and every published file.
  const chain = readPackChain(dir)
  assert.ok(chain.ok && chain.head)
  const published = allFiles(dir).map((f) => readFileSync(f, 'utf8')).join('\n')
  const everything = `${r.out.join('\n')}\n${r.err.join('\n')}\n${published}`
  for (const secret of [KEY, double.base, '127.0.0.1', 'ms-apikey', 'mintsoft_static_api_key', 'Authorization']) assert.ok(!everything.includes(secret), `output contains ${secret}`)
  const item = chain.head!.record.items.find((i) => i.id === 'R1')!
  assert.deepEqual([item.outcome, [...item.sources].sort()], ['pass', ['ims-database', 'mintsoft-api']])
})

// [mutation: the auth-mode check removed]
test('A MINTSOFT CONFIGURED TO LOG IN (or with a mode that is not the fixed key) is refused: R1 is inconclusive VENDOR_AUTH_REFUSED and NO request is made, /api/Auth included', async () => {
  process.env.E2E_TEST_MODE = '1'
  for (const mode of ['credentials', 'api-key', '']) {
    const double = await mintsoft()
    const r = rig(double.base, { mode })
    assert.equal(await run(r, argv(scratchDir(bases), '--vendor-reads-only')), 5)
    assert.equal(line(r, 'R1'), 'R1 inconclusive VENDOR_AUTH_REFUSED', mode)
    assert.equal(double.seen.length, 0, `nothing was sent (${mode})`)
    assert.equal(r.credentialReads, 1)
  }
})

test('a difference is UNSETTLED on its first run: inconclusive UNSETTLED_PENDING, never a pass and never a failure yet; a confirmed alignment retires the claim with the IMS source alone and no request', async () => {
  process.env.E2E_TEST_MODE = '1'
  const double = await mintsoft()
  const r = rig(double.base, { ims: 'short' })
  assert.equal(await run(r, argv(scratchDir(bases), '--vendor-reads-only')), 5)
  assert.equal(line(r, 'R1'), 'R1 inconclusive UNSETTLED_PENDING,SETTLING_STATE_UNUSABLE')
  // Both bindings ALIGN_TO_WMS with a confirmation stamp: nothing is asked of Mintsoft and the pass names the IMS source alone.
  const retiredDouble = await mintsoft()
  const retired = rig(retiredDouble.base)
  const original = retired.deps.openIms!
  retired.deps.openIms = async () => {
    const ims = await original()
    return { ...ims, client: { query: async (sql, values) => { const result = await ims.client.query(sql, values); return /FROM external_wms_bindings/.test(sql) ? { rows: result.rows.map((row) => ({ ...row, mode: 'ALIGN_TO_WMS', confirmed: true })) } : result } } }
  }
  const dir = scratchDir(bases)
  assert.equal(await run(retired, argv(dir, '--vendor-reads-only')), 5)
  assert.equal(line(retired, 'R1'), 'R1 pass -')
  assert.equal(retiredDouble.seen.length, 0, 'the vendor was not asked')
  assert.equal(retired.credentialReads, 0, 'and no credential was read for it')
  const chain = readPackChain(dir)
  assert.ok(chain.ok && chain.head)
  assert.deepEqual(chain.head!.record.items.find((i) => i.id === 'R1')!.sources, ['ims-database'])
})
