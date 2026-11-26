/**
 * READ-ONLY: the supplier prepayments the owner records in Xero (Spend Money > Prepayment), looked up by the Reference he types on them (the IMS
 * purchase order number). Per-event FX rates for purchasing (switch `purchase_event_fx_rates_enabled`, o3d-hqvrp.51 step 2) lock a foreign
 * order's goods at the rate of that prepayment, which is the exact bank rate of the money that left.
 *
 * ONE GET, through the shared Xero client (`xeroGet`), so the call counts against the organisation's shared minute and rolling-day budget like every
 * other Xero request and is refused (not sent) when that budget is gone. Nothing here writes to Xero.
 *
 * WHY THE PREPAYMENTS ENDPOINT CAN BE ASKED BY REFERENCE. Until Xero's change of 16 July 2026 ("Reference and InvoiceNumber fields for Prepayments")
 * the Reference of a prepayment came back as the invoice number; since then it is the reference typed on the transaction, and the endpoint filters
 * on it. The filter is Xero's; every row that comes back is checked again here (type, status, reference) and nothing it returns is trusted to be
 * the answer without those checks.
 *
 * THE RATE CONVENTION. Xero's `CurrencyRate` is units of the document currency per ONE unit of the organisation's base currency: a GBP organisation's
 * USD bill of 2026-09-07 carries 1.352650993 (1 GBP = 1.35 USD), its CNY bill 8.937375334, its EUR bill 1.1835295458 (read from the live
 * organisation, 2026-11-22). That is EXACTLY IMS's `fxRateToBase` convention (1 base = rate foreign, base = foreign / rate), so the conversion is the
 * identity. It is kept local on purpose (`xeroCurrencyRateToImsRateToBase`): lib/connectors/xero/fx.ts inverts the rate for the documents IMS
 * sends, which is the defect filed as o3d-rk7qf and fixed separately.
 */
import { Prisma } from '@/app/generated/prisma/client'
import { xeroGet } from './api'

/** Xero returns at most this many prepayments per page; a full page cannot show it is the whole answer. */
export const XERO_PREPAYMENTS_PAGE_SIZE = 100
/** A receipt or an operator waits for this read; a bounded call refuses instead of sleeping for minute budget. */
export const XERO_PREPAYMENT_READ_TIMEOUT_MS = 20_000
/** The most decimal places a rate may carry and still be stored exactly (purchase_order_fx_locks.rate_to_base is DECIMAL(28,12)). */
const RATE_MAX_DECIMALS = 12
/** A JSON number keeps 15 significant digits exactly; a rate with more cannot be proved to be Xero's value. */
const RATE_MAX_SIGNIFICANT_DIGITS = 15

export type XeroSupplierPrepayment = {
  prepaymentId: string
  status: string
  reference: string
  contactId: string
  currencyCode: string
  /** Xero's CurrencyRate, as Xero holds it (units of `currencyCode` per 1 base). */
  currencyRate: Prisma.Decimal
  total: Prisma.Decimal
  /** YYYY-MM-DD. */
  date: string
}

export type XeroSupplierPrepaymentRead =
  | { ok: true; tenantId: string; prepayments: XeroSupplierPrepayment[] }
  | { ok: false; error: string }

type RawPrepayment = {
  PrepaymentID?: unknown
  Type?: unknown
  Status?: unknown
  Reference?: unknown
  Contact?: { ContactID?: unknown } | null
  CurrencyCode?: unknown
  CurrencyRate?: unknown
  Total?: unknown
  Date?: unknown
  DateString?: unknown
}

type RawPrepaymentsResponse = { Prepayments?: RawPrepayment[] }

export type PrepaymentReadDeps = {
  get: <T>(path: string) => Promise<{ ok: boolean; status: number; data?: T; error?: string; tenantId?: string }>
}

const DEFAULT_DEPS: PrepaymentReadDeps = {
  get: (path) => xeroGet(path, { bounded: { timeoutMs: XERO_PREPAYMENT_READ_TIMEOUT_MS } }),
}

/** Statuses of a prepayment that no longer stands: read, then set aside (a voided prepayment holds no money). */
const SET_ASIDE_STATUSES = new Set(['VOIDED', 'DELETED'])

/** The identity: Xero's CurrencyRate is already IMS's fxRateToBase (see the header). Refuses a value that is not a positive, exactly storable rate. */
export function xeroCurrencyRateToImsRateToBase(value: unknown): Prisma.Decimal | null {
  let text: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    text = String(value)
  } else if (typeof value === 'string' && value.trim()) {
    text = value.trim()
  } else {
    return null
  }
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  const rate = new Prisma.Decimal(text)
  if (!rate.gt(0)) return null
  if (rate.decimalPlaces() > RATE_MAX_DECIMALS) return null
  if (text.replace('.', '').replace(/^0+/, '').length > RATE_MAX_SIGNIFICANT_DIGITS) return null
  return rate
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function money(value: unknown): Prisma.Decimal | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Prisma.Decimal(String(value))
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return new Prisma.Decimal(value.trim())
  return null
}

/** The prepayment's own date, YYYY-MM-DD: `DateString` (Xero's ISO form) first, else the `/Date(ms+0000)/` form. */
function prepaymentDate(row: RawPrepayment): string | null {
  const iso = text(row.DateString)
  if (iso && /^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10)
  const legacy = text(row.Date)
  const match = legacy?.match(/^\/Date\((-?\d+)([+-]\d{4})?\)\/$/)
  if (match) return new Date(Number(match[1])).toISOString().slice(0, 10)
  return null
}

/** Xero's `where` compares Reference case-insensitively; the check on the way back is the same comparison, on the trimmed values. */
export function prepaymentReferenceMatches(reference: string, wanted: string): boolean {
  return reference.trim().toUpperCase() === wanted.trim().toUpperCase()
}

/**
 * Every live SPEND prepayment whose Reference is `reference`. Fail-closed: a row that claims to be one but cannot be read in full makes the whole
 * read an error (a missing answer is never "no prepayment"), as do a failed request, an answer no organisation is named for and a full page.
 */
export async function readXeroSupplierPrepaymentsByReference(
  reference: string,
  deps: PrepaymentReadDeps = DEFAULT_DEPS,
): Promise<XeroSupplierPrepaymentRead> {
  const wanted = reference.trim()
  if (!wanted) return { ok: false, error: 'no purchase order reference to look the prepayment up by' }
  if (/["\\]/.test(wanted)) {
    return { ok: false, error: `the reference ${JSON.stringify(wanted)} contains a quote or a backslash, so IMS cannot ask Xero for exactly it` }
  }
  const where = `Reference=="${wanted}"`
  let res: Awaited<ReturnType<PrepaymentReadDeps['get']>> & { data?: RawPrepaymentsResponse }
  try {
    res = await deps.get<RawPrepaymentsResponse>(`Prepayments?where=${encodeURIComponent(where)}&page=1`)
  } catch (error) {
    return { ok: false, error: `the Xero prepayment read threw: ${String(error)}` }
  }
  if (!res.ok) return { ok: false, error: res.error ?? `the Xero prepayment read failed with HTTP ${res.status}` }
  if (!res.data || !Array.isArray(res.data.Prepayments)) return { ok: false, error: 'the Xero prepayment read returned no Prepayments list' }
  const tenantId = text(res.tenantId)
  if (!tenantId) return { ok: false, error: 'the Xero prepayment read did not report which organisation answered it' }
  const rows = res.data.Prepayments
  if (rows.length >= XERO_PREPAYMENTS_PAGE_SIZE) {
    return { ok: false, error: `the Xero prepayment read for ${wanted} filled its page (${rows.length} rows), so it cannot show it saw every prepayment` }
  }

  const prepayments: XeroSupplierPrepayment[] = []
  for (const row of rows) {
    // A customer (RECEIVE) prepayment is not a supplier payment, whatever its reference says.
    if (text(row.Type) !== 'SPEND-PREPAYMENT') continue
    const status = text(row.Status)
    const rowReference = text(row.Reference)
    if (status && SET_ASIDE_STATUSES.has(status.toUpperCase())) continue
    if (rowReference !== null && !prepaymentReferenceMatches(rowReference, wanted)) continue
    const prepaymentId = text(row.PrepaymentID)
    const contactId = text(row.Contact?.ContactID)
    const currencyCode = text(row.CurrencyCode)?.toUpperCase() ?? null
    const currencyRate = xeroCurrencyRateToImsRateToBase(row.CurrencyRate)
    const total = money(row.Total)
    const date = prepaymentDate(row)
    if (!prepaymentId || !status || !rowReference || !contactId || !currencyCode || !currencyRate || !total || !date) {
      return {
        ok: false,
        error: `a Xero supplier prepayment for ${wanted}${prepaymentId ? ` (${prepaymentId})` : ''} could not be read in full `
          + '(id, status, reference, contact, currency, a positive CurrencyRate, total and date are all needed)',
      }
    }
    prepayments.push({ prepaymentId, status, reference: rowReference, contactId, currencyCode, currencyRate, total, date })
  }
  return { ok: true, tenantId, prepayments }
}
