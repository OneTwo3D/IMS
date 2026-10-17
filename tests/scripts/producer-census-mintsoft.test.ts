import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'

import { DECLARATIONS } from '../../scripts/producer-census-declarations.ts'
import { scanSource, scanTree, seamFindings } from '../../scripts/producer-census.ts'
import {
  DESTINATION_TABLE_FILE,
  MINT_SEAM_FUNCTIONS,
  literalMembersOf,
  mintCensusFindings,
  scanMintsoftCallersSource,
  scanMintsoftTransportSource,
  type MintCensusInput,
  type MintScan,
  type MintTransportSite,
} from '../../scripts/producer-census-mintsoft.ts'
import { SOURCE_ROOTS, walk } from '../../scripts/producer-census-woocommerce.ts'
import { WRITER_OWNERSHIP_MAP, type OwnershipRow } from '../../lib/security/writer-ownership-map.ts'

/**
 * THE MINTSOFT HALF OF THE PRODUCER CENSUS, AND PROOF THAT IT CAN FAIL.
 *
 * Part 1 runs it over the real tree and prints its precondition (so a scan that examined nothing cannot pass). Part 2 mutates the
 * REAL sources in memory (a consultation moved after its effect, deleted, an operation literal changed, a function renamed away,
 * a barrier removed) and shows each red, naming the site. Part 3 drives the detectors with fixtures: a new raw Mintsoft call in a
 * new file, a write called without a clearance, a forged clearance, a discarded answer.
 */

const ROOT = process.cwd()
const scan = scanTree(ROOT)
const siteKeys = new Set(scan.sites.map((site) => site.key))
const files = SOURCE_ROOTS.flatMap((root) => walk(join(ROOT, root)))
const realText = (file: string) => readFileSync(join(ROOT, file), 'utf8')

const transport: MintTransportSite[] = []
const scans: MintScan[] = []
for (const abs of files) {
  const rel = relative(ROOT, abs).split('\\').join('/')
  const text = readFileSync(abs, 'utf8')
  transport.push(...scanMintsoftTransportSource(text, rel))
  scans.push(scanMintsoftCallersSource(text, rel))
}

function input(overrides: Partial<MintCensusInput> = {}, mutate: Record<string, (text: string) => string> = {}): MintCensusInput {
  return {
    readSource: (file) => {
      const text = (() => { try { return realText(file) } catch { return undefined } })()
      return text !== undefined && mutate[file] ? mutate[file]!(text) : text
    },
    transport,
    scans,
    declarations: DECLARATIONS,
    siteKeys,
    registeredConnectorIds: literalMembersOf(realText('lib/connectors/wms/types.ts'), 'WMS_CONNECTOR_IDS', 'array'),
    destinationConnectorIds: literalMembersOf(realText(DESTINATION_TABLE_FILE), 'WMS_PRODUCER_DESTINATION', 'object'),
    ...overrides,
  }
}
/** The caller scans re-run over one mutated file, replacing that file's real scan. */
function withMutatedCaller(file: string, mutate: (text: string) => string): MintScan[] {
  const mutated = mutate(realText(file))
  assert.notEqual(mutated, realText(file), `precondition: the mutation changed ${file}`)
  return [...scans.filter((entry) => entry !== scanOf(file)), scanMintsoftCallersSource(mutated, file)]
}
function scanOf(file: string): MintScan | undefined {
  const index = files.findIndex((abs) => relative(ROOT, abs).split('\\').join('/') === file)
  return index < 0 ? undefined : scans[index]
}
const red = (report: { failures: string[] }, code: string, needle = '') => report.failures.filter((f) => f.startsWith(code) && f.includes(needle))

test('PRECONDITION: the real tree is green, and the census reached every part of it', () => {
  const report = mintCensusFindings(input())
  console.log(`# mintsoft census: seam functions ${report.counts.seamFunctionsConsulting}/${report.counts.seamFunctions} naming ${report.counts.seamOperationsNamed}/${report.counts.seamOperations} operations; `
    + `consultations read ${report.counts.consultCallsRead}/${report.counts.consultCalls}; transport ${report.counts.transportSitesBehindBarrier}/${report.counts.transportSites}; `
    + `writes with clearance ${report.counts.writeCallsWithClearance}/${report.counts.writeCalls}; clearance casts ${report.counts.clearanceCasts}; map operations governed ${report.counts.mapOperationsGoverned}/${report.counts.mapOperations}`)
  assert.deepEqual(report.failures, [])
  assert.ok(files.length >= 800)
  assert.equal(report.counts.seamFunctions, MINT_SEAM_FUNCTIONS.length)
  assert.equal(report.counts.seamFunctionsConsulting, MINT_SEAM_FUNCTIONS.length)
  assert.equal(report.counts.seamOperationsNamed, report.counts.seamOperations)
  assert.equal(report.counts.writeCalls, 13, 'the sweep (7 + comment), the refund note, the product, bundle and content writers and the two ASN buttons')
  assert.equal(report.counts.writeCallsWithClearance, report.counts.writeCalls)
  assert.equal(report.counts.transportSites, 3, 'sendMintsoftRequest and the two login helpers')
  assert.equal(report.counts.clearanceCasts, 1)
  assert.equal(report.counts.mintCalls, 2, 'one in the generic seam (an unregistered connector) and one in the destination seam')
  assert.equal(report.counts.mapOperationsGoverned, report.counts.mapOperations)
  assert.ok(report.counts.consultCalls >= 15)
})

test('MUTATION MINT-1 (the barrier is moved AFTER the key lookup): red, naming the function', () => {
  const report = mintCensusFindings(input({}, {
    'lib/connectors/mintsoft/api/client.ts': (text) => {
      const start = text.indexOf('  const egressHold = mintsoftEgressHold()')
      const end = text.indexOf('  const config = await getMintsoftApiConfiguration()')
      assert.ok(start > 0 && end > start, 'precondition: the barrier block was found')
      const block = text.slice(start, end)
      return text.slice(0, start) + text.slice(end).replace('  // Set when a 401 was seen', `${block}  // Set when a 401 was seen`)
    },
  }))
  const hit = red(report, 'MINT-1', 'client.ts::mintsoftRequest')
  assert.equal(hit.length, 1, JSON.stringify(report.failures))
  assert.match(hit[0]!, /AFTER its first effect/)
})

test('MUTATION MINT-1 (the barrier is deleted): red', () => {
  const report = mintCensusFindings(input({}, { 'lib/connectors/mintsoft/api/client.ts': (text) => text.replace('const egressHold = mintsoftEgressHold()', 'const egressHold = { held: false as const }') }))
  assert.equal(red(report, 'MINT-1', 'client.ts::mintsoftRequest').length, 1, JSON.stringify(report.failures))
})

test('MUTATION MINT-1 (each producer stops asking): red, one finding each, naming the function', () => {
  const cases: Array<[string, string, (text: string) => string, string]> = [
    ['lib/connectors/mintsoft/sync/product-sync.ts', 'await mintsoftProducerSeam(', (text) => text.replace('await mintsoftProducerSeam(', 'await Promise.resolve('), 'syncOneMintsoftProduct'],
    ['lib/connectors/mintsoft/sync/bundle-sync.ts', 'await mintsoftProducerSeam(', (text) => text.replace('await mintsoftProducerSeam(', 'await Promise.resolve('), 'syncBundleInternal'],
    ['lib/connectors/mintsoft/sync/product-content-sync.ts', 'await mintsoftProducerSeam(', (text) => text.replace('await mintsoftProducerSeam(', 'await Promise.resolve('), 'syncMintsoftProductContent'],
    ['app/actions/wms-order-push.ts', 'wmsOrderCreateReArmShadow(', (text) => text.replace('await wmsOrderCreateReArmShadow(', 'await Promise.resolve('), 'replayWmsOrderPush'],
    ['app/actions/sync-exceptions.ts', 'wmsOrderCreateReArmShadow(', (text) => text.replace('await wmsOrderCreateReArmShadow(', 'await Promise.resolve('), 'repushMissingWmsOrder'],
    ['app/actions/sales.ts', 'wmsProducerSeam(', (text) => text.replace('await wmsProducerSeam(', 'await Promise.resolve('), 'createRefund'],
    ['lib/domain/wms/order-push-sweep.ts', 'wmsProducerHold(', (text) => text.replace('wmsProducerHold(connectorId, producerContext).held', 'false'), 'runWmsOrderPushSweepCore'],
  ]
  for (const [file, , mutate, decl] of cases) {
    const report = mintCensusFindings(input({}, { [file]: mutate }))
    assert.equal(red(report, 'MINT-1', `${file}::${decl}`).length, 1, `${decl}: ${JSON.stringify(report.failures)}`)
  }
})

test('MUTATION MINT-1 (the two ASN buttons are separate rows): removing the seam from one is red for that button only', () => {
  const report = mintCensusFindings(input({}, {
    'app/actions/mintsoft-sync.ts': (text) => {
      const at = text.indexOf('export async function createMintsoftTransferAsn(')
      assert.ok(at > 0)
      return text.slice(0, at) + text.slice(at).replace('const asnSeam = await mintsoftProducerSeam(', 'const asnSeam = await Promise.resolve(')
    },
  }))
  assert.equal(red(report, 'MINT-1', 'createMintsoftTransferAsn').length, 1, JSON.stringify(report.failures))
  assert.equal(red(report, 'MINT-1', 'createMintsoftPurchaseOrderAsn').length, 0)
})

test('MUTATION MINT-1c (the sweep asks for the wrong operation): a cancel pass that consults "order.hold" leaves order.cancel un-named: red', () => {
  const report = mintCensusFindings(input({}, {
    'lib/domain/wms/order-push-sweep.ts': (text) => text.replace("operation: 'order.cancel',\n          subjectType: 'SalesOrder',\n          subjectId: link.orderId,\n          payload: { externalOrderId: link.externalOrderId, action: 'cancel' }", "operation: 'order.hold',\n          subjectType: 'SalesOrder',\n          subjectId: link.orderId,\n          payload: { externalOrderId: link.externalOrderId, action: 'cancel' }"),
  }))
  // The create-pass compensation names order.cancel too (as a conditional), so the operation is still named there: the per-site
  // check is the compiler's (a clearance for 'order.hold' is not a clearance for 'order.cancel'); this arm proves the row still reads literals.
  const unnamed = mintCensusFindings(input({}, {
    'lib/domain/wms/order-push-sweep.ts': (text) => text.replaceAll("'order.cancel'", "'order.hold'"),
  }))
  assert.equal(red(unnamed, 'MINT-1', 'mintsoft.order.cancel').length, 1, JSON.stringify(unnamed.failures))
  assert.deepEqual(red(report, 'MINT-1', 'mintsoft.order.cancel'), [], 'the conditional in the compensation still names it')
})

test('MUTATION MINT-1 (a seam function is renamed away): red, and the message says what to update', () => {
  const report = mintCensusFindings(input({}, { 'lib/connectors/mintsoft/sync/bundle-sync.ts': (text) => text.replace('async function syncBundleInternal(', 'async function syncBundleRenamed(') }))
  const hit = red(report, 'MINT-1', 'syncBundleInternal')
  assert.equal(hit.length, 1)
  assert.match(hit[0]!, /no longer exists/)
})

test('MUTATION MINT-2 (the answer of a consultation is thrown away, or never tested): red, naming the site', () => {
  const discarded = mintCensusFindings(input({ scans: withMutatedCaller('lib/connectors/mintsoft/sync/bundle-sync.ts', (text) => text.replace('const bundleSeam = await mintsoftProducerSeam(', 'await mintsoftProducerSeam(')) }))
  assert.ok(red(discarded, 'MINT-2', 'bundle-sync.ts').length >= 1, JSON.stringify(discarded.failures))
  const untested = mintCensusFindings(input({ scans: withMutatedCaller('lib/connectors/mintsoft/sync/product-sync.ts', (text) => text.replace('if (!upsertSeam.proceed) {', 'if (false) {')) }))
  assert.ok(red(untested, 'MINT-2', 'product-sync.ts').some((f) => f.includes('never tests it')), JSON.stringify(untested.failures))
  const heldDropped = mintCensusFindings(input({ scans: withMutatedCaller('lib/domain/wms/order-push-sweep.ts', (text) => text.replace('const warehouseHeld = wmsProducerHold(connectorId, producerContext).held', 'wmsProducerHold(connectorId, producerContext); const warehouseHeld = false')) }))
  assert.ok(red(heldDropped, 'MINT-2', 'order-push-sweep.ts').length >= 1, JSON.stringify(heldDropped.failures))
})

test('MUTATION MINT-3 (a new raw Mintsoft call in a new file, any method): red with the file and line; a login helper and an unrelated call are not', () => {
  const post = "import { connectorFetch } from '@/lib/security/connector-fetch'\nexport async function sneak(base: string) {\n  return connectorFetch(`${base}/api/Order/5/Cancel`, { method: 'GET' }, { connectorName: 'Mintsoft', hopGate: g })\n}\n"
  const sites = scanMintsoftTransportSource(post, 'lib/new-thing.ts')
  assert.deepEqual(sites.map((s) => [s.file, s.decl, s.method]), [['lib/new-thing.ts', 'sneak', 'GET']])
  const report = mintCensusFindings(input({ transport: [...transport, ...sites] }))
  const hit = red(report, 'MINT-3', 'lib/new-thing.ts')
  assert.equal(hit.length, 1)
  assert.match(hit[0]!, /lib\/new-thing\.ts:3 \(sneak\)/)
  assert.match(hit[0]!, /mutates through GET too/)
  assert.deepEqual(scanMintsoftTransportSource("export const r = connectorFetch('https://api.example.com/x', { method: 'POST' }, { connectorName: 'Other' })\n", 'a.ts'), [])
  const spread = scanMintsoftTransportSource("export const b = (init: RequestInit) => connectorFetch('https://s/api/x', { ...init }, { connectorName: 'Mintsoft' })\n", 'a.ts')
  assert.deepEqual(spread.map((s) => s.method), ['UNKNOWN'])
})

test('MUTATION MINT-3 (the function behind the barrier is called from elsewhere): red', () => {
  const report = mintCensusFindings(input({}, {
    'lib/connectors/mintsoft/api/client.ts': (text) => `${text}\nexport async function sneakySend() { return sendMintsoftRequest('/api/Order', 'https://x', 'k', undefined, '89') }\n`,
  }))
  assert.equal(red(report, 'MINT-3', 'sendMintsoftRequest').length, 1, JSON.stringify(report.failures))
})

test('MUTATION MINT-3 (a login helper whose call is gone, and a key test that stops being a GET): red', () => {
  const stale = mintCensusFindings(input({ transport: transport.filter((s) => !s.decl.includes('testMintsoftFixedApiKey')) }))
  assert.equal(red(stale, 'MINT-3', 'testMintsoftFixedApiKey').length, 1, JSON.stringify(stale.failures))
  const post = mintCensusFindings(input({ transport: transport.map((s) => (s.decl === 'testMintsoftFixedApiKey' ? { ...s, method: 'POST' } : s)) }))
  assert.equal(red(post, 'MINT-3', 'read-only key test').length, 1, JSON.stringify(post.failures))
})

test('MUTATION MINT-4 (a new Mintsoft operation in the ownership map that nothing governs): red', () => {
  const extra: OwnershipRow = { destination: 'mintsoft', operation: 'order.merge', owners: { P0: 'nobody', P1: 'nobody', P2: 'IMS' }, obligationTime: 'not-applicable', note: 'fixture' }
  const report = mintCensusFindings(input({ map: [...(WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]), extra] }))
  assert.equal(red(report, 'MINT-4', 'mintsoft.order.merge').length, 1, JSON.stringify(report.failures))
  const stale = mintCensusFindings(input({ governedElsewhere: { 'auth.login': 'fixture reason that is long enough', 'no.such.operation': 'fixture reason that is long enough', 'asn.create': 'fixture reason that is long enough' } }))
  assert.equal(red(stale, 'MINT-4', 'no.such.operation').length, 1, JSON.stringify(stale.failures))
  assert.equal(red(stale, 'MINT-4', 'both governed').length, 1)
})

test('MUTATION MINT-5 (a write called without a clearance, or with a forged one): red', () => {
  const bare = scanMintsoftCallersSource("export async function f(c: any) { await c.pushOrder({}) }\n", 'lib/x.ts')
  assert.equal(bare.writeCalls, 1)
  assert.equal(bare.failures.length, 1)
  assert.match(bare.failures[0]!, /MINT-5 lib\/x\.ts:1 \(f\) calls the warehouse write pushOrder without/)
  const wrong = scanMintsoftCallersSource("export async function f(c: any, k: unknown) { await c.cancelOrder('1', k) }\n", 'lib/x.ts')
  assert.equal(wrong.failures.length, 1)
  const optional = scanMintsoftCallersSource("export async function f(c: any, s: { clearance: unknown }) { await c.cancelOrder?.('1', s.clearance) }\n", 'lib/x.ts')
  assert.equal(optional.writeCalls, 1)
  assert.deepEqual(optional.failures, [])
  const forged = scanMintsoftCallersSource("import type { WmsWriteClearance } from '@/lib/connectors/wms/types'\nexport const fake = {} as WmsWriteClearance<'order.create'>\n", 'lib/forge.ts')
  assert.deepEqual(forged.clearanceCasts, [{ file: 'lib/forge.ts', line: 2 }])
  const report = mintCensusFindings(input({ scans: [...scans, forged] }))
  assert.equal(red(report, 'MINT-5', 'lib/forge.ts:2').length, 1, JSON.stringify(report.failures))
  assert.equal(red(report, 'MINT-5', 'expected exactly one cast').length, 1)
})

test('MUTATION MINT-5 (the clearance is minted somewhere else): a call of the mint function outside the two seams is red, and so is a seam that stops minting', () => {
  const stray = scanMintsoftCallersSource("import { mintWmsWriteClearance } from '@/lib/connectors/wms/clearance'\nexport const forged = mintWmsWriteClearance<'order.create'>()\n", 'lib/forge.ts')
  assert.equal(stray.failures.length, 1)
  assert.match(stray.failures[0]!, /MINT-5 lib\/forge\.ts:2 \(forged\) calls mintWmsWriteClearance/)
  const report = mintCensusFindings(input({ scans: [...scans, stray] }))
  assert.equal(red(report, 'MINT-5', 'lib/forge.ts:2').length, 1, JSON.stringify(report.failures))
  const noMint = mintCensusFindings(input({ scans: withMutatedCaller('lib/connectors/mintsoft/producer-seam.ts', (text) => text.replace('mintWmsWriteClearance<Op>()', '({} as never)')) }))
  assert.equal(red(noMint, 'MINT-5', 'expected exactly two calls').length, 1, JSON.stringify(noMint.failures))
})

test('MUTATION MINT-5 (the real sweep passes something else as the clearance): red, naming the call', () => {
  const report = mintCensusFindings(input({ scans: withMutatedCaller('lib/domain/wms/order-push-sweep.ts', (text) => text.replace('connector.pushOrder!(input, createSeam.clearance)', 'connector.pushOrder!(input, undefined as never)')) }))
  assert.equal(red(report, 'MINT-5', 'order-push-sweep.ts').length, 1, JSON.stringify(report.failures))
})

test('MUTATION MINT-5 (an operation literal that is not in the ownership map, and a registered connector with no destination): red', () => {
  const typo = mintCensusFindings(input({ scans: withMutatedCaller('lib/connectors/mintsoft/sync/bundle-sync.ts', (text) => text.replace("operation: 'product.bundle'", "operation: 'product.bundel'")) }))
  assert.equal(red(typo, 'MINT-5', 'product.bundel').length, 1, JSON.stringify(typo.failures))
  const undestined = mintCensusFindings(input({ registeredConnectorIds: ['mintsoft', 'acme-wms'] }))
  assert.equal(red(undestined, 'MINT-5', 'acme-wms').length, 1, JSON.stringify(undestined.failures))
  const stray = mintCensusFindings(input({ destinationConnectorIds: ['mintsoft', 'ghost'] }))
  assert.equal(red(stray, 'MINT-5', 'ghost').length, 1)
  const unreadable = mintCensusFindings(input({ destinationConnectorIds: null }))
  assert.equal(red(unreadable, 'MINT-5', 'could not be read').length, 1)
})

test('the declared sweep sites are SEAM sites and SEAM-1 confirms each is preceded by a consultation; removing the seam from the sweep is red for them', () => {
  const file = 'lib/domain/wms/order-push-sweep.ts'
  const text = realText(file)
  const green = seamFindings(new Map([[file, text]]), scanSource(text, file), DECLARATIONS)
  assert.deepEqual(green.failures, [], 'CONTROL: the real sweep passes SEAM-1')
  const seamSites = DECLARATIONS.filter((d) => d.key.startsWith(`${file}::`) && d.mechanism === 'seam')
  assert.equal(seamSites.length, 7)
  const mutated = text.replaceAll('wmsProducerSeam(', 'Promise.resolve(').replaceAll('wmsProducerHold(', 'Promise.resolve(')
  const report = seamFindings(new Map([[file, mutated]]), scanSource(mutated, file), DECLARATIONS)
  assert.equal(report.failures.filter((f) => f.startsWith('SEAM-1')).length, 7, JSON.stringify(report.failures))
})

test('a direct call of a Mintsoft writer from a NEW file is an undeclared producer site (the connector facade cannot be bypassed quietly)', () => {
  const fixture = "import { createMintsoftAsn } from '@/lib/connectors/mintsoft'\nexport async function sneakyAsn(input: never) { return createMintsoftAsn(input) }\n"
  const sites = scanSource(fixture, 'lib/sneaky.ts')
  assert.deepEqual(sites.map((s) => s.key), ['lib/sneaky.ts::sneakyAsn::createMintsoftAsn#1'])
  assert.equal(DECLARATIONS.some((d) => d.key === sites[0]!.key), false, 'it is not declared, so the census reports it')
})

test('literalMembersOf reads the registered ids and the destination table as SYNTAX', () => {
  assert.deepEqual(literalMembersOf(realText('lib/connectors/wms/types.ts'), 'WMS_CONNECTOR_IDS', 'array'), ['mintsoft'])
  assert.deepEqual(literalMembersOf(realText(DESTINATION_TABLE_FILE), 'WMS_PRODUCER_DESTINATION', 'object'), ['mintsoft'])
  assert.equal(literalMembersOf('export const X = computed()', 'X', 'array'), null)
})

test('MUTATION MINT-3 (a Mintsoft connectorFetch with no hop gate and no redirect refusal): red, naming the call; gated ones are not', () => {
  const ungated = scanMintsoftTransportSource("export const a = (u: URL) => connectorFetch(u, { method: 'GET' }, { connectorName: 'Mintsoft' })\n", 'lib/a.ts')
  assert.deepEqual(ungated.map((s) => s.gated), [false])
  const gated = scanMintsoftTransportSource("export const b = (u: URL) => connectorFetch(u, { method: 'GET' }, { connectorName: 'Mintsoft', hopGate: g })\nexport const c = (u: URL) => connectorFetch(u, { method: 'POST' }, { connectorName: 'Mintsoft', refuseRedirects: true })\nexport const d = (u: URL) => connectorFetch(u, { method: 'POST' }, { connectorName: 'Mintsoft', refuseRedirects: mintsoftProducerHoldEnforced() })\nexport const e = (u: URL) => connectorFetch(u, { method: 'POST' }, { connectorName: 'Mintsoft', refuseRedirects: someOtherFlag() })\n", 'lib/b.ts')
  assert.deepEqual(gated.map((s) => s.gated), [true, true, true, false])
  const report = mintCensusFindings(input({ transport: [...transport, ...ungated] }))
  assert.equal(red(report, 'MINT-3', 'without `hopGate`').length, 1, JSON.stringify(report.failures))
  // and every real call is gated
  assert.equal(transport.filter((s) => s.gated === false).length, 0)
  const stripped = scanMintsoftTransportSource(realText('lib/connectors/mintsoft/api/auth.ts').replace('    refuseRedirects: mintsoftProducerHoldEnforced(),', ''), 'lib/connectors/mintsoft/api/auth.ts')
  assert.ok(stripped.some((s) => s.gated === false), 'removing the login refusal is seen')
})
