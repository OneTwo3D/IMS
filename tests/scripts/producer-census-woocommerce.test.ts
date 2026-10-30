import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { DECLARATIONS, NO_PRODUCER } from '../../scripts/producer-census-declarations.ts'
import { scanSource, scanTree, seamFindings } from '../../scripts/producer-census.ts'
import {
  WOO_SEAM_FUNCTIONS,
  scanWooTransport,
  scanOutboxRegistrySource,
  scanWooTransportSource,
  wooCensusFindings,
  type WooCensusInput,
} from '../../scripts/producer-census-woocommerce.ts'
import { WRITER_OWNERSHIP_MAP, type OwnershipRow } from '../../lib/security/writer-ownership-map.ts'

/**
 * THE WOOCOMMERCE HALF OF THE PRODUCER CENSUS, AND PROOF THAT IT CAN FAIL.
 *
 * Part 1 runs it over the real tree and prints its precondition (so a scan that examined nothing cannot pass). Part 2 mutates the
 * REAL sources in memory (a consultation moved after its effect, deleted, or a function renamed away) and shows each red, naming
 * the site. Part 3 drives the detectors with fixtures: a new raw WooCommerce write in a new file, a computed method, a read.
 */

const ROOT = process.cwd()
const scan = scanTree(ROOT)
const siteKeys = new Set(scan.sites.map((site) => site.key))
const transport = scanWooTransport(ROOT)
const realText = (file: string) => readFileSync(join(ROOT, file), 'utf8')

function input(overrides: Partial<WooCensusInput> = {}, mutate: Record<string, (text: string) => string> = {}): WooCensusInput {
  return {
    readSource: (file) => {
      const text = (() => { try { return realText(file) } catch { return undefined } })()
      return text !== undefined && mutate[file] ? mutate[file]!(text) : text
    },
    transport: transport.sites,
    declarations: DECLARATIONS,
    siteKeys,
    noProducer: NO_PRODUCER,
    ...overrides,
  }
}
const red = (report: { failures: string[] }, code: string, needle = '') => report.failures.filter((f) => f.startsWith(code) && f.includes(needle))

test('PRECONDITION: the real tree is green, and the census reached every part of it', () => {
  const report = wooCensusFindings(input())
  console.log(`# woo census: seam functions ${report.counts.seamFunctionsConsulting}/${report.counts.seamFunctions}; transport calls ${report.counts.transportSites} `
    + `(writes ${report.counts.transportWrites}, behind barrier ${report.counts.transportWritesBehindBarrier}); outbox enqueue sites ${report.counts.outboxEnqueueSitesHandlingShadow}/${report.counts.outboxEnqueueSites}; `
    + `map operations governed ${report.counts.mapOperationsGoverned}/${report.counts.mapOperations}; registry entries ${report.counts.registryEntries}`)
  assert.deepEqual(report.failures, [])
  assert.ok(scan.filesScanned >= 800)
  assert.equal(report.counts.seamFunctions, WOO_SEAM_FUNCTIONS.length)
  assert.equal(report.counts.seamFunctionsConsulting, WOO_SEAM_FUNCTIONS.length)
  assert.equal(report.counts.transportWrites, 5, 'wcPost, wcPut, the FX push, the FX probe and the partial-shipment push')
  assert.ok(report.counts.transportSites > report.counts.transportWrites, 'the reads were seen too, and are not writes')
  assert.equal(report.counts.outboxEnqueueSites, 4)
  assert.equal(report.counts.mapOperationsGoverned, report.counts.mapOperations)
  assert.equal(report.counts.registryEntries, 10)
})

test('MUTATION WOO-1 (the consultation is moved AFTER its effect): red, naming the function', () => {
  const report = wooCensusFindings(input({}, {
    'lib/connectors/woocommerce/api.ts': (text) => {
      // swap the order inside wcPost: do the fetch's setup first by deleting the early gate and re-adding it after connectorFetch
      const gate = "  const egressHold = wooEgressHold()\n  if (egressHold.held) return { data: null, error: egressHold.notice, held: true }\n"
      const first = text.indexOf(gate)
      assert.ok(first > 0, 'precondition: the gate text was found in wcPost')
      const without = text.slice(0, first) + text.slice(first + gate.length)
      return without.replace('  if (!res.ok) {\n    const detail = await readErrorDetails(res)\n    return { data: null, error: `WC API POST error', gate + '  if (!res.ok) {\n    const detail = await readErrorDetails(res)\n    return { data: null, error: `WC API POST error')
    },
  }))
  assert.equal(red(report, 'WOO-1', 'api.ts::wcPost').length, 1, JSON.stringify(report.failures))
  assert.match(red(report, 'WOO-1', 'api.ts::wcPost')[0]!, /AFTER its first effect/)
})

test('MUTATION WOO-1 (the stock writer stops asking): red', () => {
  const report = wooCensusFindings(input({}, { 'lib/connectors/woocommerce/sync/stock-sync.ts': (text) => text.replace('await wooProducerSeam(', 'await Promise.resolve(') }))
  assert.equal(red(report, 'WOO-1', 'stock-sync.ts::pushStockToWc').length, 1, JSON.stringify(report.failures))
})

test('MUTATION WOO-1 (a drain stops asking, and the outbox enqueue stops deciding): red, one finding each', () => {
  const drains = wooCensusFindings(input({}, {
    'lib/connectors/woocommerce/sync/order-completion-jobs.ts': (text) => text.replace('if (wooDrainHold().held) return summary', ''),
    'lib/connectors/woocommerce/sync/order-status-jobs.ts': (text) => text.replace('if (wooDrainHold().held) return summary', ''),
    'lib/connectors/woocommerce/sync/stock-sync-jobs.ts': (text) => text.replace('if (wooDrainHold().held) return { ...summary, held: true }', ''),
  }))
  for (const needle of ['order-completion-jobs.ts::processWcOrderCompletionJobs', 'order-status-jobs.ts::runFencedWcOrderJob', 'stock-sync-jobs.ts::processQueuedWcStockSyncJobs']) {
    assert.equal(red(drains, 'WOO-1', needle).length, 1, needle)
  }
  const primitive = wooCensusFindings(input({}, { 'lib/domain/integrations/outbox.ts': (text) => text.replace('const producerVerdict = outboxProducerVerdict(input)', 'const producerVerdict = { kind: \'proceed\' } as const') }))
  assert.equal(red(primitive, 'WOO-1', 'outbox.ts::enqueueIntegrationOutbox').length, 1, JSON.stringify(primitive.failures))
})

test('MUTATION WOO-1 (a seam function is renamed away): red, and the message says what to update', () => {
  const report = wooCensusFindings(input({}, { 'lib/connectors/woocommerce/sync/stock-sync.ts': (text) => text.replace('export async function pushStockToWc(', 'export async function pushStockToWcRenamed(') }))
  const hit = red(report, 'WOO-1', 'pushStockToWc')
  assert.equal(hit.length, 1)
  assert.match(hit[0]!, /no longer exists/)
})

test('MUTATION WOO-1b (the reconcile stamps a shadowed push): red', () => {
  const report = wooCensusFindings(input({}, { 'lib/connectors/woocommerce/sync/reconcile.ts': (text) => text.replace('if (stock.shadowed === true) {', 'if (false) {') }))
  assert.equal(red(report, 'WOO-1b').length, 1, JSON.stringify(report.failures))
  const missing = wooCensusFindings(input({}, { 'lib/connectors/woocommerce/sync/reconcile.ts': (text) => text.replaceAll('last_wc_stock_daily_reconcile_at', 'some_other_key') }))
  assert.equal(red(missing, 'WOO-1b').length, 1, 'a reconcile that no longer stamps has nothing to guard: the row must be updated, not silently pass')
})

test('MUTATION WOO-2 (an outbox enqueue site reads the answer as a queued row): red, naming the site', () => {
  const report = wooCensusFindings(input({}, {
    'lib/connectors/woocommerce/sync/order-completion-jobs.ts': (text) => text.replace('if (isOutboxEnqueueShadowed(enqueued)) return null\n', ''),
  }))
  assert.equal(red(report, 'WOO-2', 'order-completion-jobs.ts::scheduleWcOrderCompletion').length, 1, JSON.stringify(report.failures))
})

test('MUTATION WOO-3 (a new raw WooCommerce POST in a new file): red with the file and line; a GET and an unrelated POST are not', () => {
  const rawPost = "import { connectorFetch } from '@/lib/security/connector-fetch'\nexport async function sneak(base: string) {\n  return connectorFetch(`${base}/wp-json/wc/v3/products/1`, { method: 'POST', body: '{}' }, { connectorName: 'WooCommerce' })\n}\n"
  const sites = scanWooTransportSource(rawPost, 'lib/new-thing.ts')
  assert.deepEqual(sites.map((s) => [s.file, s.decl, s.method, s.write]), [['lib/new-thing.ts', 'sneak', 'POST', true]])
  const report = wooCensusFindings(input({ transport: [...transport.sites, ...sites] }))
  const hit = red(report, 'WOO-3', 'lib/new-thing.ts')
  assert.equal(hit.length, 1)
  assert.match(hit[0]!, /lib\/new-thing\.ts:3 \(sneak\)/)
  assert.deepEqual(scanWooTransportSource("export const r = connectorFetch('https://shop/wp-json/wc/v3/orders', { method: 'GET' }, { connectorName: 'WooCommerce' })\n", 'a.ts').map((s) => s.write), [false])
  assert.deepEqual(scanWooTransportSource("export const r = connectorFetch('https://api.example.com/x', { method: 'POST' }, { connectorName: 'Other' })\n", 'a.ts'), [])
})

test('WOO-3: a COMPUTED or missing-literal method counts as a write, and a spread init does too', () => {
  const computed = scanWooTransportSource("export const a = (m: string) => connectorFetch('https://s/wp-json/wc/v3/x', { method: m }, { connectorName: 'WooCommerce' })\n", 'a.ts')
  assert.deepEqual(computed.map((s) => [s.method, s.write]), [['UNKNOWN', true]])
  const spread = scanWooTransportSource("export const b = (init: RequestInit) => connectorFetch('https://s/wp-json/wc/v3/x', init, { connectorName: 'WooCommerce' })\n", 'a.ts')
  assert.deepEqual(spread.map((s) => [s.method, s.write]), [['UNKNOWN', true]])
  const lower = scanWooTransportSource("export const c = () => connectorFetch('https://s/wp-json/wc/v3/x', { method: 'delete' }, { connectorName: 'WooCommerce' })\n", 'a.ts')
  assert.deepEqual(lower.map((s) => [s.method, s.write]), [['DELETE', true]])
})

test('MUTATION WOO-3 (a barrier row whose write is gone): red', () => {
  const report = wooCensusFindings(input({ transport: transport.sites.filter((s) => !(s.file.endsWith('partial-shipment.ts') && s.write)) }))
  assert.equal(red(report, 'WOO-3', 'partial-shipment.ts::pushPartialShipmentToWc').length, 1, JSON.stringify(report.failures))
})

test('MUTATION WOO-4 (a new WooCommerce operation in the ownership map that nothing governs): red', () => {
  const extra: OwnershipRow = { destination: 'woocommerce', operation: 'order.refund-note', owners: { P0: 'nobody', P1: 'nobody', P2: 'IMS' }, obligationTime: 'not-applicable', note: 'fixture' }
  const report = wooCensusFindings(input({ map: [...(WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]), extra] }))
  assert.equal(red(report, 'WOO-4', 'woocommerce.order.refund-note').length, 1, JSON.stringify(report.failures))
  // and a governed operation that loses its seam: drop the 'seam' declarations of one operation
  const withoutTracking = DECLARATIONS.filter((d) => !(d.destination === 'woocommerce' && d.operation === 'order.tracking' && d.mechanism === 'seam'))
  const dropped = wooCensusFindings(input({ declarations: withoutTracking }))
  assert.equal(red(dropped, 'WOO-4', 'woocommerce.order.tracking').length, 1, JSON.stringify(dropped.failures))
})

test('MUTATION WOO-4 (a stale exception): an operation both governed and listed as governed elsewhere is red; a nonexistent one is red', () => {
  const report = wooCensusFindings(input({ governedElsewhere: { 'order.tracking': 'fixture reason that is long enough', 'no.such.operation': 'fixture reason that is long enough' } }))
  assert.equal(red(report, 'WOO-4', 'both governed').length, 1, JSON.stringify(report.failures))
  assert.equal(red(report, 'WOO-4', 'no.such.operation').length, 1)
})

test('MUTATION WOO-5 (an outbox registry entry with no destination, and a WooCommerce one the map does not name): red', () => {
  const report = wooCensusFindings(input({
    registry: {
      woocommerce: { 'new.job': { destination: 'woocommerce' } },
      sales: { 'x.y': {} as never },
    },
  }))
  assert.equal(red(report, 'WOO-5', 'woocommerce/new.job').length, 1, JSON.stringify(report.failures))
  assert.equal(red(report, 'WOO-5', 'sales/x.y').length, 1)
})

test('MUTATION SEAM-1 over the real facade (the bypass in the arm): removing the seam from any facade push is red, naming that site; the control is green', () => {
  const file = 'lib/shopping.ts'
  const text = realText(file)
  const green = seamFindings(new Map([[file, text]]), scanSource(text, file), DECLARATIONS)
  assert.deepEqual(green.failures, [], 'CONTROL: the real facade passes SEAM-1')
  const wooSeamSites = DECLARATIONS.filter((d) => d.key.startsWith(`${file}::`) && d.mechanism === 'seam')
  console.log(`# facade seam sites declared: ${wooSeamSites.length}`)
  assert.equal(wooSeamSites.length, 6)
  for (const decl of ['pushProductMetadata', 'pushOrderDeliveryMetadata', 'pushPartialShipmentToShopping', 'pushWmsOrderStatusToShopping', 'pushFxRatesToConnectors']) {
    const mutated = text.replace(new RegExp(`(export async function ${decl}\\([\\s\\S]*?)wooProducerSeam\\(`), '$1(async (x: unknown) => ({ proceed: true as const, x }))(')
    assert.notEqual(mutated, text, `precondition: the seam call in ${decl} was found and removed`)
    const report = seamFindings(new Map([[file, mutated]]), scanSource(mutated, file), DECLARATIONS)
    assert.equal(report.failures.filter((f) => f.startsWith('SEAM-1') && f.includes(`::${decl}::`)).length, 1, `${decl}: ${JSON.stringify(report.failures)}`)
  }
  const drain = text.replace(/const hold = wooDrainHold\(\)/, 'const hold = { held: false as const }')
  const drainReport = seamFindings(new Map([[file, drain]]), scanSource(drain, file), DECLARATIONS)
  assert.equal(drainReport.failures.filter((f) => f.includes('::pushSalesOrderStatus::')).length, 1, JSON.stringify(drainReport.failures))
})

test('a direct call of a WooCommerce writer from a NEW file is an undeclared producer site (the facade cannot be bypassed quietly)', () => {
  const fixture = "import { pushImsProductToWc } from '@/lib/connectors/woocommerce/sync/product-sync'\nexport async function sneakyProductPush(id: string) { return pushImsProductToWc(id) }\n"
  const sites = scanSource(fixture, 'lib/sneaky.ts')
  assert.deepEqual(sites.map((s) => s.key), ['lib/sneaky.ts::sneakyProductPush::pushImsProductToWc#1'])
  assert.equal(DECLARATIONS.some((d) => d.key === sites[0]!.key), false, 'it is not declared, so the census reports it')
})

test('WOO-5 reads the registry as SYNTAX: the real registry yields every entry with a destination, and removing or corrupting one is red', () => {
  const real = scanOutboxRegistrySource(realText('lib/domain/integrations/outbox-registry.ts'))
  const flat = Object.entries(real).flatMap(([connector, operations]) => Object.entries(operations).map(([operation, entry]) => `${connector}/${operation}=${entry.destination}`))
  console.log(`# registry by syntax: ${flat.join(' ')}`)
  assert.equal(flat.length, 10)
  assert.ok(flat.includes('woocommerce/stock.push=woocommerce'))
  assert.ok(flat.includes('xero/accounting.post=xero'))
  assert.ok(flat.includes('mintsoft/inbound.booked-in=internal'))
  const removed = wooCensusFindings(input({}, { 'lib/domain/integrations/outbox-registry.ts': (text) => text.replace("      name: 'stockSync',\n      destination: 'woocommerce',\n", "      name: 'stockSync',\n") }))
  assert.equal(red(removed, 'WOO-5', 'woocommerce/stock.push').length, 1, JSON.stringify(removed.failures))
  const corrupted = wooCensusFindings(input({}, { 'lib/domain/integrations/outbox-registry.ts': (text) => text.replace("      name: 'orderCancel',\n      destination: 'woocommerce',\n", "      name: 'orderCancel',\n      destination: 'elsewhere',\n") }))
  assert.equal(red(corrupted, 'WOO-5', 'woocommerce/order.cancel').length, 1, JSON.stringify(corrupted.failures))
  const unreadable = wooCensusFindings(input({ readSource: () => undefined }))
  assert.ok(red(unreadable, 'WOO-5', 'could not be read').length >= 1)
})

// ───────────────────────────── the tax-rate writer (woocommerce `tax-rate`) ─────────────────────────────

test('TAX-RATE WRITER: the census governs woocommerce.tax-rate through applyWooTaxPlan, and the operation is no longer an unproduced one', () => {
  const report = wooCensusFindings(input())
  assert.deepEqual(report.failures, [])
  const entry = WOO_SEAM_FUNCTIONS.find((f) => f.decl === 'applyWooTaxPlan')
  assert.ok(entry, 'applyWooTaxPlan is a designated seam function')
  assert.deepEqual(entry.operations, ['tax-rate'])
  assert.equal(NO_PRODUCER['woocommerce.tax-rate'], undefined, 'the operation has a producer now')
  const keys = DECLARATIONS.filter((d) => d.destination === 'woocommerce' && d.operation === 'tax-rate').map((d) => d.key)
  assert.deepEqual(keys, [
    'lib/connectors/woocommerce/tax-rate-port.ts::createWooTaxRateWritePort::wcPost#1',
    'lib/connectors/woocommerce/tax-rate-port.ts::createWooTaxRateWritePort::wcPut#1',
    'lib/connectors/woocommerce/tax-rate-port.ts::createWooTaxRateWritePort::wcPost#2',
  ])
  for (const key of keys) assert.ok(siteKeys.has(key), `the census sees ${key}`)
  const row = (WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]).find((r) => r.destination === 'woocommerce' && r.operation === 'tax-rate')!
  assert.deepEqual([row.owners.P1, row.owners.P2], ['operator-manual', 'IMS'])
})

test('MUTATION WOO-1 (the tax-rate writer stops asking the seam): red, naming applyWooTaxPlan', () => {
  const report = wooCensusFindings(input({}, { 'lib/connectors/woocommerce/tax-rate-writer.ts': (text) => text.replace('await wooProducerSeam(', 'await Promise.resolve(') }))
  assert.equal(red(report, 'WOO-1', 'tax-rate-writer.ts::applyWooTaxPlan').length, 1, JSON.stringify(report.failures))
})

test('MUTATION WOO-1 (the tax-rate writer sends BEFORE it asks): red', () => {
  const report = wooCensusFindings(input({}, {
    'lib/connectors/woocommerce/tax-rate-writer.ts': (text) => {
      const marker = '      lock.assertHeld(`sending ${change.key}`)\n'
      assert.ok(text.includes(marker), 'precondition: the loop head was found')
      return text.replace(marker, marker + '      await send(deps.port, change)\n')
    },
  }))
  assert.equal(red(report, 'WOO-1', 'tax-rate-writer.ts::applyWooTaxPlan').length, 1, JSON.stringify(report.failures))
  assert.match(red(report, 'WOO-1', 'tax-rate-writer.ts::applyWooTaxPlan')[0]!, /AFTER its first effect/)
})

test('MUTATION WOO-4 (the tax-rate writer is no longer a designated seam function): the operation is ungoverned and red; its direct-write declarations alone do not govern it', () => {
  const withoutSeam = WOO_SEAM_FUNCTIONS.filter((f) => f.decl !== 'applyWooTaxPlan')
  const red4 = red(wooCensusFindings(input({ seamFunctions: withoutSeam })), 'WOO-4', 'woocommerce.tax-rate')
  assert.equal(red4.length, 1, JSON.stringify(red4))
  const withoutDeclarations = DECLARATIONS.filter((d) => !(d.destination === 'woocommerce' && d.operation === 'tax-rate'))
  assert.deepEqual(red(wooCensusFindings(input({ declarations: withoutDeclarations })), 'WOO-4', 'woocommerce.tax-rate'), [], 'the designated function governs it')
})

test('MUTATION WOO-3 (the tax-rate port grows a raw POST of its own): red; the port as written has no raw transport', () => {
  const text = realText('lib/connectors/woocommerce/tax-rate-port.ts')
  assert.deepEqual(scanWooTransportSource(text, 'lib/connectors/woocommerce/tax-rate-port.ts'), [], 'the real port reaches the store only through wcPost and wcPut')
  const sneaky = text + "\nimport { connectorFetch } from '@/lib/security/connector-fetch'\nexport async function rawDelete(base: string) {\n  return connectorFetch(`${base}/wp-json/wc/v3/taxes/1`, { method: 'DELETE' }, { connectorName: 'WooCommerce' })\n}\n"
  const sites = scanWooTransportSource(sneaky, 'lib/connectors/woocommerce/tax-rate-port.ts')
  const report = wooCensusFindings(input({ transport: [...transport.sites, ...sites] }))
  assert.equal(red(report, 'WOO-3', 'tax-rate-port.ts').length, 1, JSON.stringify(report.failures))
})
