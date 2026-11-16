/**
 * THE PURCHASE ORDER DOCUMENT: the pure layout and totals helpers, and the decision of whether "Confirm & Send PO" mails the supplier.
 *
 * The PDF route (/api/purchase-order/[id]), the outbox email and the Settings > Documents preview all render the SAME
 * `PurchaseOrderDocument` through these helpers, so the preview shows what a real order looks like. No database, no clock, no PDF
 * runtime: everything here is plain numbers and strings.
 */

export type PoDocumentLine = {
  sku: string
  name: string
  barcode: string | null
  mpn: string | null
  /** The supplier's own SKU for the product, when the supplier catalogue holds one. */
  supplierSku: string | null
  /** Quantity in STOCK units. */
  qty: number
  /** Quantity in purchase units (boxes, rolls), when the line was ordered that way. */
  purchaseUnitQty: number | null
  purchaseUnitAbbreviation: string | null
  stockUnitName: string | null
  /** Net cost per STOCK unit, ALREADY after the line discount, so qty x unitCost = total. The discount is never shown beside it (that read as taken twice); it is in the totals block. */
  unitCost: number
  /** The line discount, in the order currency (0 when none). */
  discountAmount: number
  /** The line's net total. */
  total: number
  /**
   * The line's delivery date, set ONLY when it differs from the order's header date (lib/domain/purchasing/line-eta.ts); null/omitted
   * when the line simply follows the header. Any line carrying one switches the "Delivery" column on for the whole document.
   */
  deliveryDate?: Date | null
}

export type PoDocumentTotals = {
  /** Sum of the line nets; the stored subtotal is already after line and order discounts. */
  subtotal: number
  lineDiscounts: number
  orderDiscount: number
  tax: number
  taxLabel: string
  additionalCosts: number
  total: number
}

export type PoDocumentAddress = { name: string; address: string }

export type PoMoney = (amount: number) => string

export type PoColumn = { label: string; width: number; align?: 'left' | 'right'; wrap?: boolean }
export type PoTotalsRow = { label: string; amount: string; strong?: boolean; muted?: boolean }

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/** Page content width is 495pt (A4 less 50pt margins); the columns below add up to it. */
export function poDocumentColumns(symbol: string, opts: { showSupplierSku: boolean; showPurchaseUnits: boolean; showLineEta?: boolean }): PoColumn[] {
  const cols: PoColumn[] = [
    { label: '#', width: 22, align: 'right' },
    { label: 'SKU', width: 62 },
  ]
  if (opts.showSupplierSku) cols.push({ label: 'Supplier SKU', width: 62 })
  cols.push({ label: 'Product', width: 0, wrap: true }) // width is filled below
  cols.push({ label: 'Barcode / EAN', width: 66 })
  cols.push({ label: 'Qty', width: opts.showPurchaseUnits ? 64 : 40, align: 'right' })
  cols.push({ label: opts.showPurchaseUnits ? `Cost/unit (${symbol})` : `Unit cost (${symbol})`, width: 56, align: 'right' })
  if (opts.showLineEta) cols.push({ label: 'Delivery', width: 56, align: 'right' })
  cols.push({ label: `Total (${symbol})`, width: 56, align: 'right' })
  const fixed = cols.reduce((s, c) => s + c.width, 0)
  const product = cols.find((c) => c.label === 'Product')!
  product.width = Math.max(60, 495 - fixed)
  return cols
}

/** The quantity cell: purchase-unit orders show both ("2 box (200 pcs)"), others just the number. */
export function formatPoQty(line: Pick<PoDocumentLine, 'qty' | 'purchaseUnitQty' | 'purchaseUnitAbbreviation' | 'stockUnitName'>): string {
  if (line.purchaseUnitQty != null && line.purchaseUnitAbbreviation) {
    return `${line.purchaseUnitQty} ${line.purchaseUnitAbbreviation} (${line.qty} ${line.stockUnitName ?? 'pcs'})`
  }
  return String(line.qty)
}

export function poDocumentRows(
  lines: readonly PoDocumentLine[],
  opts: { showSupplierSku: boolean; showLineEta?: boolean; formatDate?: (d: Date) => string },
): string[][] {
  return lines.map((l, i) => {
    const row = [String(i + 1), l.sku]
    if (opts.showSupplierSku) row.push(l.supplierSku ?? '—')
    row.push(l.name, l.barcode ?? '—', formatPoQty(l), l.unitCost.toFixed(2))
    if (opts.showLineEta) row.push(l.deliveryDate ? (opts.formatDate ?? isoDay)(l.deliveryDate) : '—')
    row.push(l.total.toFixed(2))
    return row
  })
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10)

export function poLayoutFlags(lines: readonly PoDocumentLine[]): { showSupplierSku: boolean; showPurchaseUnits: boolean; showLineEta: boolean } {
  return {
    showLineEta: lines.some((l) => l.deliveryDate != null),
    showSupplierSku: lines.some((l) => l.supplierSku),
    showPurchaseUnits: lines.some((l) => l.purchaseUnitQty != null && l.purchaseUnitAbbreviation),
  }
}

/**
 * The totals block, in the order the order page shows it. The stored subtotal is already after the line and header discounts, so
 * the discount row is informational ("included above") and is never subtracted a second time.
 */
export function poTotalsRows(t: PoDocumentTotals, money: PoMoney): PoTotalsRow[] {
  const rows: PoTotalsRow[] = [{ label: 'Subtotal (after discounts)', amount: money(t.subtotal) }]
  const discounts = round2(t.lineDiscounts + t.orderDiscount)
  if (discounts > 0) {
    const detail = t.lineDiscounts > 0 && t.orderDiscount > 0
      ? ` (lines ${money(t.lineDiscounts)} + order ${money(t.orderDiscount)})`
      : t.orderDiscount > 0 ? ' (order)' : ' (lines)'
    rows.push({ label: `Discounts included above${detail}`, amount: money(discounts), muted: true })
  }
  if (t.tax > 0) rows.push({ label: t.taxLabel, amount: money(t.tax) })
  if (t.additionalCosts > 0) rows.push({ label: 'Additional costs', amount: money(t.additionalCosts) })
  rows.push({ label: 'Total', amount: money(t.total), strong: true })
  return rows
}

export function poTaxLabel(name: string | null, ratePercent: number | null): string {
  return `${name ?? 'VAT'}${ratePercent != null ? ` (${(ratePercent * 100).toFixed(0)}%)` : ''}`
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export const PO_EMAIL_SETTING_KEY = 'purchase_order_email_enabled'
export const PO_EMAIL_DISABLED_MESSAGE = 'PO confirmed. Emailing POs to suppliers is switched off (Settings > Documents); download the PO PDF and send it to the supplier directly.'
export const PO_EMAIL_DISABLED_REASON = 'Not sent: emailing purchase orders to suppliers is switched off (Settings > Documents)'

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type PoSendDecision =
  | { action: 'queue'; to: string }
  | { action: 'skip'; reason: 'no_supplier_email' | 'invalid_supplier_email' }

/** Whether the confirmed order can be mailed: it needs a plausible supplier address. Never throws. */
export function decidePoSend(supplierEmail: string | null | undefined): PoSendDecision {
  const to = (supplierEmail ?? '').trim()
  if (!to) return { action: 'skip', reason: 'no_supplier_email' }
  if (!EMAIL_SHAPE.test(to)) return { action: 'skip', reason: 'invalid_supplier_email' }
  return { action: 'queue', to }
}

export type PoSendStatus = 'disabled' | 'queued' | 'already_queued' | 'no_supplier_email' | 'invalid_supplier_email' | 'failed'
export type PoSendResult = { status: PoSendStatus; to?: string; message: string }

export type PoSendDeps = {
  /** Whether emailing POs to suppliers is switched on (setting `purchase_order_email_enabled`, default OFF). */
  isEnabled: () => Promise<boolean>
  /** Enqueue the email on the outbox. Returns whether a new row was written (false = an undelivered one already exists). */
  queue: (to: string) => Promise<{ queued: boolean }>
}

/**
 * The send step of "Confirm & Send PO", run AFTER the status change has committed. It never throws: a failed enqueue is a result
 * the caller shows, not an error that undoes the confirmation. "queued" means the outbox holds the email; it is delivered by the
 * outbox drain, under the installation's own SMTP settings and suppression list, so it is not a claim that the supplier has it yet.
 */
export async function runPoSend(supplierEmail: string | null | undefined, deps: PoSendDeps): Promise<PoSendResult> {
  let enabled = false
  try { enabled = await deps.isEnabled() } catch { enabled = false }
  if (!enabled) return { status: 'disabled', message: PO_EMAIL_DISABLED_MESSAGE }
  const decision = decidePoSend(supplierEmail)
  if (decision.action === 'skip') {
    return decision.reason === 'no_supplier_email'
      ? { status: 'no_supplier_email', message: 'The order is confirmed, but the supplier has no email address, so nothing was sent. Add one on the supplier and use "Email PO", or download the PO PDF and send it to the supplier directly.' }
      : { status: 'invalid_supplier_email', message: 'The order is confirmed, but the supplier\'s email address is not valid, so nothing was sent. Correct it on the supplier and use "Email PO".' }
  }
  try {
    const outcome = await deps.queue(decision.to)
    return outcome.queued
      ? { status: 'queued', to: decision.to, message: `The order is confirmed and the PO PDF is queued to be emailed to ${decision.to}.` }
      : { status: 'already_queued', to: decision.to, message: `The order is confirmed. A PO email to ${decision.to} is already queued and not yet delivered, so no second one was added.` }
  } catch (e) {
    return { status: 'failed', to: decision.to, message: `The order is confirmed, but the email could not be queued (${e instanceof Error ? e.message : String(e)}). Use "Email PO" to retry.` }
  }
}
