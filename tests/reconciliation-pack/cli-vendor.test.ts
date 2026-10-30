import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { afterEach } from 'node:test'

import { runPackCli, type PackCliDeps } from '../../scripts/reconciliation-pack.ts'
import { KEPT_ENV, VENDOR_ENV, buildPackEnv, parsePackArgs } from '../../lib/reconciliation-pack/cli.ts'
import { PACK_CLI_CODES, PACK_CLI_FLAGS } from '../../lib/reconciliation-pack/constants.ts'
import type { ImsQueryClient } from '../../lib/reconciliation-pack/ims-readers.ts'
import { readPackChain } from '../../lib/reconciliation-pack/trend.ts'
import { D, fakeBasisPort, goodState, healthyLiveness } from './basis-fixtures.ts'
import { NOW, allFiles, cleanup, realEvidence, scratchDir } from './helpers.ts'
import { order } from './woo-fixtures.ts'

/**
 * THE COMMAND WITH VENDOR READS: off by default (no request, no credential read, no key kept), and on only with --vendor-reads-only,
 * against a LOOPBACK double of the store. Mutations are listed in the PR.
 */

const bases: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  cleanup(bases)
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
  delete process.env.E2E_TEST_MODE
})

const SID = '7000000000000000001'
const KEY = 'ck_cli_consumer_key_value'
const SECRET = 'cs_cli_consumer_secret_value'
const EMAIL = 'victim.customer@example.com'

type Seen = { method: string; url: string }
async function store(): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '' })
    const url = new URL(req.url ?? '/', 'http://x')
    const page = Number(url.searchParams.get('page'))
    const headers = { 'content-type': 'application/json' }
    // Rows carry fields the pack never asked for (a customer's e-mail, a note): they must not reach any output.
    if (url.pathname === '/wp-json/wc/v3/orders') {
      const rows = url.searchParams.get('status') === 'processing' ? [order(11, 'processing', { billing: { email: EMAIL }, customer_note: `call ${SECRET}` }), order(12)] : []
      res.writeHead(200, { ...headers, 'x-wp-total': String(rows.length), 'x-wp-totalpages': String(rows.length ? 1 : 0) }); res.end(JSON.stringify(page === 1 ? rows : [])); return
    }
    if (url.pathname === '/wp-json/wc/v3/taxes') { res.writeHead(200, { ...headers, 'x-wp-total': '1', 'x-wp-totalpages': '1' }); res.end(JSON.stringify(page === 1 ? [{ id: 5, name: 'GB VAT', rate: '20.0000', country: 'GB', state: '', postcode: '', city: '', class: '', shipping: true, compound: false }] : [])); return }
    res.writeHead(404, headers); res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

type Rig = { sent: string[]; credentialReads: number; out: string[]; err: string[]; deps: Partial<PackCliDeps> }
function rig(base: string): Rig {
  const r: Rig = { sent: [], credentialReads: 0, out: [], err: [], deps: {} }
  const imsOrders = [
    { id: `c${'1'.padStart(24, '0')}`, status: 'PROCESSING', currency: 'GBP', total: '12.50', created: '2026-10-10T09:30:00.000Z', updated: null },
    { id: `c${'2'.padStart(24, '0')}`, status: 'ALLOCATED', currency: 'GBP', total: '12.50', created: '2026-10-10T09:30:00.000Z', updated: null },
  ]
  const client: ImsQueryClient = {
    async query(sql, values) {
      r.sent.push(sql)
      if (/pg_current_snapshot/.test(sql)) return { rows: [{ snapshot: '10:20:', read_only: 'on', isolation: 'repeatable read' }] }
      if (/transaction_read_only/.test(sql)) return { rows: [{ read_only: 'on' }] }
      if (/pg_control_system/.test(sql)) return { rows: [{ sid: SID, db: 'ims' }] }
      if (/key = ANY/.test(sql) && JSON.stringify(values).includes('wc_url')) { r.credentialReads += 1; return { rows: [{ key: 'wc_url', value: base }, { key: 'wc_consumer_key', value: KEY }, { key: 'wc_consumer_secret', value: SECRET }] } }
      if (/'wc_initial_import_completed'/.test(sql)) return { rows: [{ key: 'wc_initial_import_completed', value: 'true', at: '2026-09-01T00:00:00.000Z' }] }
      if (/FROM sales_orders/.test(sql)) return { rows: imsOrders.map((o) => ({ ...o })) }
      if (/FROM shopping_order_links/.test(sql)) return { rows: [{ order_id: imsOrders[0]!.id, connector: 'woocommerce', external_id: '11' }, { order_id: imsOrders[1]!.id, connector: 'woocommerce', external_id: '12' }] }
      if (/FROM tax_rates/.test(sql)) return { rows: [{ id: 'r1', name: 'GB VAT', rate: '0.2000', used_for: 'SALES', reverse_charge: false, active: true, tax_type: null, country: 'GB', category: null, is_compound: false, tax_category: 'STANDARD' }] }
      if (/FROM shopping_tax_rate_mappings/.test(sql)) return { rows: [{ connector: 'woocommerce', external_id: '5', rate_id: 'r1', external_class: null }] }
      return { rows: [] }
    },
  }
  r.deps = {
    now: () => NOW,
    openIms: async () => ({ client, close: async () => undefined }),
    runInvariant: async () => realEvidence(),
    disconnect: async () => undefined,
    liveness: healthyLiveness(),
    basis: fakeBasisPort(goodState()),
  }
  return r
}
const run = (r: Rig, argv: string[], env: Record<string, string> = {}, onKeptEnv?: (kept: Readonly<Record<string, string>>) => void) => runPackCli({ argv, onKeptEnv, env: { DATABASE_URL: 'postgresql://ims@127.0.0.1:1/x', ...env }, uid: 1000, checkoutOwnerUid: 1000, repoRoot: '/var/tmp', deps: r.deps, stdout: (t) => r.out.push(t), stderr: (t) => r.err.push(t) })
const argv = (dir: string, ...more: string[]) => ['--phase', 'P1', '--as-of', D, '--items', 'R9,R13', '--report-dir', dir, ...more]
const line = (r: Rig, id: string) => r.out.find((l) => l.startsWith(`${id} `))

// [mutation: the vendor ports built without the flag / the opt-in not passed to the run]
test('WITHOUT --vendor-reads-only the whole command makes NO request, reads NO credential, and R9 and R13 are inconclusive VENDOR_READS_OFF', async () => {
  const double = await store()
  const r = rig(double.base)
  let wooTouched = 0
  r.deps.woo = { get: async () => { wooTouched += 1; return { ok: false } } }
  for (const args of [argv(scratchDir(bases)), ['--phase', 'P1', '--as-of', D, '--report-dir', scratchDir(bases)]]) {
    assert.equal(await run(r, args), 5)
    assert.equal(line(r, 'R9'), 'R9 inconclusive VENDOR_READS_OFF')
    assert.equal(line(r, 'R13'), 'R13 inconclusive VENDOR_READS_OFF')
    r.out.length = 0
  }
  assert.equal(double.seen.length, 0, 'no request reached the store')
  assert.equal(wooTouched, 0)
  assert.equal(r.credentialReads, 0, 'the credentials were never read')
  assert.ok(!r.sent.some((sql) => /wc_consumer/.test(sql) || /key = ANY/.test(sql)))
  assert.ok(!r.sent.some((sql) => /shopping_order_links|shopping_status_mappings/.test(sql)), 'and the IMS side of the vendor items was not read either')
})

test('WITH --vendor-reads-only: GET requests to the store only, R9 compares the open orders, R13 is not a pass without the Xero list; no secret, URL or customer data reaches any output', async () => {
  process.env.E2E_TEST_MODE = '1'
  const double = await store()
  const r = rig(double.base)
  const dir = scratchDir(bases)
  assert.equal(await run(r, argv(dir, '--vendor-reads-only')), 5)
  assert.equal(line(r, 'R9'), 'R9 pass -')
  assert.equal(line(r, 'R13'), 'R13 inconclusive VENDOR_LIST_UNPROVEN')
  assert.equal(r.credentialReads, 1)
  // THE NO-NON-GET PROOF over the whole command.
  assert.ok(double.seen.length >= 4)
  assert.deepEqual([...new Set(double.seen.map((s) => s.method))], ['GET'])
  assert.ok(double.seen.every((s) => /^\/wp-json\/wc\/v3\/(orders|taxes)\?/.test(s.url) && !s.url.includes(KEY) && !s.url.includes(SECRET)))
  assert.ok(!r.sent.some((sql) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|COMMIT)\b/i.test(sql)), 'and nothing was written to the database')
  // THE SECRETS-ABSENCE SCAN over every output: stdout, stderr and every published file.
  const chain = readPackChain(dir)
  assert.ok(chain.ok && chain.head)
  const published = allFiles(dir).map((f) => readFileSync(f, 'utf8')).join('\n')
  const everything = `${r.out.join('\n')}\n${r.err.join('\n')}\n${published}`
  for (const secret of [KEY, SECRET, EMAIL, double.base, '127.0.0.1', 'Basic ', 'Authorization']) assert.ok(!everything.includes(secret), `output contains ${secret}`)
  const item = chain.head!.record.items.find((i) => i.id === 'R9')!
  assert.deepEqual([item.outcome, [...item.sources].sort()], ['pass', ['ims-database', 'woocommerce-api']])
})

test('a store that cannot be read makes the vendor items inconclusive, never a pass, and the run still publishes', async () => {
  process.env.E2E_TEST_MODE = '1'
  const double = await store()
  const r = rig(double.base)
  r.deps.openIms = (() => { const open = r.deps.openIms!; return async () => { const c = await open(); return { client: { query: async (sql: string, values?: unknown[]) => /key = ANY/.test(sql) && JSON.stringify(values).includes('wc_url') && !/wc_sync/.test(JSON.stringify(values)) ? { rows: [] } : c.client.query(sql, values) }, close: c.close } } })()
  assert.equal(await run(r, argv(scratchDir(bases), '--vendor-reads-only')), 5)
  assert.equal(line(r, 'R9'), 'R9 inconclusive SOURCE_UNREADABLE')
  assert.equal(double.seen.length, 0, 'no credentials, no request')
})

test('the flag parses, is documented, and cannot be combined with --basis-only (which reads no vendor)', () => {
  const ok = parsePackArgs(['--phase', 'P1', '--vendor-reads-only'], NOW)
  assert.ok(!('code' in ok) && ok.vendorReadsOnly === true)
  assert.deepEqual(parsePackArgs(['--phase', 'P1', '--vendor-reads-only', '--vendor-reads-only'], NOW), { code: 'BAD_ARGUMENTS' })
  assert.deepEqual(parsePackArgs(['--phase', 'P1', '--basis-only', '--vendor-reads-only'], NOW), { code: 'BAD_ARGUMENTS' })
  const documented = PACK_CLI_FLAGS.find((f) => f.flag === '--vendor-reads-only')!
  assert.ok(/GET/.test(documented.meaning) && /VENDOR_READS_OFF/.test(documented.meaning) && !/reserved/i.test(documented.meaning))
  assert.ok(!('VENDOR_READS_RESERVED' in PACK_CLI_CODES))
})

// [mutation: the encryption keys kept without the flag]
test('the encryption key that reads the stored credentials is kept in the environment ONLY for a run that opted in', () => {
  const parent = { PATH: '/bin', DATABASE_URL: 'postgresql://x', SETTINGS_ENCRYPTION_KEY: 'a'.repeat(32), ENCRYPTION_KEY: 'b'.repeat(32), E2E_TEST_MODE: '1', NODE_OPTIONS: '--require x', WC_CONSUMER_SECRET: 'z' }
  assert.deepEqual(Object.keys(buildPackEnv(parent, '/tmp')).sort(), ['DATABASE_URL', 'HOME', 'PATH'])
  assert.deepEqual(Object.keys(buildPackEnv(parent, '/tmp', true)).sort(), ['DATABASE_URL', 'ENCRYPTION_KEY', 'HOME', 'PATH', 'SETTINGS_ENCRYPTION_KEY'])
  // R12 judges the stored Xero connection by the connector's own tenant guard, so a vendor run (and only a vendor run) keeps the guard's variables.
  const guarded = { ...parent, XERO_ALLOWED_TENANT_IDS: 'a1b2c3d4-0000-4000-8000-000000000001', XERO_BLOCKED_TENANT_IDS: 'x', XERO_TENANT_ID: 'y', XERO_ALLOWED_TENANT_NAMES: 'z', XERO_REQUIRE_DEMO_ORG: '1', NODE_ENV: 'production', XERO_WRITE_ALLOWED_TENANT: 'a1b2c3d4-0000-4000-8000-000000000001' }
  assert.deepEqual(Object.keys(buildPackEnv(guarded, '/tmp')).sort(), ['DATABASE_URL', 'HOME', 'PATH'])
  assert.deepEqual(Object.keys(buildPackEnv(guarded, '/tmp', true)).sort(), ['DATABASE_URL', 'ENCRYPTION_KEY', 'HOME', 'NODE_ENV', 'PATH', 'SETTINGS_ENCRYPTION_KEY', 'XERO_ALLOWED_TENANT_IDS', 'XERO_ALLOWED_TENANT_NAMES', 'XERO_BLOCKED_TENANT_IDS', 'XERO_REQUIRE_DEMO_ORG', 'XERO_TENANT_ID'])
  // Never the write grant (it would make the fetch seam's hold treat a Xero request to a non-Xero host as granted) and never the loopback allowance.
  assert.ok(!('XERO_WRITE_ALLOWED_TENANT' in buildPackEnv(guarded, '/tmp', true)) && !('E2E_TEST_MODE' in buildPackEnv(guarded, '/tmp', true)))
  // Nothing that loosens the transport survives either way: no loopback allowance, no loader variable, no vendor credential in the environment.
  for (const env of [buildPackEnv(parent, '/tmp'), buildPackEnv(parent, '/tmp', true)]) for (const name of ['E2E_TEST_MODE', 'NODE_OPTIONS', 'WC_CONSUMER_SECRET']) assert.ok(!(name in env), name)
  assert.deepEqual([...VENDOR_ENV], ['SETTINGS_ENCRYPTION_KEY', 'ENCRYPTION_KEY', 'XERO_ALLOWED_TENANT_IDS', 'XERO_ALLOWED_TENANT_NAMES', 'XERO_BLOCKED_TENANT_IDS', 'XERO_TENANT_ID', 'XERO_REQUIRE_DEMO_ORG', 'NODE_ENV'])
  assert.ok(!KEPT_ENV.some((name) => (VENDOR_ENV as readonly string[]).includes(name)))
})

// [mutation: the flag not handed to buildPackEnv by the command]
test('the command keeps the encryption keys in its whitelisted environment only when it was started with the flag', async () => {
  const keys = { SETTINGS_ENCRYPTION_KEY: 'a'.repeat(32), E2E_TEST_MODE: '1' }
  const kept = async (...more: string[]) => {
    let seen: Readonly<Record<string, string>> | null = null
    const r = rig('http://127.0.0.1:1')
    await run(r, ['--phase', 'P0', '--report-dir', scratchDir(bases), ...more], keys, (env) => { seen = env })
    return Object.keys(seen ?? {}).sort()
  }
  assert.deepEqual(await kept(), ['DATABASE_URL', 'HOME'])
  assert.deepEqual(await kept('--vendor-reads-only'), ['DATABASE_URL', 'HOME', 'SETTINGS_ENCRYPTION_KEY'])
})
