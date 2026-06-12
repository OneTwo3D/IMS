import { accountingPayloadKey } from '@/lib/accounting/payload-key'
import { roundQuantity } from '@/lib/domain/math/decimal'

export type PurchaseInvoiceEditHeader = {
  invoiceNumber: string | null
  invoiceDate: string | null
  dueDate: string | null
  notes: string | null
  supplierInvoiceUrl: string | null
}

export type PurchaseInvoiceEditLine = {
  id: string
  description: string | null
  qtyBilled: number
  unitCostForeign: number
  totalForeign: number
}

export type PurchaseInvoicePoLine = {
  id: string
  qty: unknown
  /**
   * Quantity received against this PO line. With qtyReturned, drives the
   * three-way match guard: a line can only be billed up to the NET received
   * quantity (received − returned), not the ordered quantity, so goods sent
   * back as defective before invoicing are not billable. Optional so legacy
   * callers still typecheck; when absent the guard falls back to the ordered
   * quantity cap.
   */
  qtyReceived?: unknown
  /**
   * Quantity returned to the supplier. Subtracted from qtyReceived to get the
   * billable net. Optional; treated as 0 when absent.
   */
  qtyReturned?: unknown
  product: { sku: string }
  taxRate?: { accountingTaxType: string | null; reverseCharge?: boolean } | null
}

export type PurchaseInvoiceCostLine = {
  id: string
  description: string
  amountForeign: unknown
  vatable: boolean
}

export type PurchaseInvoiceInputLine =
  | {
      kind: 'product'
      id?: string
      poLineId: string
      qtyBilled: number
      unitCostForeign: number
    }
  | {
      kind: 'cost'
      id?: string
      costLineId: string
      description?: string | null
      amountForeign: number
    }

export type PurchaseInvoiceLineDraft = {
  id?: string
  poLineId: string | null
  costLineId: string | null
  description: string | null
  qtyBilled: number
  unitCostForeign: number
  totalForeign: number
  totalBase: number
}

export type PurchaseInvoiceAccountingLine = {
  description: string
  quantity: number
  unitAmount: number
  accountCode: string
  taxType?: string
}

export type PurchaseInvoiceCalculation = {
  lineData: PurchaseInvoiceLineDraft[]
  accountingLines: PurchaseInvoiceAccountingLine[]
  subtotalForeign: number
  subtotalBase: number
  taxForeign: number
  taxBase: number
  totalForeign: number
  totalBase: number
}

export type PurchaseInvoiceAccountingPayload = {
  accountingInvoiceId?: string
  invoiceNumber: string
  contactName: string
  date: string
  dueDate?: string
  currency: string
  currencyRateToBase?: number
  reference?: string
  lines: PurchaseInvoiceAccountingLine[]
  supplierInvoicePath?: string
}

export type ExistingPurchaseInvoiceLine = {
  poLineId: string | null
  costLineId: string | null
  qtyBilled: unknown
  totalForeign: unknown
}

export function assertPurchaseInvoiceEditable(invoice: { paidAt: Date | string | null }): void {
  if (invoice.paidAt) throw new Error('Paid bills cannot be edited')
}

export function dateKey(value: Date | string | null | undefined): string | null {
  if (!value) return null
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10)
}

export function optionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function rounded4(value: number): number {
  return roundQuantity(value, 4).toNumber()
}

function assertPositiveFxRate(fxRate: number): void {
  if (!Number.isFinite(fxRate) || fxRate <= 0) {
    throw new Error('Invalid FX rate')
  }
}

export function calculatePurchaseInvoice(params: {
  lines: PurchaseInvoiceInputLine[]
  fxRateToBase: number
  poReference: string
  poSubtotalForeign: number
  poTaxForeign: number
  transitAccount: string
  fallbackTaxType?: string
  /**
   * Accounting tax type to use when a line's resolved TaxRate has
   * reverseCharge=true. Falls back to the line's normal taxType (or
   * fallbackTaxType) when empty — defensive default so the bill still
   * posts even if the admin hasn't configured the swap yet.
   */
  reverseChargeTaxType?: string
  poLineById: Map<string, PurchaseInvoicePoLine>
  costLineById: Map<string, PurchaseInvoiceCostLine>
}): PurchaseInvoiceCalculation {
  assertPositiveFxRate(params.fxRateToBase)

  let subtotalForeign = 0
  let subtotalBase = 0
  let taxBaseForeign = 0
  const lineData: PurchaseInvoiceLineDraft[] = []
  const accountingLines: PurchaseInvoiceAccountingLine[] = []

  for (const line of params.lines) {
    if (line.kind === 'product') {
      const poLine = params.poLineById.get(line.poLineId)
      if (!poLine) throw new Error(`Unknown PO line ${line.poLineId}`)
      if (!Number.isFinite(line.qtyBilled) || line.qtyBilled <= 0) {
        throw new Error(`Invalid quantity for ${poLine.product.sku}`)
      }
      if (!Number.isFinite(line.unitCostForeign) || line.unitCostForeign < 0) {
        throw new Error(`Invalid unit cost for ${poLine.product.sku}`)
      }

      const totalForeign = rounded4(line.qtyBilled * line.unitCostForeign)
      const totalBase = rounded4(totalForeign / params.fxRateToBase)
      subtotalForeign += totalForeign
      subtotalBase += totalBase
      taxBaseForeign += totalForeign

      lineData.push({
        id: line.id,
        poLineId: line.poLineId,
        costLineId: null,
        description: null,
        qtyBilled: line.qtyBilled,
        unitCostForeign: line.unitCostForeign,
        totalForeign,
        totalBase,
      })
      const baseTaxType = poLine.taxRate?.accountingTaxType ?? params.fallbackTaxType
      const productTaxType = poLine.taxRate?.reverseCharge && params.reverseChargeTaxType
        ? params.reverseChargeTaxType
        : baseTaxType
      accountingLines.push({
        description: `PO ${params.poReference} line`,
        quantity: line.qtyBilled,
        unitAmount: rounded4(line.unitCostForeign),
        accountCode: params.transitAccount,
        taxType: productTaxType,
      })
      continue
    }

    const costLine = params.costLineById.get(line.costLineId)
    if (!costLine) throw new Error(`Unknown cost line ${line.costLineId}`)
    if (!Number.isFinite(line.amountForeign) || line.amountForeign <= 0) {
      throw new Error(`Invalid amount for ${costLine.description}`)
    }

    const description = optionalText(line.description ?? costLine.description) ?? costLine.description
    const totalForeign = rounded4(line.amountForeign)
    const totalBase = rounded4(totalForeign / params.fxRateToBase)
    subtotalForeign += totalForeign
    subtotalBase += totalBase
    if (costLine.vatable) taxBaseForeign += totalForeign

    lineData.push({
      id: line.id,
      poLineId: null,
      costLineId: line.costLineId,
      description,
      qtyBilled: 1,
      unitCostForeign: totalForeign,
      totalForeign,
      totalBase,
    })
    accountingLines.push({
      description,
      quantity: 1,
      unitAmount: totalForeign,
      accountCode: params.transitAccount,
      taxType: costLine.vatable ? params.fallbackTaxType : undefined,
    })
  }

  const taxRate = params.poSubtotalForeign > 0 ? params.poTaxForeign / params.poSubtotalForeign : 0
  const taxForeign = rounded4(taxBaseForeign * taxRate)
  const taxBase = rounded4(taxForeign / params.fxRateToBase)

  return {
    lineData,
    accountingLines,
    subtotalForeign: rounded4(subtotalForeign),
    subtotalBase: rounded4(subtotalBase),
    taxForeign,
    taxBase,
    totalForeign: rounded4(subtotalForeign + taxForeign),
    totalBase: rounded4(subtotalBase + taxBase),
  }
}

export function buildPurchaseInvoiceAccountingPayload(params: {
  accountingInvoiceId?: string | null
  poReference: string
  contactName: string | null | undefined
  date: string
  dueDate?: string | null
  currency: string
  fxRateToBase: number
  reference?: string | null
  lines: PurchaseInvoiceAccountingLine[]
  supplierInvoicePath?: string | null
}): PurchaseInvoiceAccountingPayload {
  return {
    accountingInvoiceId: params.accountingInvoiceId ?? undefined,
    invoiceNumber: params.poReference,
    contactName: params.contactName ?? 'Unknown Supplier',
    date: params.date,
    dueDate: params.dueDate ?? undefined,
    currency: params.currency,
    currencyRateToBase: Number(params.fxRateToBase) || undefined,
    reference: params.reference ?? undefined,
    lines: params.lines,
    supplierInvoicePath: params.supplierInvoicePath ?? undefined,
  }
}

export function validatePurchaseInvoiceLineLimits(params: {
  lineData: PurchaseInvoiceLineDraft[]
  alreadyBilledLines: ExistingPurchaseInvoiceLine[]
  poLineById: Map<string, PurchaseInvoicePoLine>
  costLineById: Map<string, PurchaseInvoiceCostLine>
  /**
   * When false (the default), product lines may only be billed up to the
   * received quantity — the three-way match control (PO ↔ receipt ↔ bill).
   * When true, billing is capped at the ordered quantity instead, which is
   * the legacy behaviour and is intended only for operators who deliberately
   * raise deposit / pro-forma bills before goods arrive. Driven by the
   * `purchasing_allow_bill_before_receipt` setting at the action layer.
   *
   * The cap only relaxes to the ordered quantity when a PO line has a known
   * qtyReceived; lines whose qtyReceived is undefined (legacy callers that
   * don't select it) always fall back to the ordered-quantity cap regardless
   * of this flag, preserving prior behaviour.
   */
  allowBillBeforeReceipt?: boolean
}): void {
  const alreadyProductByLine = new Map<string, number>()
  const alreadyCostByLine = new Map<string, number>()

  for (const existingLine of params.alreadyBilledLines) {
    if (existingLine.poLineId) {
      alreadyProductByLine.set(
        existingLine.poLineId,
        (alreadyProductByLine.get(existingLine.poLineId) ?? 0) + Number(existingLine.qtyBilled),
      )
    }
    if (existingLine.costLineId) {
      alreadyCostByLine.set(
        existingLine.costLineId,
        (alreadyCostByLine.get(existingLine.costLineId) ?? 0) + Number(existingLine.totalForeign),
      )
    }
  }

  for (const line of params.lineData) {
    if (line.poLineId) {
      const poLine = params.poLineById.get(line.poLineId)
      if (!poLine) throw new Error(`Unknown PO line ${line.poLineId}`)
      const already = alreadyProductByLine.get(line.poLineId) ?? 0
      const orderedQty = Number(poLine.qty)
      // Three-way match: cap at the NET received quantity (received − returned)
      // unless the supplier is prepaid (allowBillBeforeReceipt). Goods returned
      // to the supplier before invoicing are not billable. Fall back to the
      // ordered quantity when qtyReceived is unknown (un-migrated caller).
      const receivedKnown = poLine.qtyReceived !== undefined && poLine.qtyReceived !== null
      const netReceived = Number(poLine.qtyReceived ?? 0) - Number(poLine.qtyReturned ?? 0)
      const cap = (!params.allowBillBeforeReceipt && receivedKnown)
        ? netReceived
        : orderedQty
      if (already + line.qtyBilled > cap + 1e-6) {
        const billedSoFar = already > 0 ? ` (${already} already billed)` : ''
        const reason = (!params.allowBillBeforeReceipt && receivedKnown && cap < orderedQty)
          ? `exceeds net received qty ${cap}${billedSoFar} — only received, un-returned goods can be billed`
          : `exceeds remaining qty${billedSoFar}`
        throw new Error(`Line ${poLine.product.sku} ${reason}`)
      }
    }
    if (line.costLineId) {
      const costLine = params.costLineById.get(line.costLineId)
      if (!costLine) throw new Error(`Unknown cost line ${line.costLineId}`)
      const already = alreadyCostByLine.get(line.costLineId) ?? 0
      if (already + line.totalForeign > Number(costLine.amountForeign) + 1e-4) {
        throw new Error(`Cost line "${costLine.description}" exceeds remaining amount`)
      }
    }
  }
}

export function purchaseInvoiceLineChangeSnapshot(line: PurchaseInvoiceLineDraft | PurchaseInvoiceEditLine): PurchaseInvoiceEditLine {
  return {
    id: line.id ?? '',
    description: optionalText(line.description),
    qtyBilled: line.qtyBilled,
    unitCostForeign: line.unitCostForeign,
    totalForeign: line.totalForeign,
  }
}

function sortedLines(lines: PurchaseInvoiceEditLine[]): PurchaseInvoiceEditLine[] {
  return [...lines].sort((a, b) => a.id.localeCompare(b.id))
}

export function hasPurchaseInvoiceEditChanges(params: {
  existingHeader: PurchaseInvoiceEditHeader
  nextHeader: PurchaseInvoiceEditHeader
  existingLines: PurchaseInvoiceEditLine[]
  nextLines: PurchaseInvoiceEditLine[]
}): boolean {
  return JSON.stringify(params.existingHeader) !== JSON.stringify(params.nextHeader)
    || JSON.stringify(sortedLines(params.existingLines)) !== JSON.stringify(sortedLines(params.nextLines))
}

export function buildPurchaseInvoiceUpdateIdempotencyKey(params: {
  invoiceId: string
  accountingInvoiceId: string
  payload: Record<string, unknown>
}): string {
  return accountingPayloadKey(
    `purchase-invoice-update:${params.invoiceId}:${params.accountingInvoiceId}`,
    params.payload,
  )
}
