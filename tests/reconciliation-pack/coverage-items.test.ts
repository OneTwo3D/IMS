import assert from 'node:assert/strict'
import test from 'node:test'

import { getPackItem } from '../../lib/reconciliation-pack/constants.ts'
import { runCoverageItem, type CoverageContext, type SkuListPort } from '../../lib/reconciliation-pack/coverage-items.ts'
import type { ImsRead, ImsReadOptions, ProductRow } from '../../lib/reconciliation-pack/ims-readers.ts'
import { parseSkuExclusionFile, type SkuExclusionFile } from '../../lib/reconciliation-pack/sku-exclusions.ts'
import { NOW } from './helpers.ts'
import { sourceOf } from './qoblex-fixtures.ts'
import { fakeStore, noSleep } from './woo-fixtures.ts'

/**
 * R14 over doubles of the four systems. Mutations are listed in the PR.
 */

const imsProduct = (sku: string, type = 'SIMPLE'): ProductRow => ({ id: `p-${sku}`, sku, type, active: true, lifecycleStatus: 'ACTIVE' })
const wooProduct = (id: number, sku: string) => ({ id, sku, status: 'publish', type: 'simple' })
const qobProduct = (sku: string, type = 'SIMPLE') => ({ sku, type })

type Rig = { ims?: string[] | ProductRow[]; woo?: Array<[number, string]>; qoblex?: Array<{ sku: string; type: string }> | 'fail'; mintsoft?: SkuListPort | string[] | 'absent'; exclusions?: SkuExclusionFile; imsFail?: boolean }
function ctx(rig: Rig, over: Partial<CoverageContext> = {}): CoverageContext & { imsCalls: ImsReadOptions[]; fake: ReturnType<typeof fakeStore> } {
  const imsCalls: ImsReadOptions[] = []
  const imsRows = (rig.ims ?? ['A', 'B']).map((p) => (typeof p === 'string' ? imsProduct(p) : p))
  const woo = fakeStore({ products: (rig.woo ?? [[1, 'A'], [2, 'B']]).map(([id, sku]) => wooProduct(id, sku)) })
  const mintsoft: SkuListPort | undefined = rig.mintsoft === 'absent' ? undefined : typeof rig.mintsoft === 'function' ? rig.mintsoft : (() => { const list = rig.mintsoft ?? ['A', 'B']; return async () => ({ ok: true as const, skus: list }) })()
  return {
    asOf: '2026-10-19', now: () => NOW, vendorReads: true, woo, fake: woo, wooOptions: { sleep: noSleep }, imsCalls,
    ims: async (options): Promise<ImsRead> => {
      imsCalls.push(options)
      if (rig.imsFail) return { ok: false, reason: 'READ_INCOMPLETE' }
      return { ok: true, snapshotId: '1:2:', sections: { products: { ok: true, value: imsRows } } } as ImsRead
    },
    qoblex: sourceOf(rig.qoblex === 'fail' ? { products: 'fail' } : { products: rig.qoblex ?? [qobProduct('A'), qobProduct('B')] }),
    wms: mintsoft, exclusions: rig.exclusions,
    ...over,
  }
}
const keys = (item: { entries?: Partial<Record<string, readonly { key: string }[]>> }, bucket: string) => (item.entries?.[bucket] ?? []).map((e) => e.key).sort()
const exclusionFile = (rows: Array<Record<string, unknown>>) => parseSkuExclusionFile(JSON.stringify({ schemaVersion: 1, exclusions: rows }))
const excl = (sku: string, system: string, over: Record<string, unknown> = {}) => ({ sku, system, acceptedBy: 'owner', acceptedAt: '2026-10-01T00:00:00Z', reason: 'not stocked on purpose', expiresAt: '2026-12-01T00:00:00Z', ...over })

test('R14 passes when every SKU is in all four systems, naming all four sources, comparing (SKU, system) pairs', async () => {
  const c = ctx({})
  const item = await runCoverageItem(c)
  assert.equal(item.outcome, 'pass', JSON.stringify(item.reasons))
  assert.deepEqual(item.proof, { kind: 'compared' })
  assert.deepEqual([...(item.sources ?? [])].sort(), [...getPackItem('R14').sources].sort())
  assert.deepEqual(keys(item, 'bothEqual'), ['A|ims', 'A|mintsoft', 'A|qoblex', 'A|woocommerce', 'B|ims', 'B|mintsoft', 'B|qoblex', 'B|woocommerce'])
  assert.equal(c.imsCalls.length, 1)
})

// [mutation: the system dropped from the key / only the union checked / a total compared]
test('R14 lists the SKU per MISSING system; IDENTITY SWAP (equal counts, one SKU different) is two findings', async () => {
  const item = await runCoverageItem(ctx({ woo: [[1, 'A']], mintsoft: ['A', 'B'], ims: ['A', 'B', 'C'], qoblex: [qobProduct('A'), qobProduct('B'), qobProduct('C')] }))
  assert.equal(item.outcome, 'fail')
  assert.deepEqual(item.reasons, ['DIFFERENCES'])
  assert.deepEqual(keys(item, 'onlyIms'), ['B|woocommerce', 'C|mintsoft', 'C|woocommerce'])
  assert.deepEqual(keys(item, 'onlyVendor'), [])
  const swapped = await runCoverageItem(ctx({ woo: [[1, 'A'], [2, 'X']] }))
  assert.equal(swapped.outcome, 'fail')
  assert.ok(keys(swapped, 'onlyIms').includes('B|woocommerce') && keys(swapped, 'onlyIms').includes('X|ims'), JSON.stringify(keys(swapped, 'onlyIms')))
  const caseOnly = await runCoverageItem(ctx({ woo: [[1, 'a'], [2, 'B']] }))
  assert.equal(caseOnly.outcome, 'fail', 'a SKU is compared exactly as each system holds it')
  assert.deepEqual(keys(caseOnly, 'onlyIms'), ['A|woocommerce', 'a|ims', 'a|mintsoft', 'a|qoblex'])
})

// [mutation: the exclusion not applied / applied to every system / applied by SKU alone / expiry not checked / acceptedAt in the future allowed]
test('R14 exclusions: valid covers exactly one SKU in one system; wrong system, other SKU, expired, not yet accepted, over 90 days cover nothing', async () => {
  const base: Rig = { woo: [[1, 'A']], mintsoft: ['A', 'B'] }
  const withFile = (rows: Array<Record<string, unknown>>) => runCoverageItem(ctx({ ...base, exclusions: exclusionFile(rows) }))
  const valid = await withFile([excl('B', 'woocommerce')])
  assert.equal(valid.outcome, 'pass', JSON.stringify([valid.reasons, keys(valid, 'onlyIms')]))
  assert.deepEqual(keys(valid, 'excluded'), ['B|woocommerce'])
  for (const [label, rows] of [
    ['wrong system', [excl('B', 'mintsoft')]],
    ['other SKU', [excl('A', 'woocommerce')]],
    ['expired', [excl('B', 'woocommerce', { expiresAt: '2026-10-20T11:59:59Z' })]],
    ['expires exactly now', [excl('B', 'woocommerce', { expiresAt: '2026-10-20T12:00:00Z' })]],
    ['not yet accepted', [excl('B', 'woocommerce', { acceptedAt: '2026-10-20T12:00:01Z', expiresAt: '2026-11-20T00:00:00Z' })]],
    ['over 90 days', [excl('B', 'woocommerce', { acceptedAt: '2026-10-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' })]],
  ] as const) {
    const item = await withFile([...rows])
    assert.equal(item.outcome, 'fail', label)
    assert.deepEqual(keys(item, 'onlyIms'), ['B|woocommerce'], label)
    assert.ok(!keys(item, 'excluded').includes('B|woocommerce'), label)
  }
  const exactly = await withFile([excl('B', 'woocommerce', { acceptedAt: '2026-10-20T12:00:00Z', expiresAt: '2026-10-20T12:00:01Z' })])
  assert.equal(exactly.outcome, 'pass', 'in force from the instant it is accepted')
  const none = await runCoverageItem(ctx({ ...base }))
  assert.equal(none.outcome, 'fail')
  // an exclusion for a pair the SKU is NOT missing from is simply listed as excluded, and excludes nothing else
  const present = await withFile([excl('A', 'qoblex'), excl('B', 'woocommerce')])
  assert.equal(present.outcome, 'pass')
  assert.deepEqual(keys(present, 'excluded'), ['A|qoblex', 'B|woocommerce'])
})

// [mutation: a rejected file's entries still used]
test('R14: an untrusted, malformed or ambiguous exclusion file accepts NOTHING (absent too)', async () => {
  const base: Rig = { woo: [[1, 'A']], mintsoft: ['A', 'B'] }
  const good = JSON.stringify({ schemaVersion: 1, exclusions: [excl('B', 'woocommerce')] })
  assert.equal(parseSkuExclusionFile(good).status, 'ok')
  const bad = (text: string | null) => parseSkuExclusionFile(text)
  const rejected = [
    '{not json', '[]', JSON.stringify({ schemaVersion: 2, exclusions: [] }), JSON.stringify({ schemaVersion: 1, exclusions: [], extra: 1 }),
    JSON.stringify({ schemaVersion: 1, exclusions: [{ ...excl('B', 'woocommerce'), extra: 1 }] }),
    JSON.stringify({ schemaVersion: 1, exclusions: [excl('B', 'woocommerce'), excl('B', 'woocommerce', { reason: 'a different long reason' })] }),
    JSON.stringify({ schemaVersion: 1, exclusions: 'all' }),
  ]
  for (const text of rejected) {
    const file = bad(text)
    assert.equal(file.status, 'rejected', text)
    const item = await runCoverageItem(ctx({ ...base, exclusions: file }))
    assert.equal(item.outcome, 'fail', text)
  }
  assert.equal((await runCoverageItem(ctx({ ...base, exclusions: bad(null) }))).outcome, 'fail')
  // an entry that is incomplete accepts nothing, and the others stand
  const mixed = bad(JSON.stringify({ schemaVersion: 1, exclusions: [excl('B', 'woocommerce'), excl('Z', 'qoblex', { reason: 'short' }), excl('Y', 'nowhere')] }))
  assert.equal(mixed.status === 'ok' && mixed.entries.length, 1)
  assert.equal(mixed.status === 'ok' && mixed.incomplete, 2)
  assert.equal((await runCoverageItem(ctx({ ...base, exclusions: mixed }))).outcome, 'pass')
})

// [mutation: a missing Mintsoft leg treated as an empty list / as a pass]
test('R14 without a Mintsoft source: the other three are compared, a finding there still fails, and nothing ever passes', async () => {
  const clean = await runCoverageItem(ctx({ mintsoft: 'absent' }))
  assert.deepEqual([clean.outcome, clean.reasons], ['inconclusive', ['LEG_UNAVAILABLE']])
  assert.equal(clean.proof ?? null, null)
  assert.ok(!(clean.sources ?? []).includes('mintsoft-api'))
  assert.deepEqual(keys(clean, 'bothEqual'), ['A|ims', 'A|qoblex', 'A|woocommerce', 'B|ims', 'B|qoblex', 'B|woocommerce'])
  const finding = await runCoverageItem(ctx({ mintsoft: 'absent', woo: [[1, 'A']] }))
  assert.deepEqual([finding.outcome, finding.reasons], ['fail', ['DIFFERENCES', 'LEG_UNAVAILABLE']])
  assert.deepEqual(keys(finding, 'onlyIms'), ['B|woocommerce'])
  // present but failing: the same, with its own closed reason
  const failing = await runCoverageItem(ctx({ mintsoft: async () => ({ ok: false, reason: 'VENDOR_READ_UNSTABLE' }) }))
  assert.deepEqual([failing.outcome, failing.reasons], ['inconclusive', ['LEG_UNAVAILABLE', 'VENDOR_READ_UNSTABLE']])
  const throwing = await runCoverageItem(ctx({ mintsoft: async () => { throw new Error('secret-token-123') } }))
  assert.deepEqual([throwing.outcome, throwing.reasons], ['inconclusive', ['LEG_UNAVAILABLE', 'SOURCE_UNREADABLE']])
  assert.ok(!JSON.stringify(throwing).includes('secret-token'))
  // a port that says ok with a list that is not a list of plain SKUs lied: the whole item is unreadable
  const lying = await runCoverageItem(ctx({ mintsoft: async () => ({ ok: true, skus: ['A', 'A'] }) }))
  assert.deepEqual([lying.outcome, lying.reasons], ['inconclusive', ['DUPLICATE_KEY']])
  const lying2 = await runCoverageItem(ctx({ mintsoft: (async () => ({ ok: true, skus: ['A', ''] })) as SkuListPort }))
  assert.deepEqual([lying2.outcome, lying2.reasons], ['inconclusive', ['BAD_KEY']])
})

test('R14 a Mintsoft list that is present and complete is a real leg: a SKU only Mintsoft has is a finding for the other three', async () => {
  const item = await runCoverageItem(ctx({ mintsoft: ['A', 'B', 'M'] }))
  assert.equal(item.outcome, 'fail')
  assert.deepEqual(keys(item, 'onlyIms'), ['M|ims', 'M|qoblex', 'M|woocommerce'])
})

// [mutation: variations not set aside / set aside from every system]
test('R14 sets aside, listed and never a finding, the storefront side of a variation and a storefront product with no SKU', async () => {
  const rig: Rig = { ims: [imsProduct('A'), imsProduct('B'), imsProduct('V-1', 'VARIANT')], qoblex: [qobProduct('A'), qobProduct('B'), qobProduct('V-1', 'VARIANT')], mintsoft: ['A', 'B', 'V-1'], woo: [[1, 'A'], [2, 'B'], [3, '']] }
  const item = await runCoverageItem(ctx(rig))
  assert.equal(item.outcome, 'pass', JSON.stringify([item.reasons, keys(item, 'onlyIms')]))
  assert.deepEqual(keys(item, 'outOfPopulation'), ['3|woocommerce', 'V-1|woocommerce'])
  // the variation is still required in the other three systems
  const missing = await runCoverageItem(ctx({ ...rig, mintsoft: ['A', 'B'] }))
  assert.deepEqual(keys(missing, 'onlyIms'), ['V-1|mintsoft'])
  // a variation in Qoblex only (typed VARIANT there) is also set aside in the storefront
  const qobOnly = await runCoverageItem(ctx({ ims: [imsProduct('A'), imsProduct('B'), imsProduct('V-1')], qoblex: rig.qoblex, mintsoft: rig.mintsoft, woo: [[1, 'A'], [2, 'B']] }))
  assert.equal(qobOnly.outcome, 'pass')
})

test('R14 refuses a repeated SKU inside one system, a SKU that is not plain, and every unreadable leg, as inconclusive', async () => {
  const dupWoo = await runCoverageItem(ctx({ woo: [[1, 'A'], [2, 'A'], [3, 'B']] }))
  assert.deepEqual([dupWoo.outcome, dupWoo.reasons], ['inconclusive', ['DUPLICATE_KEY']])
  const control = await runCoverageItem(ctx({ woo: [[1, 'A'], [2, 'B\u0007']] }))
  assert.equal(control.outcome, 'inconclusive')
  const qoblexDown = await runCoverageItem(ctx({ qoblex: 'fail' }))
  assert.deepEqual([qoblexDown.outcome, qoblexDown.reasons], ['inconclusive', ['SOURCE_UNREADABLE']])
  const stale = await runCoverageItem(ctx({}, { qoblex: sourceOf({ ok: false, reason: 'QOBLEX_EXPORT_STALE' }) }))
  assert.deepEqual([stale.outcome, stale.reasons], ['inconclusive', ['QOBLEX_EXPORT_STALE']])
  const imsDown = await runCoverageItem(ctx({ imsFail: true }))
  assert.deepEqual([imsDown.outcome, imsDown.reasons], ['inconclusive', ['READ_INCOMPLETE']])
  const wooDown = await runCoverageItem(ctx({}, { woo: { get: async () => ({ ok: false }) } }))
  assert.deepEqual([wooDown.outcome, wooDown.reasons], ['inconclusive', ['SOURCE_UNREADABLE']])
})

// [mutation: the opt-in checks reordered / removed]
test('R14 with no opt-in reads nothing (VENDOR_READS_OFF), and with no export named reads no file (QOBLEX_EXPORT_OFF) and makes no request', async () => {
  const off = ctx({})
  const a = await runCoverageItem({ ...off, vendorReads: false })
  assert.deepEqual([a.outcome, a.reasons, a.sources ?? []], ['inconclusive', ['VENDOR_READS_OFF'], []])
  assert.equal(off.fake.calls.length, 0)
  assert.equal(off.imsCalls.length, 0)
  const noExport = ctx({})
  const b = await runCoverageItem({ ...noExport, qoblex: undefined })
  assert.deepEqual([b.outcome, b.reasons, b.sources ?? []], ['inconclusive', ['QOBLEX_EXPORT_OFF'], []])
  assert.equal(noExport.fake.calls.length, 0)
  assert.equal(noExport.imsCalls.length, 0)
})

test('R14 uses the storefront walk only (GET of products), and returns no storefront row field beyond the SKU', async () => {
  const c = ctx({})
  const item = await runCoverageItem(c)
  assert.ok(c.fake.calls.length >= 2 && c.fake.calls.every((call) => call.collection === 'products'))
  assert.ok(!JSON.stringify(item).includes('publish'))
})
