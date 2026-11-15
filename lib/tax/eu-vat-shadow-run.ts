/**
 * THE EU VAT SHADOW REPORT, WITHOUT ITS I/O: the orchestration of one run over INJECTED ports.
 *
 * For each chosen order it (1) reads the WooCommerce order, (2) builds the invoice IMS would post, (3) fetches the invoice the plugin / Xeroom actually posted, and (4) compares the two with the pure
 * comparator (lib/domain/accounting/eu-vat-shadow-compare.ts). Every effect lives behind a port: the order list and the build are IMS reads, the WooCommerce order and the Xero invoice are `GET`s. Nothing
 * here enqueues, writes, posts or stamps, and nothing here can: a port that wrote would be a defect in the port, and the live ports (eu-vat-shadow-live.ts) call only reads.
 *
 * WHAT IS KEPT. A result holds the order NUMBER, a status, closed figures (account, TaxType, amounts), refusal reasons IMS wrote itself, and closed codes for anything a vendor said. It never holds a name, an
 * email, an address, a description, a raw response or a credential, so the report can be printed and pasted.
 */
import { SCHEME_DESTINATIONS, normaliseDestination } from '@/lib/domain/accounting/eu-vat-regime'
import {
  compareComparableInvoices, comparableFromXeroInvoice, isBoundaryOrder, statusOfComparison,
  type ComparableInvoice, type InvoiceComparison, type ShadowStatus,
} from '@/lib/domain/accounting/eu-vat-shadow-compare'

/** The most orders one run reads, whatever `--max` says. */
export const SHADOW_HARD_MAX_ORDERS = 200
export const SHADOW_DEFAULT_MAX_ORDERS = 25

export type ShadowSelection =
  | { kind: 'orders'; refs: string[] }
  | { kind: 'range'; from: string; to: string }

export type ShadowOrderRef = { orderId: string; orderNumber: string; /** The WooCommerce order id (the store's own), used only to read the order. */ externalOrderId: string }

/** What the WooCommerce read gives back: the destination and invoice number the run needs, and the order itself, which only the build ever sees. */
export type ShadowWcOrder = { destination: string | null; invoiceNumber: string | null; order: unknown }

export type ShadowImsBuild =
  | { kind: 'built'; invoice: ComparableInvoice; warnings: Array<{ code: string }>; stampSource: 'stored' | 'provisional' | 'none'; route: string; regime: string | null }
  | { kind: 'refused'; reason: string }

export type ShadowXeroFetch =
  | { kind: 'found'; /** The raw invoice; only the compared fields are read from it, by `comparableFromXeroInvoice`. */ invoice: unknown }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'error'; /** A closed, vendor-free description: never a response body, a header or a token. */ code: string }

export type ShadowPorts = {
  listOrders(selection: ShadowSelection, limit: number): Promise<{ refs: ShadowOrderRef[]; unresolved: string[] }>
  loadWcOrder(ref: ShadowOrderRef): Promise<{ ok: true; wc: ShadowWcOrder } | { ok: false; code: string }>
  buildIms(ref: ShadowOrderRef, wc: ShadowWcOrder): Promise<ShadowImsBuild>
  /** THE ONLY XERO CALL, and a GET: find the sales invoice under this number and return it with its lines. */
  fetchXeroInvoice(invoiceNumber: string): Promise<ShadowXeroFetch>
}

export type ShadowOrderResult = {
  orderNumber: string
  status: ShadowStatus
  /** Why IMS refused, or why the order could not be compared. Written by IMS; never a vendor's words. */
  detail: string | null
  boundary: boolean
  route: string | null
  regime: string | null
  stampSource: 'stored' | 'provisional' | 'none' | null
  warningCodes: string[]
  xeroStatus: string | null
  comparison: InvoiceComparison | null
}

export type ShadowReport = {
  maxOrders: number
  truncated: boolean
  unresolved: string[]
  skippedNotEu: number
  results: ShadowOrderResult[]
  counts: Record<ShadowStatus, number>
}

/** What to do about a closed code, said in IMS's own words. */
const CODE_HINTS: Record<string, string> = {
  xero_token_expired: 'Xero access token expired; open IMS Sync once to refresh, then rerun',
  xero_not_connected: 'Xero is not connected',
  xero_tenant_blocked: 'the stored Xero connection is refused by the tenant guard',
}

const emptyCounts = (): Record<ShadowStatus, number> => ({ match: 0, differs: 0, review: 0, no_xero_doc: 0, ims_refused: 0, not_comparable: 0 })

const blank = (orderNumber: string, status: ShadowStatus, detail: string | null): ShadowOrderResult => ({
  orderNumber, status, detail, boundary: false, route: null, regime: null, stampSource: null, warningCodes: [], xeroStatus: null, comparison: null,
})

export async function runEuVatShadow(ports: ShadowPorts, options: { selection: ShadowSelection; maxOrders: number }): Promise<ShadowReport> {
  const maxOrders = Math.min(Math.max(1, Math.floor(options.maxOrders)), SHADOW_HARD_MAX_ORDERS)
  // One more than the cap is asked for, so a selection larger than the cap is reported as truncated rather than looking complete.
  const listed = await ports.listOrders(options.selection, maxOrders + 1)
  const truncated = listed.refs.length > maxOrders
  const refs = listed.refs.slice(0, maxOrders)
  const report: ShadowReport = { maxOrders, truncated, unresolved: listed.unresolved, skippedNotEu: 0, results: [], counts: emptyCounts() }

  for (const ref of refs) {
    const result = await runOne(ports, ref)
    if (result === 'not_eu') { report.skippedNotEu += 1; continue }
    report.results.push(result)
    report.counts[result.status] += 1
  }
  return report
}

async function runOne(ports: ShadowPorts, ref: ShadowOrderRef): Promise<ShadowOrderResult | 'not_eu'> {
  const loaded = await ports.loadWcOrder(ref)
  if (!loaded.ok) return blank(ref.orderNumber, 'not_comparable', `the WooCommerce order could not be read (${loaded.code})`)
  const destination = normaliseDestination(loaded.wc.destination)
  if (!SCHEME_DESTINATIONS.has(destination)) return 'not_eu'

  const built = await ports.buildIms(ref, loaded.wc)
  if (built.kind === 'refused') return blank(ref.orderNumber, 'ims_refused', built.reason)

  const boundary = isBoundaryOrder(built.warnings)
  const base: ShadowOrderResult = { ...blank(ref.orderNumber, 'match', null), boundary, route: built.route, regime: built.regime, stampSource: built.stampSource, warningCodes: built.warnings.map((w) => w.code) }

  if (loaded.wc.invoiceNumber === null || loaded.wc.invoiceNumber.trim() === '') {
    return { ...base, status: 'not_comparable', detail: 'the order has no invoice number yet (`_wcpdf_invoice_number`), so there is no Xero invoice to look for' }
  }
  const fetched = await ports.fetchXeroInvoice(loaded.wc.invoiceNumber.trim())
  if (fetched.kind === 'none') return { ...base, status: 'no_xero_doc', detail: 'Xero holds no sales invoice under this order’s number' }
  if (fetched.kind === 'ambiguous') return { ...base, status: 'not_comparable', detail: `Xero holds ${fetched.count} documents under this order’s number, so none can be chosen` }
  if (fetched.kind === 'error') return { ...base, status: 'not_comparable', detail: `the Xero invoice could not be read (${fetched.code})${CODE_HINTS[fetched.code] ? `: ${CODE_HINTS[fetched.code]}` : ''}` }

  const reading = comparableFromXeroInvoice(fetched.invoice)
  if (!reading.ok) return { ...base, status: 'not_comparable', detail: reading.reason }
  if (reading.status === 'VOIDED' || reading.status === 'DELETED') return { ...base, status: 'no_xero_doc', xeroStatus: reading.status, detail: `the only Xero document under this number is ${reading.status}` }

  const comparison = compareComparableInvoices(built.invoice, reading.invoice)
  const status = statusOfComparison(comparison, boundary)
  return { ...base, status, xeroStatus: reading.status, comparison, detail: status === 'not_comparable' ? `not fully compared: ${comparison.incomplete.join('; ')}` : null }
}

/** The exit code of a finished report: 0 only when every order matched; 1 when anything differs, needs review (boundary), was refused by IMS, has no Xero document or could not be compared, or the selection was cut short or not fully resolved. A `review` order is accepted by a person, not by the exit code. */
export function shadowExitCode(report: ShadowReport): 0 | 1 {
  const c = report.counts
  return c.differs + c.review + c.ims_refused + c.no_xero_doc + c.not_comparable > 0 || report.truncated || report.unresolved.length > 0 ? 1 : 0
}
