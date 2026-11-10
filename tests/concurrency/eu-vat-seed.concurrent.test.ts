import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test, { after, before } from 'node:test'
import { config } from 'dotenv'

/**
 * THE EU IOSS / VOEC SEED APPLY, COMMITTED, AGAINST A REAL DATABASE (the plan, the preflight and the command line are unit-tested in tests/tax/eu-vat-preflight.test.ts and
 * tests/scripts/eu-vat-cli.test.ts). It seeds its own IMS rates, stamped WooCommerce mappings and a stored Xero list (tenant tagged per run) for three declared rates (Woo 112 UK VAT, 220 DE VAT, 239 NO VAT) and removes only those by id; the Xero store, like the mappings, must be empty of anything else (precondition, before any write). The
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
const WOO = { uk: 112, de: 220, no: 239, z1: 150, z2: 151 } as const
const TENANT = `tenant-eu-${run}`
const STORE = 'https://shop.example'
const GENERATION = `gen-${run}`
const CTX = { connection: { tenantId: TENANT, connectionGeneration: GENERATION }, storeIdentity: STORE }

async function loadDeps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  const [{ db }, pre, seedLib, listLib, drift] = await Promise.all([import('../../lib/db/index.ts'), import('../../lib/tax/eu-vat-preflight.ts'), import('../../lib/tax/eu-vat-seed.ts'), import('../../lib/connectors/xero/tax-rate-list.ts'), import('../../lib/connectors/xero/tax-rate-drift-sweeper.ts')])
  return { db, pre, seed: seedLib.loadEuVatSeed(), listLib, drift }
}
type Deps = Awaited<ReturnType<typeof loadDeps>>

const ids: { rates: string[]; mappings: string[] } = { rates: [], mappings: [] }
const xeroRow = (taxType: string, name: string, percent: string) => ({ taxType, name, status: 'ACTIVE' as const, reportTaxType: 'OUTPUT', effectiveRate: `${percent}.000000`, displayTaxRate: `${percent}.000000`, components: [{ name, rate: `${percent}.000000`, compound: false, nonRecoverable: false }], canApply: { assets: false, equity: false, expenses: false, liabilities: false, revenue: true } })
let d: Deps
const asClient = (db: Deps['db']) => db as unknown as Parameters<Deps['pre']['applyEuVatSeed']>[0]
const apply = (digest: string, client: Parameters<Deps['pre']['applyEuVatSeed']>[0] = asClient(d.db)) => d.pre.applyEuVatSeed(client, d.seed, digest, CTX)

async function snapshotRates(): Promise<Record<string, unknown>[]> {
  return d.db.taxRate.findMany({ where: { id: { in: ids.rates } }, orderBy: { name: 'asc' } }) as unknown as Record<string, unknown>[]
}

before(async () => {
  if (!RUN) return
  d = await loadDeps()
  const foreign = { xeroTokens: await d.db.accountingToken.count({ where: { connector: 'xero' } }), xeroRates: await d.db.xeroTaxRate.count(), xeroLists: await d.db.xeroTaxRateList.count(), stamp: await d.db.setting.count({ where: { key: d.drift.TAX_RATE_DRIFT_LAST_CHECKED_SETTING } }) }
  assert.deepEqual(foreign, { xeroTokens: 0, xeroRates: 0, xeroLists: 0, stamp: 0 }, 'PRECONDITION: this scratch database holds a Xero tax-rate store this test did not create; it will not delete it. Use a database with an empty Xero store.')
  const clash = await d.db.shoppingTaxRateMapping.count({ where: { connector: 'woocommerce', externalTaxRateId: { in: Object.values(WOO).map(String) } } })
  assert.equal(clash, 0, 'the database already holds a mapping for a declared WooCommerce rate id: refusing before any write')
  const make = async (key: keyof typeof WOO, over: { name: string; rate: string; country: string; code: string }) => {
    const declared = d.seed.rates.find((r) => r.wooId === WOO[key])!
    const rate = await d.db.taxRate.create({ data: { name: over.name, rate: over.rate, usedFor: 'SALES', countryCode: over.country, accountingTaxType: over.code, active: true, taxCategory: 'STANDARD' } })
    ids.rates.push(rate.id)
    const mapping = await d.db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(declared.wooId), externalName: declared.wooName, externalCountry: declared.country, externalRatePct: declared.ratePercent, externalClass: declared.wooClass, taxRateId: rate.id, storeIdentity: STORE } })
    ids.mappings.push(mapping.id)
  }
  await d.db.accountingToken.create({ data: { connector: 'xero', accessToken: 'a', expiresAt: new Date(Date.now() + 3_600_000), tenantId: TENANT, tenantName: `Org ${TENANT}`, connectionGeneration: GENERATION } })
  const rows = [xeroRow('ZERORATEDOUTPUT', 'Zero Rated Income', '0'), xeroRow('OUTPUT2', 'GB VAT (Income)', '20'), xeroRow('ZQTAXDE', 'DE VAT', '19'), xeroRow('TAX131', 'DE IOSS VAT', '0'), xeroRow('TAX124', 'NO VAT', '25'), xeroRow('TAX122', 'NO VOEC VAT', '0')]
  const fetchedAt = new Date(Date.now() - 300_000)
  await d.db.xeroTaxRate.createMany({ data: rows.map((r) => ({ connector: 'xero', tenantId: TENANT, fetchedAt, taxType: r.taxType, name: r.name, status: r.status, reportTaxType: r.reportTaxType, effectiveRate: r.effectiveRate, displayTaxRate: r.displayTaxRate, components: r.components, canApplyToRevenue: true, canApplyToAssets: false, canApplyToEquity: false, canApplyToExpenses: false, canApplyToLiabilities: false })) })
  await d.db.xeroTaxRateList.create({ data: { connector: 'xero', tenantId: TENANT, fetchedAt, rowCount: rows.length, digest: d.listLib.digestTaxRateList(TENANT, rows as never) } })
  await d.db.setting.upsert({ where: { key: d.drift.TAX_RATE_DRIFT_LAST_CHECKED_SETTING }, create: { key: d.drift.TAX_RATE_DRIFT_LAST_CHECKED_SETTING, value: fetchedAt.toISOString() }, update: { value: fetchedAt.toISOString() } })
  await make('uk', { name: 'UK VAT', rate: '0.2000', country: 'GB', code: 'OUTPUT2' })
  await make('de', { name: 'DE VAT', rate: '0.1900', country: 'DE', code: 'ZQTAXDE' })
  await make('no', { name: 'NO VAT', rate: '0.2500', country: 'NO', code: 'TAX124' })
  // Woo 150 (GB) and 151 (AT) are declared to be the one zero-rated Xero rate: ONE IMS rate, two mappings.
  const zeroRate = await d.db.taxRate.create({ data: { name: 'Zero Rated Income', rate: '0.0000', usedFor: 'SALES', countryCode: null, accountingTaxType: 'ZERORATEDOUTPUT', active: true, taxCategory: 'ZERO' } })
  ids.rates.push(zeroRate.id)
  for (const key of ['z1', 'z2'] as const) {
    const declared = d.seed.rates.find((r) => r.wooId === WOO[key])!
    const mapping = await d.db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(declared.wooId), externalName: declared.wooName, externalCountry: declared.country, externalRatePct: declared.ratePercent, externalClass: declared.wooClass, taxRateId: zeroRate.id, storeIdentity: STORE } })
    ids.mappings.push(mapping.id)
  }
})

after(async () => {
  if (!RUN || !d) return
  await d.db.shoppingTaxRateMapping.deleteMany({ where: { id: { in: ids.mappings } } })
  await d.db.taxRate.deleteMany({ where: { id: { in: ids.rates } } })
  await d.db.setting.deleteMany({ where: { key: d.drift.TAX_RATE_DRIFT_LAST_CHECKED_SETTING } })
  await d.db.xeroTaxRateList.deleteMany({ where: { tenantId: TENANT } })
  await d.db.xeroTaxRate.deleteMany({ where: { tenantId: TENANT } })
  await d.db.accountingToken.deleteMany({ where: { connector: 'xero', tenantId: TENANT } })
  await d.db.$disconnect()
})

const plan = async () => d.pre.readEuVatSeedPlan(d.db as never, d.seed, CTX)

test('a dry run writes nothing; the plan names exactly the two scheme rates', { skip }, async () => {
  const before = await snapshotRates()
  const p = await plan()
  assert.deepEqual(p.changes.map((c) => c.wooId).sort(), [220, 239])
  assert.equal(p.unchanged, 3, 'the UK rate and the two zero-rated WooCommerce rates have nothing to set')
  assert.equal(p.skipped.length, 60)
  assert.deepEqual(await snapshotRates(), before)
})

test('the preflight read changes nothing and judges against the stored list', { skip }, async () => {
  const before = await snapshotRates()
  const input = await d.pre.readEuVatPreflightInput(d.db as never, d.seed, new Date(), TENANT, STORE)
  const result = d.pre.evaluateEuVatPreflight(input)
  assert.equal(result.status, 'checked')
  assert.equal(d.pre.evaluateEuVatPreflight(await d.pre.readEuVatPreflightInput(d.db as never, d.seed, new Date(), 'another-org', STORE)).status, 'refused', 'a list read from another organisation is not proven')
  assert.deepEqual(await snapshotRates(), before)
})

test('a missing or wrong digest writes nothing', { skip }, async () => {
  const before = await snapshotRates()
  const none = await d.pre.applyEuVatSeed(asClient(d.db), d.seed, 'not-a-digest', CTX)
  assert.equal(none.applied, false)
  assert.equal(none.applied === false && none.refusal?.code, 'CONFIRM_REQUIRED')
  const wrong = await d.pre.applyEuVatSeed(asClient(d.db), d.seed, 'c'.repeat(64), CTX)
  assert.equal(wrong.applied === false && wrong.refusal?.code, 'DIGEST_MISMATCH')
  assert.deepEqual(await snapshotRates(), before)
})

test('the stale digest of a plan whose rate was edited afterwards refuses and writes nothing', { skip }, async () => {
  const stale = (await plan()).digest
  const de = ids.rates[1]!
  await d.db.taxRate.update({ where: { id: de }, data: { reportingCategory: 'OSS' } })
  try {
    const before = await snapshotRates()
    const result = await d.pre.applyEuVatSeed(asClient(d.db), d.seed, stale, CTX)
    assert.equal(result.applied === false && result.refusal?.code, 'DIGEST_MISMATCH')
    assert.deepEqual(await snapshotRates(), before)
  } finally {
    await d.db.taxRate.update({ where: { id: de }, data: { reportingCategory: null } })
  }
})

test('the right digest sets the two columns on the two scheme rates and nothing else; a second apply has nothing to do', { skip }, async () => {
  const before = await snapshotRates()
  const p = await plan()
  const result = await d.pre.applyEuVatSeed(asClient(d.db), d.seed, p.digest, CTX)
  assert.equal(result.applied, true)
  assert.equal(result.applied && result.written, 2)
  const after = await snapshotRates()
  for (const row of after) {
    const old = before.find((b) => b.id === row.id)!
    const changed = Object.keys(row).filter((k) => JSON.stringify(row[k]) !== JSON.stringify(old[k])).sort()
    if (String(row.name).endsWith('UK VAT') || row.name === 'Zero Rated Income') assert.deepEqual(changed, [], `${String(row.name)} is untouched`)
    else assert.deepEqual(changed, ['reportingCategory', 'schemePostingTaxType', 'updatedAt'], `only the two declared columns (and the row's updatedAt) changed on ${String(row.name)}`)
  }
  const de = after.find((r) => String(r.name).endsWith('DE VAT'))!
  const no = after.find((r) => String(r.name).endsWith('NO VAT'))!
  assert.deepEqual([de.schemePostingTaxType, de.reportingCategory], ['TAX131', 'IOSS'])
  assert.deepEqual([no.schemePostingTaxType, no.reportingCategory], ['TAX122', 'VOEC'])
  assert.equal(await d.db.shoppingTaxRateMapping.count({ where: { id: { in: ids.mappings } } }), 5, 'no mapping touched')
  const again = await d.pre.applyEuVatSeed(asClient(d.db), d.seed, (await plan()).digest, CTX)
  assert.equal(again.applied === false && again.refusal?.code, 'NOTHING_TO_APPLY')
})

test('two concurrent applies of one plan write once, refuse the other cleanly and never deadlock', { skip }, async () => {
  for (const id of ids.rates) await d.db.taxRate.update({ where: { id }, data: { schemePostingTaxType: null, reportingCategory: null } })
  await d.db.taxRate.update({ where: { id: ids.rates[3]! }, data: { reportingCategory: 'IOSS' } })
  const { digest } = await plan()
  const results = await Promise.all([apply(digest), apply(digest)])
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

test('a mapping stamped for another store, or never stamped, is not written through; no store configured refuses the apply', { skip }, async () => {
  for (const id of ids.rates) await d.db.taxRate.update({ where: { id }, data: { schemePostingTaxType: null, reportingCategory: null } })
  const de = ids.mappings[1]!
  for (const stamp of ['https://other.example', null]) {
    await d.db.shoppingTaxRateMapping.update({ where: { id: de }, data: { storeIdentity: stamp } })
    try {
      const p = await plan()
      assert.equal(p.changes.some((c) => c.wooId === 220), false)
      assert.equal(p.skipped.find((s) => s.wooId === 220)?.reason, stamp === null ? 'MAPPING_UNSTAMPED' : 'MAPPING_OTHER_STORE')
      assert.equal((await apply(p.digest)).applied, true, 'the other rate (Norway) is still written by its own plan')
    } finally {
      await d.db.shoppingTaxRateMapping.update({ where: { id: de }, data: { storeIdentity: STORE } })
      for (const id of ids.rates) await d.db.taxRate.update({ where: { id }, data: { schemePostingTaxType: null, reportingCategory: null } })
    }
  }
  const beforeNone = await snapshotRates()
  const none = await d.pre.applyEuVatSeed(asClient(d.db), d.seed, (await plan()).digest, { connection: CTX.connection, storeIdentity: null })
  assert.equal(none.applied, false)
  assert.deepEqual(await snapshotRates(), beforeNone)
})

test('a rate edited after the dry run (percentage, country, name, charged code) changes the digest and the apply refuses, writing nothing', { skip }, async () => {
  for (const id of ids.rates) await d.db.taxRate.update({ where: { id }, data: { schemePostingTaxType: null, reportingCategory: null } })
  const de = ids.rates[1]!
  const original = await d.db.taxRate.findUniqueOrThrow({ where: { id: de } })
  for (const edit of [{ rate: '0.2000' }, { countryCode: 'AT' }, { name: 'DE VAT x' }, { accountingTaxType: 'TAX124' }]) {
    const stale = (await plan()).digest
    await d.db.taxRate.update({ where: { id: de }, data: edit })
    try {
      const before = await snapshotRates()
      const result = await apply(stale)
      assert.equal(result.applied === false && result.refusal?.code, 'DIGEST_MISMATCH', JSON.stringify(edit))
      assert.deepEqual(await snapshotRates(), before)
    } finally {
      await d.db.taxRate.update({ where: { id: de }, data: { rate: original.rate, countryCode: original.countryCode, name: original.name, accountingTaxType: original.accountingTaxType } })
    }
  }
})

test('a rate edited in the instant between the plan read and the row lock fails the compare-and-set and rolls the whole apply back', { skip }, async () => {
  const [, de, no] = ids.rates as [string, string, string]
  for (const id of ids.rates) await d.db.taxRate.update({ where: { id }, data: { schemePostingTaxType: null, reportingCategory: null } })
  await d.db.taxRate.update({ where: { id: ids.rates[3]! }, data: { reportingCategory: 'IOSS' } })
  const { digest } = await plan()
  const original = await d.db.taxRate.findUniqueOrThrow({ where: { id: de } })
  // The first row lock is preceded by a committed edit made from another session, exactly as an editor that read before the apply took the lock would have made it.
  const zMapping = ids.mappings[4]!
  const origMapping = await d.db.shoppingTaxRateMapping.findUniqueOrThrow({ where: { id: zMapping } })
  const edits: Array<() => Promise<unknown>> = [
    () => d.db.taxRate.update({ where: { id: de }, data: { rate: '0.2000' } }),
    () => d.db.taxRate.update({ where: { id: de }, data: { name: 'DE VAT renamed' } }),
    () => d.db.taxRate.update({ where: { id: de }, data: { countryCode: 'AT' } }),
    () => d.db.taxRate.update({ where: { id: de }, data: { accountingTaxType: 'TAX124' } }),
    () => d.db.taxRate.update({ where: { id: de }, data: { usedFor: 'BOTH' } }),
    () => d.db.taxRate.update({ where: { id: de }, data: { reverseCharge: true } }),
    () => d.db.taxRate.update({ where: { id: de }, data: { reportingCategory: 'OSS' } }),
    () => d.db.taxRate.update({ where: { id: de }, data: { schemePostingTaxType: 'TAX122' } }),
    () => d.db.shoppingTaxRateMapping.update({ where: { id: ids.mappings[1]! }, data: { storeIdentity: 'https://other.example' } }),
    () => d.db.shoppingTaxRateMapping.update({ where: { id: ids.mappings[1]! }, data: { taxRateId: no } }),
    // The second mapping of the SHARED zero-rated rate, field by field, and removed.
    () => d.db.shoppingTaxRateMapping.update({ where: { id: zMapping }, data: { externalCountry: 'DE' } }),
    () => d.db.shoppingTaxRateMapping.update({ where: { id: zMapping }, data: { externalRatePct: '1.0000' } }),
    () => d.db.shoppingTaxRateMapping.update({ where: { id: zMapping }, data: { externalClass: 'reduced-rate' } }),
    () => d.db.shoppingTaxRateMapping.update({ where: { id: zMapping }, data: { storeIdentity: null } }),
    () => d.db.shoppingTaxRateMapping.update({ where: { id: zMapping }, data: { taxRateId: de } }),
    () => d.db.shoppingTaxRateMapping.update({ where: { id: zMapping }, data: { externalTaxRateId: '99151' } }),
    () => d.db.shoppingTaxRateMapping.delete({ where: { id: zMapping } }),
    // A mapping nobody declared arrives on the German rate between the plan read and the lock.
    () => d.db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: '88888', externalName: 'Stray', externalCountry: 'DE', externalRatePct: '19.0000', externalClass: 'standard', taxRateId: de, storeIdentity: STORE } }),
  ]
  for (const edit of edits) {
    let fired = false
    const hooked = { $transaction: <T>(fn: (tx: never) => Promise<T>) => (d.db as never as { $transaction: (f: (tx: Record<string | symbol, unknown>) => Promise<T>) => Promise<T> }).$transaction((tx) => fn(new Proxy(tx, { get(target, prop) {
      const value = target[prop]
      if (prop === '$queryRaw') return async (...args: unknown[]) => { if (!fired && Array.from(args[0] as ArrayLike<string>).join('').includes('FROM tax_rates')) { fired = true; await edit() } return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args) }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    } }) as never)) }
    try {
      // Rows are locked in ascending id order, so make the edited rate's lock the first one the apply takes.
      const result = await apply(digest, hooked as never)
      assert.equal(fired, true, `edit #${edits.indexOf(edit)} never fired; result=${JSON.stringify(result.applied ? 'applied' : result.refusal)}`)
      assert.equal(result.applied, false)
      assert.equal(result.applied === false && result.refusal?.code, 'RATE_CHANGED_DURING_APPLY')
      const after = await snapshotRates()
      const zeroId = ids.rates[3]!
      assert.equal(after.find((r) => r.id === zeroId)!.reportingCategory, 'IOSS', 'the shared rate keeps the stale marker the plan would have cleared')
      assert.equal(after.filter((r) => r.id !== zeroId).some((r) => r.schemePostingTaxType === 'TAX131' || r.reportingCategory === 'IOSS' || r.reportingCategory === 'VOEC'), false, 'nothing the plan would set was written, the other rate included')
      assert.deepEqual(after.filter((r) => r.id !== de && r.id !== zeroId).map((r) => [r.schemePostingTaxType, r.reportingCategory]), [[null, null], [null, null]])
    } finally {
      await d.db.taxRate.update({ where: { id: de }, data: { rate: original.rate, name: original.name, countryCode: original.countryCode, accountingTaxType: original.accountingTaxType, usedFor: original.usedFor, reverseCharge: original.reverseCharge, reportingCategory: null, schemePostingTaxType: null } })
      await d.db.shoppingTaxRateMapping.update({ where: { id: ids.mappings[1]! }, data: { storeIdentity: STORE, taxRateId: de } })
      const fields = { connector: origMapping.connector, externalTaxRateId: origMapping.externalTaxRateId, externalName: origMapping.externalName, externalCountry: origMapping.externalCountry, externalRatePct: origMapping.externalRatePct, externalClass: origMapping.externalClass, taxRateId: origMapping.taxRateId, storeIdentity: origMapping.storeIdentity }
      await d.db.shoppingTaxRateMapping.upsert({ where: { id: zMapping }, create: origMapping, update: fields })
      await d.db.shoppingTaxRateMapping.deleteMany({ where: { connector: 'woocommerce', externalTaxRateId: '88888' } })
    }
  }
  await d.db.taxRate.update({ where: { id: ids.rates[3]! }, data: { reportingCategory: null } })
})

test('a shared IMS rate is one change with every mapping that names it; the apply writes it once and leaves the mappings alone', { skip }, async () => {
  for (const id of ids.rates) await d.db.taxRate.update({ where: { id }, data: { schemePostingTaxType: null, reportingCategory: null } })
  const zero = ids.rates[3]!
  await d.db.taxRate.update({ where: { id: zero }, data: { reportingCategory: 'IOSS' } })
  try {
    const p = await plan()
    const change = p.changes.find((c) => c.taxRateId === zero)
    assert.ok(change)
    assert.deepEqual(change.identity.mappings.map((m) => m.externalTaxRateId).sort(), ['150', '151'])
    const result = await apply(p.digest)
    assert.equal(result.applied, true)
    assert.equal((await d.db.taxRate.findUniqueOrThrow({ where: { id: zero } })).reportingCategory, null)
    assert.equal(await d.db.shoppingTaxRateMapping.count({ where: { id: { in: ids.mappings } } }), 5)
  } finally {
    await d.db.taxRate.update({ where: { id: zero }, data: { reportingCategory: null } })
  }
})

test('a Xero connection that changes after it was captured refuses the apply under the mapping-selection lock and writes nothing', { skip }, async () => {
  for (const id of ids.rates) await d.db.taxRate.update({ where: { id }, data: { schemePostingTaxType: null, reportingCategory: null } })
  const { digest } = await plan()
  const before = await snapshotRates()
  for (const change of [{ connectionGeneration: 'rebound' }, { tenantId: 'another-org' }]) {
    await d.db.accountingToken.update({ where: { connector: 'xero' }, data: change })
    try {
      const result = await apply(digest)
      assert.equal(result.applied === false && result.refusal?.code, 'XERO_CONNECTION_CHANGED', JSON.stringify(change))
      assert.deepEqual(await snapshotRates(), before)
    } finally {
      await d.db.accountingToken.update({ where: { connector: 'xero' }, data: { tenantId: TENANT, connectionGeneration: GENERATION } })
    }
  }
  const none = await d.pre.applyEuVatSeed(asClient(d.db), d.seed, digest, { connection: null, storeIdentity: STORE })
  assert.equal(none.applied === false && none.refusal?.code, 'XERO_CONNECTION_CHANGED', 'a token present where none was captured')
  assert.deepEqual(await snapshotRates(), before)
})

test('the apply takes the Xero mapping-selection lock first: a rebind that holds it makes the apply wait for the rebind to commit', { skip }, async () => {
  for (const id of ids.rates) await d.db.taxRate.update({ where: { id }, data: { schemePostingTaxType: null, reportingCategory: null } })
  const { digest } = await plan()
  const { lockAccountingMappingSelection } = await import('../../lib/integration-plugin-selection-lock.ts')
  let applyStarted = false
  let applyDone = false
  let outcome: Awaited<ReturnType<typeof apply>> | null = null
  await d.db.$transaction(async (tx) => {
    await lockAccountingMappingSelection(tx as never, 'xero')
    const running = (async () => { applyStarted = true; outcome = await apply(digest); applyDone = true })()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.equal(applyStarted, true)
    assert.equal(applyDone, false, 'the apply waits while a rebind holds the lock')
    // The rebind changes the connection before it commits.
    await tx.accountingToken.update({ where: { connector: 'xero' }, data: { connectionGeneration: 'rebound' } })
    void running
  }, { timeout: 30_000 })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  try {
    assert.equal(applyDone, true)
    const done = outcome as Awaited<ReturnType<typeof apply>> | null
    assert.equal(done !== null && done.applied === false && done.refusal?.code, 'XERO_CONNECTION_CHANGED')
  } finally {
    await d.db.accountingToken.update({ where: { connector: 'xero' }, data: { connectionGeneration: GENERATION } })
  }
})

for (const scenario of ['a planned mapping', 'the unusable mapping of a sharer of a planned rate'] as const) test(`the apply row-locks the COMPLETE mapping set its plan rests on (${scenario}): a writer of one of them waits for the apply to commit`, { skip }, async () => {
  for (const id of ids.rates) await d.db.taxRate.update({ where: { id }, data: { schemePostingTaxType: null, reportingCategory: null } })
  const second = scenario !== 'a planned mapping'
  const zero = ids.rates[3]!
  const z2 = ids.mappings[4]!
  const z2Original = await d.db.shoppingTaxRateMapping.findUniqueOrThrow({ where: { id: z2 } })
  if (second) {
    // The shared zero-rated rate has a stale marker, so it is planned; one sharer's mapping records another country, so it is declared but unusable: in the rate's mapping set, not in the plan's facts.
    await d.db.taxRate.update({ where: { id: zero }, data: { reportingCategory: 'IOSS' } })
    await d.db.shoppingTaxRateMapping.update({ where: { id: z2 }, data: { externalCountry: 'DE' } })
  }
  const { digest } = await plan()
  const zMapping = second ? z2 : ids.mappings[1]! // the German rate's mapping: DE is one of the rates this plan writes
  let writerDone = false
  let writer: Promise<unknown> = Promise.resolve()
  let heldWhileApplying = false
  let fired = false
  const hooked = { $transaction: <T>(fn: (tx: never) => Promise<T>) => (d.db as never as { $transaction: (f: (tx: Record<string | symbol, unknown>) => Promise<T>) => Promise<T> }).$transaction((tx) => fn(new Proxy(tx, { get(target, prop) {
    const value = target[prop]
    if (prop === 'taxRate') {
      // The first write of the apply comes after the mapping rows were locked: a writer started now must still be waiting.
      return new Proxy(value as object, { get(rates, name) {
        const method = (rates as Record<string | symbol, unknown>)[name]
        if (name === 'updateMany') return async (...args: unknown[]) => {
          if (!fired) {
            fired = true
            writer = d.db.shoppingTaxRateMapping.update({ where: { id: zMapping }, data: { externalName: 'edited by a writer' } }).then(() => { writerDone = true })
            await new Promise((resolve) => setTimeout(resolve, 700))
            heldWhileApplying = !writerDone
          }
          return (method as (...a: unknown[]) => Promise<unknown>).apply(rates, args)
        }
        return typeof method === 'function' ? (method as (...a: unknown[]) => unknown).bind(rates) : method
      } })
    }
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
  } }) as never)) }
  const original = await d.db.shoppingTaxRateMapping.findUniqueOrThrow({ where: { id: zMapping } })
  try {
    const result = await apply(digest, hooked as never)
    assert.equal(result.applied, true)
    assert.equal(fired, true)
    assert.equal(heldWhileApplying, true, 'the mapping writer was still waiting while the apply held its row lock')
    await writer
    assert.equal(writerDone, true, 'and it went through once the apply had committed')
  } finally {
    await d.db.shoppingTaxRateMapping.update({ where: { id: zMapping }, data: { externalName: original.externalName } })
    if (second) {
      await d.db.shoppingTaxRateMapping.update({ where: { id: z2 }, data: { externalCountry: z2Original.externalCountry } })
      await d.db.taxRate.update({ where: { id: zero }, data: { reportingCategory: null } })
    }
  }
})

test('an undeclared mapping onto a declared rate after the dry run is a different plan (the rate is no longer planned) and the apply refuses', { skip }, async () => {
  for (const id of ids.rates) await d.db.taxRate.update({ where: { id }, data: { schemePostingTaxType: null, reportingCategory: null } })
  const { digest } = await plan()
  const de = ids.rates[1]!
  const stray = await d.db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: '88888', externalName: 'Stray', externalCountry: 'DE', externalRatePct: '19.0000', externalClass: 'standard', taxRateId: de, storeIdentity: STORE } })
  try {
    const p = await plan()
    assert.equal(p.skipped.find((s) => s.wooId === 220)?.reason, 'SHARED_IMS_ROW')
    const before = await snapshotRates()
    const result = await apply(digest)
    assert.equal(result.applied === false && result.refusal?.code, 'DIGEST_MISMATCH')
    assert.deepEqual(await snapshotRates(), before)
  } finally {
    await d.db.shoppingTaxRateMapping.delete({ where: { id: stray.id } })
  }
})
