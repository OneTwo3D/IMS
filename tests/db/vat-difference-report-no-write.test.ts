import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE VAT DIFFERENCE REPORT AGAINST A REAL DATABASE WRITES NOTHING. GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 * It seeds its own tax rates, components, WooCommerce mapping, a stored Xero list (header, rows, last-success stamp) and a Xero token, digests
 * ONLY those rows (with each row's xmin, so any write, even of the same value, changes the digest) before and after a full report and a
 * refused report, and proves the transaction is READ ONLY (a write in it is refused by the database). The pre-existing stored Xero list
 * and token of the scratch database are set aside and restored.
 *
 * Mutations (seen red, reverted): the SET TRANSACTION ... READ ONLY statement removed -> the "write refused" arm fails; a write
 * (an update of a seeded tax rate) added to readImsXeroSnapshot -> the digest arm fails.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/vat-difference-report-no-write.test.ts would have been skipped.')
}

async function deps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const [{ db }, run, drift, listMod] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/tax/vat-difference-run.ts'),
    import('../../lib/connectors/xero/tax-rate-drift-sweeper.ts'),
    import('../../lib/connectors/xero/tax-rate-list.ts'),
  ])
  return { db, ...run, ...drift, ...listMod }
}

type Db = Awaited<ReturnType<typeof deps>>['db']

async function ownedRowsDigest(db: Db, own: { rateIds: string[]; mappingIds: string[]; tenant: string; stampKey: string }): Promise<string> {
  const parts: Array<[string, string, unknown[]]> = [
    ['rates', `SELECT t.*, t.xmin::text AS x FROM tax_rates t WHERE t."id" = ANY($1)`, [own.rateIds]],
    ['components', `SELECT c.*, c.xmin::text AS x FROM tax_rate_components c WHERE c."tax_rate_id" = ANY($1)`, [own.rateIds]],
    ['mappings', `SELECT m.*, m.xmin::text AS x FROM shopping_tax_rate_mappings m WHERE m."id" = ANY($1)`, [own.mappingIds]],
    ['xero-rates', `SELECT r.*, r.xmin::text AS x FROM xero_tax_rates r WHERE r."tenantId" = $1`, [own.tenant]],
    ['xero-list', `SELECT l.*, l.xmin::text AS x FROM xero_tax_rate_lists l WHERE l."tenantId" = $1`, [own.tenant]],
    ['stamp', `SELECT s.*, s.xmin::text AS x FROM settings s WHERE s."key" = $1`, [own.stampKey]],
    ['token', `SELECT t.*, t.xmin::text AS x FROM accounting_tokens t WHERE t."connector" = 'xero'`, []],
  ]
  const out: string[] = []
  for (const [name, sql, args] of parts) {
    const rows = await db.$queryRawUnsafe<Array<{ d: string; n: bigint }>>(`SELECT md5(coalesce(string_agg(q::text, '|' ORDER BY q::text), '')) AS d, count(*) AS n FROM (${sql}) q`, ...args)
    out.push(`${name}:${rows[0]!.n}:${rows[0]!.d}`)
  }
  return out.join(' ')
}

test('the VAT difference report reads a real database and writes nothing', { skip }, async () => {
  const d = await deps()
  const { db } = d
  const tag = randomBytes(4).toString('hex')
  const tenant = `vatd-${tag}`
  const now = new Date()
  // Set aside whatever the scratch database holds for the Xero list and token.
  const savedLists = await db.xeroTaxRateList.findMany()
  const savedRates = await db.xeroTaxRate.findMany()
  const savedTokens = await db.accountingToken.findMany({ where: { connector: 'xero' } })
  const savedStamp = await db.setting.findUnique({ where: { key: d.TAX_RATE_DRIFT_LAST_CHECKED_SETTING } })
  const rateIds: string[] = []
  const mappingIds: string[] = []
  try {
    await db.xeroTaxRate.deleteMany({})
    await db.xeroTaxRateList.deleteMany({})
    await db.accountingToken.deleteMany({ where: { connector: 'xero' } })
    await db.accountingToken.create({ data: { connector: 'xero', accessToken: 'x', expiresAt: new Date(now.getTime() + 3_600_000), tenantId: tenant } })
    const xeroRows = [
      { taxType: 'OUTPUT2', name: '20% (VAT on Income)', status: 'ACTIVE' as const, reportTaxType: null, effectiveRate: '20.000000', displayTaxRate: '20.000000', components: [], canApply: { assets: false, equity: false, expenses: false, liabilities: false, revenue: true } },
      { taxType: 'INPUT2', name: '20% (VAT on Expenses)', status: 'ACTIVE' as const, reportTaxType: null, effectiveRate: '20.000000', displayTaxRate: '20.000000', components: [], canApply: { assets: false, equity: false, expenses: true, liabilities: false, revenue: false } },
    ]
    await db.xeroTaxRate.createMany({
      data: xeroRows.map((r) => ({ connector: 'xero', tenantId: tenant, taxType: r.taxType, name: r.name, status: r.status, effectiveRate: r.effectiveRate, displayTaxRate: r.displayTaxRate, components: r.components, canApplyToAssets: false, canApplyToEquity: false, canApplyToExpenses: r.canApply.expenses, canApplyToLiabilities: false, canApplyToRevenue: r.canApply.revenue, fetchedAt: now })),
    })
    await db.xeroTaxRateList.create({ data: { connector: 'xero', tenantId: tenant, fetchedAt: now, rowCount: xeroRows.length, digest: d.digestTaxRateList(tenant, xeroRows) } })
    await db.setting.upsert({ where: { key: d.TAX_RATE_DRIFT_LAST_CHECKED_SETTING }, update: { value: now.toISOString() }, create: { key: d.TAX_RATE_DRIFT_LAST_CHECKED_SETTING, value: now.toISOString() } })
    const uk = await db.taxRate.create({ data: { name: `VATD UK ${tag}`, rate: '0.2000', usedFor: 'SALES', accountingTaxType: 'OUTPUT2', countryCode: 'GB', components: { create: [{ name: 'VAT', rate: '0.2000', sortOrder: 0 }] } } })
    const purchase = await db.taxRate.create({ data: { name: `VATD IN ${tag}`, rate: '0.1900', usedFor: 'PURCHASE', accountingTaxType: 'INPUT2' } })
    rateIds.push(uk.id, purchase.id)
    const mapping = await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: `9${tag.replace(/\D/g, '1')}`, externalName: 'UK VAT', externalRatePct: '20', externalClass: 'standard', taxRateId: uk.id } })
    mappingIds.push(mapping.id)
    const wooId = Number(mapping.externalTaxRateId)
    const woo = {
      async get(): Promise<{ ok: true; status: number; total: string; totalPages: string; body: unknown[] }> {
        return { ok: true, status: 200, total: '1', totalPages: '1', body: [{ id: wooId, name: 'UK VAT', rate: '19.0000', country: 'GB', state: '', postcode: '', city: '', class: 'standard', shipping: true, compound: false }] }
      },
    }
    const own = { rateIds, mappingIds, tenant, stampKey: d.TAX_RATE_DRIFT_LAST_CHECKED_SETTING }
    const before = await ownedRowsDigest(db, own)

    const report = await d.runVatDifferenceReport({ db, now: () => new Date(), woo, wooOptions: { sleep: async () => undefined } })
    assert.equal(report.status, 'compared')
    if (report.status === 'compared') {
      // Our rows are in it: the Woo rate disagrees with Xero's 20 and the purchase rate with Xero's INPUT2.
      const mine = report.differences.filter((x) => x.imsRateId === uk.id || x.imsRateId === purchase.id || x.wooRateId === String(wooId))
      assert.deepEqual(mine.map((x) => x.reason).sort(), ['PERCENTAGE_MISMATCH_IMS_XERO', 'WOO_PERCENTAGE_MISMATCH'])
    }
    const refused = await d.runVatDifferenceReport({ db, now: () => new Date(now.getTime() + 3 * 24 * 3_600_000), woo, wooOptions: { sleep: async () => undefined } })
    assert.equal(refused.status === 'refused' && refused.code, 'XERO_LIST_STALE')
    assert.equal(await ownedRowsDigest(db, own), before, 'a full report and a refused report wrote nothing to the rows they read')

    // The transaction the report reads in is READ ONLY: a write inside one is refused by the database itself.
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        await tx.taxRate.update({ where: { id: uk.id }, data: { name: 'changed' } })
      }),
      /read-only transaction/i,
    )
    assert.equal(await ownedRowsDigest(db, own), before)

    // The real command, in a child with a hostile environment: no WooCommerce credentials are stored, so it refuses (exit 2) and still writes nothing.
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/vat-difference-report.ts', '--json'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 120_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', DATABASE_URL: process.env.DATABASE_URL, SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY, PGHOST: '203.0.113.1' },
    })
    assert.equal(child.status, 2, `stderr: ${child.stderr.slice(0, 300)}`)
    assert.equal((JSON.parse(child.stdout) as { code: string }).code, 'WOO_READ_FAILED')
    assert.equal(await ownedRowsDigest(db, own), before)
    console.log(`# digests equal; rows owned: rates=${rateIds.length} mappings=${mappingIds.length}`)
  } finally {
    await db.shoppingTaxRateMapping.deleteMany({ where: { id: { in: mappingIds } } })
    await db.taxRate.deleteMany({ where: { id: { in: rateIds } } })
    await db.xeroTaxRate.deleteMany({})
    await db.xeroTaxRateList.deleteMany({})
    await db.accountingToken.deleteMany({ where: { connector: 'xero' } })
    if (savedRates.length) await db.xeroTaxRate.createMany({ data: savedRates.map(({ id: _id, ...rest }) => ({ ...rest, components: rest.components as never })) })
    if (savedLists.length) await db.xeroTaxRateList.createMany({ data: savedLists.map(({ id: _id, ...rest }) => rest) })
    if (savedTokens.length) await db.accountingToken.createMany({ data: savedTokens.map(({ id: _id, ...rest }) => rest) })
    if (savedStamp) await db.setting.update({ where: { key: d.TAX_RATE_DRIFT_LAST_CHECKED_SETTING }, data: { value: savedStamp.value } })
    else await db.setting.deleteMany({ where: { key: d.TAX_RATE_DRIFT_LAST_CHECKED_SETTING } })
    await db.$disconnect()
  }
})
