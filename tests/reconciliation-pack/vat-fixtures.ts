import type { WooGetPort, WooPage } from '../../lib/reconciliation-pack/woo-source.ts'
import type { XeroGetPort, XeroPage } from '../../lib/reconciliation-pack/xero-source.ts'
import type { ImsRead, ImsReadOptions, ImsVat, PopulationBoundaries, TaxMappingRow, TaxRateRow, VatSalesRow, XeroTaxRateStore } from '../../lib/reconciliation-pack/ims-readers.ts'
import type { VatItemContext } from '../../lib/reconciliation-pack/vat-item.ts'
import type { XeroResource } from '../../lib/reconciliation-pack/constants.ts'

/** The cycle date of the fixtures: the closed months are 2026-08 and 2026-09 (October is not closed until the 8th of November). */
export const ASOF = '2026-10-19'
export const TENANT = 'tenant-fixture-1'
export const noSleep = async (): Promise<void> => undefined

export const BOUNDARIES: PopulationBoundaries = { firstLoad: { state: 'verified', cutAt: '2026-01-01T00:00:00.000Z' }, storefrontImport: { state: 'completed', cutAt: '2026-01-01T00:00:00.000Z' }, retentionMonths: 0 }

export const rate = (id: string, over: Partial<TaxRateRow> = {}): TaxRateRow => ({ id, active: true, accountingTaxType: null, countryCode: null, reportingCategory: null, ...over })
export const R_GB = rate('rGB', { accountingTaxType: 'OUTPUT2', countryCode: 'GB', reportingCategory: 'DOMESTIC' })
export const R_IE = rate('rIE', { accountingTaxType: 'OUTPUT9', countryCode: 'IE', reportingCategory: 'DOMESTIC' })
export const R_DE_OSS = rate('rDE', { accountingTaxType: 'MOSS1', countryCode: 'DE', reportingCategory: 'OSS' })
export const REPORT_TYPES = [{ taxType: 'OUTPUT2', reportTaxType: 'OUTPUT' }, { taxType: 'OUTPUT9', reportTaxType: 'OUTPUT' }, { taxType: 'MOSS1', reportTaxType: 'MOSSSALES' }]
export const MAPPINGS: TaxMappingRow[] = [
  { connector: 'woocommerce', externalTaxRateId: '11', taxRateId: 'rGB' },
  { connector: 'woocommerce', externalTaxRateId: '12', taxRateId: 'rIE' },
  { connector: 'woocommerce', externalTaxRateId: '13', taxRateId: 'rDE' },
]

export type ImsFixture = {
  rates?: TaxRateRow[]
  mappings?: TaxMappingRow[]
  sales?: VatSalesRow[]
  boundaries?: PopulationBoundaries
  baseCurrency?: string
  store?: XeroTaxRateStore
  reportTypes?: Array<{ taxType: string; reportTaxType: string | null }>
  xeroTenantId?: string | null
  shippingAccount?: string
  shippingAccountInChart?: boolean
  salesAccount?: string
  discountAccount?: string
  wooFx?: ImsVat['wooFx']
  fail?: 'read' | 'throws' | { section: 'boundaries' | 'taxes' | 'xeroTaxRates' | 'vat'; reason: 'CAP_EXCEEDED' | 'READ_INCOMPLETE' }
}

export const provenStore = (taxTypes: string[] = REPORT_TYPES.map((entry) => entry.taxType)): XeroTaxRateStore => ({ state: 'proven', tenantId: TENANT, fetchedAt: '2026-10-19T01:00:00.000Z', taxTypes: taxTypes.map((taxType) => ({ taxType, status: 'ACTIVE' })) })

export function imsPort(fixture: ImsFixture = {}): { calls: ImsReadOptions[]; ims: NonNullable<VatItemContext['ims']> } {
  const calls: ImsReadOptions[] = []
  return {
    calls,
    ims: async (options): Promise<ImsRead> => {
      calls.push(options)
      if (fixture.fail === 'throws') throw new Error('boom')
      if (fixture.fail === 'read') return { ok: false, reason: 'READ_INCOMPLETE' }
      const vat: ImsVat = {
        baseCurrency: fixture.baseCurrency ?? 'GBP',
        window: options.vatWindow ?? { from: '2000-01-01', toExclusive: '2000-02-01' },
        sales: fixture.sales ?? [],
        xeroTenantId: fixture.xeroTenantId === undefined ? TENANT : fixture.xeroTenantId,
        xeroReportTypes: fixture.reportTypes ?? REPORT_TYPES,
        shippingAccount: fixture.shippingAccount ?? '260',
        shippingAccountInChart: fixture.shippingAccountInChart ?? true,
        salesAccount: fixture.salesAccount ?? '200',
        discountAccount: fixture.discountAccount ?? '',
        wooFx: fixture.wooFx ?? [],
      }
      const values: Record<string, unknown> = {
        boundaries: fixture.boundaries ?? BOUNDARIES,
        taxes: { rates: fixture.rates ?? [R_GB, R_IE, R_DE_OSS], mappings: fixture.mappings ?? MAPPINGS, componentTaxTypes: [], reverseCharge: { sales: '', purchase: '' } },
        xeroTaxRates: fixture.store ?? provenStore(),
        vat,
      }
      const sections: Record<string, unknown> = {}
      for (const name of options.sections) {
        const failure = typeof fixture.fail === 'object' && fixture.fail.section === name ? fixture.fail.reason : undefined
        sections[name] = failure ? { ok: false, reason: failure } : { ok: true, value: values[name] }
      }
      return { ok: true, snapshotId: '1:2:', sections } as ImsRead
    },
  }
}

export const sale = (period: string, taxRateId: string | null, taxBase: string, lines = 1, nonZeroLines?: number): VatSalesRow => ({ period, taxRateId, taxBase, lines, nonZeroLines: nonZeroLines ?? (/^-?0+(\.0+)?$/.test(taxBase) ? 0 : lines) })

// ---- Xero double ------------------------------------------------------------------------------

type Json = Record<string, unknown>
export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
/** `account` defaults to the sales account '200'; null leaves the code off the line. */
export type XeroLine = { type: string; tax: number; account?: string | null; amount?: number }
export const invoice = (n: number, date: string, lines: XeroLine[], over: Json = {}): Json => ({
  InvoiceID: uuid(n), Type: 'ACCREC', Status: 'AUTHORISED', DateString: `${date}T00:00:00`, CurrencyCode: 'GBP', CurrencyRate: 1, LineAmountTypes: 'Exclusive',
  TotalTax: Math.round(lines.reduce((sum, line) => sum + line.tax, 0) * 100) / 100, SubTotal: lines.reduce((sum, line) => sum + (line.amount ?? 100), 0), Total: Math.round((lines.reduce((sum, line) => sum + (line.amount ?? 100), 0) + lines.reduce((sum, line) => sum + line.tax, 0)) * 100) / 100,
  LineItems: lines.map((line) => ({ TaxType: line.type, TaxAmount: line.tax, LineAmount: line.amount ?? 100, ...(line.account === null ? {} : { AccountCode: line.account ?? '200' }) })), ...over,
})

export type XeroCall = { resource: XeroResource; params: Record<string, string> }
export type XeroTweak = (call: XeroCall, n: number, page: Extract<XeroPage, { ok: true }>) => XeroPage | undefined
export function xeroDouble(invoices: Json[], options: { pageSize?: number; baseCurrency?: string; tweak?: XeroTweak } = {}): XeroGetPort & { calls: XeroCall[] } {
  const calls: XeroCall[] = []
  const pageSize = options.pageSize ?? 100
  return {
    calls,
    async get(resource, params): Promise<XeroPage> {
      calls.push({ resource, params: { ...params } })
      let body: Json
      if (resource === 'Organisation') body = { Organisations: [{ BaseCurrency: options.baseCurrency ?? 'GBP' }] }
      else {
        const sorted = [...invoices].sort((a, b) => String(a.InvoiceID).localeCompare(String(b.InvoiceID)))
        const page = Number(params.page)
        body = { Invoices: sorted.slice((page - 1) * pageSize, page * pageSize).map((row) => ({ ...row })), pagination: { page, pageSize, pageCount: Math.ceil(sorted.length / pageSize), itemCount: sorted.length } }
      }
      const ok: Extract<XeroPage, { ok: true }> = { ok: true, status: 200, body }
      return options.tweak?.(calls.at(-1)!, calls.length, ok) ?? ok
    },
  }
}

// ---- WooCommerce double ----------------------------------------------------------------------------

export type WooCall = { collection: string; params: Record<string, string> }
export type WooTweak = (call: WooCall, n: number, page: Extract<WooPage, { ok: true }>) => WooPage | undefined
/** The order's total_tax as the store reports it: every tax line's tax_total plus its shipping_tax_total (the double puts 99.00 of shipping tax on each line). */
export const wooTotalTax = (taxes: Array<[number, string]>): string => (taxes.reduce((sum, [, total]) => sum + Math.round((Number(total) + 99) * 100), 0) / 100).toFixed(2)
export const wooOrder = (id: number, created: string, taxes: Array<[number, string]>, over: Json = {}): Json => ({
  id, status: 'processing', currency: 'GBP', date_created_gmt: created, fee_lines: [], total_tax: wooTotalTax(taxes), tax_lines: taxes.map(([rateId, total]) => ({ id: rateId * 10, rate_id: rateId, tax_total: total, shipping_tax_total: '99.00' })), ...over,
})
export function wooDouble(orders: Record<string, Json[]>, tweak?: WooTweak): WooGetPort & { calls: WooCall[] } {
  const calls: WooCall[] = []
  return {
    calls,
    async get(collection, params): Promise<WooPage> {
      calls.push({ collection, params: { ...params } })
      const all = collection === 'orders' ? (orders[params.status ?? ''] ?? []) : []
      const sorted = [...all].sort((a, b) => Number(a.id) - Number(b.id))
      const perPage = Number(params.per_page)
      const page = Number(params.page)
      const ok: Extract<WooPage, { ok: true }> = { ok: true, status: 200, total: String(sorted.length), totalPages: String(Math.ceil(sorted.length / perPage)), body: sorted.slice((page - 1) * perPage, page * perPage).map((row) => ({ ...row })) }
      return tweak?.(calls.at(-1)!, calls.length, ok) ?? ok
    },
  }
}

export const binding = (over: Partial<{ tenantId: string; connectionGeneration: string | null }> = {}) => async () => ({ tenantId: TENANT, connectionGeneration: 'gen-1', ...over })

/** The standard estate: GBP 100.00 of VAT in 2026-09 and 50.00 in 2026-08, in all three systems, on the domestic GB rate. */
export function standard(over: { ims?: ImsFixture; xero?: Json[]; woo?: Record<string, Json[]>; xeroOptions?: Parameters<typeof xeroDouble>[1]; wooTweak?: WooTweak; context?: Partial<VatItemContext> } = {}) {
  const ims = imsPort({ sales: [sale('2026-09', 'rGB', '100.00', 3), sale('2026-08', 'rGB', '50.00', 2)], ...(over.ims ?? {}) })
  const xero = xeroDouble(over.xero ?? [
    invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 60 }]),
    invoice(2, '2026-09-20', [{ type: 'OUTPUT2', tax: 40 }]),
    invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }]),
  ], over.xeroOptions)
  const woo = wooDouble(over.woo ?? { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '60.00']]), wooOrder(102, '2026-09-21T10:00:00', [[11, '40.00']]), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] }, over.wooTweak)
  const ctx: VatItemContext = { asOf: ASOF, vendorReads: true, vendor: { woo, xero: { port: xero, binding: binding() } }, ims: ims.ims, wooOptions: { sleep: noSleep }, xeroOptions: { sleep: noSleep }, ...(over.context ?? {}) }
  return { ims, xero, woo, ctx }
}
