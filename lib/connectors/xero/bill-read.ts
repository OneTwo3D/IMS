/**
 * READ-ONLY: one supplier bill (ACCPAY) as Xero holds it, by its InvoiceID. Per-event FX rates for purchasing, MED-C: a bill that reached Xero outside
 * IMS has no IMS record of what it put in Stock in Transit, so the owner's one-off exchange-rate journal for it is measured on the Xero bill itself (its
 * CurrencyRate and the accounts its lines are coded to), read once by `npm run purchase-fx:non-ims-bills` and stored with the confirmation.
 *
 * ONE GET, through the Xero client (`xeroGet`), bounded. The client's minute and day limiter is PER PROCESS: run from the command line it cannot see the
 * calls the application makes against the organisation's 1,000-a-day allowance, so the command caps its own reads (`--max-reads`) and stops at the first
 * rate-limited or unsent read (`stopReading`). Nothing here writes to Xero.
 *
 * The rate convention is Xero's CurrencyRate = units of the bill's currency per ONE base unit, which is IMS's fxRateToBase (see prepayments.ts).
 */
import { Prisma } from '@/app/generated/prisma/client'
import { xeroGet } from './api'

export const XERO_BILL_READ_TIMEOUT_MS = 20_000

export type XeroBillLine = { accountCode: string | null; lineAmount: Prisma.Decimal; taxAmount: Prisma.Decimal }

export type XeroBill = {
  invoiceId: string
  type: string
  status: string
  currencyCode: string
  /** Xero's CurrencyRate (1 base = rate foreign). */
  currencyRate: Prisma.Decimal
  lineAmountTypes: string
  lines: XeroBillLine[]
}

/** `stopReading`: Xero rate-limited the read (HTTP 429) or the client refused to send it (status 0): no further read should be tried in this run. */
export type XeroBillRead = { ok: true; tenantId: string; bill: XeroBill } | { ok: false; error: string; stopReading?: boolean }

export type XeroBillReadDeps = {
  get: <T>(path: string) => Promise<{ ok: boolean; status: number; data?: T; error?: string; tenantId?: string }>
}

const DEFAULT_DEPS: XeroBillReadDeps = {
  get: (path) => xeroGet(path, { bounded: { timeoutMs: XERO_BILL_READ_TIMEOUT_MS } }),
}

type RawLine = { AccountCode?: unknown; LineAmount?: unknown; TaxAmount?: unknown }
type RawInvoice = { InvoiceID?: unknown; Type?: unknown; Status?: unknown; CurrencyCode?: unknown; CurrencyRate?: unknown; LineAmountTypes?: unknown; LineItems?: RawLine[] }

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Xero's CurrencyRate as IMS's rate (the identity, see prepayments.ts): a positive decimal of at most 12 places, else null. */
function currencyRate(value: unknown): Prisma.Decimal | null {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!/^\d+(\.\d{1,12})?$/.test(raw)) return null
  const rate = new Prisma.Decimal(raw)
  return rate.gt(0) ? rate : null
}

function money(value: unknown): Prisma.Decimal | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Prisma.Decimal(String(value))
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return new Prisma.Decimal(value.trim())
  return null
}

/** The bill, or why it could not be read in full (fail-closed: an incomplete answer is never a basis for a journal). */
export async function readXeroBillById(invoiceId: string, deps: XeroBillReadDeps = DEFAULT_DEPS): Promise<XeroBillRead> {
  const id = invoiceId.trim()
  if (!GUID.test(id)) return { ok: false, error: `${JSON.stringify(id)} is not a Xero InvoiceID` }
  let res: Awaited<ReturnType<XeroBillReadDeps['get']>> & { data?: { Invoices?: RawInvoice[] } }
  try {
    res = await deps.get<{ Invoices?: RawInvoice[] }>(`Invoices/${encodeURIComponent(id)}`)
  } catch (error) {
    return { ok: false, error: `the Xero bill read threw: ${String(error)}` }
  }
  if (!res.ok) return { ok: false, error: res.error ?? `the Xero bill read failed with HTTP ${res.status}`, ...(res.status === 429 || res.status === 0 ? { stopReading: true } : {}) }
  const tenantId = text(res.tenantId)
  if (!tenantId) return { ok: false, error: 'the Xero bill read did not report which organisation answered it' }
  const rows = res.data?.Invoices
  if (!Array.isArray(rows) || rows.length !== 1) return { ok: false, error: `the Xero bill read returned ${Array.isArray(rows) ? rows.length : 'no'} invoices for ${id}` }
  const row = rows[0]!
  const returnedId = text(row.InvoiceID)
  const type = text(row.Type)
  const status = text(row.Status)
  const currencyCode = text(row.CurrencyCode)?.toUpperCase() ?? null
  const rate = currencyRate(row.CurrencyRate)
  const lineAmountTypes = text(row.LineAmountTypes) ?? 'Exclusive'
  if (!returnedId || returnedId.toLowerCase() !== id.toLowerCase() || !type || !status || !currencyCode || !rate || !Array.isArray(row.LineItems)) {
    return { ok: false, error: `the Xero bill ${id} could not be read in full (id, type, status, currency, a positive CurrencyRate and its lines are all needed)` }
  }
  const lines: XeroBillLine[] = []
  for (const line of row.LineItems) {
    const lineAmount = money(line.LineAmount)
    if (!lineAmount) return { ok: false, error: `a line of the Xero bill ${id} has no readable LineAmount` }
    lines.push({ accountCode: text(line.AccountCode), lineAmount, taxAmount: money(line.TaxAmount) ?? new Prisma.Decimal(0) })
  }
  return { ok: true, tenantId, bill: { invoiceId: returnedId, type, status, currencyCode, currencyRate: rate, lineAmountTypes, lines } }
}
