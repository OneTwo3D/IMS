import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { assessPackItem } from '../../lib/ops/readiness-gate-pack.ts'
import { PACK_ITEM_IDS_BY_SCHEMA, PACK_SCHEMA_VERSION } from '../../lib/reconciliation-pack/constants.ts'
import { publishSyntheticRun } from '../../lib/reconciliation-pack/harness.ts'
import { ReportInvalid, deriveExitCode, parseReport, sha256Hex, summarise, verifyEvidence, type ReportRecord } from '../../lib/reconciliation-pack/report.ts'
import { carriedStateFromChain } from '../../lib/reconciliation-pack/settling.ts'
import { itemSeries, readPackChain } from '../../lib/reconciliation-pack/trend.ts'
import { allBrackets, at, cleanup, scratchDir } from './helpers.ts'

// Historical reports: a report published before R16 existed (schemaVersion 1, exactly R1 to R15) is read under the rules that applied when it was published.
// The report's own schemaVersion is the catalogue it names; nothing is inferred from its length alone.

const bases: string[] = []
after(() => cleanup(bases))
const fresh = () => path.join(scratchDir(bases), 'reports')

function publish(reportDir: string, minutes: number) {
  const result = publishSyntheticRun({ reportDir, phase: 'P1', asOf: '2026-10-19', now: at(minutes), streams: allBrackets() })
  assert.equal(result.ok, true, JSON.stringify(result))
  return result as Extract<typeof result, { ok: true }>
}
type Json = Record<string, unknown>
/** Rewrite a published report's JSON (the commit record), recomputing the derived values the reader checks. */
function rewrite(file: string, edit: (value: Json) => void) {
  const value = JSON.parse(readFileSync(file, 'utf8')) as Json
  edit(value)
  const items = value.items as Array<{ outcome: string; applicability: string }>
  value.summary = summarise(items as never)
  value.exitCode = deriveExitCode(items as never)
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}
/** Turn a freshly published report into what the build before R16 published: schema 1, R1 to R15. */
const toPreR16 = (file: string) => rewrite(file, (v) => { v.schemaVersion = 1; v.items = (v.items as Array<{ id: string }>).filter((item) => item.id !== 'R16') })
const chainOf = (dir: string) => readPackChain(dir)
const refused = (dir: string) => { const chain = chainOf(dir); assert.equal(chain.ok, false); return chain }

// [mutation: a schema 1 report refused / the catalogue taken from the item count / schema 1 accepting R16]
test('a chain of a 15-item pre-R16 report followed by a new R16 report reads and appends', () => {
  const dir = fresh()
  const old = publish(dir, 0)
  toPreR16(old.json)
  const chain = chainOf(dir)
  assert.equal(chain.ok, true, JSON.stringify(chain))
  const head = (chain as Extract<typeof chain, { ok: true }>).head!
  assert.deepEqual([head.record.schemaVersion, head.record.items.map((i) => i.id)], [1, [...PACK_ITEM_IDS_BY_SCHEMA[1]]])
  const next = publish(dir, 1)
  assert.equal(next.record.schemaVersion, PACK_SCHEMA_VERSION)
  assert.equal(next.record.items.length, 16)
  assert.equal(next.record.items[15]!.id, 'R16')
  assert.equal(next.record.sequence, 2)
  assert.equal(next.record.previousReportSha256, sha256Hex(readFileSync(old.json)))
  const after2 = chainOf(dir)
  assert.equal(after2.ok, true)
  const reports = (after2 as Extract<typeof after2, { ok: true }>).reports
  assert.deepEqual(reports.map((r) => [r.sequence, r.record.schemaVersion, r.record.items.length]), [[1, 1, 15], [2, 2, 16]])
  // The series of an item the old report never carried starts where the item does.
  assert.deepEqual(itemSeries(reports, 'R16').map((p) => p.sequence), [2])
  assert.deepEqual(itemSeries(reports, 'R3').map((p) => p.sequence), [1, 2])
})

// [mutation: schemaVersion 2 accepted with fifteen items]
test('a 15-item report that claims the new catalogue (schemaVersion 2) is refused', () => {
  const dir = fresh()
  const only = publish(dir, 0)
  rewrite(only.json, (v) => { v.items = (v.items as Array<{ id: string }>).filter((item) => item.id !== 'R16') })
  assert.equal(refused(dir).ok, false)
  assert.throws(() => parseReport(readFileSync(only.json, 'utf8')), ReportInvalid)
})

// [mutation: schemaVersion 1 accepted with sixteen items]
test('a 16-item report that claims the old catalogue (schemaVersion 1) is refused', () => {
  const dir = fresh()
  const only = publish(dir, 0)
  rewrite(only.json, (v) => { v.schemaVersion = 1 })
  assert.equal(refused(dir).ok, false)
})

// [mutation: a short report accepted under schema 1]
test('a 14-item report is refused under either schemaVersion', () => {
  for (const version of [1, 2]) {
    const dir = fresh()
    const only = publish(dir, 0)
    rewrite(only.json, (v) => { v.schemaVersion = version; v.items = (v.items as Array<{ id: string }>).filter((item) => item.id !== 'R16' && item.id !== 'R15') })
    assert.equal(refused(dir).ok, false, `schemaVersion ${version}`)
  }
})

// [mutation: item order or identity not checked under schema 2]
test('a 16-item report missing R16 (a repeated or out-of-place id in its place) is refused', () => {
  for (const edit of [
    (items: Array<Json>) => { items[15] = { ...items[14]! } },
    (items: Array<Json>) => { items[15] = { ...items[0]! } },
    (items: Array<Json>) => { [items[14], items[15]] = [items[15]!, items[14]!] },
  ]) {
    const dir = fresh()
    const only = publish(dir, 0)
    rewrite(only.json, (v) => { edit(v.items as Array<Json>) })
    assert.equal(refused(dir).ok, false)
  }
})

// [mutation: the schema 1 list written with R16 / an unknown schemaVersion accepted]
test('a 15-item report must be exactly R1 to R15 in order; any other schemaVersion is refused', () => {
  const dir = fresh()
  const only = publish(dir, 0)
  toPreR16(only.json)
  rewrite(only.json, (v) => { const items = v.items as Array<Json>; [items[0], items[1]] = [items[1]!, items[0]!] })
  assert.equal(refused(dir).ok, false)
  for (const version of [0, 3, '1', null]) {
    const other = fresh()
    const one = publish(other, 0)
    toPreR16(one.json)
    rewrite(one.json, (v) => { v.schemaVersion = version })
    assert.equal(refused(other).ok, false, String(version))
  }
})

// [mutation: evidence naming an item the report does not carry accepted]
test('evidence under a schema 1 report may not name R16', () => {
  const dir = fresh()
  const only = publish(dir, 0)
  toPreR16(only.json)
  const record = parseReport(readFileSync(only.json, 'utf8'))
  const line = JSON.stringify({ item: 'R16', bucket: 'onlyVendor', key: 'xero-rate|payment|x', ims: null, vendor: '0.8', delta: null, imsCurrency: null, vendorCurrency: null, imsPresent: false, vendorPresent: true })
  const text = `${line}\n`
  const forged: ReportRecord = { ...record, evidence: { ...record.evidence, sha256: sha256Hex(text), lines: 1 } }
  assert.throws(() => verifyEvidence(text, forged), /does not carry/)
})

// [mutation: the gate treats an old report as malformed for the added item / believes it for R1 to R15 less]
test('the readiness gate reads a pre-R16 report for R1 to R15 as before and R16 as not available', () => {
  const dir = fresh()
  const only = publish(dir, 0)
  toPreR16(only.json)
  const record = parseReport(readFileSync(only.json, 'utf8'))
  const context = { phase: 'P1' as const, now: at(1), systemIdentifier: record.systemIdentifier }
  const r16 = assessPackItem({ record }, 'R16', context)
  assert.equal(r16.kind, 'not-available')
  assert.match(r16.kind === 'not-available' ? r16.reason : '', /added after/)
  assert.equal(assessPackItem({ record }, 'R3', context).kind, 'not-available', 'R3 is read from the old report as always (the synthetic run has no runner)')
})

// [mutation: carried state read from a report that does not list the item as usable]
test('settling reads the carried state of an item from a pre-R16 head, and never invents one for R16', () => {
  const dir = fresh()
  const only = publish(dir, 0)
  toPreR16(only.json)
  const chain = chainOf(dir)
  assert.equal(chain.ok, true)
  const where = { phase: 'P1' as const, systemIdentifier: '7000000000000000001' }
  assert.equal(carriedStateFromChain(chain, 'R12', where).usable, false)
  assert.equal(carriedStateFromChain(chain, 'R16', where).usable, false)
  assert.equal(readdirSync(dir).filter((n) => !n.startsWith('.')).length, 1)
})
