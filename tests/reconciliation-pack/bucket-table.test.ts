import assert from 'node:assert/strict'
import test from 'node:test'

import { compareItem, outcomeOfComparison, type CompareResult, type SideRow } from '../../lib/reconciliation-pack/compare.ts'
import { getPackItem, type ComparisonBucket, type PackItemId, type PackReasonCode } from '../../lib/reconciliation-pack/constants.ts'
import { defaultItems, newRunId } from '../../lib/reconciliation-pack/harness.ts'
import { canonicalKey } from '../../lib/reconciliation-pack/identity.ts'
import { ReportInvalid, buildReport, parseReport, sha256Hex, verifyEvidence, type ItemInput, type ItemResult, type ReportInput } from '../../lib/reconciliation-pack/report.ts'
import { NOW, STAMP, allBrackets } from './helpers.ts'

/**
 * EVERY COMBINATION OF BUCKETS, in both modes, from the comparator to the parsed report. No combination without a
 * genuinely compared, in-population, non-excluded identity (or a valid named proof that the population is empty) may pass.
 */

const key = (raw: string) => [{ kind: 'sku' as const, raw }]
const input = (items: ItemInput[]): ReportInput => ({ runId: newRunId(NOW), systemIdentifier: '7000000000000000001', phase: 'P1', asOf: '2026-10-19', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), streams: allBrackets(), items })
const put = (items: ItemInput[], next: ItemInput) => items.map((item) => (item.id === next.id ? next : item))

type Flags = { E: boolean; D: boolean; I: boolean; V: boolean; X: boolean; P: boolean; S: boolean; Y: boolean }
const LETTERS = ['E', 'D', 'I', 'V', 'X', 'P', 'S', 'Y'] as const

function rowsFor(flags: Flags, mode: 'values' | 'presence') {
  const ims: SideRow[] = []
  const vendor: SideRow[] = []
  const val = (v: string): Partial<SideRow> => (mode === 'values' ? { value: v } : {})
  const both = (name: string, a: string, b: string) => { ims.push({ key: key(name), ...val(a) }); vendor.push({ key: key(name), ...val(b) }) }
  if (flags.E) both('E1', '1', '1')
  if (flags.D) both('D1', '1', '9')
  if (flags.I) ims.push({ key: key('I1'), ...val('2') })
  if (flags.V) vendor.push({ key: key('V1'), ...val('3') })
  if (flags.X) both('X1', '1', '1')
  if (flags.P) ims.push({ key: key('P1'), ...val('4') })
  const inPopulation = ['E1', 'D1', 'I1', 'V1', 'X1'].filter((k, i) => [flags.E, flags.D, flags.I, flags.V, flags.X][i])
  return {
    ims, vendor,
    excluded: flags.X ? new Set([canonicalKey(key('X1'))]) : undefined,
    population: flags.P ? new Set(inPopulation.map((k) => canonicalKey(key(k)))) : undefined,
  }
}

function expected(flags: Flags, mode: 'values' | 'presence'): { outcome: 'pass' | 'fail' | 'inconclusive'; reasons: PackReasonCode[] } {
  const differs = (mode === 'values' && flags.D) || flags.I || flags.V
  const judged = flags.E || differs
  if (!judged && !flags.Y) return { outcome: 'inconclusive', reasons: ['EMPTY_UNPROVEN'] }
  if (differs) return flags.S ? { outcome: 'inconclusive', reasons: ['UNSETTLED_PENDING'] } : { outcome: 'fail', reasons: ['DIFFERENCES'] }
  return { outcome: 'pass', reasons: [] }
}

function itemOf(id: PackItemId, result: CompareResult): ItemInput {
  const verdict = outcomeOfComparison(result)
  const spec = getPackItem(id)
  const base: ItemInput = { id, outcome: verdict.outcome, reasons: verdict.reasons, sources: [...spec.sources] }
  if (result.status !== 'compared') return base
  return { ...base, entries: result.buckets, proof: verdict.outcome === 'pass' ? result.proof : null }
}

for (const mode of ['values', 'presence'] as const) {
  const id: PackItemId = mode === 'values' ? 'R1' : 'R13'
  test(`TABLE ${mode}: every combination of equal, differ, onlyIms, onlyVendor, excluded, out of population, settling and empty proof`, () => {
    let combos = 0
    let passes = 0
    for (let mask = 0; mask < 1 << LETTERS.length; mask += 1) {
      const flags = Object.fromEntries(LETTERS.map((letter, bit) => [letter, (mask & (1 << bit)) !== 0])) as Flags
      if (mode === 'presence' && flags.D) continue // a presence comparison has no "differs"
      const label = LETTERS.filter((l) => flags[l]).join('') || '(nothing)'
      const rows = rowsFor(flags, mode)
      const result = compareItem(id, {
        imsComplete: true, vendorComplete: true, ims: rows.ims, vendor: rows.vendor, excluded: rows.excluded, population: rows.population,
        emptyProof: flags.Y ? 'vendor-total-zero' : undefined,
        settling: flags.S ? { carried: new Map(), stamp: STAMP, usable: true } : undefined,
      })
      const want = expected(flags, mode)
      assert.deepEqual(outcomeOfComparison(result), want, `${mode} ${label}: comparator outcome`)
      combos += 1

      // Through the report and back.
      const built = buildReport(input(put(defaultItems('P1'), itemOf(id, result))), 1, null)
      const parsed = parseReport(built.jsonText)
      verifyEvidence(built.evidenceText, parsed)
      const item: ItemResult = parsed.items.find((row) => row.id === id)!
      assert.equal(item.outcome, want.outcome, `${mode} ${label}: report outcome`)
      const judgedEqual = item.counts.bothEqual
      if (item.outcome === 'pass') {
        passes += 1
        const genuine = (item.proof?.kind === 'compared' && judgedEqual > 0)
        const emptyOk = (item.proof?.kind === 'proven-empty' && judgedEqual === 0 && flags.Y && !flags.E && !flags.I && !flags.V && !flags.D)
        assert.ok(genuine || emptyOk, `${mode} ${label}: a pass without a compared identity or a valid empty proof`)
        // Excluded and out-of-population identities are never what a pass rests on.
        assert.equal(genuine, flags.E, `${mode} ${label}: only an equal in-population identity makes a "compared" pass`)
      } else {
        assert.equal(item.proof, null)
      }
    }
    console.log(`precondition: ${mode}: ${combos} combinations, ${passes} passes`)
    assert.ok(combos >= 128 && passes > 0)
  })
}

// ---- forged items: whatever the combination, a pass needs the proof ------------------------------------------------

type Entry = Record<string, unknown>
function entriesFor(mode: 'values' | 'presence', bucket: ComparisonBucket): Entry {
  const k = `${bucket.slice(0, 3).toUpperCase()}1`
  if (mode === 'values') {
    switch (bucket) {
      case 'bothEqual': return { key: k, ims: '1', vendor: '1', delta: '0' }
      case 'bothDiffer': return { key: k, ims: '1', vendor: '9', delta: '-8' }
      case 'onlyIms': case 'excluded': return { key: k, ims: '2', vendor: null, delta: null }
      case 'onlyVendor': case 'outOfPopulation': return { key: k, ims: null, vendor: '3', delta: null }
      case 'unsettled': return { key: k, ims: '2', vendor: null, delta: null, settling: { first: STAMP, later: [] } }
    }
  }
  const p = (ims: boolean, vendor: boolean, extra: Entry = {}): Entry => ({ key: k, ims: null, vendor: null, delta: null, imsPresent: ims, vendorPresent: vendor, ...extra })
  switch (bucket) {
    case 'bothEqual': return p(true, true)
    case 'bothDiffer': return p(true, true)
    case 'onlyIms': case 'excluded': return p(true, false)
    case 'onlyVendor': case 'outOfPopulation': return p(false, true)
    case 'unsettled': return p(true, false, { settling: { first: STAMP, later: [] } })
  }
}

for (const mode of ['values', 'presence'] as const) {
  const id: PackItemId = mode === 'values' ? 'R1' : 'R13'
  const buckets: ComparisonBucket[] = mode === 'values' ? ['bothEqual', 'bothDiffer', 'onlyIms', 'onlyVendor', 'unsettled', 'excluded', 'outOfPopulation'] : ['bothEqual', 'onlyIms', 'onlyVendor', 'unsettled', 'excluded', 'outOfPopulation']
  test(`FORGED PASS ${mode}: a pass is accepted only with equal identities and the "compared" proof, or no equal identity and a named empty proof`, () => {
    let accepted = 0
    let refused = 0
    for (let mask = 0; mask < 1 << buckets.length; mask += 1) {
      const present = buckets.filter((_, bit) => (mask & (1 << bit)) !== 0)
      const entries = Object.fromEntries(present.map((b) => [b, [entriesFor(mode, b)]]))
      for (const proof of [null, { kind: 'compared' }, { kind: 'proven-empty', source: 'vendor-total-zero' }] as const) {
        const item = { id, outcome: 'pass', reasons: [], sources: [...getPackItem(id).sources], proof, entries } as never as ItemInput
        const findings = present.some((b) => b === 'bothDiffer' || b === 'onlyIms' || b === 'onlyVendor') || present.includes('unsettled')
        const hasEqual = present.includes('bothEqual')
        const shouldAccept = !findings && proof !== null && ((proof.kind === 'compared' && hasEqual) || (proof.kind === 'proven-empty' && !hasEqual))
        const label = `${mode} [${present.join(',')}] proof ${proof ? proof.kind : 'none'}`
        if (shouldAccept) {
          const built = buildReport(input(put(defaultItems('P1'), item)), 1, null)
          assert.equal(parseReport(built.jsonText).items.find((i) => i.id === id)!.outcome, 'pass', label)
          accepted += 1
        } else {
          assert.throws(() => buildReport(input(put(defaultItems('P1'), item)), 1, null), ReportInvalid, label)
          refused += 1
        }
      }
    }
    console.log(`precondition: ${mode}: ${accepted} accepted, ${refused} refused`)
    assert.ok(accepted > 0 && refused > accepted)
  })
}

// ---- presence-mode buckets are derived from the recorded presence, not believed ---------------------------------------

test('PRESENCE: the bucket is derived from the per-side presence flags in the builder and in the reader', () => {
  const r13 = (bucket: ComparisonBucket, ims: unknown, vendor: unknown, outcome: ItemInput['outcome'] = 'fail'): ItemInput => ({
    id: 'R13', outcome, reasons: outcome === 'fail' ? ['DIFFERENCES'] : [], sources: [...getPackItem('R13').sources],
    entries: { [bucket]: [{ key: 'TAX1', ims: null, vendor: null, delta: null, imsPresent: ims, vendorPresent: vendor }] },
  } as never)
  const build = (item: ItemInput) => buildReport(input(put(defaultItems('P1'), item)), 1, null)
  // the reviewed attack: a one-sided identity published as an equal pass
  assert.throws(() => build({ ...r13('bothEqual', true, false, 'pass'), proof: { kind: 'compared' } }), ReportInvalid, 'bothEqual with the vendor side absent')
  assert.throws(() => build({ ...r13('bothEqual', false, true, 'pass'), proof: { kind: 'compared' } }), ReportInvalid, 'bothEqual with the ims side absent')
  assert.throws(() => build({ ...r13('bothEqual', false, false, 'pass'), proof: { kind: 'compared' } }), ReportInvalid, 'present on neither side')
  assert.throws(() => build(r13('onlyIms', true, true)), ReportInvalid, 'onlyIms with both present')
  assert.throws(() => build(r13('onlyIms', false, true)), ReportInvalid, 'onlyIms that is vendor-only')
  assert.throws(() => build(r13('onlyVendor', true, false)), ReportInvalid, 'onlyVendor that is ims-only')
  assert.throws(() => build(r13('onlyVendor', true, true)), ReportInvalid)
  assert.throws(() => build(r13('bothDiffer', true, true)), ReportInvalid, 'a presence pair cannot differ')
  assert.throws(() => build(r13('excluded', false, false)), ReportInvalid, 'excluded and present on neither side')
  for (const bad of [undefined, null, 'true', 1, 0, {}, []]) assert.throws(() => build(r13('onlyIms', bad, false)), ReportInvalid, `flag ${String(bad)}`)
  assert.doesNotThrow(() => build({ ...r13('bothEqual', true, true, 'pass'), proof: { kind: 'compared' } }))
  assert.doesNotThrow(() => build(r13('onlyIms', true, false)))
  assert.doesNotThrow(() => build(r13('onlyVendor', false, true)))
  assert.doesNotThrow(() => build({ ...r13('excluded', true, true, 'inconclusive'), reasons: ['EMPTY_UNPROVEN'] }), 'excluded may be present on both sides')
})

test('COMPARATOR: excluded, out-of-population and unsettled identities never become a "compared" proof', () => {
  const X = canonicalKey(key('X1'))
  const row = (k: string): SideRow => ({ key: key(k), value: '1' })
  const run = (over: Record<string, unknown>) => compareItem('R1', { imsComplete: true, vendorComplete: true, ims: [row('X1')], vendor: [row('X1')], ...over } as never)
  // one excluded row, nothing else, no proof: unreadable (the reviewed attack passed here)
  assert.deepEqual(run({ excluded: new Set([X]) }), { status: 'unreadable', reason: 'EMPTY_UNPROVEN' })
  assert.deepEqual(outcomeOfComparison(run({ excluded: new Set([X]) })), { outcome: 'inconclusive', reasons: ['EMPTY_UNPROVEN'] })
  // with a named proof that the judged population is empty, the proof is that one, never "compared"
  const proven = run({ excluded: new Set([X]), emptyProof: 'vendor-total-zero' })
  assert.equal(proven.status === 'compared' && proven.proof?.kind, 'proven-empty')
  assert.equal(proven.status === 'compared' && proven.buckets.excluded.length, 1)
  // out of population only
  assert.deepEqual(run({ population: new Set() }), { status: 'unreadable', reason: 'EMPTY_UNPROVEN' })
  const outside = run({ population: new Set(), emptyProof: 'vendor-total-zero' })
  assert.equal(outside.status === 'compared' && outside.proof?.kind, 'proven-empty')
  // excluded and out of population together
  assert.deepEqual(run({ ims: [row('X1'), row('P1')], vendor: [row('X1')], excluded: new Set([X]), population: new Set([X]) }), { status: 'unreadable', reason: 'EMPTY_UNPROVEN' })
  // findings or unsettled identities alone: no proof at all, and never a pass
  const finding = run({ ims: [row('I1')], vendor: [] })
  assert.equal(finding.status === 'compared' && finding.proof, null)
  assert.equal(outcomeOfComparison(finding).outcome, 'fail')
  const unsettled = run({ ims: [row('I1')], vendor: [], settling: { carried: new Map(), stamp: STAMP, usable: true } })
  assert.equal(unsettled.status === 'compared' && unsettled.proof, null)
  assert.equal(outcomeOfComparison(unsettled).outcome, 'inconclusive')
  // a real equal identity beside an excluded one: "compared", resting on the equal one
  const real = run({ ims: [row('E1'), row('X1')], vendor: [row('E1'), row('X1')], excluded: new Set([X]) })
  assert.equal(real.status === 'compared' && real.proof?.kind, 'compared')
  assert.equal(real.status === 'compared' && real.buckets.bothEqual.length, 1)
})

test('READER: presence evidence lines are re-judged from their recorded presence flags', () => {
  const built = buildReport(input(put(defaultItems('P1'), {
    id: 'R13', outcome: 'fail', reasons: ['DIFFERENCES'], sources: [...getPackItem('R13').sources],
    entries: {
      bothEqual: [{ key: 'TAX1', ims: null, vendor: null, delta: null, imsPresent: true, vendorPresent: true }],
      onlyIms: [{ key: 'TAX2', ims: null, vendor: null, delta: null, imsPresent: true, vendorPresent: false }],
      onlyVendor: [{ key: 'TAX3', ims: null, vendor: null, delta: null, imsPresent: false, vendorPresent: true }],
    },
  } as never)), 1, null)
  const lines = built.evidenceText.trim().split('\n')
  assert.deepEqual(lines.map((l) => JSON.parse(l).bucket), ['onlyIms', 'onlyVendor', 'bothEqual'])
  verifyEvidence(built.evidenceText, built.record)
  const resign = (text: string) => ({ ...built.record, evidence: { ...built.record.evidence, sha256: sha256Hex(text) } })
  const tamper = (index: number, from: string, to: string, label: string) => {
    const copy = [...lines]; copy[index] = copy[index]!.replace(from, to)
    assert.notEqual(copy[index], lines[index], label)
    const text = `${copy.join('\n')}\n`
    assert.throws(() => verifyEvidence(text, resign(text)), ReportInvalid, label)
  }
  tamper(2, '"vendorPresent":true', '"vendorPresent":false', 'an equal line whose vendor side is now absent')
  tamper(2, '"imsPresent":true', '"imsPresent":false', 'an equal line whose ims side is now absent')
  tamper(0, '"vendorPresent":false', '"vendorPresent":true', 'an onlyIms line that is now present on both')
  tamper(1, '"imsPresent":false', '"imsPresent":true', 'an onlyVendor line that is now present on both')
  tamper(0, '"bucket":"onlyIms"', '"bucket":"bothEqual"', 'an onlyIms line relabelled equal')
  tamper(1, '"bucket":"onlyVendor"', '"bucket":"onlyIms"', 'an onlyVendor line relabelled onlyIms')
  tamper(2, '"imsPresent":true,"vendorPresent":true', '"imsPresent":false,"vendorPresent":false', 'present on neither side')
  tamper(2, '"imsPresent":true', '"imsPresent":"yes"', 'a flag that is not a boolean')
  tamper(2, ',"imsPresent":true', '', 'a missing flag')
  tamper(2, '"ims":null', '"ims":"1"', 'a value in a presence line')
})

test('VALUES: the presence flags must agree with the values, and the bucket with both', () => {
  const r1 = (entry: Record<string, unknown>, bucket: ComparisonBucket = 'onlyIms') => buildReport(input(put(defaultItems('P1'), { id: 'R1', outcome: 'fail', reasons: ['DIFFERENCES'], entries: { [bucket]: [entry] } } as never)), 1, null)
  assert.doesNotThrow(() => r1({ key: 'A', ims: '2', vendor: null, delta: null }))
  assert.doesNotThrow(() => r1({ key: 'A', ims: '2', vendor: null, delta: null, imsPresent: true, vendorPresent: false }))
  assert.throws(() => r1({ key: 'A', ims: '2', vendor: null, delta: null, imsPresent: false, vendorPresent: false }), ReportInvalid, 'flag false for a value')
  assert.throws(() => r1({ key: 'A', ims: '2', vendor: null, delta: null, imsPresent: true, vendorPresent: true }), ReportInvalid, 'vendor flag without a value')
  assert.throws(() => r1({ key: 'A', ims: '2', vendor: null, delta: null }, 'onlyVendor'), ReportInvalid, 'an ims-only identity labelled onlyVendor')
  assert.throws(() => r1({ key: 'A', ims: '1', vendor: '1', delta: '0' }, 'onlyIms'), ReportInvalid, 'an equal pair labelled onlyIms')
  assert.throws(() => r1({ key: 'A', ims: '1', vendor: '1', delta: '0' }, 'bothDiffer'), ReportInvalid, 'an equal pair labelled differ')
})

test('a presence entry must SAY which sides have the identity; a flag left out is never guessed, and evidence lines always carry both flags', () => {
  const entry = (extra: Record<string, unknown>) => ({ key: 'TAX1', ims: null, vendor: null, delta: null, ...extra })
  const build = (e: Record<string, unknown>) => buildReport(input(put(defaultItems('P1'), { id: 'R13', outcome: 'fail', reasons: ['DIFFERENCES'], sources: [...getPackItem('R13').sources], entries: { onlyIms: [e] } } as never)), 1, null)
  assert.throws(() => build(entry({ imsPresent: true })), ReportInvalid, 'vendor flag omitted')
  assert.throws(() => build(entry({ vendorPresent: false })), ReportInvalid, 'ims flag omitted')
  assert.throws(() => build(entry({})), ReportInvalid, 'both omitted')
  assert.doesNotThrow(() => build(entry({ imsPresent: true, vendorPresent: false })))
  // an evidence line for a VALUES item that lacks its flags is refused too (the reader does not default them)
  const built = buildReport(input(put(defaultItems('P1'), { id: 'R1', outcome: 'fail', reasons: ['DIFFERENCES'], entries: { onlyIms: [{ key: 'A', ims: '2', vendor: null, delta: null }] } } as never)), 1, null)
  const text = built.evidenceText.replace(',"imsPresent":true,"vendorPresent":false', '')
  assert.notEqual(text, built.evidenceText)
  assert.throws(() => verifyEvidence(text, { ...built.record, evidence: { ...built.record.evidence, sha256: sha256Hex(text) } }), ReportInvalid)
})
