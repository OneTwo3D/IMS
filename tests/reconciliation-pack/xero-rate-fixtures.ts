import type { FxRateRow, ImsRead, ImsReadOptions, XeroPostedRateRow } from '../../lib/reconciliation-pack/ims-readers.ts'
import type { XeroGetPort, XeroPage } from '../../lib/reconciliation-pack/xero-source.ts'
import type { XeroResource } from '../../lib/reconciliation-pack/constants.ts'
import type { XeroRateItemContext } from '../../lib/reconciliation-pack/xero-rate-item.ts'

/**
 * FAKES FOR THE XERO RATE CHECK (R16). A fake Xero (a GET-only port that serves invoices, credit notes and payments with Xero's own
 * pagination object) and a fake IMS read (the base currency and the fx_rates rows). Nothing here touches a network or a database.
 */

export const ASOF = '2026-10-19' // the closed months are 2026-08 and 2026-09
export const TENANT = 'tenant-rate-fixture'
export const noSleep = async (): Promise<void> => undefined
export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

type Json = Record<string, unknown>

// ---- IMS ---------------------------------------------------------------------------------------

/** 1 GBP = 1.25 EUR from the morning of 2026-09-10, 1.3 USD from the morning of 2026-09-10. */
export const FX_ROWS: FxRateRow[] = [
  { currency: 'EUR', rate: '1.25', fetchedAt: '2026-09-10T06:00:00.000Z', manualOverride: false },
  { currency: 'USD', rate: '1.3', fetchedAt: '2026-09-10T06:00:00.000Z', manualOverride: false },
]

export function imsRates(options: { base?: string; rows?: FxRateRow[]; posted?: XeroPostedRateRow[]; fail?: 'throws' | 'read' | 'section' | 'posted' } = {}): { calls: ImsReadOptions[]; ims: NonNullable<XeroRateItemContext['ims']> } {
  const calls: ImsReadOptions[] = []
  return {
    calls,
    ims: async (read): Promise<ImsRead> => {
      calls.push(read)
      if (options.fail === 'throws') throw new Error('boom')
      if (options.fail === 'read') return { ok: false, reason: 'READ_INCOMPLETE' }
      if (options.fail === 'section') return { ok: true, snapshotId: '10:20:', sections: { baseCurrency: { ok: true, value: options.base ?? 'GBP' }, fxRates: { ok: false, reason: 'CAP_EXCEEDED' }, xeroPostedRates: { ok: true, value: [] } } }
      if (options.fail === 'posted') return { ok: true, snapshotId: '10:20:', sections: { baseCurrency: { ok: true, value: options.base ?? 'GBP' }, fxRates: { ok: true, value: options.rows ?? FX_ROWS }, xeroPostedRates: { ok: false, reason: 'CAP_EXCEEDED' } } }
      return { ok: true, snapshotId: '10:20:', sections: { baseCurrency: { ok: true, value: options.base ?? 'GBP' }, fxRates: { ok: true, value: options.rows ?? FX_ROWS }, xeroPostedRates: { ok: true, value: options.posted ?? [] } } }
    },
  }
}

// ---- Xero --------------------------------------------------------------------------------------

/** The statuses Xero gives a document; a row in any other status is returned whatever the request named (a service that answers outside its own filter). */
const KNOWN_STATUSES = new Set(['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID', 'VOIDED', 'DELETED'])

export type RateRow = { n: number; date: string; currency: string; rate: number | string | null; type?: string; status?: string; over?: Json }
/** An invoice or bill (ACCREC unless `type` says otherwise). The rate field is left off when `rate` is null. */
export const invoiceRow = (row: RateRow): Json => ({
  InvoiceID: uuid(row.n), Type: row.type ?? 'ACCREC', Status: row.status ?? 'AUTHORISED', DateString: `${row.date}T00:00:00`, CurrencyCode: row.currency,
  ...(row.rate === null ? {} : { CurrencyRate: row.rate }), ...(row.over ?? {}),
})
export const creditNoteRow = (row: RateRow): Json => ({
  CreditNoteID: uuid(row.n), Type: row.type ?? 'ACCRECCREDIT', Status: row.status ?? 'AUTHORISED', DateString: `${row.date}T00:00:00`, CurrencyCode: row.currency,
  ...(row.rate === null ? {} : { CurrencyRate: row.rate }), ...(row.over ?? {}),
})
/** A payment names the currency of the document it settles, through the invoice (or credit note) it carries. */
export const paymentRow = (row: RateRow & { holder?: 'Invoice' | 'CreditNote' | 'none' }): Json => ({
  PaymentID: uuid(row.n), Status: row.status ?? 'AUTHORISED', DateString: `${row.date}T00:00:00`,
  ...(row.rate === null ? {} : { CurrencyRate: row.rate }),
  ...(row.holder === 'none' ? {} : { [row.holder ?? 'Invoice']: { InvoiceID: uuid(9000 + row.n), CurrencyCode: row.currency } }), ...(row.over ?? {}),
})

export type XeroCall = { resource: XeroResource; params: Record<string, string> }
export type XeroTweak = (call: XeroCall, n: number, page: Extract<XeroPage, { ok: true }>) => XeroPage | undefined
export type RateDouble = XeroGetPort & { calls: XeroCall[] }

export function rateDouble(lists: { invoices?: Json[]; creditNotes?: Json[]; payments?: Json[] }, options: { pageSize?: number; baseCurrency?: string; tweak?: XeroTweak } = {}): RateDouble {
  const calls: XeroCall[] = []
  const pageSize = options.pageSize ?? 100
  const idKey: Record<string, string> = { Invoices: 'InvoiceID', CreditNotes: 'CreditNoteID', Payments: 'PaymentID' }
  const source: Record<string, Json[]> = { Invoices: lists.invoices ?? [], CreditNotes: lists.creditNotes ?? [], Payments: lists.payments ?? [] }
  return {
    calls,
    async get(resource, params): Promise<XeroPage> {
      calls.push({ resource, params: { ...params } })
      let body: Json
      if (resource === 'Organisation') body = { Organisations: [{ BaseCurrency: options.baseCurrency ?? 'GBP' }] }
      else {
        // Like Xero, the double returns only the statuses a request names (none named = all): a request that leaves a status out never sees its rows.
        const wanted = params.Statuses === undefined ? null : new Set(params.Statuses.split(','))
        const sorted = [...source[resource]!].filter((row) => wanted === null || wanted.has(String(row.Status)) || !KNOWN_STATUSES.has(String(row.Status))).sort((a, b) => String(a[idKey[resource]!]).localeCompare(String(b[idKey[resource]!])))
        const page = Number(params.page)
        body = { [resource]: sorted.slice((page - 1) * pageSize, page * pageSize).map((row) => ({ ...row })), pagination: { page, pageSize, pageCount: Math.ceil(sorted.length / pageSize), itemCount: sorted.length } }
      }
      const ok: Extract<XeroPage, { ok: true }> = { ok: true, status: 200, body }
      return options.tweak?.(calls.at(-1)!, calls.length, ok) ?? ok
    },
  }
}

export const binding = (over: Partial<{ tenantId: string; connectionGeneration: string | null }> = {}) => async () => ({ tenantId: TENANT, connectionGeneration: 'gen-1', ...over })

export function context(lists: Parameters<typeof rateDouble>[0], over: { double?: Parameters<typeof rateDouble>[1]; ims?: Parameters<typeof imsRates>[0]; context?: Partial<XeroRateItemContext> } = {}): { ctx: XeroRateItemContext; xero: RateDouble; ims: ReturnType<typeof imsRates> } {
  const xero = rateDouble(lists, over.double)
  const ims = imsRates(over.ims)
  return { xero, ims, ctx: { asOf: ASOF, vendorReads: true, vendor: { xero: { port: xero, binding: binding() } }, ims: ims.ims, xeroOptions: { sleep: noSleep }, ...over.context } }
}

/** A euro invoice dated 2026-09-10 unless said otherwise (1 GBP = 1.25 EUR from that morning, so Xero's rate should be 0.8). */
export const eurInvoice = (n: number, rate: number | string | null, date = '2026-09-10'): Json => invoiceRow({ n, date, currency: 'EUR', rate })

/** What IMS recorded when it posted the Xero record `ref` (the Xero id of the row built with n = ref): a connector-confirmed sync record carrying `rate` (1 base = X foreign). */
export const postedRow = (ref: number, type: string, over: Partial<XeroPostedRateRow> = {}): XeroPostedRateRow => ({
  id: `log${ref}`, type, externalId: uuid(ref), noPayload: false, currency: 'EUR', date: '2026-09-10', rate: '1.25', wooReceipt: false, orderRate: null, wooOrder: false, ...over,
})
