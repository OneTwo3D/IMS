/**
 * A TRUSTED STORED XERO LIST for the first-load tests: the rails hold every existing supplier default tax rate to Xero's stored row (rails.ts supplierTaxRates), so a scratch installation that
 * runs the suppliers step needs the organisation's token, the list, its header (with the digest the writer records) and the last-success stamp. Not a `.test.ts` file.
 */
import { digestTaxRateList, type NormalisedXeroTaxRate } from '../../lib/connectors/xero/tax-rate-list'

export const TRUSTED_TENANT = 'zq-trusted-org'

export const xeroListRow = (taxType: string, name: string, percent: string, over: Partial<NormalisedXeroTaxRate> = {}): NormalisedXeroTaxRate => ({
  taxType, name, status: 'ACTIVE', reportTaxType: null, effectiveRate: percent, displayTaxRate: percent,
  components: Number(percent) === 0 ? [] : [{ name: 'VAT', rate: percent, compound: false, nonRecoverable: false }],
  canApply: { assets: false, equity: false, expenses: true, liabilities: false, revenue: false }, ...over,
})

/** INPUT2 20%, ZERORATEDINPUT 0%, NONE 0%: the three supplier purchase tax types. */
export const DEFAULT_XERO_LIST = (): NormalisedXeroTaxRate[] => [
  xeroListRow('INPUT2', 'ZQ Xero 20% (VAT on Expenses)', '20.000000'),
  xeroListRow('ZERORATEDINPUT', 'ZQ Xero Zero Rated Expenses', '0.000000'),
  xeroListRow('NONE', 'ZQ Xero No VAT', '0.000000'),
]

type Db = typeof import('@/lib/db')['db']

export async function wipeXeroList(db: Db): Promise<void> {
  await db.setting.deleteMany({ where: { key: 'xero_tax_rate_drift_last_checked_at' } })
  await db.accountingToken.deleteMany({ where: { connector: 'xero' } })
  await db.xeroTaxRateList.deleteMany({})
  await db.xeroTaxRate.deleteMany({})
}

export async function seedXeroList(db: Db, rows: NormalisedXeroTaxRate[] = DEFAULT_XERO_LIST(), over: { fetchedAt?: Date; stamp?: boolean; tenant?: string } = {}): Promise<void> {
  await wipeXeroList(db)
  const tenant = over.tenant ?? TRUSTED_TENANT
  const fetchedAt = over.fetchedAt ?? new Date(Date.now() - 600_000)
  await db.accountingToken.create({ data: { connector: 'xero', accessToken: 'a', expiresAt: new Date(Date.now() + 3_600_000), tenantId: TRUSTED_TENANT, tenantName: 'ZQ Org', connectionGeneration: 'gen-zq' } })
  await db.xeroTaxRate.createMany({ data: rows.map((r) => ({ connector: 'xero', tenantId: tenant, taxType: r.taxType, name: r.name, status: r.status, reportTaxType: r.reportTaxType, effectiveRate: r.effectiveRate, displayTaxRate: r.displayTaxRate, components: r.components, canApplyToAssets: r.canApply.assets, canApplyToEquity: r.canApply.equity, canApplyToExpenses: r.canApply.expenses, canApplyToLiabilities: r.canApply.liabilities, canApplyToRevenue: r.canApply.revenue, fetchedAt })) })
  await db.xeroTaxRateList.create({ data: { connector: 'xero', tenantId: tenant, fetchedAt, rowCount: rows.length, digest: digestTaxRateList(tenant, rows) } })
  if (over.stamp !== false) await db.setting.upsert({ where: { key: 'xero_tax_rate_drift_last_checked_at' }, create: { key: 'xero_tax_rate_drift_last_checked_at', value: fetchedAt.toISOString() }, update: { value: fetchedAt.toISOString() } })
}
