import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DECLARATIONS,
  EXCLUDED_OPERATIONS,
  NO_PRODUCER,
} from '../../scripts/producer-census-declarations.ts'
import {
  MIN_SOURCE_FILES,
  PRIMITIVES,
  reconcile,
  scanSource,
  scanTree,
  seamFindings,
  type CensusInputs,
  type Declaration,
  type Site,
} from '../../scripts/producer-census.ts'
import { WRITER_OWNERSHIP_MAP, type OwnershipRow } from '../../lib/security/writer-ownership-map.ts'

/**
 * THE PRODUCER CENSUS, AND PROOF THAT IT CAN FAIL.
 *
 * Part 1 runs the census over the real tree and prints its precondition (files scanned, sites per
 * family) so a scan that examined nothing cannot pass. Part 2 drives every detector through fixtures,
 * including the shapes the census claims to see (alias import, re-export, literal element access,
 * destructured alias, `.call`) and the shapes it documents it does NOT see (a dynamic property call, a
 * caller of a local wrapper): the second kind are asserted as ABSENT so the blind spot is a measured
 * fact in this file, not a sentence in a comment. Part 3 breaks the reconciliation in every direction.
 */

const ROOT = process.cwd()
const mapRows = WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]

function realInputs(overrides: Partial<CensusInputs> = {}): CensusInputs & { filesScanned: number } {
  const scan = scanTree(ROOT)
  return {
    sites: scan.sites,
    declarations: DECLARATIONS,
    excludedOperations: EXCLUDED_OPERATIONS,
    noProducer: NO_PRODUCER,
    filesScanned: scan.filesScanned,
    sources: scan.sources,
    ...overrides,
  }
}

const calls = (source: string, file = 'lib/fixture.ts') => scanSource(source, file)
const names = (sites: Site[]) => sites.map((s) => `${s.primitive}${s.kind === 'call' ? '' : `[${s.kind}]`}`)

// ───────────────────────────── part 1: the real tree ─────────────────────────────

test('PRECONDITION: the census reached the tree and every primitive family, and the real tree reconciles', () => {
  const scan = scanTree(ROOT)
  const report = reconcile(realInputs())
  console.log(`# producer census (real tree): files ${scan.filesScanned}, sites ${report.counts.sitesFound}, `
    + `declared ${report.counts.declared}, excluded ${report.counts.excluded}`)
  console.log(`# sites by family ${JSON.stringify(report.counts.byFamily)}`)
  console.log(`# sites by destination ${JSON.stringify(report.counts.byDestination)}`)
  assert.ok(scan.filesScanned >= MIN_SOURCE_FILES, `scanned only ${scan.filesScanned} files`)
  assert.ok(report.counts.sitesFound >= 150, `found only ${report.counts.sitesFound} sites`)
  const families = new Set(Object.values(PRIMITIVES).map((p) => p.family))
  for (const family of families) assert.ok((report.counts.byFamily[family] ?? 0) > 0, `no site in family ${family}`)
  // The brief's named bypass and the four create sites are all seen as sites.
  const keys = new Set(scan.sites.map((s) => s.key))
  for (const key of [
    'lib/connectors/xero/queue.ts::queueXeroSync::createAccountingSyncLogRow#1',
    'lib/accounting.ts::queueAccountingSyncTx::createAccountingSyncLogRow#1',
    'lib/connectors/xero/daily-sync.ts::createPendingSyncLog::createAccountingSyncLogRow#1',
    'lib/connectors/xero/sync-processor.ts::enqueueFollowUpSyncLog::createAccountingSyncLogRow#1',
    'scripts/repro-scjz68.ts::seedScenario::accountingSyncLog.create#1',
    'scripts/provision-xero-demo.ts::ensureCurrencies::xeroPut#1',
  ]) assert.ok(keys.has(key), `expected site ${key}`)
  assert.deepEqual(report.failures, [])
})

// ───────────────────────────── part 2: detectors ─────────────────────────────

test('detector: a direct call, a namespace/member call and a plain identifier call are sites with stable keys', () => {
  const sites = calls(`
    import { wcPut } from './api'
    import * as api from './api'
    export async function pushIt() {
      await wcPut('/orders/1', {})
      await api.wcPost('/orders/1/notes', {})
      await wcPut('/orders/2', {})
    }`)
  assert.deepEqual(sites.map((s) => s.key), [
    'lib/fixture.ts::pushIt::wcPut#1',
    'lib/fixture.ts::pushIt::wcPost#1',
    'lib/fixture.ts::pushIt::wcPut#2',
  ])
})

test('detector: an ALIAS import is seen (the brief\'s `createAccountingSyncLogRow as c`)', () => {
  const sites = calls(`
    import { createAccountingSyncLogRow as c } from '@/lib/domain/accounting/sync-log-row'
    export async function sneaky(tx: unknown) { return c(tx, {}) }`)
  assert.deepEqual(names(sites), ['createAccountingSyncLogRow'])
  assert.equal(sites[0]!.via, 'c')
})

test('detector: a destructured alias from a dynamic import, and a `const f = prim` alias, are seen', () => {
  const sites = calls(`
    export async function a() {
      const { wcPost: post } = await import('@/lib/connectors/woocommerce/api')
      await post('/x', {})
    }
    import { wcPut } from './api'
    export async function b() { const f = wcPut; await f('/y', {}) }`)
  assert.deepEqual(names(sites).sort(), ['wcPost', 'wcPut', 'wcPut[reference]'].sort())
})

test('detector: a RE-EXPORT is seen, including a renamed one', () => {
  const sites = calls(`
    export { wcPost } from './api'
    export { wcPut as put } from './api'`)
  assert.deepEqual(names(sites), ['wcPost[reexport]', 'wcPut[reexport]'])
})

test('detector: a literal element-access call `facade[\'wcPost\'](…)` is seen; `.call` and `.apply` are seen', () => {
  const sites = calls(`
    import * as facade from './api'
    export async function f() {
      await facade['wcPost']('/x', {})
      await facade.wcPut.call(null, '/y', {})
    }`)
  assert.deepEqual(names(sites).sort(), ['wcPost', 'wcPut'])
})

test('detector: a primitive passed on as a value is a reference site (`.then(wcPost)`, `{ wcPost }`)', () => {
  const sites = calls(`
    import { wcPost } from './api'
    export const handlers = { wcPost }
    export const run = (p: Promise<unknown>) => p.then(wcPost)`)
  assert.deepEqual(names(sites), ['wcPost[reference]', 'wcPost[reference]'])
})

test('detector: a raw create on a queue table is a site, whoever holds the client', () => {
  const sites = calls(`
    export async function seed(db: any, tx: any) {
      await db.accountingSyncLog.create({ data: {} })
      await tx.integrationOutbox.createMany({ data: [] })
      await db.somethingElse.create({ data: {} })
    }`)
  assert.deepEqual(names(sites), ['accountingSyncLog.create', 'integrationOutbox.createMany'])
})

test('detector: member-only names (pushOrder) count as `x.pushOrder(…)` and not as a bare function', () => {
  const sites = calls(`
    export async function f(connector: any) {
      await connector.pushOrder({})
      await connector?.cancelOrder?.('1')
      function pushOrder() {}
      pushOrder()
    }`)
  assert.deepEqual(names(sites), ['pushOrder', 'cancelOrder'])
})

test('detector: declarations, types, property names, strings and comments are NOT sites (no false positives)', () => {
  const sites = calls(`
    // wcPost(...) in a comment
    import { wcPost } from './api'
    export async function wcPut() {}
    export type T = typeof wcPost
    export const note = 'wcPost(' + "createAccountingSyncLogRow("
    export const obj = { wcPost: 1, wcPut() {} }
    interface I { wcPost(): void }
    class C { wcPut() {} }`)
  assert.deepEqual(names(sites), [])
})

test('KNOWN BLIND SPOTS, measured: a dynamic property call and a caller of a local wrapper are NOT sites', () => {
  const dynamic = calls(`
    import * as facade from './api'
    export async function f(name: string) { await (facade as any)[name]('/x', {}) }`)
  assert.deepEqual(names(dynamic), [], 'a non-literal key is invisible to a syntactic scan')

  const wrapper = calls(`
    import { wcPost } from './api'
    export function wrapped(path: string) { return wcPost(path, {}) }
    export async function callerOfWrapper() { await wrapped('/x') }`)
  assert.deepEqual(wrapper.map((s) => s.key), ['lib/fixture.ts::wrapped::wcPost#1'],
    'the wrapper\'s inner call is a site; the caller of the wrapper is not')

  const star = calls(`export * from './api'`)
  assert.deepEqual(names(star), [], '`export *` is invisible')
})

// ───────────────────────────── part 3: reconciliation fails in every direction ─────────────────────────────

const row = (destination: string, operation: string, obligationTime: 'required' | 'not-applicable' = 'not-applicable'): OwnershipRow => ({
  destination: destination as OwnershipRow['destination'],
  operation,
  owners: { P0: 'nobody', P1: 'nobody', P2: 'IMS' },
  obligationTime,
  note: 'fixture row',
})
const site = (key: string): Site => {
  const [file, decl, rest] = key.split('::') as [string, string, string]
  const primitive = rest.replace(/#\d+$/, '').replace(/\[.*$/, '')
  return { key, file, line: 1, decl, primitive, kind: 'call' }
}
const decl = (key: string, destination: string, operation: string, obligationTime: Declaration['obligationTime'] = 'not-applicable'): Declaration => ({
  key, destination, operation, mechanism: 'direct-write', obligationTime, note: 'fixture declaration for the test',
})
const small = (over: Partial<CensusInputs> = {}): CensusInputs => ({
  sites: [site('lib/a.ts::f::wcPost#1')],
  declarations: [decl('lib/a.ts::f::wcPost#1', 'woocommerce', 'stock')],
  excludedOperations: {},
  noProducer: {},
  map: [row('woocommerce', 'stock')],
  filesScanned: 1000,
  minSourceFiles: 10,
  ...over,
})
const familiesFound = (report: ReturnType<typeof reconcile>) => report.failures.filter((f) => !f.startsWith('SUBJECT NOT REACHED: the scan found no site'))

test('reconcile: the fixture baseline is green apart from the family floor (the rig can pass)', () => {
  assert.deepEqual(familiesFound(reconcile(small())), [])
})

test('reconcile: an UNDECLARED new call site is red, and the message names the file to edit', () => {
  const report = reconcile(small({ sites: [site('lib/a.ts::f::wcPost#1'), site('lib/b.ts::g::wcPut#1')] }))
  const failures = familiesFound(report)
  assert.equal(failures.length, 1)
  assert.match(failures[0]!, /NEW PRODUCER SITE lib\/b\.ts::g::wcPut#1/)
  assert.match(failures[0]!, /scripts\/producer-census-declarations\.ts/)
})

test('reconcile: a STALE declaration (no site matches) is red', () => {
  const report = reconcile(small({ sites: [] }))
  assert.ok(familiesFound(report).some((f) => /STALE DECLARATION lib\/a\.ts::f::wcPost#1/.test(f)))
})

test('reconcile: a declared (destination, operation) that is neither mapped nor excluded is red; an exclusion with a reason makes it green', () => {
  const declarations = [decl('lib/a.ts::f::wcPost#1', 'woocommerce', 'made-up')]
  const bad = reconcile(small({ declarations, map: [row('woocommerce', 'stock')] }))
  assert.ok(familiesFound(bad).some((f) => /woocommerce\.made-up, which is neither an operation/.test(f)))
  const ok = reconcile(small({
    declarations,
    map: [row('woocommerce', 'stock')],
    excludedOperations: { 'woocommerce.made-up': 'a fixture reason that is long enough' },
    noProducer: { 'woocommerce.stock': 'a fixture reason that is long enough' },
  }))
  assert.deepEqual(familiesFound(ok), [])
})

test('reconcile: an ownership-map operation with no producer and no note is red; a NO_PRODUCER note makes it green; a stale note is red', () => {
  const map = [row('woocommerce', 'stock'), row('mintsoft', 'asn.create')]
  const missing = reconcile(small({ map }))
  assert.ok(familiesFound(missing).some((f) => /OWNERSHIP OPERATION mintsoft\.asn\.create has no declared producer/.test(f)))
  const noted = reconcile(small({ map, noProducer: { 'mintsoft.asn.create': 'no producer in this repo, by design' } }))
  assert.deepEqual(familiesFound(noted), [])
  const stale = reconcile(small({ map, noProducer: { 'mintsoft.asn.create': 'no producer in this repo, by design', 'woocommerce.stock': 'was true once, no longer' } }))
  assert.ok(familiesFound(stale).some((f) => /STALE NO_PRODUCER woocommerce\.stock/.test(f)))
  const unknown = reconcile(small({ map, noProducer: { 'mintsoft.asn.create': 'no producer in this repo, by design', 'xero.nope': 'not a map operation at all' } }))
  assert.ok(familiesFound(unknown).some((f) => /NO_PRODUCER\["xero\.nope"\] is not an operation/.test(f)))
})

test('reconcile: an obligationTime that disagrees with the ownership map is red', () => {
  const report = reconcile(small({ map: [row('woocommerce', 'stock', 'required')] }))
  assert.ok(familiesFound(report).some((f) => /declares obligationTime 'not-applicable' but woocommerce\.stock/.test(f)))
})

test('reconcile: a duplicate declaration, an unknown mechanism, a missing note and a weak exclusion reason are red', () => {
  const dup = reconcile(small({ declarations: [decl('lib/a.ts::f::wcPost#1', 'woocommerce', 'stock'), decl('lib/a.ts::f::wcPost#1', 'woocommerce', 'stock')] }))
  assert.ok(familiesFound(dup).some((f) => /DUPLICATE DECLARATION/.test(f)))
  const mech = reconcile(small({ declarations: [{ ...decl('lib/a.ts::f::wcPost#1', 'woocommerce', 'stock'), mechanism: 'bogus' as never }] }))
  assert.ok(familiesFound(mech).some((f) => /mechanism "bogus"/.test(f)))
  const note = reconcile(small({ declarations: [{ ...decl('lib/a.ts::f::wcPost#1', 'woocommerce', 'stock'), note: 'x' }] }))
  assert.ok(familiesFound(note).some((f) => /note is missing or shorter/.test(f)))
  const weak = reconcile(small({
    declarations: [decl('lib/a.ts::f::wcPost#1', 'woocommerce', 'made-up')],
    excludedOperations: { 'woocommerce.made-up': 'meh' },
    noProducer: { 'woocommerce.stock': 'a fixture reason that is long enough' },
  }))
  assert.ok(familiesFound(weak).some((f) => /has no real reason/.test(f)))
})

test('reconcile: a scan that reached too few files, or no site of a family, is "subject not reached", not a pass', () => {
  assert.ok(reconcile(small({ filesScanned: 3 })).failures.some((f) => /SUBJECT NOT REACHED: only 3 source files/.test(f)))
  const none = reconcile({ ...small(), sites: [], declarations: [], noProducer: { 'woocommerce.stock': 'a fixture reason that is long enough' } })
  assert.ok(none.failures.some((f) => /SUBJECT NOT REACHED: the scan found no site at all for the "xero-queue" family/.test(f)))
})

// ───────────────────────────── part 3b: named mutations against the REAL declarations and map ─────────────────────────────

test('MUTATION (drop a declaration): removing any one real declaration makes the census red with that site named', () => {
  const inputs = realInputs()
  const target = DECLARATIONS.find((d) => d.key === 'lib/connectors/woocommerce/sync/tracking-sync.ts::pushImsTrackingToWc::wcPut#1')
  assert.ok(target, 'precondition: the declaration to drop exists')
  const report = reconcile({ ...inputs, declarations: DECLARATIONS.filter((d) => d !== target) })
  console.log(`# drop-a-declaration: ${report.failures.length} finding(s)`)
  assert.ok(report.failures.some((f) => f.includes(`NEW PRODUCER SITE ${target.key}`)))
})

test('MUTATION (remove an ownership operation): deleting a map row that producers declare is red, naming the declarations', () => {
  const inputs = realInputs()
  const without = mapRows.filter((r) => !(r.destination === 'woocommerce' && r.operation === 'order.tracking'))
  assert.equal(without.length, mapRows.length - 1, 'precondition: exactly one row removed')
  const report = reconcile({ ...inputs, map: without })
  const hits = report.failures.filter((f) => /woocommerce\.order\.tracking, which is neither an operation/.test(f))
  console.log(`# remove-an-ownership-operation: ${hits.length} declaration(s) now point at a missing operation`)
  assert.ok(hits.length >= 2)
})

test('MUTATION (add an ownership operation): a new map row with no producer is red until a producer or a note exists', () => {
  const inputs = realInputs()
  const report = reconcile({ ...inputs, map: [...mapRows, row('woocommerce', 'order.refund-note')] })
  assert.ok(report.failures.some((f) => /OWNERSHIP OPERATION woocommerce\.order\.refund-note has no declared producer/.test(f)))
})

test('MUTATION (skip the walk for one file): a scan that skips a file leaves its declarations stale, so the census is red', () => {
  const inputs = realInputs()
  const skipped = 'lib/connectors/woocommerce/sync/wms-status.ts'
  const sites = inputs.sites.filter((s) => s.file !== skipped)
  assert.ok(sites.length < inputs.sites.length, 'precondition: the file had sites that are now not found')
  const report = reconcile({ ...inputs, sites })
  assert.ok(report.failures.some((f) => f.includes(`STALE DECLARATION ${skipped}::`)))
})

test('MUTATION (new call site in a real file): one extra wcPut in a real file is an undeclared site with the next ordinal', () => {
  const inputs = realInputs()
  const file = 'lib/connectors/woocommerce/sync/wms-status.ts'
  const existing = inputs.sites.filter((s) => s.file === file && s.primitive === 'wcPut')
  assert.equal(existing.length, 1, 'precondition: one wcPut in the file today')
  const extra = scanSource(`import { wcPut } from '../api'\nexport async function pushWmsOrderStatusToWc() {\n await wcPut('/a', {})\n await wcPut('/b', {})\n}`, file)
  const report = reconcile({ ...inputs, sites: [...inputs.sites.filter((s) => s.file !== file), ...extra] })
  assert.ok(report.failures.some((f) => f.includes(`NEW PRODUCER SITE ${file}::pushWmsOrderStatusToWc::wcPut#2`)))
})


// ───────────────────────────── part 4: the Xero seam checks ─────────────────────────────

const seamDecl = (key: string, mechanism: Declaration['mechanism'] = 'seam'): Declaration => ({
  key, destination: 'xero', operation: 'type-generic-queue-seam', mechanism, obligationTime: 'not-applicable', note: 'A fixture declaration for the seam checks.',
})

function seamRun(file: string, source: string, declarations: Declaration[] = []) {
  const sites = scanSource(source, file)
  const result = seamFindings(new Map([[file, source]]), sites, declarations)
  return { sites, ...result }
}

const GOOD_CALLER = `
  import { createAccountingSyncLogRow } from '@/lib/domain/accounting/sync-log-row'
  import { scheduleXeroAccountingOutbox } from './outbox'
  export async function enqueue(tx: unknown) {
    const created = await createAccountingSyncLogRow(tx, {})
    if (created.suppressed !== null) return
    if (created.shadowed) return
    await scheduleXeroAccountingOutbox(tx, { accountingSyncLogId: created.row.id })
  }`

test('SEAM-2 PRECONDITION: the real tree has sync-log create sites and seam sites, every create site handles the shadow answer, and every seam site consults the hold first', () => {
  const inputs = realInputs()
  const report = reconcile(inputs)
  const seam = report.counts.seam!
  console.log(`# seam checks (real tree): ${seam.seamSitesConsulting}/${seam.seamSites} seam sites consult the hold; ${seam.rowSitesHandlingShadow}/${seam.rowSites} create sites handle the shadow`)
  assert.ok(seam.seamSites >= 3, 'PRECONDITION: seam sites were examined')
  assert.ok(seam.rowSites >= 4, 'PRECONDITION: the four create callers were examined')
  assert.equal(seam.seamSitesConsulting, seam.seamSites)
  assert.equal(seam.rowSitesHandlingShadow, seam.rowSites)
  assert.deepEqual(report.failures, [])
})

test('SEAM-2: a caller that reads `.shadowed` between the create and the outbox schedule is accepted', () => {
  const result = seamRun('lib/connectors/xero/fixture.ts', GOOD_CALLER)
  assert.equal(result.counts.rowSites, 1)
  assert.deepEqual(result.failures, [])
})

test('SEAM-2 MUTATION (one caller schedules a job for a shadow): dropping the shadow answer before the schedule is red, naming the site', () => {
  const mutated = GOOD_CALLER.replace('    if (created.shadowed) return\n', '')
  assert.notEqual(mutated, GOOD_CALLER, 'precondition: the mutation changed the fixture')
  const result = seamRun('lib/connectors/xero/fixture.ts', mutated)
  assert.equal(result.counts.rowSites, 1)
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0]!, /SEAM-2 lib\/connectors\/xero\/fixture\.ts::enqueue::createAccountingSyncLogRow#1/)
})

test('SEAM-2 MUTATION (the shadow check sits AFTER the schedule): reading `.shadowed` too late is red', () => {
  const late = `
    export async function enqueue(tx: unknown) {
      const created = await createAccountingSyncLogRow(tx, {})
      await scheduleXeroAccountingOutbox(tx, { accountingSyncLogId: created.row.id })
      if (created.shadowed) return
    }`
  assert.equal(seamRun('lib/connectors/xero/late.ts', late).failures.length, 1)
})

test('SEAM-2: a `.shadowed` read in ANOTHER function does not count (the check is per declaration)', () => {
  const split = `
    function other(created: { shadowed?: unknown }) { return created.shadowed }
    export async function enqueue(tx: unknown) {
      const created = await createAccountingSyncLogRow(tx, {})
      await scheduleXeroAccountingOutbox(tx, { accountingSyncLogId: created.row.id })
    }`
  assert.equal(seamRun('lib/connectors/xero/split.ts', split).failures.length, 1)
})

test('SEAM-2: a call of the primitive inside the primitive\'s own file is exempt (it is the seam)', () => {
  const result = seamRun('lib/domain/accounting/sync-log-row.ts', `export async function wrapper(tx: unknown) { return createAccountingSyncLogRow(tx, {}) }`)
  assert.equal(result.counts.rowSites, 0)
})

test('SEAM-1: a declared seam must call a consultation BEFORE the site; after it, or not at all, is red', () => {
  const ok = `export async function act() { const v = xeroProducerSeamVerdict({}); await putXeroTaxRate({}) }`
  const okRun = seamRun('app/actions/fixture.ts', ok, [seamDecl('app/actions/fixture.ts::act::putXeroTaxRate#1')])
  assert.equal(okRun.counts.seamSites, 1)
  assert.equal(okRun.counts.seamSitesConsulting, 1)
  assert.deepEqual(okRun.failures, [])
  for (const [label, source] of [
    ['no consultation', `export async function act() { await putXeroTaxRate({}) }`],
    ['consulted after', `export async function act() { await putXeroTaxRate({}); xeroProducerSeamVerdict({}) }`],
    ['consulted in another function', `function ask() { return xeroProducerSeamVerdict({}) }\nexport async function act() { await putXeroTaxRate({}) }`],
  ] as const) {
    const run = seamRun('app/actions/fixture.ts', source, [seamDecl('app/actions/fixture.ts::act::putXeroTaxRate#1')])
    console.log(`# SEAM-1 ${label}: ${run.failures.length} finding(s)`)
    assert.equal(run.failures.length, 1, label)
    assert.match(run.failures[0]!, /SEAM-1 .* is declared a seam but act calls none of/)
  }
})

test('SEAM-1 over the real tree, MUTATED: a seam declaration on a site whose function never consults the hold is red', () => {
  const inputs = realInputs()
  // queueXeroSync never calls the consultation itself (it relies on the primitive), so declaring it a seam must fail.
  const key = 'lib/connectors/xero/queue.ts::queueXeroSync::createAccountingSyncLogRow#1'
  const declarations = inputs.declarations.map((d) => (d.key === key ? { ...d, mechanism: 'seam' as const } : d))
  assert.ok(declarations.some((d) => d.key === key && d.mechanism === 'seam'), 'precondition: the mutation applied')
  const report = reconcile({ ...inputs, declarations })
  assert.ok(report.failures.some((f) => f.includes(`SEAM-1 ${key}`)), report.failures.join('\n'))
})

test('SEAM-2 over the real tree, MUTATED: removing the shadow read from the daily-batch caller is red with that site named', () => {
  const inputs = realInputs()
  const file = 'lib/connectors/xero/daily-sync.ts'
  const text = inputs.sources!.get(file)!
  const mutated = text.replace('if (created.shadowed) return created.shadowed.id', '/* removed */')
  assert.notEqual(mutated, text, 'precondition: the shadow read was found and removed')
  const sources = new Map(inputs.sources!)
  sources.set(file, mutated)
  const report = reconcile({ ...inputs, sources })
  assert.ok(report.failures.some((f) => f.includes(`SEAM-2 ${file}::createPendingSyncLog::createAccountingSyncLogRow#1`)), report.failures.join('\n'))
})

test('SEAM-3: a direct Xero write declared "direct-write" is red; as a seam or as the transport behind one it is green', () => {
  const inputs = realInputs()
  const key = 'app/actions/settings.ts::generateMissingXeroTaxRates::putXeroTaxRate#1'
  const direct = inputs.declarations.map((d) => (d.key === key ? { ...d, mechanism: 'direct-write' as const } : d))
  const report = reconcile({ ...inputs, declarations: direct })
  assert.ok(report.failures.some((f) => f.startsWith(`SEAM-3 ${key}`)), report.failures.join('\n'))
  assert.ok(report.failures.some((f) => f.includes(`SEAM-1 ${key}`)) === false, 'the SEAM-1 check applies only to a declared seam')
  assert.deepEqual(reconcile(inputs).failures, [])
})

test('the seam checks cannot pass by examining nothing: with the tree reached and no seam or create site in the sources, the census says "subject not reached"', () => {
  const inputs = realInputs()
  const report = reconcile({ ...inputs, sources: new Map() })
  assert.ok(report.failures.some((f) => /SUBJECT NOT REACHED: the seam checks saw 0 seam site/.test(f)) || report.failures.some((f) => f.startsWith('SEAM ')), report.failures.join('\n'))
})
