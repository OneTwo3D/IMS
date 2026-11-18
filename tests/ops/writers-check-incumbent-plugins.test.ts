import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  INCUMBENT_PLUGINS_PATH,
  classifyIncumbentPluginsBody,
  incumbentPluginsHopRefusal,
  readIncumbentPluginsFromWc,
} from '../../lib/connectors/woocommerce/incumbent-plugins'
import { evaluateWritersCheck, readWritersCheckInputs, type WritersCheckInputs } from '../../lib/ops/writers-check'
import { WRITERS_CHECK_EVIDENCE_KEYS_FOR_TESTS } from '../../lib/security/writers-check-constants'

/**
 * THE LEGACY-BRIDGE-ACTIVE INTERLOCK (o3d-zvec.3): the storefront's helper plugin says which incumbent writer plugins are ACTIVE, and the writers check
 * refuses a claim of ownership while one is. Every network call here is an injected fake; nothing leaves the process.
 */

const NOW = new Date('2026-11-19T12:00:00Z')
const CUTOFF = '2026-11-10T00:00:00Z'
const WOO_LIVE_ENV = { WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test', WC_WRITES_LIVE_FROM: CUTOFF, PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce' }
const NONE = { legacy_bridge: false, xeroom: false, ioss_xero: false }

function inputs(overrides: Partial<WritersCheckInputs> = {}): WritersCheckInputs {
  const zero = { counted: 0, total: 0, unpaid: 0, floor: '2026-11-10T00:00:00.000Z' }
  return {
    env: WOO_LIVE_ENV, now: NOW, windowDays: 14,
    settings: new Map([['wc_stock_sync_enabled', 'true']]),
    cronEnabled: { 'wms-order-push': true },
    pluginEnabled: { woocommerce: true, mintsoft: false, xero: false },
    evidence: Object.fromEntries(WRITERS_CHECK_EVIDENCE_KEYS_FOR_TESTS.map((k) => [k, zero])) as NonNullable<WritersCheckInputs['evidence']>,
    evidenceUnrecorded: 0, unknownEvidenceKinds: 0,
    ...overrides,
  }
}

const ALL_PLUGINS = { legacy_bridge: true, xeroom: true, ioss_xero: true }
const MINTSOFT_LIVE_ENV = { MINTSOFT_WRITE_ALLOWED: 'https://api.mintsoft.example|89', MINTSOFT_WRITES_LIVE_FROM: CUTOFF, PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'mintsoft' }
const WOO_SETTINGS = new Map([['wc_stock_sync_enabled', 'true'], ['wc_invoice_document_enabled', 'true'], ['trackship_refire_enabled', 'true']])
const subjects = (report: ReturnType<typeof evaluateWritersCheck>, code: string) => report.findings.filter((f) => f.code === code).map((f) => f.subject).sort()

test('P1 (nothing granted): the map gives IMS nothing the plugins write, so every plugin ACTIVE is clean', () => {
  const report = evaluateWritersCheck(inputs({ env: {}, settings: WOO_SETTINGS, incumbentPlugins: { state: 'read', active: ALL_PLUGINS } }))
  assert.equal(report.verdict, 'ok')
  assert.deepEqual(report.findings, [])
})

test('P2 WooCommerce: the bridge ACTIVE contests exactly the rows the map moves from the bridge to IMS (derived, not listed)', () => {
  const clean = evaluateWritersCheck(inputs({ settings: WOO_SETTINGS, incumbentPlugins: { state: 'read', active: NONE } }))
  assert.equal(clean.verdict, 'ok', 'precondition: with the plugins inactive the same installation is clean')
  for (const key of ['woocommerce.order.tracking', 'woocommerce.order.partial-shipment', 'woocommerce.order.status', 'woocommerce.order.trackship-refire', 'woocommerce.product.meta']) {
    assert.equal(clean.operations.find((op) => op.key === key)?.imsCanWrite, true, `precondition: IMS can write ${key}`)
  }
  const report = evaluateWritersCheck(inputs({ settings: WOO_SETTINGS, incumbentPlugins: { state: 'read', active: { ...NONE, legacy_bridge: true } } }))
  assert.equal(report.verdict, 'double-claim')
  assert.equal(report.exitCode, 1)
  assert.deepEqual(subjects(report, 'incumbent-plugin-active-vs-ims-writer'), [
    'woocommerce.order.partial-shipment', 'woocommerce.order.status', 'woocommerce.order.tracking', 'woocommerce.order.trackship-refire', 'woocommerce.product.meta',
  ])
  // The WMS-status meta is IMS-only (P1 owner nobody): the bridge never writes it, so it is not contested. Stock is Qoblex's in P1: not the bridge's.
  assert.ok(!report.findings.some((f) => f.subject === 'woocommerce.order.wms-status-meta' || f.subject === 'woocommerce.stock'))
})

test('P2 Mintsoft: the bridge ACTIVE contests Mintsoft order creation, and only when Mintsoft is in P2', () => {
  const live = evaluateWritersCheck(inputs({ env: MINTSOFT_LIVE_ENV, pluginEnabled: { woocommerce: true, mintsoft: true, xero: false }, incumbentPlugins: { state: 'read', active: { ...NONE, legacy_bridge: true } } }))
  assert.equal(live.operations.find((op) => op.key === 'mintsoft.order.create')?.imsCanWrite, true)
  assert.equal(live.verdict, 'double-claim')
  assert.ok(subjects(live, 'incumbent-plugin-active-vs-ims-writer').includes('mintsoft.order.create'))
  const p1 = evaluateWritersCheck(inputs({ env: {}, pluginEnabled: { woocommerce: true, mintsoft: true, xero: false }, incumbentPlugins: { state: 'read', active: { ...NONE, legacy_bridge: true } } }))
  assert.equal(p1.verdict, 'ok')
})

test('P2: Xeroom and IOSS/Xero stay ACTIVE by design and never fail the check on the invoice note or document', () => {
  const settings = new Map([...WOO_SETTINGS, ['xero_sync_enabled', 'true']])
  const report = evaluateWritersCheck(inputs({ settings, pluginEnabled: { woocommerce: true, mintsoft: false, xero: true }, incumbentPlugins: { state: 'read', active: { ...NONE, xeroom: true, ioss_xero: true } } }))
  assert.equal(report.operations.find((op) => op.key === 'woocommerce.order.invoice-document')?.imsCanWrite, true, 'precondition: IMS can write the invoice document')
  assert.equal(report.verdict, 'ok')
  assert.deepEqual(subjects(report, 'incumbent-plugin-active-vs-ims-writer'), [])
  assert.ok(!report.findings.some((f) => /deactivate/i.test(f.message)))
})

test('FAIL CLOSED: unreadable AND not-probed are errors while IMS can write a contested operation, and warnings while it cannot', () => {
  for (const reading of [{ state: 'unreadable', reason: 'HTTP 404' }, { state: 'not-probed', reason: 'WooCommerce URL or webhook secret not configured' }] as const) {
    const live = evaluateWritersCheck(inputs({ settings: WOO_SETTINGS, incumbentPlugins: reading }))
    assert.equal(live.verdict, 'unreadable', reading.state)
    assert.equal(live.exitCode, 2)
    assert.equal(live.findings.find((f) => f.code === 'incumbent-plugin-unreadable')?.severity, 'fail')
    const held = evaluateWritersCheck(inputs({ env: {}, incumbentPlugins: reading }))
    assert.equal(held.verdict, 'ok')
    assert.equal(held.findings.find((f) => f.code === 'incumbent-plugin-unreadable')?.severity, 'warn')
  }
  // Mintsoft in P2 with the WooCommerce plugin off: the bridge cannot be asked, and that is not "inactive".
  const mintsoftOnly = evaluateWritersCheck(inputs({ env: MINTSOFT_LIVE_ENV, pluginEnabled: { woocommerce: false, mintsoft: true, xero: false }, incumbentPlugins: { state: 'not-probed', reason: 'the WooCommerce plugin is off' } }))
  assert.equal(mintsoftOnly.verdict, 'unreadable')
  // Absent is the same as not asked.
  assert.equal(evaluateWritersCheck(inputs({ settings: WOO_SETTINGS })).verdict, 'unreadable')
})

test('classifier: only the exact schema-1 shape is a reading', () => {
  assert.deepEqual(classifyIncumbentPluginsBody({ ok: true, schema: 1, active: NONE }), { state: 'read', active: NONE })
  for (const bad of [null, [], 'x', {}, { ok: true, schema: 2, active: NONE }, { ok: false, schema: 1, active: NONE }, { ok: true, schema: 1 },
    { ok: true, schema: 1, active: { legacy_bridge: false, xeroom: false } }, { ok: true, schema: 1, active: { ...NONE, xeroom: 'no' } }, { ok: true, schema: 1, active: { ...NONE, xeroom: 0 } }]) {
    assert.equal(classifyIncumbentPluginsBody(bad).state, 'unreadable', JSON.stringify(bad))
  }
})

test('transport: one signed GET, no body, redirects refused; every other shape is refused by the hop gate', async () => {
  const base = new URL('https://shop.example.com/')
  const hop = (url: string, method = 'GET', redirectCount = 0) => ({ method, url: new URL(url), redirectCount })
  const good = `https://shop.example.com${INCUMBENT_PLUGINS_PATH}`
  assert.equal(incumbentPluginsHopRefusal(base, hop(good)), null)
  assert.equal(incumbentPluginsHopRefusal(base, hop(good, 'POST')), 'method')
  assert.equal(incumbentPluginsHopRefusal(base, hop(good, 'GET', 1)), 'redirect')
  assert.equal(incumbentPluginsHopRefusal(base, hop(`${good}?x=1`)), 'parameter')
  assert.equal(incumbentPluginsHopRefusal(base, hop('https://shop.example.com/wp-json/oti/v1/fx-rates')), 'path')
  assert.equal(incumbentPluginsHopRefusal(base, hop(`https://evil.example.com${INCUMBENT_PLUGINS_PATH}`)), 'origin')

  const seen: Array<{ url: string; init: RequestInit; options: Record<string, unknown> }> = []
  const fetchImpl = (async (url: URL, init: RequestInit, options: Record<string, unknown>) => {
    seen.push({ url: String(url), init, options })
    return new Response(JSON.stringify({ ok: true, schema: 1, active: { ...NONE, legacy_bridge: true } }), { status: 200 })
  }) as never
  const result = await readIncumbentPluginsFromWc({ fetchImpl, settings: { url: 'https://shop.example.com', secret: 's3' } })
  assert.deepEqual(result, { state: 'read', active: { ...NONE, legacy_bridge: true } })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].init.method, 'GET')
  assert.equal(seen[0].init.body, undefined)
  assert.equal((seen[0].init.headers as Record<string, string>)['X-OTI-Signature'], createHmac('sha256', 's3').update('').digest('hex'))
  assert.equal(seen[0].options.refuseRedirects, true)

  const http500 = (async () => new Response('no', { status: 404 })) as never
  assert.equal((await readIncumbentPluginsFromWc({ fetchImpl: http500, settings: { url: 'https://shop.example.com', secret: 's3' } })).state, 'unreadable')
  const boom = (async () => { throw new Error('down') }) as never
  assert.equal((await readIncumbentPluginsFromWc({ fetchImpl: boom, settings: { url: 'https://shop.example.com', secret: 's3' } })).state, 'unreadable')
  assert.equal((await readIncumbentPluginsFromWc({ settings: { url: '', secret: '' } })).state, 'not-probed')
})

test('reader: the probe runs only when the WooCommerce plugin is on, and a throwing probe is unreadable', async () => {
  // The database arm is covered in tests/db; here a client that throws everywhere leaves pluginEnabled null, so the probe is not asked.
  let asked = 0
  const throwing = new Proxy({}, { get() { throw new Error('no db') } })
  const read = await readWritersCheckInputs({ env: {}, now: NOW, client: throwing, probeIncumbentPlugins: async () => { asked += 1; return { state: 'read', active: NONE } } })
  assert.equal(asked, 0)
  assert.equal(read.incumbentPlugins?.state, 'not-probed')
})

test('plugin source pin (no PHP runner in CI): the route is GET-only, signed, and its handler writes nothing', () => {
  const php = readFileSync('lib/connectors/woocommerce/wp-plugin/onetwoinventory-helper.php', 'utf8')
  const route = php.slice(php.indexOf("'/incumbents'"), php.indexOf("'/incumbents'") + 260)
  assert.match(route, /'methods'\s*=>\s*'GET'/)
  assert.match(route, /oti_verify_fx_signature/)
  const start = php.indexOf('function oti_handle_incumbents_read')
  const handler = php.slice(start, php.indexOf("if (!function_exists('oti_handle_aelia_rates_read'))", start))
  assert.doesNotMatch(handler, /update_option|add_option|delete_option|update_site_option|wp_remote_|\$wpdb|file_put_contents/)
  assert.match(handler, /legacy_bridge/)
  assert.match(php, /Version:\s+1\.5\.0/)
  assert.match(handler, /'woo-mintsoft'/, 'exact slugs')
  assert.doesNotMatch(handler, /preg_match\(\$pattern/, 'no loose name match')
  assert.match(handler, /active_sitewide_plugins/)
  assert.match(handler, /wp_get_mu_plugins/)
})
