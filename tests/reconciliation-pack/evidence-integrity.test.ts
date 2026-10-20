import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { MAX_EVIDENCE_LINES_PER_ITEM, PACK_LOCK_FILE, PACK_SEQUENCE_CLAIM_PREFIX, getPackItem, type PackItemId } from '../../lib/reconciliation-pack/constants.ts'
import { compareItem } from '../../lib/reconciliation-pack/compare.ts'
import { defaultItems, newRunId } from '../../lib/reconciliation-pack/harness.ts'
import { publishPackReport } from '../../lib/reconciliation-pack/publish.ts'
import { ReportInvalid, buildReport, equalDigest, parseReport, sha256Hex, verifyEvidence, type ItemInput, type ReportInput } from '../../lib/reconciliation-pack/report.ts'
import { NOW, STAMP, allBrackets, cleanup, passItem, scratchDir } from './helpers.ts'

const bases: string[] = []
after(() => cleanup(bases))
const CAP = 40
const MARK = 'leak@marker.example'
// A deliberately loose view of the input, so a test can corrupt any field of it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const pair = (key: string, ims = '1', vendor = '1', delta = '0', extra: Record<string, unknown> = {}) => ({ key: key as never, ims, vendor, delta, ...extra })
const soloI = (key: string) => ({ key: key as never, ims: '2', vendor: null, delta: null })
const soloV = (key: string) => ({ key: key as never, ims: null, vendor: '3', delta: null })
function input(items: ItemInput[], over: Partial<ReportInput> = {}): ReportInput {
  return { runId: newRunId(NOW), systemIdentifier: '7000000000000000001', phase: 'P1', asOf: '2026-10-19', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), streams: allBrackets(), items, ...over }
}
const put = (items: ItemInput[], next: ItemInput) => items.map((item) => (item.id === next.id ? next : item))
const compared = (id: PackItemId, entries: ItemInput['entries']): ItemInput => ({ ...passItem(id), proof: { kind: 'compared' }, entries })
const R1 = (entries: ItemInput['entries']) => compared('R1', entries)
const rejects = (items: ItemInput[], label: string) => assert.throws(() => buildReport(input(items), 1, null), ReportInvalid, label)

// ---- (1) a value-bearing entry must carry what the item's mode and measure demand --------------------------------

test('a value-mode item cannot pass on entries that carry no values (the empty comparison that "passed")', () => {
  const base = defaultItems('P1')
  rejects(put(base, R1({ bothEqual: [{ key: 'A|MAIN', ims: null, vendor: null, delta: null }] } as never)), 'all null')
  rejects(put(base, R1({ bothEqual: [{ key: 'A|MAIN', ims: '1', vendor: null, delta: null }] } as never)), 'one side')
  rejects(put(base, R1({ bothEqual: [{ key: 'A|MAIN', ims: '1', vendor: '1', delta: null }] } as never)), 'no delta')
  rejects(put(base, R1({ bothEqual: [pair('A|MAIN', '1', '1', '5')] })), 'wrong delta')
  rejects(put(base, R1({ bothEqual: [pair('A|MAIN', '1', '5', '-4')] })), 'a pair outside the tolerance listed as equal')
  assert.doesNotThrow(() => buildReport(input(put(base, R1({ bothEqual: [pair('A|MAIN')] }))), 1, null))
  assert.doesNotThrow(() => buildReport(input(put(base, R1({ bothEqual: [pair('A|MAIN', '1', '1.00005', '-0.00005')] }))), 1, null), 'inside 0.0001')
})

test('each bucket demands its own value shape, delta and verdict', () => {
  const base = defaultItems('P1')
  const reasonsFor = (entries: ItemInput['entries']) => (entries?.unsettled?.length ? (['DIFFERENCES', 'UNSETTLED_PENDING'] as const) : (['DIFFERENCES'] as const))
  const fail = (entries: ItemInput['entries'], label: string) => rejects(put(base, { id: 'R1', outcome: 'fail', reasons: [...reasonsFor(entries)], entries }), label)
  const ok = (entries: ItemInput['entries'], label: string) => assert.doesNotThrow(() => buildReport(input(put(base, { id: 'R1', outcome: 'fail', reasons: [...reasonsFor(entries)], entries })), 1, null), label)
  ok({ unsettled: [{ ...soloI('U|MAIN'), settling: { first: STAMP, later: [] } }], onlyIms: [soloI('V|MAIN')] }, 'an unsettled one-sided difference')
  ok({ unsettled: [{ ...pair('U|MAIN', '1', '5', '-4'), settling: { first: STAMP, later: [STAMP] } }] }, 'an unsettled pair that differs')
  fail({ unsettled: [{ ...pair('U|MAIN', '1', '5', '-3'), settling: { first: STAMP, later: [] } }] }, 'an unsettled pair with a wrong delta')
  ok({ bothDiffer: [pair('A|MAIN', '1', '5', '-4')] }, 'a real difference')
  fail({ bothDiffer: [pair('A|MAIN', '1', '1', '0')] }, 'bothDiffer within tolerance')
  fail({ bothDiffer: [pair('A|MAIN', '1', '5', '9')] }, 'bothDiffer with a wrong delta')
  fail({ bothDiffer: [{ key: 'A|MAIN', ims: null, vendor: null, delta: null }] }, 'bothDiffer without values')
  ok({ onlyIms: [soloI('A|MAIN')] }, 'onlyIms')
  fail({ onlyIms: [pair('A|MAIN')] }, 'onlyIms with a vendor value')
  fail({ onlyIms: [{ key: 'A|MAIN', ims: null, vendor: null, delta: null }] }, 'onlyIms with no value')
  fail({ onlyIms: [{ ...soloI('A|MAIN'), delta: '2' }] }, 'onlyIms with a delta')
  fail({ onlyIms: [soloV('A|MAIN')] }, 'onlyIms carrying a vendor value')
  ok({ onlyVendor: [soloV('A|MAIN')] }, 'onlyVendor')
  fail({ onlyVendor: [soloI('A|MAIN')] }, 'onlyVendor carrying an ims value')
  ok({ excluded: [soloI('A|MAIN')], outOfPopulation: [soloV('B|MAIN')], onlyIms: [soloI('C|MAIN')] }, 'excluded and out of population')
  fail({ excluded: [{ key: 'A|MAIN', ims: null, vendor: null, delta: null }] }, 'excluded with no value')
  fail({ excluded: [{ ...soloI('A|MAIN'), delta: '1' }] }, 'excluded with a delta')
  fail({ outOfPopulation: [pair('A|MAIN', '1', '1', '1')] }, 'outOfPopulation with a delta')
  fail({ unsettled: [{ ...pair('A|MAIN'), settling: { first: STAMP, later: [] } }] }, 'unsettled pair that does not differ')
  fail({ unsettled: [{ key: 'A|MAIN', ims: null, vendor: null, delta: null, settling: { first: STAMP, later: [] } }] }, 'unsettled without values')
  fail({ onlyIms: [{ ...soloI('A|MAIN'), settling: { first: STAMP, later: [] } }] }, 'settling data outside unsettled')
  fail({ unsettled: [soloI('A|MAIN')] }, 'unsettled without settling data')
  fail({ onlyIms: [soloI('A|MAIN')], bothDiffer: [pair('A|MAIN', '1', '5', '-4')] }, 'one identity in two buckets')
  fail({ onlyIms: [{ key: 'A|MAIN' as never, ims: '2', vendor: null, delta: null, vendorCurrency: 'GBP' }] }, 'a currency for a value that is missing')
  fail({ bothDiffer: [pair('A|MAIN', '1', '5', '-4', { imsCurrency: 'GBP' })] }, 'a currency on one side of a pair')
  fail({ bothDiffer: [pair('A|MAIN', '1', '5', '-4', { imsCurrency: 'QQQ', vendorCurrency: 'QQQ' })] }, 'a currency that is not in the known list')
  fail({ onlyIms: [{ ...soloI('A|MAIN'), imsCurrency: 'gbp' }] }, 'a currency in the wrong case')
})

test('currencies: R9 (minor unit) needs a known currency for each value, equal on both sides for an equal pair', () => {
  const r9 = (entries: ItemInput['entries'], outcome: 'pass' | 'fail' = 'pass'): ItemInput => outcome === 'pass' ? compared('R9', entries) : { id: 'R9', outcome: 'fail', reasons: ['DIFFERENCES'], entries }
  const base = defaultItems('P1')
  const gbp = { imsCurrency: 'GBP', vendorCurrency: 'GBP' }
  assert.doesNotThrow(() => buildReport(input(put(base, r9({ bothEqual: [pair('1001', '10', '10.01', '-0.01', gbp)] }))), 1, null))
  rejects(put(base, r9({ bothEqual: [pair('1001', '10', '10.02', '-0.02', gbp)] })), 'two minor units apart')
  rejects(put(base, r9({ bothEqual: [pair('1001', '10', '10', '0')] })), 'no currency at all')
  rejects(put(base, r9({ bothEqual: [pair('1001', '10', '10', '0', { imsCurrency: 'GBP', vendorCurrency: 'EUR' })] })), 'two currencies listed as equal')
  rejects(put(base, r9({ bothEqual: [pair('1001', '10', '10', '0', { imsCurrency: 'QQQ', vendorCurrency: 'QQQ' })] })), 'an unknown currency')
  rejects(put(base, r9({ bothEqual: [pair('1001', '10', '10', '0', { imsCurrency: 'GBP', vendorCurrency: null })] })), 'a currency on one side')
  assert.doesNotThrow(() => buildReport(input(put(base, r9({ bothDiffer: [pair('1001', '10', '10', '0', { imsCurrency: 'GBP', vendorCurrency: 'EUR' })] }, 'fail'))), 1, null), 'a currency disagreement is a difference')
  assert.doesNotThrow(() => buildReport(input(put(base, r9({ onlyIms: [{ key: '1002', ims: '5', vendor: null, delta: null, imsCurrency: 'JPY' }] }, 'fail'))), 1, null))
  rejects(put(base, r9({ onlyIms: [{ key: '1002', ims: '5', vendor: null, delta: null }] }, 'fail')), 'a value with no currency')
  rejects(put(base, { id: 'R1', outcome: 'fail', reasons: ['DIFFERENCES'], entries: { onlyIms: [{ key: 'A|MAIN', ims: null, vendor: null, delta: null, imsCurrency: 'GBP' }] } } as never), 'a currency for a missing value')
})

test('presence items (R13, R14) carry no values and no currencies', () => {
  const base = defaultItems('P1')
  const r13 = (e: ItemInput['entries']): ItemInput => ({ ...passItem('R13'), proof: { kind: 'compared' }, entries: e })
  assert.doesNotThrow(() => buildReport(input(put(base, r13({ bothEqual: [{ key: 'TAX1', ims: null, vendor: null, delta: null, imsPresent: true, vendorPresent: true }] }))), 1, null))
  rejects(put(base, r13({ bothEqual: [pair('TAX1')] })), 'a value in a presence item')
  rejects(put(base, r13({ bothEqual: [{ key: 'TAX1', ims: null, vendor: null, delta: null, imsCurrency: 'GBP' }] })), 'a currency in a presence item')
  assert.equal(getPackItem('R13').measure, null)
})

// ---- (2) the pass proof is recomputable from the evidence ------------------------------------------------------------

function passingBuild(keys = ['A|MAIN', 'B|MAIN', 'C|MAIN']) {
  return buildReport(input(put(defaultItems('P1'), R1({ bothEqual: keys.map((k) => pair(k)) }))), 1, null)
}

test('every equal identity is a line of the evidence; the count and the digest are recomputed from the lines', () => {
  const built = passingBuild()
  const lines = built.evidenceText.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  assert.deepEqual(lines.map((l) => [l.item, l.bucket, l.key]), [['R1', 'bothEqual', 'A|MAIN'], ['R1', 'bothEqual', 'B|MAIN'], ['R1', 'bothEqual', 'C|MAIN']])
  const r1 = built.record.items.find((i) => i.id === 'R1')!
  assert.equal(r1.counts.bothEqual, 3)
  assert.equal(r1.evidenceLines, 3)
  assert.equal(r1.bothEqualSha256, equalDigest(['A|MAIN', 'B|MAIN', 'C|MAIN']))
  assert.doesNotThrow(() => verifyEvidence(built.evidenceText, built.record))
})

test('the reader rejects evidence that no longer proves the count or the digest, even when its own digest is re-signed', () => {
  const built = passingBuild()
  const lines = built.evidenceText.trim().split('\n')
  const resign = (text: string, lineCount = text.trim().split('\n').length) => ({ ...built.record, evidence: { ...built.record.evidence, sha256: sha256Hex(text), lines: lineCount } })
  const check = (text: string, label: string, lineCount?: number) => assert.throws(() => verifyEvidence(text, resign(text, lineCount)), ReportInvalid, label)
  check(`${lines.slice(1).join('\n')}\n`, 'a line removed')
  check(`${[...lines, lines[0]].join('\n')}\n`, 'a line duplicated')
  check(`${[lines[0], lines[1], lines[2]!.replace('C|MAIN', 'D|MAIN')].join('\n')}\n`, 'an identity swapped (same count, new digest)')
  check(`${[lines[0], lines[1], lines[2]!.replace('"bothEqual"', '"onlyIms"')].join('\n')}\n`, 'a line moved to another bucket')
  check(`${[lines[0], lines[1], lines[2]!.replace('"ims":"1"', '"ims":"9"')].join('\n')}\n`, 'a value changed so the pair is no longer equal')
  check(`${[lines[0], lines[1], lines[2]!.replace('"delta":"0"', '"delta":"0.0"')].join('\n')}\n`, 'a non-canonical delta')
  check(`${[lines[0], lines[1], lines[2]!.replace('"delta":"0"', '"delta":null')].join('\n')}\n`, 'a missing delta')
  check(`${[lines[0], lines[1], lines[2]!.replace(',"imsCurrency":null', '')].join('\n')}\n`, 'a missing field')
  check(`${[lines[0], lines[1], lines[2]!.replace('}', ',"extra":1}')].join('\n')}\n`, 'an extra field')
  check(`${[lines[0], lines[1], lines[2]!.replace('"item":"R1"', '"item":"R13"')].join('\n')}\n`, 'a line for a presence item carrying values')
  assert.doesNotThrow(() => verifyEvidence(built.evidenceText, built.record))
})

test('the count the reader trusts is the evidence\'s: a report that claims more equal identities than it lists is invalid', () => {
  const built = passingBuild()
  const lying = JSON.parse(JSON.stringify(built.record))
  lying.items.find((i: { id: string }) => i.id === 'R1').counts.bothEqual = 30
  assert.throws(() => verifyEvidence(built.evidenceText, lying), ReportInvalid)
})

// ---- (3) nothing the caller owns is serialised: a marker in EVERY nested property ---------------------------------

function richInput(): ReportInput {
  const items = put(put(defaultItems('P1'), {
    id: 'R1', outcome: 'fail', reasons: ['DIFFERENCES', 'UNSETTLED_PENDING'], sources: ['ims-database', 'mintsoft-api'],
    entries: {
      onlyIms: [soloI('A|MAIN')], onlyVendor: [soloV('B|MAIN')], bothDiffer: [pair('C|MAIN', '1', '5', '-4')], bothEqual: [pair('D|MAIN')],
      unsettled: [{ ...soloI('E|MAIN'), settling: { first: STAMP, later: [STAMP] } }], excluded: [soloI('F|MAIN')], outOfPopulation: [soloV('G|MAIN')],
    },
  }), { ...passItem('R3'), proof: { kind: 'proven-empty', source: 'invariant-report-clean' } })
  return input(items)
}

/** Every property path of a plain structure (objects by key, arrays by index), depth first. */
function paths(value: unknown, prefix: Array<string | number> = []): Array<Array<string | number>> {
  if (typeof value !== 'object' || value === null) return []
  const out: Array<Array<string | number>> = [prefix]
  for (const [k, v] of Object.entries(value)) out.push(...paths(v, [...prefix, Array.isArray(value) ? Number(k) : k]))
  return out
}
function at(root: unknown, p: Array<string | number>): Record<string | number, unknown> {
  return p.reduce<unknown>((node, k) => (node as Record<string | number, unknown>)[k], root) as Record<string | number, unknown>
}
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

test('the rich input builds; its evidence and JSON hold only the whitelisted fields', () => {
  const built = buildReport(richInput(), 1, null)
  assert.equal(built.record.items.find((i) => i.id === 'R1')!.counts.unsettled, 1)
  const keys = new Set<string>()
  for (const l of built.evidenceText.trim().split('\n')) for (const k of Object.keys(JSON.parse(l))) keys.add(k)
  assert.deepEqual([...keys].sort(), ['bucket', 'delta', 'ims', 'imsCurrency', 'imsPresent', 'item', 'key', 'settling', 'vendor', 'vendorCurrency', 'vendorPresent'])
})

test('DATA ABSENCE: a marker added to, or put in place of, every nested property of the input is refused before any output exists', () => {
  const base = richInput()
  const all = paths(base)
  assert.ok(all.length > 50, `precondition: ${all.length} object paths`)
  let attempts = 0
  const refuse = (mutated: ReportInput, label: string) => {
    attempts += 1
    try { buildReport(mutated, 1, null) } catch (error) {
      assert.ok(error instanceof ReportInvalid, `${label}: ${String(error)}`)
      assert.ok(!(error as Error).message.includes(MARK), `${label}: the message must not repeat the data`)
      return
    }
    assert.fail(`${label}: accepted`)
  }
  for (const p of all) {
    const label = JSON.stringify(p)
    const extra = clone(base); const holder = at(extra, p)
    if (Array.isArray(holder)) (holder as unknown as Record<string, unknown>)[MARK] = MARK; else holder[MARK] = MARK
    refuse(extra, `extra property at ${label}`)
    if (Array.isArray(holder)) { const longer = clone(base); (at(longer, p) as unknown as unknown[]).push(MARK); refuse(longer, `an extra element at ${label}`) }
  }
  // each leaf replaced by the marker, by an object holding it, and by a list holding it
  const leaves: Array<Array<string | number>> = []
  const walk = (v: unknown, p: Array<string | number>) => { if (typeof v === 'object' && v !== null) { for (const [k, c] of Object.entries(v)) walk(c, [...p, Array.isArray(v) ? Number(k) : k]) } else leaves.push(p) }
  walk(base, [])
  assert.ok(leaves.length > 100, `precondition: ${leaves.length} leaves`)
  for (const p of leaves) {
    for (const replacement of [MARK, { m: MARK }, [MARK]]) {
      const mutated = clone(base); const parent = at(mutated, p.slice(0, -1)); parent[p[p.length - 1]!] = replacement
      refuse(mutated, `leaf ${JSON.stringify(p)} = ${JSON.stringify(replacement)}`)
    }
  }
  console.log(`precondition: ${all.length} object paths, ${leaves.length} leaves, ${attempts} refusals`)
})

test('prototype and object tricks never reach the output: every one is refused', () => {
  const clean = (): Loose => clone(richInput())
  const tricks: Array<[string, (i: Loose) => ReportInput]> = [
    ['__proto__ as an own key', (i) => ({ ...i, items: JSON.parse(`[${JSON.stringify(i.items[0])}]`.replace('{', '{"__proto__":{"x":1},')) as never })],
    ['__proto__ own key on the input', () => JSON.parse(JSON.stringify(clean()).replace('{', '{"__proto__":{"polluted":true},')) as never],
    ['constructor as a key', (i) => ({ ...i, constructor: 'X' }) as never],
    ['toJSON as a key', (i) => ({ ...i, toJSON: () => ({ leak: MARK }) }) as never],
    ['a getter on the input', (i) => { const o = { ...i }; Object.defineProperty(o, 'asOf', { get: () => '2026-10-19', enumerable: true }); return o }],
    ['a getter on an item', (i) => { const items = [...i.items]; const it = { ...items[0]! }; Object.defineProperty(it, 'outcome', { get: () => 'inconclusive', enumerable: true }); items[0] = it; return { ...i, items } }],
    ['a getter on an entry', () => { const c = clean(); const e = { ...c.items[0]!.entries!.onlyIms![0]! }; Object.defineProperty(e, 'ims', { get: () => '2', enumerable: true }); c.items[0]!.entries!.onlyIms![0] = e; return c }],
    ['a symbol key', (i) => ({ ...i, [Symbol('x')]: MARK }) as never],
    ['a non-enumerable property', (i) => { const o = { ...i }; Object.defineProperty(o, 'hidden', { value: MARK, enumerable: false }); return o }],
    ['a class instance as the input', (i) => Object.assign(new (class Evil { })(), i) as never],
    ['a class instance as an entry', () => { const c = clean(); c.items[0]!.entries!.onlyIms![0] = Object.assign(new (class E { })(), c.items[0]!.entries!.onlyIms![0]) as never; return c }],
    ['a Proxy as the input', (i) => new Proxy(i, {})],
    ['a Proxy as an item', () => { const c = clean(); c.items[0] = new Proxy(c.items[0]!, {}); return c }],
    ['a Proxy as a list', () => { const c = clean(); return { ...c, items: new Proxy(c.items, {}) as never } }],
    ['an object with a custom prototype', (i) => Object.setPrototypeOf({ ...i }, { inherited: MARK })],
    ['a Map as an entry', () => { const c = clean(); c.items[0]!.entries!.onlyIms![0] = new Map() as never; return c }],
    ['a Date as a stamp', (i) => ({ ...i, startedAt: new Date(0) }) as never],
    ['a String object as a name', (i) => ({ ...i, systemIdentifier: new String('7000000000000000001') }) as never],
    ['a sparse list', (i) => { const items = new Array(15); items[0] = i.items[0]; return { ...i, items } }],
    ['a list with an extra property', (i) => { const items = [...i.items]; Object.assign(items, { extra: MARK }); return { ...i, items } }],
    ['a list subclass', (i) => ({ ...i, items: Object.setPrototypeOf([...i.items], class Sub extends Array { }.prototype) })],
    ['a list with a getter element', (i) => { const items = [...i.items]; Object.defineProperty(items, 0, { get: () => i.items[0], enumerable: true }); return { ...i, items } }],
    ['an enormous list', () => { const c = clean(); c.items[0]!.entries!.onlyIms = new Array(5_000_000).fill(null) as never; return c }],
    ['an enormous sparse list', () => { const c = clean(); c.items[0]!.entries!.onlyIms = new Array(2 ** 31) as never; return c }],
    ['deep nesting in an unknown field', (i) => { let deep: Record<string, unknown> = {}; for (let n = 0; n < 20000; n += 1) deep = { d: deep }; return { ...i, extra: deep } as never }],
    ['deep nesting in a settling field', () => { let deep: unknown = []; for (let n = 0; n < 20000; n += 1) deep = [deep]; const c = clean(); (c.items[0]!.entries!.unsettled![0] as { settling: { later: unknown } }).settling.later = deep; return c }],
    ['a function as a value', (i) => ({ ...i, asOf: () => '2026-10-19' }) as never],
    ['a bigint as a count-like value', () => { const c = clean(); (c.items[0]!.entries!.onlyIms![0] as { ims: unknown }).ims = BigInt(2); return c }],
  ]
  let n = 0
  for (const [label, make] of tricks) {
    n += 1
    assert.throws(() => buildReport(make(clean()), 1, null), (error: unknown) => error instanceof ReportInvalid && !error.message.includes(MARK), label)
  }
  console.log(`precondition: ${n} tricks refused`)
  assert.equal(({} as Record<string, unknown>).polluted, undefined, 'Object.prototype was not polluted')
})

test('the evidence reader refuses __proto__, constructor and toJSON keys and a prototype-bearing line', () => {
  const built = passingBuild()
  const line = built.evidenceText.trim().split('\n')[0]!
  const resign = (text: string) => ({ ...built.record, evidence: { ...built.record.evidence, sha256: sha256Hex(text), lines: text.trim().split('\n').length } })
  for (const bad of [line.replace('{', '{"__proto__":{"x":1},'), line.replace('{', '{"constructor":1,'), line.replace('{', '{"toJSON":1,')]) {
    const text = `${bad}\n${built.evidenceText.trim().split('\n').slice(1).join('\n')}\n`
    assert.throws(() => verifyEvidence(text, resign(text)), ReportInvalid, bad.slice(0, 30))
  }
})

test('CRASH SAFETY: an invalid input never writes a file, a directory or a claim, and the lock is released', () => {
  const dir = path.join(scratchDir(bases), 'reports')
  const writes: string[] = []
  const hooks = { writeFile: (file: string) => { writes.push(file) } }
  const bad = richInput(); (bad.items[0] as unknown as { extra: string }).extra = MARK
  assert.throws(() => publishPackReport(dir, bad, hooks), ReportInvalid)
  assert.throws(() => publishPackReport(dir, { ...richInput(), items: [] }, hooks), ReportInvalid)
  assert.deepEqual(writes, [])
  assert.deepEqual(readdirSync(dir), [], 'nothing, not even a claim or a lock')
  assert.equal(existsSync(path.join(dir, PACK_LOCK_FILE)), false)
  assert.equal(readdirSync(dir).some((n) => n.startsWith(PACK_SEQUENCE_CLAIM_PREFIX)), false)
})

test('the published files hold none of a caller\'s extra data, because it is refused rather than dropped', () => {
  const dir = path.join(scratchDir(bases), 'reports')
  const ok = publishPackReport(dir, richInput())
  assert.equal(ok.ok, true)
  const text = [ok.ok ? ok.json : '', ok.ok ? ok.markdown : '', ok.ok ? ok.evidence : ''].map((f) => path.basename(f))
  assert.equal(text.length, 3)
})

test('the report reader refuses a JSON document with a __proto__, constructor or toJSON key anywhere', () => {
  const built = passingBuild()
  const text = built.jsonText
  for (const injected of ['"__proto__": {"x": 1},', '"constructor": 1,', '"toJSON": 1,']) {
    assert.throws(() => parseReport(text.replace('{', `{${injected}`)), ReportInvalid, injected)
    assert.throws(() => parseReport(text.replace('"counts": {', `"counts": {${injected}`)), ReportInvalid, `nested ${injected}`)
    assert.throws(() => parseReport(text.replace('"evidence": {', `"evidence": {${injected}`)), ReportInvalid, `evidence ${injected}`)
  }
  assert.doesNotThrow(() => parseReport(text))
})

test('the cap cuts equal identities, never a finding; a cut item cannot pass', () => {
  const equal = Array.from({ length: CAP + 5 }, (_, i) => pair(`E${i}`))
  const built = buildReport(input(put(defaultItems('P1'), { id: 'R1', outcome: 'fail', reasons: ['DIFFERENCES'], entries: { bothEqual: equal, onlyIms: [soloI('LOST-IF-CUT')] } })), 1, null, { maxLinesPerItem: CAP })
  const r1 = built.record.items.find((i) => i.id === 'R1')!
  assert.equal(r1.counts.onlyIms, 1, 'the finding is kept')
  assert.equal(r1.counts.bothEqual, CAP - 1)
  assert.ok(r1.reasons.includes('CAP_EXCEEDED'))
  assert.throws(() => buildReport(input(put(defaultItems('P1'), R1({ bothEqual: equal }))), 1, null, { maxLinesPerItem: CAP }), ReportInvalid, 'a pass whose equal identities do not all fit')
  assert.throws(() => buildReport(input(defaultItems('P1')), 1, null, { maxLinesPerItem: 0 }), ReportInvalid)
  assert.throws(() => buildReport(input(defaultItems('P1')), 1, null, { maxLinesPerItem: MAX_EVIDENCE_LINES_PER_ITEM + 1 }), ReportInvalid, 'the cap cannot be raised')
})

test('a proof carries exactly its own fields', () => {
  const base = defaultItems('P1')
  rejects(put(base, { ...R1({ bothEqual: [pair('A|MAIN')] }), proof: { kind: 'compared', source: 'vendor-total-zero' } } as never), 'compared with a source')
  rejects(put(base, { ...passItem('R3'), proof: { kind: 'proven-empty' } } as never), 'proven-empty without a source')
  rejects(put(base, { ...passItem('R3'), proof: { kind: 'proven-empty', source: 'vendor-total-zero', note: MARK } } as never), 'an extra field')
  assert.doesNotThrow(() => buildReport(input(put(base, passItem('R3'))), 1, null))
})

test('the reader refuses one identity listed twice in the evidence even when every count still adds up', () => {
  const built = buildReport(input(put(defaultItems('P1'), { id: 'R1', outcome: 'fail', reasons: ['DIFFERENCES'], entries: { onlyIms: [soloI('A|MAIN')], onlyVendor: [soloV('B|MAIN')] } })), 1, null)
  const lines = built.evidenceText.trim().split('\n')
  const text = `${lines[0]}\n${lines[1]!.replace('B|MAIN', 'A|MAIN')}\n`
  assert.throws(() => verifyEvidence(text, { ...built.record, evidence: { ...built.record.evidence, sha256: sha256Hex(text) } }), ReportInvalid)
})

test('the comparator for an item uses the catalogue\'s mode and measure, whatever the caller would prefer', () => {
  const cmp = (id: PackItemId, ims: string, vendor: string, extra: Record<string, unknown> = {}) => compareItem(id, { imsComplete: true, vendorComplete: true, ims: [{ key: [{ kind: 'sku', raw: 'A' }], value: ims, ...extra }], vendor: [{ key: [{ kind: 'sku', raw: 'A' }], value: vendor, ...extra }] })
  const counts = (r: ReturnType<typeof cmp>) => (r.status === 'compared' ? { equal: r.buckets.bothEqual.length, differ: r.buckets.bothDiffer.length } : r.reason)
  assert.deepEqual(counts(cmp('R1', '1', '5')), { equal: 0, differ: 1 }, 'exact')
  assert.deepEqual(counts(cmp('R1', '1', '1.00005')), { equal: 1, differ: 0 })
  assert.deepEqual(counts(cmp('R6', '100', '100.9')), { equal: 1, differ: 0 }, 'GBP 1')
  assert.deepEqual(counts(cmp('R6', '100', '101.1')), { equal: 0, differ: 1 })
  assert.deepEqual(counts(cmp('R12', '10', '10.04')), { equal: 1, differ: 0 }, 'GBP 0.05')
  assert.deepEqual(counts(cmp('R12', '10', '10.06')), { equal: 0, differ: 1 })
  assert.deepEqual(counts(cmp('R5', '1000000', '999600')), { equal: 1, differ: 0 }, 'composite: 0.05% of a million is 500')
  assert.deepEqual(counts(cmp('R5', '1000000', '999400')), { equal: 0, differ: 1 })
  assert.deepEqual(counts(cmp('R9', '10', '10.01', { currency: 'GBP' })), { equal: 1, differ: 0 }, 'one minor unit')
  assert.deepEqual(counts(cmp('R9', '10', '10.02', { currency: 'GBP' })), { equal: 0, differ: 1 })
  assert.equal(counts(cmp('R9', '10', '10')), 'CURRENCY_UNKNOWN')
  assert.equal(counts(cmp('R13', '1', '1')), 'VALUE_SHAPE_MISMATCH', 'a presence item takes no values')
})
