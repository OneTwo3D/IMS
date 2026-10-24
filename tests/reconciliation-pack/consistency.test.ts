import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { PACK_ITEM_IDS, PACK_LOCK_FILE, getPackItem, itemApplicability, type PackItemId, type PackReasonCode } from '../../lib/reconciliation-pack/constants.ts'
import { defaultItems, newRunId } from '../../lib/reconciliation-pack/harness.ts'
import { publishPackReport } from '../../lib/reconciliation-pack/publish.ts'
import { ReportInvalid, buildReport, parseReport, sha256Hex, verifyEvidence, type ItemInput, type ReportInput, type StreamBracket } from '../../lib/reconciliation-pack/report.ts'
import { readPackChain } from '../../lib/reconciliation-pack/trend.ts'
import { NOW, STAMP, allBrackets, cleanup, itemFromComparison, key, passItem, scratchDir } from './helpers.ts'

const bases: string[] = []
after(() => cleanup(bases))

// An equal pair (a bothEqual entry); solo/soloV carry one side only (onlyIms, onlyVendor, unsettled, excluded, outOfPopulation).
const entry = (sku: string) => ({ key: sku as never, ims: '1', vendor: '1', delta: '0' })
const solo = (sku: string) => ({ key: sku as never, ims: '1', vendor: null, delta: null })
const soloV = (sku: string) => ({ key: sku as never, ims: null, vendor: '1', delta: null })
function input(items: ItemInput[], streams: StreamBracket[] = allBrackets(), phase: 'P0' | 'P1' | 'P2' = 'P1'): ReportInput {
  return { runId: newRunId(NOW), systemIdentifier: '7000000000000000001', phase, asOf: '2026-10-19', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), streams, items }
}
const base = (phase: 'P0' | 'P1' | 'P2' = 'P1') => defaultItems(phase)
const put = (items: ItemInput[], next: ItemInput) => items.map((item) => (item.id === next.id ? next : item))
const rejects = (items: ItemInput[], streams?: StreamBracket[], phase?: 'P0' | 'P1' | 'P2') => assert.throws(() => buildReport(input(items, streams, phase), 1, null), ReportInvalid)
const accepts = (items: ItemInput[], streams?: StreamBracket[], phase?: 'P0' | 'P1' | 'P2') => assert.doesNotThrow(() => buildReport(input(items, streams, phase), 1, null))

test('a pass with a proof, its exact sources and every dependent stream bracketed is accepted', () => {
  accepts(put(base(), passItem('R1')))
  accepts(put(base(), { ...passItem('R1'), proof: { kind: 'compared' }, entries: { bothEqual: [entry('A|MAIN')] } }))
  accepts(put(base(), passItem('R3')))
})

test('a pass with NO proof is rejected: an empty or unreadable comparison cannot be a verified pass', () => {
  rejects(put(base(), { ...passItem('R1'), proof: null }))
  rejects(put(base(), { id: 'R1', outcome: 'pass', reasons: [] }))
  // "compared" with nothing compared
  rejects(put(base(), { ...passItem('R1'), proof: { kind: 'compared' } }))
  rejects(put(base(), { ...passItem('R1'), proof: { kind: 'compared' }, entries: { outOfPopulation: [solo('A|MAIN')] } }))
  // "proven-empty" while identities were compared, or with an invented proof source
  rejects(put(base(), { ...passItem('R1'), entries: { bothEqual: [entry('A|MAIN')] } }))
  rejects(put(base(), { ...passItem('R1'), proof: { kind: 'proven-empty', source: 'because I said so' as never } }))
  rejects(put(base(), { ...passItem('R1'), proof: { kind: 'wishful' as never } }))
})

test('a pass names exactly its catalogue sources', () => {
  const spec = getPackItem('R1').sources
  rejects(put(base(), { ...passItem('R1'), sources: [] }))
  rejects(put(base(), { ...passItem('R1'), sources: [spec[0]!] }))
  rejects(put(base(), { ...passItem('R1'), sources: [...spec, 'qoblex-file'] }))
  rejects(put(base(), { ...passItem('R1'), sources: ['ims-database', 'xero-api'] }))
  rejects(put(base(), { ...passItem('R1'), sources: ['ims-database', 'mintsoft-api', 'not-a-source' as never] }))
  rejects(put(base(), { ...passItem('R1'), sources: [...spec, spec[0]!] }))
  rejects(put(base(), { id: 'R1', outcome: 'fail', reasons: ['DIFFERENCES'], sources: ['qoblex-file'] }))
  rejects(put(base(), { id: 'R1', outcome: 'fail', reasons: ['DIFFERENCES'], sources: ['ims-database', 'ims-database'] }))
})

test('a pass needs an equal start and end stamp for EVERY stream the item depends on', () => {
  const items = put(base(), passItem('R12'))
  assert.deepEqual([...getPackItem('R12').streams].sort(), ['woocommerce-order-sweep', 'xero-tax-rates'])
  accepts(items)
  const without = (stream: string) => allBrackets().filter((b) => b.stream !== stream)
  rejects(items, without('xero-tax-rates'))
  rejects(items, without('woocommerce-order-sweep'))
  rejects(items, [])
  const patched = (stream: string, patch: Partial<StreamBracket>) => allBrackets().map((b) => (b.stream === stream ? { ...b, ...patch } : b))
  rejects(items, patched('xero-tax-rates', { end: '2026-10-19T00:00:01.000Z' }))
  rejects(items, patched('xero-tax-rates', { start: null }))
  rejects(items, patched('woocommerce-order-sweep', { end: null }))
  rejects(items, patched('woocommerce-order-sweep', { start: null, end: null }))
  // a stream the item does NOT depend on does not matter; an item with no streams needs none
  accepts(items, patched('mintsoft-stock-sync', { start: null, end: null }))
  accepts(put(base(), passItem('R3')), [])
})

test('nothing but a pass carries a proof; a pass carries no reason, finding or unsettled identity', () => {
  rejects(put(base(), { id: 'R3', outcome: 'inconclusive', reasons: ['READ_INCOMPLETE'], proof: { kind: 'compared' } }))
  rejects(put(base(), { id: 'R3', outcome: 'fail', reasons: ['DIFFERENCES'], proof: { kind: 'compared' } }))
  rejects(put(base(), { ...passItem('R3'), reasons: ['DIFFERENCES'] }))
  rejects(put(base(), { ...passItem('R3'), entries: { onlyIms: [solo('A|MAIN')] } }))
  rejects(put(base(), { ...passItem('R3'), entries: { unsettled: [{ ...solo('A|MAIN'), settling: { sequence: 1, first: STAMP, later: [] } }] } }))
})

test('fail, inconclusive and not-applicable have invariants of their own', () => {
  const R = (outcome: ItemInput['outcome'], reasons: PackReasonCode[], extra: Partial<ItemInput> = {}): ItemInput => ({ id: 'R3', outcome, reasons, ...extra })
  // fail
  rejects(put(base(), R('fail', ['READ_INCOMPLETE'])))
  rejects(put(base(), R('fail', [])))
  accepts(put(base(), R('fail', ['DIFFERENCES'])))
  // a finding is always a fail with DIFFERENCES
  rejects(put(base(), R('inconclusive', ['READ_INCOMPLETE'], { entries: { onlyVendor: [soloV('A|MAIN')] } })))
  rejects(put(base(), R('fail', ['UNSETTLED_PENDING'], { entries: { onlyVendor: [soloV('A|MAIN')] } })))
  // inconclusive
  rejects(put(base(), R('inconclusive', [])))
  rejects(put(base(), R('inconclusive', ['DIFFERENCES'])))
  accepts(put(base(), R('inconclusive', ['STALE_BASIS'])))
  // UNSETTLED_PENDING and the unsettled count agree, in both directions
  rejects(put(base(), R('inconclusive', ['UNSETTLED_PENDING'])))
  rejects(put(base(), R('inconclusive', ['READ_INCOMPLETE'], { entries: { unsettled: [{ ...solo('A|MAIN'), settling: { sequence: 1, first: STAMP, later: [] } }] } })))
  accepts(put(base(), R('inconclusive', ['UNSETTLED_PENDING'], { entries: { unsettled: [{ ...solo('A|MAIN'), settling: { sequence: 1, first: STAMP, later: [] } }] } })))
  // NO_RUNNER is an inconclusive item with nothing listed
  rejects(put(base(), R('fail', ['NO_RUNNER', 'DIFFERENCES'])))
  rejects(put(base(), R('inconclusive', ['NO_RUNNER'], { entries: { excluded: [solo('A|MAIN')] } })))
  accepts(put(base(), R('inconclusive', ['NO_RUNNER'])))
  // NOT_SELECTED is the same, and carries no other reason
  accepts(put(base(), R('inconclusive', ['NOT_SELECTED'])))
  rejects(put(base(), R('inconclusive', ['NOT_SELECTED', 'STALE_BASIS'])))
  rejects(put(base(), R('inconclusive', ['NOT_SELECTED'], { entries: { excluded: [solo('A|MAIN')] } })))
  rejects(put(base(), R('fail', ['NOT_SELECTED', 'DIFFERENCES'])))
  rejects(put(base(), R('pass', ['NOT_SELECTED'])))
  // PHASE_NOT_APPLICABLE belongs to not-applicable alone, and not-applicable reads and lists nothing
  rejects(put(base(), R('inconclusive', ['PHASE_NOT_APPLICABLE'])))
  rejects(put(base('P1'), { id: 'R7', outcome: 'not-applicable', reasons: ['PHASE_NOT_APPLICABLE'], sources: ['qoblex-file'] }))
  rejects(put(base('P1'), { id: 'R7', outcome: 'not-applicable', reasons: ['PHASE_NOT_APPLICABLE'], entries: { excluded: [solo('A|MAIN')] } }))
  rejects(put(base('P1'), { id: 'R7', outcome: 'not-applicable', reasons: ['PHASE_NOT_APPLICABLE', 'NO_RUNNER'] }))
  rejects(put(base('P1'), { id: 'R7', outcome: 'inconclusive', reasons: ['NO_RUNNER'] }))
  rejects(put(base('P1'), { id: 'R7', outcome: 'pass', reasons: [], proof: { kind: 'compared' }, entries: { bothEqual: [entry('A|MAIN')] }, sources: ['ims-database', 'qoblex-file'] }))
  // an unlisted source on a non-pass is also refused
  rejects(put(base(), R('inconclusive', ['STALE_BASIS'], { sources: ['qoblex-file'] })))
})

test('a listed-only item is held to the same rules', () => {
  assert.equal(itemApplicability('R2', 'P1'), 'listed-only')
  rejects(put(base('P1'), { id: 'R2', outcome: 'pass', reasons: [] }))
  accepts(put(base('P1'), passItem('R2')))
})

// ---- the reader holds the same line --------------------------------------------------------------------

function goodRecord(): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const items = base('P1').map((item) => (itemApplicability(item.id, 'P1') === 'not-applicable' ? item : passItem(item.id)))
  const { body, markdown } = buildReport(input(items), 1, null)
  return { ...JSON.parse(JSON.stringify(body)), companionMarkdownSha256: sha256Hex(markdown) }
}
const item = (record: Record<string, any>, id: PackItemId) => record.items.find((i: { id: string }) => i.id === id) // eslint-disable-line @typescript-eslint/no-explicit-any

test('the reader accepts what the builder wrote', () => {
  const parsed = parseReport(JSON.stringify(goodRecord()))
  assert.equal(parsed.exitCode, 0)
  assert.equal(parsed.items.filter((i) => i.outcome === 'pass').length, 12)
})

test('the reader rejects every way a pass can lose its footing, after the file is written', () => {
  const mutations: Array<[string, (r: Record<string, any>) => void]> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ['proof removed', (r) => { item(r, 'R1').proof = null }],
    ['compared with nothing compared', (r) => { item(r, 'R1').proof = { kind: 'compared' } }],
    ['proof source invented', (r) => { item(r, 'R1').proof = { kind: 'proven-empty', source: 'trust me' } }],
    ['proof with an extra field', (r) => { item(r, 'R1').proof = { kind: 'proven-empty', source: 'vendor-total-zero', note: 'x' } }],
    ['sources emptied', (r) => { item(r, 'R1').sources = [] }],
    ['a source added', (r) => { item(r, 'R1').sources = [...item(r, 'R1').sources, 'qoblex-file'] }],
    ['a source invented', (r) => { item(r, 'R1').sources = ['ims-database', 'mintsoft-api', 'a-website'] }],
    ['a dependent stream removed', (r) => { r.streams = r.streams.filter((s: { stream: string }) => s.stream !== 'mintsoft-stock-sync') }],
    ['a stream bracket moved', (r) => { r.streams.find((s: { stream: string }) => s.stream === 'xero-balance-snapshots').end = '2026-10-19T00:00:01.000Z' }],
    ['a stream bracket nulled', (r) => { r.streams.find((s: { stream: string }) => s.stream === 'xero-tax-rates').start = null }],
    ['a reason on a pass', (r) => { item(r, 'R3').reasons = ['NO_RUNNER'] }],
    ['a proof on a not-applicable item', (r) => { item(r, 'R7').proof = { kind: 'compared' } }],
    ['sources on a not-applicable item', (r) => { item(r, 'R7').sources = ['qoblex-file'] }],
    ['proof key missing', (r) => { delete item(r, 'R1').proof }],
    ['sources key missing', (r) => { delete item(r, 'R1').sources }],
  ]
  for (const [name, mutate] of mutations) {
    const record = goodRecord()
    mutate(record)
    assert.throws(() => parseReport(JSON.stringify(record)), ReportInvalid, name)
  }
  // the unmutated record still parses (the mutations, not the fixture, are what fail)
  assert.doesNotThrow(() => parseReport(JSON.stringify(goodRecord())))
})

test('the reader rejects the other states the builder rejects', () => {
  const mutations: Array<[string, (r: Record<string, any>) => void]> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ['fail without DIFFERENCES', (r) => { Object.assign(item(r, 'R3'), { outcome: 'fail', reasons: ['READ_INCOMPLETE'], proof: null }); r.summary = { pass: 11, fail: 1, inconclusive: 0, notApplicable: 3 }; r.exitCode = 1 }],
    ['inconclusive with DIFFERENCES', (r) => { Object.assign(item(r, 'R3'), { outcome: 'inconclusive', reasons: ['DIFFERENCES'], proof: null }); r.summary = { pass: 11, fail: 0, inconclusive: 1, notApplicable: 3 }; r.exitCode = 5 }],
    ['UNSETTLED_PENDING with nothing unsettled', (r) => { Object.assign(item(r, 'R3'), { outcome: 'inconclusive', reasons: ['UNSETTLED_PENDING'], proof: null }); r.summary = { pass: 11, fail: 0, inconclusive: 1, notApplicable: 3 }; r.exitCode = 5 }],
    ['PHASE_NOT_APPLICABLE on an applicable item', (r) => { Object.assign(item(r, 'R3'), { outcome: 'inconclusive', reasons: ['PHASE_NOT_APPLICABLE'], proof: null }); r.summary = { pass: 11, fail: 0, inconclusive: 1, notApplicable: 3 }; r.exitCode = 5 }],
    ['a stale exit code', (r) => { r.exitCode = 5 }],
    ['a stale summary', (r) => { r.summary.pass = 3 }],
  ]
  for (const [name, mutate] of mutations) {
    const record = goodRecord()
    mutate(record)
    assert.throws(() => parseReport(JSON.stringify(record)), ReportInvalid, name)
  }
})

test('the publisher refuses an unproven pass: nothing is written, the lock is released, the chain is untouched', () => {
  const dir = path.join(scratchDir(bases), 'reports')
  const bad = put(base(), { id: 'R3', outcome: 'pass', reasons: [] })
  assert.throws(() => publishPackReport(dir, input(bad)), ReportInvalid)
  assert.equal(existsSync(path.join(dir, PACK_LOCK_FILE)), false)
  assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith('.')), [])
  assert.equal(readPackChain(dir).ok, true)
  void itemFromComparison; void key; void PACK_ITEM_IDS
})

// ---- malformed shapes at the report layer: refused, never defaulted ---------------------------------------------

test('the builder refuses every malformed input shape with ReportInvalid (never a TypeError, never a default)', () => {
  const good = () => base()
  const bad: Array<[string, () => ReportInput]> = [
    ['items not a list', () => ({ ...input(good()), items: null as never })],
    ['items an object', () => ({ ...input(good()), items: {} as never })],
    ['streams not a list', () => ({ ...input(good()), streams: undefined as never })],
    ['a stream bracket null', () => ({ ...input(good()), streams: [null as never] })],
    ['a stream bracket without a stream', () => ({ ...input(good()), streams: [{ start: STAMP, end: STAMP } as never] })],
    ['a bracket stamp undefined', () => ({ ...input(good()), streams: [{ stream: 'xero-tax-rates', start: undefined as never, end: STAMP }] })],
    ['an item null', () => input([...good().slice(1), null as never])],
    ['an item without reasons', () => input(put(good(), { id: 'R3', outcome: 'inconclusive' } as never))],
    ['reasons a string', () => input(put(good(), { id: 'R3', outcome: 'inconclusive', reasons: 'STALE_BASIS' } as never))],
    ['an outcome undefined', () => input(put(good(), { id: 'R3', reasons: ['STALE_BASIS'] } as never))],
    ['an outcome in the wrong case', () => input(put(good(), { id: 'R3', outcome: 'PASS', reasons: [] } as never))],
    ['sources a string', () => input(put(good(), { id: 'R3', outcome: 'inconclusive', reasons: ['STALE_BASIS'], sources: 'invariant-report' } as never))],
    ['a proof a string', () => input(put(good(), { ...passItem('R3'), proof: 'compared' } as never))],
    ['entries a list', () => input(put(good(), { id: 'R3', outcome: 'inconclusive', reasons: ['STALE_BASIS'], entries: [] } as never))],
    ['an unknown bucket', () => input(put(good(), { id: 'R3', outcome: 'inconclusive', reasons: ['STALE_BASIS'], entries: { onlyUs: [solo('A|MAIN')] } } as never))],
    ['a bucket not a list', () => input(put(good(), { id: 'R3', outcome: 'inconclusive', reasons: ['STALE_BASIS'], entries: { onlyIms: solo('A|MAIN') } } as never))],
    ['an entry null', () => input(put(good(), { id: 'R3', outcome: 'inconclusive', reasons: ['STALE_BASIS'], entries: { excluded: [null] } } as never))],
    ['an entry key that is not a token', () => input(put(good(), { id: 'R3', outcome: 'inconclusive', reasons: ['STALE_BASIS'], entries: { excluded: [{ ...solo('a@b.c') }] } } as never))],
    ['an entry key missing', () => input(put(good(), { id: 'R3', outcome: 'inconclusive', reasons: ['STALE_BASIS'], entries: { excluded: [{ ims: '1', vendor: '1', delta: '0' }] } } as never))],
    ...['NaN', '', '1e3', ' 1', '-0', '1.50', '01', '+1', 5, undefined].map((value): [string, () => ReportInput] => [`an entry value ${String(value)}`, () => input(put(good(), { id: 'R3', outcome: 'inconclusive', reasons: ['STALE_BASIS'], entries: { excluded: [{ ...solo('A|MAIN'), ims: value }] } } as never))]),
    ['an entry delta undefined', () => input(put(good(), { id: 'R3', outcome: 'inconclusive', reasons: ['STALE_BASIS'], entries: { excluded: [{ key: 'A|MAIN', ims: null, vendor: null }] } } as never))],
    ['a settling stamp bad', () => input(put(good(), { id: 'R3', outcome: 'inconclusive', reasons: ['UNSETTLED_PENDING'], entries: { unsettled: [{ ...solo('A|MAIN'), settling: { sequence: 1, first: 'soon', later: [] } }] } } as never))],
    ['settling not an object', () => input(put(good(), { id: 'R3', outcome: 'inconclusive', reasons: ['UNSETTLED_PENDING'], entries: { unsettled: [{ ...solo('A|MAIN'), settling: 'x' }] } } as never))],
    ['settling later not a list', () => input(put(good(), { id: 'R3', outcome: 'inconclusive', reasons: ['UNSETTLED_PENDING'], entries: { unsettled: [{ ...solo('A|MAIN'), settling: { sequence: 1, first: STAMP, later: 'x' } }] } } as never))],
  ]
  for (const [name, make] of bad) assert.throws(() => buildReport(make(), 1, null), ReportInvalid, name)
  assert.doesNotThrow(() => buildReport(input(base()), 1, null))
})

test('the evidence reader refuses a value that is not in the one canonical text form', () => {
  const { body, markdown } = buildReport(input(put(base(), { id: 'R3', outcome: 'inconclusive', reasons: ['STALE_BASIS'], entries: { excluded: [{ key: 'A|MAIN' as never, ims: '1.5', vendor: null, delta: null }] } })), 1, null)
  const record = { ...body, companionMarkdownSha256: sha256Hex(markdown) }
  const line = (ims: string) => `${JSON.stringify({ item: 'R3', bucket: 'excluded', key: 'A|MAIN', ims, vendor: null, delta: null, imsCurrency: null, vendorCurrency: null, imsPresent: true, vendorPresent: false })}\n`
  const withText = (text: string) => ({ ...record, evidence: { ...record.evidence, sha256: sha256Hex(text) } })
  verifyEvidence(line('1.5'), withText(line('1.5')))
  for (const ims of ['1.50', '-0', '0.0', '01', '+1', '1e0']) assert.throws(() => verifyEvidence(line(ims), withText(line(ims))), ReportInvalid, ims)
})

// [mutation: the VENDOR_READS_OFF rule removed from checkItemConsistency]
test('VENDOR_READS_OFF is accepted only as the single reason of an inconclusive vendor item that read nothing and lists nothing', () => {
  const off = (id: PackItemId, over: Partial<ItemInput> = {}): ItemInput => ({ id, outcome: 'inconclusive', reasons: ['VENDOR_READS_OFF'], ...over })
  accepts(put(base(), off('R9')))
  accepts(put(base(), off('R13')))
  accepts(put(base(), off('R1')))
  rejects(put(base(), off('R3')))
  rejects(put(base(), off('R9', { reasons: ['VENDOR_READS_OFF', 'STALE_BASIS'] })))
  rejects(put(base(), off('R9', { sources: ['woocommerce-api'] })))
  rejects(put(base(), off('R9', { entries: { bothEqual: [entry('11')] } })))
  rejects(put(base(), off('R9', { outcome: 'fail' })))
  rejects(put(base(), off('R9', { outcome: 'pass', proof: { kind: 'proven-empty', source: 'per-status-total-zero' }, sources: [...getPackItem('R9').sources] })))
})

// [mutation: the exception applied to every item, or to a pass that still names the vendor, or to a pass with another proof]
test('THE ONE SOURCE EXCEPTION: a pass on the proof alignment-confirmed names the IMS source alone, for R1 only; every other pass still names exactly its catalogue sources', () => {
  const retired = (over: Partial<ItemInput> = {}): ItemInput => ({ id: 'R1', outcome: 'pass', reasons: [], proof: { kind: 'proven-empty', source: 'alignment-confirmed' }, sources: ['ims-database'], ...over })
  accepts(put(base(), retired()))
  accepts(put(base(), retired({ entries: { outOfPopulation: [solo('A|MAIN')] } })))
  rejects(put(base(), retired({ sources: [...getPackItem('R1').sources] })), undefined, undefined) // still naming the vendor it never asked
  rejects(put(base(), retired({ sources: [] })))
  rejects(put(base(), retired({ sources: ['mintsoft-api'] })))
  rejects(put(base(), retired({ proof: { kind: 'proven-empty', source: 'vendor-total-zero' } })), undefined, undefined) // another proof still needs the vendor named
  rejects(put(base(), retired({ proof: { kind: 'compared' }, entries: { bothEqual: [entry('A|MAIN')] } })))
  rejects(put(base(), { ...retired({ id: 'R9' }) }))
  rejects(put(base(), { ...retired({ id: 'R13' }), sources: ['ims-database'] }))
  rejects(put(base(), { ...retired({ id: 'R3' }), sources: ['invariant-report'] }))
  // The stream still has to be bracketed and stable for the pass (the stock sync is the item's stream).
  rejects(put(base(), retired()), allBrackets().map((b) => (b.stream === 'mintsoft-stock-sync' ? { ...b, end: '2026-10-19T00:00:01.000Z' } : b)))
})
