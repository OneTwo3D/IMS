import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test, { after, before } from 'node:test'
import { config } from 'dotenv'

/**
 * THE EU IOSS / VOEC SEED APPLY, COMMITTED, AGAINST A REAL DATABASE (the plan, the preflight and the command line are unit-tested in tests/tax/eu-vat-preflight.test.ts and
 * tests/scripts/eu-vat-cli.test.ts). It seeds its own tagged IMS rates and WooCommerce mappings for three declared rates (Woo 112 UK VAT, 220 DE VAT, 239 NO VAT) and removes only those by id. The
 * mappings' external ids are the declared ones, so the run FAILS LOUDLY at the precondition, before any write, when the database already holds a mapping with one of them.
 *
 * What it pins: a dry run writes nothing; a wrong or missing digest writes nothing; the right digest sets schemePostingTaxType and reportingCategory on the two scheme rates and nothing else (the UK
 * rate, every other column and the mappings are untouched); a second apply has nothing to do; a rate edited after the dry run changes the digest and the apply refuses; two concurrent applies with the
 * same digest write once and neither deadlocks; the preflight read changes nothing.
 *
 * Mutations (seen red, reverted): the digest comparison removed -> the stale-digest arm writes; the compare-and-set where clause dropped from the updateMany -> the concurrent arm double-writes
 * (no refusal, count 2); the plan widened to write `accountingTaxType` -> the "nothing else" arm.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1 (npm run test:concurrency)'
const run = randomBytes(4).toString('hex')
const TAG = `ZQEU${run} `
const WOO = { uk: 112, de: 220, no: 239 } as const

async function loadDeps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  const [{ db }, pre, seedLib] = await Promise.all([import('../../lib/db/index.ts'), import('../../lib/tax/eu-vat-preflight.ts'), import('../../lib/tax/eu-vat-seed.ts')])
  return { db, pre, seed: seedLib.loadEuVatSeed() }
}
type Deps = Awaited<ReturnType<typeof loadDeps>>

const ids: { rates: string[]; mappings: string[] } = { rates: [], mappings: [] }
let d: Deps
const asClient = (db: Deps['db']) => db as unknown as Parameters<Deps['pre']['applyEuVatSeed']>[0]

async function snapshotRates(): Promise<Record<string, unknown>[]> {
  return d.db.taxRate.findMany({ where: { id: { in: ids.rates } }, orderBy: { name: 'asc' } }) as unknown as Record<string, unknown>[]
}

before(async () => {
  if (!RUN) return
  d = await loadDeps()
  const clash = await d.db.shoppingTaxRateMapping.count({ where: { connector: 'woocommerce', externalTaxRateId: { in: Object.values(WOO).map(String) } } })
  assert.equal(clash, 0, 'the database already holds a mapping for a declared WooCommerce rate id: refusing before any write')
  const make = async (key: keyof typeof WOO, over: { name: string; rate: string; country: string; code: string }) => {
    const declared = d.seed.rates.find((r) => r.wooId === WOO[key])!
    const rate = await d.db.taxRate.create({ data: { name: `${TAG}${over.name}`, rate: over.rate, usedFor: 'SALES', countryCode: over.country, accountingTaxType: over.code, active: true, taxCategory: 'STANDARD' } })
    ids.rates.push(rate.id)
    const mapping = await d.db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(declared.wooId), externalName: declared.wooName, externalCountry: declared.country, externalRatePct: declared.ratePercent, externalClass: declared.wooClass, taxRateId: rate.id } })
    ids.mappings.push(mapping.id)
  }
  await make('uk', { name: 'UK VAT', rate: '0.2000', country: 'GB', code: 'OUTPUT2' })
  await make('de', { name: 'DE VAT', rate: '0.1900', country: 'DE', code: `${TAG}TAXDE`.trim() })
  await make('no', { name: 'NO VAT', rate: '0.2500', country: 'NO', code: `${TAG}TAXNO`.trim() })
})

after(async () => {
  if (!RUN || !d) return
  await d.db.shoppingTaxRateMapping.deleteMany({ where: { id: { in: ids.mappings } } })
  await d.db.taxRate.deleteMany({ where: { id: { in: ids.rates } } })
  await d.db.$disconnect()
})

const plan = async () => d.pre.planEuVatSeedApply({ seed: d.seed, ...(await d.pre.readEuVatImsSide(d.db as never)) })

test('a dry run writes nothing; the plan names exactly the two scheme rates', { skip }, async () => {
  const before = await snapshotRates()
  const p = await plan()
  assert.deepEqual(p.changes.map((c) => c.wooId).sort(), [220, 239])
  assert.equal(p.unchanged, 1, 'the UK rate has nothing to set')
  assert.equal(p.skipped.length, 62)
  assert.deepEqual(await snapshotRates(), before)
})

test('the preflight read changes nothing and, with no stored Xero list, refuses to judge', { skip }, async () => {
  const before = await snapshotRates()
  const input = await d.pre.readEuVatPreflightInput(d.db as never, d.seed, new Date(), null)
  const result = d.pre.evaluateEuVatPreflight(input)
  assert.equal(result.status, 'refused')
  assert.deepEqual(await snapshotRates(), before)
})

test('a missing or wrong digest writes nothing', { skip }, async () => {
  const before = await snapshotRates()
  const none = await d.pre.applyEuVatSeed(asClient(d.db), d.seed, 'not-a-digest')
  assert.equal(none.applied, false)
  assert.equal(none.applied === false && none.refusal?.code, 'CONFIRM_REQUIRED')
  const wrong = await d.pre.applyEuVatSeed(asClient(d.db), d.seed, 'c'.repeat(64))
  assert.equal(wrong.applied === false && wrong.refusal?.code, 'DIGEST_MISMATCH')
  assert.deepEqual(await snapshotRates(), before)
})

test('the stale digest of a plan whose rate was edited afterwards refuses and writes nothing', { skip }, async () => {
  const stale = (await plan()).digest
  const de = ids.rates[1]!
  await d.db.taxRate.update({ where: { id: de }, data: { reportingCategory: 'OSS' } })
  try {
    const before = await snapshotRates()
    const result = await d.pre.applyEuVatSeed(asClient(d.db), d.seed, stale)
    assert.equal(result.applied === false && result.refusal?.code, 'DIGEST_MISMATCH')
    assert.deepEqual(await snapshotRates(), before)
  } finally {
    await d.db.taxRate.update({ where: { id: de }, data: { reportingCategory: null } })
  }
})

test('the right digest sets the two columns on the two scheme rates and nothing else; a second apply has nothing to do', { skip }, async () => {
  const before = await snapshotRates()
  const p = await plan()
  const result = await d.pre.applyEuVatSeed(asClient(d.db), d.seed, p.digest)
  assert.equal(result.applied, true)
  assert.equal(result.applied && result.written, 2)
  const after = await snapshotRates()
  for (const row of after) {
    const old = before.find((b) => b.id === row.id)!
    const changed = Object.keys(row).filter((k) => JSON.stringify(row[k]) !== JSON.stringify(old[k])).sort()
    if (String(row.name).endsWith('UK VAT')) assert.deepEqual(changed, [], 'the UK rate is untouched')
    else assert.deepEqual(changed, ['reportingCategory', 'schemePostingTaxType', 'updatedAt'], `only the two declared columns (and the row's updatedAt) changed on ${String(row.name)}`)
  }
  const de = after.find((r) => String(r.name).endsWith('DE VAT'))!
  const no = after.find((r) => String(r.name).endsWith('NO VAT'))!
  assert.deepEqual([de.schemePostingTaxType, de.reportingCategory], ['TAX131', 'IOSS'])
  assert.deepEqual([no.schemePostingTaxType, no.reportingCategory], ['TAX122', 'VOEC'])
  assert.equal(await d.db.shoppingTaxRateMapping.count({ where: { id: { in: ids.mappings } } }), 3, 'no mapping touched')
  const again = await d.pre.applyEuVatSeed(asClient(d.db), d.seed, (await plan()).digest)
  assert.equal(again.applied === false && again.refusal?.code, 'NOTHING_TO_APPLY')
})

test('two concurrent applies of one plan write once, refuse the other cleanly and never deadlock', { skip }, async () => {
  for (const id of ids.rates) await d.db.taxRate.update({ where: { id }, data: { schemePostingTaxType: null, reportingCategory: null } })
  const { digest } = await plan()
  const results = await Promise.all([d.pre.applyEuVatSeed(asClient(d.db), d.seed, digest), d.pre.applyEuVatSeed(asClient(d.db), d.seed, digest)])
  assert.equal(results.filter((r) => r.applied).length, 1, 'exactly one apply wrote')
  const refused = results.find((r) => !r.applied)
  assert.ok(refused && !refused.applied && ['DIGEST_MISMATCH', 'NOTHING_TO_APPLY', 'RATE_CHANGED_DURING_APPLY'].includes(refused.refusal?.code ?? ''))
  const after = await snapshotRates()
  assert.deepEqual(after.filter((r) => r.schemePostingTaxType !== null).map((r) => r.schemePostingTaxType).sort(), ['TAX122', 'TAX131'])
})

test('a rate a re-key replaced (so inactive) is skipped by the plan and never written through', { skip }, async () => {
  const de = ids.rates[1]!
  await d.db.taxRate.update({ where: { id: de }, data: { schemePostingTaxType: null, reportingCategory: null } })
  await d.db.taxRate.update({ where: { id: de }, data: { active: false, replacedById: 'replacement' } })
  try {
    const p = await plan()
    assert.equal(p.changes.some((c) => c.taxRateId === de), false, 'an inactive (replaced) rate is skipped, not written')
    assert.equal(p.skipped.find((s) => s.wooId === 220)?.reason, 'IMS_RATE_INACTIVE')
  } finally {
    await d.db.taxRate.update({ where: { id: de }, data: { active: true, replacedById: null } })
  }
})
