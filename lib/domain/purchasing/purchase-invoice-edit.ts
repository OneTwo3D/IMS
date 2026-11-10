import { accountingPayloadKey } from '@/lib/accounting/payload-key'
import { rateBinding, resolvePurchaseLineTaxType } from '@/lib/accounting/reverse-charge'
import { usableStoredFxRate } from '@/lib/currencies/stored-document-rate'
import { addMoney, multiplyMoney, roundMoney, roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { noVatRateKind, type PurchaseNoTaxLineKind } from '@/lib/domain/accounting/purchase-document-tax-types'
import { effectiveTaxRateFromComponents } from '@/lib/tax/tax-rate-components'

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
  /**
   * The line's own rate. `rate` is the stored fraction (0.2 = 20%). A compound rate has active `components`, and ITS effective rate is derived from
   * them with the compound-rate maths the sales side and the tax-rate code use (lib/tax/tax-rate-components.ts), never from a line's rounded tax over its net.
   */
  taxRate?: { id?: string; accountingTaxType: string | null; reverseCharge?: boolean; rate?: unknown; isCompound?: boolean; components?: ReadonlyArray<{ rate: unknown; compoundOnPrevious?: boolean }> } | null
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
  /** Why this line may carry NONE (lib/domain/accounting/purchase-document-tax-types.ts); never sent to the ledger. */
  noTaxKind?: PurchaseNoTaxLineKind
  /** The rate `taxType` was read from; never sent (the enqueue guard binds the code to it, lib/tax/retired-tax-code-guard.ts). */
  taxRateId?: string
  /** How `taxType` was derived from that rate (lib/accounting/reverse-charge.ts TaxBindingBasis); never sent. */
  taxRateBasis?: string
}

/** The VAT rate each accounting line was taxed at in IMS, aligned with `accountingLines`, so it can be checked against the rate its tax code charges. */
export type PurchaseInvoiceLineTaxRate = {
  description: string
  taxType: string | undefined
  /** Fraction (0.2 = 20%). */
  rate: number
  /** False for a reverse-charge line, whose code is a self-accounting one whose ledger rate is not the supplier's charge. */
  checkable: boolean
}

export type PurchaseInvoiceCalculation = {
  lineData: PurchaseInvoiceLineDraft[]
  accountingLines: PurchaseInvoiceAccountingLine[]
  lineTaxRates: PurchaseInvoiceLineTaxRate[]
  subtotalForeign: number
  subtotalBase: number
  taxForeign: number
  taxBase: number
  totalForeign: number
  totalBase: number
}

export type PurchaseInvoiceAccountingPayload = {
  accountingInvoiceId?: string
  /**
   * The SUPPLIER's invoice number — which is what Xero's ACCPAY InvoiceNumber means: their
   * document, not ours. Optional, because the buyer is not obliged to enter it (the Create Bill
   * form marks the date required and this field not).
   */
  invoiceNumber?: string
  contactName: string
  date: string
  dueDate?: string
  currency: string
  currencyRateToBase?: number
  /** OUR purchase order reference — how a bill is traced back to its PO from the ledger side. */
  reference: string
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

function rounded4(value: DecimalInput): number {
  return roundQuantity(value, 4).toNumber()
}

function assertPositiveFxRate(fxRate: number): void {
  if (!Number.isFinite(fxRate) || fxRate <= 0) {
    throw new Error('Invalid FX rate')
  }
}

/**
 * A goods line's OWN VAT rate, as a fraction. A rate with active components takes its effective rate from them (the existing compound-rate maths); a simple
 * rate is its stored value; a line with no rate row takes the order's rate. On a FREIGHT order every line is taxed at the order's recorded rate.
 */
export function purchaseLineOwnRate(poLine: PurchaseInvoicePoLine, orderRate: Decimal, freightOrder: boolean): Decimal {
  if (freightOrder) return orderRate
  const rate = poLine.taxRate
  if (!rate) return orderRate
  const components = (rate.components ?? []).map((component) => ({ rate: Number(component.rate), compoundOnPrevious: component.compoundOnPrevious === true }))
  if (components.length > 0) {
    const effective = effectiveTaxRateFromComponents(components)
    if (effective != null) return toDecimal(effective)
  }
  return rate.rate != null ? toDecimal(String(rate.rate)) : orderRate
}

export function calculatePurchaseInvoice(params: {
  lines: PurchaseInvoiceInputLine[]
  fxRateToBase: number
  /**
   * The bill's currency. VAT is worked out PER LINE and rounded to this currency's minor unit, the way the ledger computes tax on an exclusive line, and the
   * header tax is the sum of those rounded line amounts (three lines of 0.03 at 20% are 0.01 each, 0.03, not 0.018). Defaults to a two-decimal currency.
   */
  currency?: string
  poReference: string
  /**
   * The order's recorded VAT rate (a fraction; null = none). It is the rate its vatable cost lines (freight, duty, handling) were
   * charged at, and what a FREIGHT order's lines are all taxed at. THERE IS NO BLENDED RATE: the bill's VAT is each billed line's
   * own rate on its own net (a goods line its rate, a vatable cost line this one), never `order tax / order subtotal` - the order's tax
   * includes the cost lines' VAT while its subtotal does not (100 of goods at 20% plus 50 of vatable freight is a blended 30%, 45 of
   * VAT instead of 30), and a part-billed mixed-rate order has no single rate at all.
   */
  poType?: string
  poTaxRatePercent?: number | string | null
  transitAccount: string
  /**
   * The tax type of the rate the ORDER was charged at (lib/domain/purchasing/order-rate-tax-code.ts), NOT the supplier's current default: it
   * is the code of every vatable cost line and of a goods line with no rate row, whose VAT is taken at `poTaxRatePercent`. Undefined when no
   * code can be shown to agree with that rate, which leaves those lines without a type (refused downstream).
   */
  fallbackTaxType?: string
  /** The rate `fallbackTaxType` was read from, bound beside the code for the enqueue guard (lib/tax/retired-tax-code-guard.ts). */
  fallbackTaxRateId?: string
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

  // Accumulate AP base/foreign totals in Decimal so the invoice header reconciles
  // to the sum of its stored line bases (cogs-audit scjz.59). Float division and
  // `+=` accumulation could drift the header a penny from its lines.
  let subtotalForeign = toDecimal(0)
  let subtotalBase = toDecimal(0)
  let taxForeignSum = toDecimal(0)
  const orderRate = toDecimal(params.poTaxRatePercent ?? 0)
  const currency = params.currency ?? 'GBP'
  const lineData: PurchaseInvoiceLineDraft[] = []
  const accountingLines: PurchaseInvoiceAccountingLine[] = []
  const lineTaxRates: PurchaseInvoiceLineTaxRate[] = []

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

      const totalForeign = rounded4(multiplyMoney(line.qtyBilled, line.unitCostForeign))
      const totalBase = rounded4(toDecimal(totalForeign).div(params.fxRateToBase))
      subtotalForeign = addMoney(subtotalForeign, totalForeign)
      subtotalBase = addMoney(subtotalBase, totalBase)
      const lineRate = purchaseLineOwnRate(poLine, orderRate, params.poType === 'FREIGHT')
      taxForeignSum = addMoney(taxForeignSum, roundMoney(multiplyMoney(totalForeign, lineRate), currency))

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
      // A line with its own rate posts on that rate's code (blank when unmapped: refused downstream). Only a line with NO rate row follows the order's
      // recorded rate, and so its code - never an unmapped own rate falling back to a code of a different rate.
      const baseTaxType = poLine.taxRate ? poLine.taxRate.accountingTaxType : params.fallbackTaxType
      const productTaxType = resolvePurchaseLineTaxType({
        baseTaxType,
        reverseCharge: poLine.taxRate?.reverseCharge,
        reverseChargePurchaseTaxType: params.reverseChargeTaxType,
      })
      lineTaxRates.push({ description: `PO ${params.poReference} line`, taxType: productTaxType, rate: lineRate.toNumber(), checkable: !poLine.taxRate?.reverseCharge })
      accountingLines.push({
        description: `PO ${params.poReference} line`,
        quantity: line.qtyBilled,
        unitAmount: rounded4(line.unitCostForeign),
        accountCode: params.transitAccount,
        taxType: productTaxType,
        // A NONE that came out of the line's own (or the supplier's default) rate is that rate's decision, so it names its kind; a blank
        // is left blank and refused by the poster.
        ...(noVatRateKind(productTaxType) ? { noTaxKind: noVatRateKind(productTaxType) } : {}),
        // The rate that code was read from (never sent), with the basis it was derived on: the line's own rate is a purchase goods line (reverse-charge swap), the supplier default is plain.
        ...(poLine.taxRate?.id ? rateBinding(poLine.taxRate.id, 'purchase_line') : rateBinding(params.fallbackTaxRateId, 'plain')),
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
    const totalBase = rounded4(toDecimal(totalForeign).div(params.fxRateToBase))
    subtotalForeign = addMoney(subtotalForeign, totalForeign)
    subtotalBase = addMoney(subtotalBase, totalBase)
    if (costLine.vatable) taxForeignSum = addMoney(taxForeignSum, roundMoney(multiplyMoney(totalForeign, orderRate), currency))

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
    lineTaxRates.push({ description, taxType: costLine.vatable ? params.fallbackTaxType : 'NONE', rate: costLine.vatable ? orderRate.toNumber() : 0, checkable: true })
    accountingLines.push({
      description,
      quantity: 1,
      unitAmount: totalForeign,
      accountCode: params.transitAccount,
      // A vatable cost line takes the supplier's default type, and REFUSES downstream when there is none; a cost line the order flags as
      // not vatable is a decided No VAT. Neither is a default.
      taxType: costLine.vatable ? params.fallbackTaxType : 'NONE',
      ...(costLine.vatable
        ? (noVatRateKind(params.fallbackTaxType) ? { noTaxKind: noVatRateKind(params.fallbackTaxType) } : {})
        : { noTaxKind: 'cost-not-vatable' as const }),
      ...rateBinding(costLine.vatable ? params.fallbackTaxRateId : undefined, 'plain'),
    })
  }

  // The header tax is the sum of each billed line's own tax, each already rounded to the currency's minor unit (as the ledger does), so the header, the
  // total and the base figure are all recomputed from the rounded lines.
  const taxForeign = rounded4(taxForeignSum)
  const taxBase = rounded4(toDecimal(taxForeign).div(params.fxRateToBase))

  return {
    lineData,
    accountingLines,
    lineTaxRates,
    subtotalForeign: rounded4(subtotalForeign),
    subtotalBase: rounded4(subtotalBase),
    taxForeign,
    taxBase,
    totalForeign: rounded4(addMoney(subtotalForeign, taxForeign)),
    totalBase: rounded4(addMoney(subtotalBase, taxBase)),
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
    // THE SUPPLIER'S NUMBER GOES IN InvoiceNumber; OUR PO REFERENCE GOES IN Reference (o3d-6l3).
    //
    // These were the wrong way round, and it destroyed data. Xero's POST /Invoices UPSERTS on
    // InvoiceNumber, so sending our PO reference — identical for every bill raised against that
    // PO — meant the second instalment did not create a bill: it OVERWROTE the first and returned
    // its InvoiceID. Two GBP 25 bills became one GBP 25 bill carrying the later reference, with
    // no error on either side, while the IMS recorded both as SYNCED. Payables understated by
    // every instalment but the last. Proven against the live ledger: the invoice bill #1 claimed
    // came back holding bill #2's reference.
    //
    // The supplier's invoice number is rarely reused, so this makes the collision rare — but NOT
    // impossible, and the earlier claim that it is "unique by nature" was too strong: Xero
    // documents ACCPAY InvoiceNumber as NON-unique, because suppliers number their own documents.
    // A supplier reusing "123", or a buyer typing it twice, would collide identically. What
    // actually removes the failure mode is pushPurchaseBill using PUT (create-only) rather than
    // POST (update-or-create) — see bills.ts. This mapping fixes the semantics; PUT fixes the
    // consequence of getting them wrong. When the supplier number is absent
    // (the field is optional) InvoiceNumber is simply omitted, which is both honest and safe:
    // Xero cannot upsert on a value that is not there. The PO reference stays on the bill as
    // Reference, so the ledger-side trail back to the PO survives either way.
    invoiceNumber: params.reference?.trim() || undefined,
    contactName: params.contactName ?? 'Unknown Supplier',
    date: params.date,
    dueDate: params.dueDate ?? undefined,
    currency: params.currency,
    // o3d-q0x56.3: the PO's STORED booked rate, or absent (a foreign bill without one is refused at the enqueue and at the connector).
    currencyRateToBase: usableStoredFxRate(params.fxRateToBase)?.toNumber(),
    reference: params.poReference,
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
   * When true, billing is capped at the ordered quantity instead, intended
   * for prepaid / deposit suppliers (Supplier.prepaid) that legitimately
   * bill before goods arrive.
   *
   * The cap only relaxes to the ordered quantity when a PO line has a known
   * qtyReceived; lines whose qtyReceived is undefined (legacy callers that
   * don't select it) always fall back to the ordered-quantity cap regardless
   * of this flag, preserving prior behaviour.
   */
  allowBillBeforeReceipt?: boolean
  /**
   * Quantities already on the invoice being EDITED, keyed by poLineId.
   * Grandfathers existing billing: a line that was legitimately billed under
   * the policy in force at creation (e.g. the supplier was prepaid then, or
   * goods were later returned) stays editable at up to its current quantity
   * even if today's cap is lower. Only INCREASES beyond the grandfathered
   * quantity must satisfy the current cap. The ordered quantity remains a
   * hard ceiling in all cases.
   */
  grandfatheredQtyByPoLineId?: Map<string, number>
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
      // Clamp the net into [0, ordered] so anomalous data (negative returns)
      // can never EXPAND the billable quantity beyond what was ordered.
      const receivedKnown = poLine.qtyReceived !== undefined && poLine.qtyReceived !== null
      const netReceived = Math.min(
        orderedQty,
        Math.max(0, Number(poLine.qtyReceived ?? 0) - Number(poLine.qtyReturned ?? 0)),
      )
      const policyCap = (!params.allowBillBeforeReceipt && receivedKnown)
        ? netReceived
        : orderedQty
      // Grandfather: when editing an existing bill, quantities billed under
      // the policy in force at creation stay valid; only increases beyond the
      // grandfathered quantity have to satisfy today's policy cap. Never
      // above the ordered quantity.
      const grandfathered = params.grandfatheredQtyByPoLineId?.get(line.poLineId) ?? 0
      const effectiveCap = Math.min(orderedQty, Math.max(policyCap, already + grandfathered))
      if (already + line.qtyBilled > effectiveCap + 1e-6) {
        const billedSoFar = already > 0 ? ` (${already} already billed)` : ''
        const reason = (!params.allowBillBeforeReceipt && receivedKnown && effectiveCap < orderedQty)
          ? `exceeds net received qty ${netReceived}${billedSoFar} — only received, un-returned goods can be billed`
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


// ---------------------------------------------------------------------------
// The order changed between reading it and locking it
// ---------------------------------------------------------------------------

/** Shown to the operator when `createInvoice` finds the order or its cost lines edited after it read them. Nothing was saved. */
export const PURCHASE_INVOICE_INPUTS_CHANGED_MESSAGE =
  'This purchase order or its cost lines were changed while the bill was being prepared, so the bill was not saved. Reload the order and create the bill again.'

export class PurchaseInvoiceInputsChangedError extends Error {
  constructor() {
    super(PURCHASE_INVOICE_INPUTS_CHANGED_MESSAGE)
    this.name = 'PurchaseInvoiceInputsChangedError'
  }
}

type Numeric = number | string | { toString(): string }
export type PurchaseInvoiceTaxInputs = {
  fxRateToBase: Numeric
  type: string
  taxRatePercent: Numeric | null
  taxForeign: Numeric
  subtotalForeign: Numeric
  costLines: Array<{ id: string; description: string; amountForeign: Numeric; vatable: boolean }>
}

const sameNumber = (a: Numeric | null, b: Numeric | null) =>
  a === null || b === null ? a === b : toDecimal(a.toString()).eq(toDecimal(b.toString()))

/**
 * Whether anything `calculatePurchaseInvoice` consumed differs between the unlocked read the bill was calculated
 * from and the same rows re-read under the invoice transaction's locks: the order's rate, VAT figures and recorded
 * rate, and each cost line's amount, description and vatable flag (a cost line that appeared or vanished counts).
 */
export function purchaseInvoiceInputsChanged(before: PurchaseInvoiceTaxInputs, locked: PurchaseInvoiceTaxInputs): boolean {
  if (before.type !== locked.type) return true
  if (!sameNumber(before.fxRateToBase, locked.fxRateToBase)) return true
  if (!sameNumber(before.taxRatePercent, locked.taxRatePercent)) return true
  if (!sameNumber(before.taxForeign, locked.taxForeign)) return true
  if (!sameNumber(before.subtotalForeign, locked.subtotalForeign)) return true
  if (before.costLines.length !== locked.costLines.length) return true
  const lockedById = new Map(locked.costLines.map((line) => [line.id, line]))
  return before.costLines.some((line) => {
    const now = lockedById.get(line.id)
    return !now || now.vatable !== line.vatable || now.description !== line.description || !sameNumber(line.amountForeign, now.amountForeign)
  })
}

/** The SHARED check for `createInvoice` and `updateInvoice`: throws `PurchaseInvoiceInputsChangedError` if the locked re-read differs. */
export function assertPurchaseInvoiceInputsUnchanged(before: PurchaseInvoiceTaxInputs, locked: PurchaseInvoiceTaxInputs): void {
  if (purchaseInvoiceInputsChanged(before, locked)) throw new PurchaseInvoiceInputsChangedError()
}

/** Refusal for an edit that would recompute an order's lines, totals, VAT or exchange rate while a bill exists against it. */
export const PO_BILLED_FIGURES_EDIT_MESSAGE =
  'This purchase order already has a bill, so its lines, costs, VAT or exchange rate cannot be changed: the bill would keep the old figures. Correct or credit the bill first.'


/**
 * THE TAX TREATMENT EACH LINE OF AN EXISTING BILL WAS BOOKED WITH: the same code and rate `calculatePurchaseInvoice` gave it (a goods line its own
 * rate row's code and rate, a line with no rate row the order's recorded rate and its code, a vatable cost line the order's rate and code, a non-vatable
 * cost line No VAT). A supplier credit note against the bill mirrors THESE, never the supplier's current default type.
 */
export type BilledLineTaxTreatment = { taxType: string | undefined; rate: number; taxRateId?: string; reverseCharge: boolean }

export function billLineTaxTreatments(params: {
  billLines: ReadonlyArray<{ poLineId: string | null; costLineId: string | null }>
  poLineById: Map<string, PurchaseInvoicePoLine>
  costLineById: Map<string, { vatable: boolean }>
  poType?: string
  poTaxRatePercent?: number | string | null
  /** The code (and its rate id) of the rate the order was charged at (lib/domain/purchasing/order-rate-tax-code.ts). */
  orderRateTaxType?: string
  orderRateTaxRateId?: string
}): BilledLineTaxTreatment[] {
  const orderRate = toDecimal(params.poTaxRatePercent ?? 0)
  return params.billLines.map((line) => {
    if (line.poLineId) {
      const poLine = params.poLineById.get(line.poLineId)
      if (!poLine) return { taxType: undefined, rate: 0, reverseCharge: false }
      return {
        taxType: poLine.taxRate ? poLine.taxRate.accountingTaxType ?? undefined : params.orderRateTaxType,
        rate: purchaseLineOwnRate(poLine, orderRate, params.poType === 'FREIGHT').toNumber(),
        taxRateId: poLine.taxRate ? poLine.taxRate.id : params.orderRateTaxRateId,
        reverseCharge: !!poLine.taxRate?.reverseCharge,
      }
    }
    const vatable = line.costLineId ? params.costLineById.get(line.costLineId)?.vatable === true : false
    return vatable
      ? { taxType: params.orderRateTaxType, rate: orderRate.toNumber(), taxRateId: params.orderRateTaxRateId, reverseCharge: false }
      : { taxType: 'NONE', rate: 0, reverseCharge: false }
  })
}
