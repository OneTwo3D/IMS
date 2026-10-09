import { z } from 'zod'
import { Prisma } from '@/app/generated/prisma/client'
import { LANDED_COST_DISTRIBUTION_METHODS, type LandedCostDistributionMethod } from './landed-cost-allocation'

/**
 * THE BOUNDARY FOR A FREIGHT ORDER'S COST LINES, shared by `createFreightPo` and `updateFreightPoCosts`.
 *
 * Both actions used to persist whatever they were handed: no sign rule, no finiteness check, no check that
 * the distribution method was one of the four, an exchange rate defaulted with `|| 1`. Two things made
 * that worse than it sounds. The three freight-cost UIs filter non-positive amounts client-side, so that
 * filter was the only thing between a crafted call and the cost basis; and the two actions built their rows
 * differently (one in floats, one in Decimal), so the same input could persist different `amountBase` and
 * `taxBase` depending on which action saved it.
 *
 * WHAT IS ACCEPTED. A signed amount is accepted DELIBERATELY: the owner's decision is that a credit or zero
 * cost line is applied to inventory basis (with a per-layer floor at zero, see landed-cost-allocation.ts),
 * so the rule lives in the arithmetic and not in a UI filter. An individual negative line is fine and so is
 * a zero line and a zero net. A NET-negative freight order is refused: an order whose lines total less than
 * zero is a supplier credit, and that belongs on a supplier credit note, not on a cost order.
 *
 * The UIs stay positive-only; opening them to credit lines is a separate workflow decision.
 */

export const FREIGHT_NET_CREDIT_MESSAGE =
  'The cost lines of a freight order cannot total less than zero. A net credit from the supplier belongs on a supplier credit note.'

// Deliberately `boolean`, not a type predicate: the schema's type stays `string` so the UI components, which
// hold the method as a plain string, compile against it; the row builder narrows after parsing.
function isDistributionMethod(value: string): boolean {
  return (LANDED_COST_DISTRIBUTION_METHODS as readonly string[]).includes(value)
}

const finiteNumber = (label: string) => z
  .number({ error: `${label} must be a number` })
  .refine(Number.isFinite, `${label} must be a finite number`)

export const FreightCostLineInputSchema = z.object({
  /**
   * The id of the STORED cost line this row edits. Optional: a row without one is a NEW line. `updateFreightPoCosts`
   * matches by this id (never by position), so a reordered or removed row cannot change which stored row is
   * updated, billed ones included.
   */
  id: z.string().min(1).optional(),
  description: z.string({ error: 'Each cost line needs a description' }),
  amountForeign: finiteNumber('Cost line amount'),
  vatable: z.boolean({ error: 'Cost line vatable must be true or false' }),
  distributionMethod: z
    .string({ error: 'Each cost line needs a distribution method' })
    .refine((value) => isDistributionMethod(value), `Distribution method must be one of ${LANDED_COST_DISTRIBUTION_METHODS.join(', ')}`),
})

export type FreightCostLineInput = z.infer<typeof FreightCostLineInputSchema>

/** The line list both actions parse, including the net-subtotal rule (D2). An empty list is valid here. */
/**
 * The amount AS PERSISTED: `freight_cost_lines.amountForeign` is Decimal(18,4), so the database stores the
 * submitted number rounded half away from zero to 4dp. Every rule and every total below is computed from this
 * rounded value, never from the raw input, so what is validated is what is stored (-0.00001 is a zero line, and
 * +0.00005 / -0.00005 do not net to a phantom credit).
 */
export function persistedAmountForeign(amount: number): Prisma.Decimal {
  return new Prisma.Decimal(amount).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
}

export const FreightCostLinesSchema = z.array(FreightCostLineInputSchema).superRefine((lines, context) => {
  const net = lines.reduce((sum, line) => sum.add(persistedAmountForeign(line.amountForeign)), new Prisma.Decimal(0))
  if (net.lt(0)) context.addIssue({ code: 'custom', message: FREIGHT_NET_CREDIT_MESSAGE })
})

/** Thrown by `assertFreightTotalNotNegative`; the actions report its message as the refusal reason. */
export class FreightNetCreditError extends Error {
  constructor() {
    super(FREIGHT_NET_CREDIT_MESSAGE)
    this.name = 'FreightNetCreditError'
  }
}

/**
 * The order's PAYABLE total is what a freight order must not drive below zero, not just the sum of its lines:
 * VAT is charged per vatable line INCLUDING a negative one, so +100 non-vatable and -100 vatable lines have a
 * zero subtotal but, at 20%, a total of -20. Checked on the BUILT figures (exact Decimal) before either action
 * writes anything. VAT on a negative vatable line is left as the builder computes it (a negative tax): the
 * rule is only that neither the net nor the total may be negative.
 */
export function freightTotalIsNegative(built: Pick<FreightCostLineRows, 'subtotalForeign' | 'totalForeign'>): boolean {
  return built.subtotalForeign.lt(0) || built.totalForeign.lt(0)
}

export function assertFreightTotalNotNegative(built: Pick<FreightCostLineRows, 'subtotalForeign' | 'totalForeign'>): void {
  if (freightTotalIsNegative(built)) throw new FreightNetCreditError()
}

export const CreateFreightPoInputSchema = z.object({
  supplierId: z.string().min(1, 'Select a supplier'),
  currency: z.string().min(1, 'Currency is required'),
  fxRateToBase: finiteNumber('Exchange rate').gt(0, 'Exchange rate must be greater than zero'),
  // costLines before primaryPoIds: the first issue is what the caller reports, and "add a cost line" has
  // always been reported before "link a primary PO".
  costLines: FreightCostLinesSchema.min(1, 'Add at least one cost line'),
  primaryPoIds: z.array(z.string().min(1)).min(1, 'Link to at least one primary PO'),
  supplierRef: z.string().optional(),
  notes: z.string().optional(),
  taxRateValue: finiteNumber('Tax rate').min(0, 'Tax rate cannot be negative').optional(),
})

export type CreateFreightPoInput = z.infer<typeof CreateFreightPoInputSchema>

export type FreightCostLineRow = {
  description: string
  amountForeign: Prisma.Decimal
  amountBase: Prisma.Decimal
  vatable: boolean
  distributionMethod: LandedCostDistributionMethod
  sortOrder: number
}

export type FreightCostLineRows = {
  rows: FreightCostLineRow[]
  subtotalForeign: Prisma.Decimal
  taxForeign: Prisma.Decimal
  subtotalBase: Prisma.Decimal
  taxBase: Prisma.Decimal
  totalForeign: Prisma.Decimal
  totalBase: Prisma.Decimal
}

/**
 * THE ONE ROW BUILDER. Decimal throughout, 4dp HALF_UP at exactly the points the order's own totals are
 * stored, so the same input persists byte-identical rows and totals whichever action saves it. `lines` must
 * already have been parsed with `FreightCostLinesSchema`.
 */
export function buildFreightCostLineRows(
  lines: FreightCostLineInput[],
  fxRateToBase: Prisma.Decimal | number | string,
  taxRateValue: Prisma.Decimal | number | string = 0,
): FreightCostLineRows {
  const fxRate = new Prisma.Decimal(fxRateToBase)
  const vatRate = new Prisma.Decimal(taxRateValue)
  let subtotalForeign = new Prisma.Decimal(0)
  let taxForeign = new Prisma.Decimal(0)
  const rows = lines.map((line, index): FreightCostLineRow => {
    const amountForeign = persistedAmountForeign(line.amountForeign)
    const amountBase = amountForeign.div(fxRate).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
    subtotalForeign = subtotalForeign.add(amountForeign)
    if (line.vatable && vatRate.gt(0)) {
      taxForeign = taxForeign.add(amountForeign.mul(vatRate).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP))
    }
    return {
      description: line.description,
      amountForeign,
      amountBase,
      vatable: line.vatable,
      distributionMethod: line.distributionMethod as LandedCostDistributionMethod,
      sortOrder: index,
    }
  })
  const subtotalBase = subtotalForeign.div(fxRate).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
  const taxBase = taxForeign.div(fxRate).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
  return {
    rows,
    subtotalForeign,
    taxForeign,
    subtotalBase,
    taxBase,
    totalForeign: subtotalForeign.add(taxForeign),
    totalBase: subtotalBase.add(taxBase),
  }
}

// ---------------------------------------------------------------------------
// Editing a freight order's stored lines
// ---------------------------------------------------------------------------

export type StoredFreightCostLine = {
  id: string
  description: string
  amountForeign: Prisma.Decimal
  vatable: boolean
  distributionMethod: string
  /** True when a purchase-invoice line points at this cost line: it has been billed and its money is fixed. */
  billed: boolean
}

export class FreightEditRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FreightEditRefusedError'
  }
}

export type FreightCostLinePlan =
  | { kind: 'noop' }
  | {
    kind: 'apply'
    /** Stored rows to edit IN PLACE, by id. */
    updates: Array<{ id: string; row: FreightCostLineRow }>
    deletes: string[]
    creates: FreightCostLineRow[]
  }

function sameLine(stored: StoredFreightCostLine, row: FreightCostLineRow): boolean {
  return stored.description === row.description
    && stored.amountForeign.eq(row.amountForeign)
    && stored.vatable === row.vatable
    && stored.distributionMethod === row.distributionMethod
}

/**
 * HOW A SAVE OF A FREIGHT ORDER'S LINES MAPS ONTO WHAT IS STORED. Pure, so it can be proved without a database.
 *
 *  - Rows are matched by STABLE ID, never by position: a reordered or removed row must not change which stored
 *    row gets updated. A submitted row with an id edits that stored row; one without an id is a NEW line; a
 *    stored row nobody submitted is DELETED. An id that is not one of this order's lines, or is repeated, is
 *    refused.
 *  - A row that has been BILLED (a purchase-invoice line points at it) is never modified and never deleted: the
 *    bill's money is fixed and silently rewriting the cost under it would disagree with the document.
 *  - A caller that supplies NO ids at all (the pre-id contract) is a full replacement: it is a no-op only when it
 *    equals the stored lines exactly, position for position and tax unchanged; otherwise every stored row is
 *    deleted and recreated (refused if any was billed). That is the previous behaviour for edits, kept so a
 *    caller that never learned about ids is neither broken nor given a position-matching shortcut.
 *  - Unchanged means: no field the operator controls differs (description, amount, vatable, method), nothing is
 *    added or removed, and the tax rate did not change. The derived base amount is NOT compared, so a legacy
 *    row stored by the old float builder is not read as an edit.
 */
export function planFreightCostLineEdit(
  stored: StoredFreightCostLine[],
  submitted: FreightCostLineInput[],
  rows: FreightCostLineRow[],
  taxChanged: boolean,
): FreightCostLinePlan {
  if (!submitted.some((line) => line.id)) {
    const identical = stored.length === rows.length && rows.every((row, index) => sameLine(stored[index]!, row))
    if (identical && !taxChanged) return { kind: 'noop' }
    const billed = stored.find((row) => row.billed)
    if (billed) {
      throw new FreightEditRefusedError(`Cost line ${billed.id} has already been billed and cannot be replaced or removed.`)
    }
    return { kind: 'apply', updates: [], deletes: stored.map((row) => row.id), creates: rows }
  }

  const storedById = new Map(stored.map((row) => [row.id, row]))
  const seen = new Set<string>()
  const updates: Array<{ id: string; row: FreightCostLineRow }> = []
  const creates: FreightCostLineRow[] = []
  submitted.forEach((line, index) => {
    const row = rows[index]!
    if (!line.id) {
      creates.push(row)
      return
    }
    const existing = storedById.get(line.id)
    if (!existing) throw new FreightEditRefusedError(`Cost line ${line.id} is not a line of this freight order.`)
    if (seen.has(line.id)) throw new FreightEditRefusedError(`Cost line ${line.id} was submitted twice.`)
    seen.add(line.id)
    if (sameLine(existing, row)) return
    if (existing.billed) {
      throw new FreightEditRefusedError(`Cost line ${existing.id} has already been billed and cannot be changed.`)
    }
    updates.push({ id: existing.id, row })
  })
  const deletes = stored.filter((row) => !seen.has(row.id)).map((row) => row.id)
  const billedDelete = stored.find((row) => deletes.includes(row.id) && row.billed)
  if (billedDelete) {
    throw new FreightEditRefusedError(`Cost line ${billedDelete.id} has already been billed and cannot be removed.`)
  }
  if (updates.length === 0 && deletes.length === 0 && creates.length === 0 && !taxChanged) return { kind: 'noop' }
  return { kind: 'apply', updates, deletes, creates }
}

// ---------------------------------------------------------------------------
// The tax rate of an edit
// ---------------------------------------------------------------------------

/** The refusal for an order that was charged VAT but never recorded the rate. Single-sourced: action and dialog show it. */
export const FREIGHT_TAX_RATE_UNKNOWN_MESSAGE =
  'This freight order was charged VAT but its VAT rate was never recorded. Choose the VAT rate to save the order.'

/**
 * WHICH VAT RATE AN EDIT SAVES AT. `requested` is what the caller sent (a fraction, 0.2; undefined = nothing sent).
 *
 *  - Sent: that rate. A different rate from the stored one is an edit in its own right (`taxChanged`), even when
 *    no line changed.
 *  - Not sent: the STORED rate is kept, never zeroed.
 *  - Not sent and the order has no recorded rate: 0 when it was charged no VAT. When it WAS charged VAT the rate is
 *    NOT inferred from tax / vatable subtotal (that turns rounding residue into a new rate); the edit is refused and
 *    the caller must say the rate.
 */
export function resolveFreightEditTaxRate(params: {
  requested: number | undefined
  storedRate: Prisma.Decimal | number | string | null
  storedTaxForeign: Prisma.Decimal | number | string
}): { effectiveRate: Prisma.Decimal; taxChanged: boolean } {
  const storedRate = params.storedRate != null ? new Prisma.Decimal(params.storedRate) : null
  if (params.requested === undefined && storedRate === null && !new Prisma.Decimal(params.storedTaxForeign).isZero()) {
    throw new FreightEditRefusedError(FREIGHT_TAX_RATE_UNKNOWN_MESSAGE)
  }
  const effectiveRate = params.requested !== undefined ? new Prisma.Decimal(params.requested) : (storedRate ?? new Prisma.Decimal(0))
  return { effectiveRate, taxChanged: !effectiveRate.eq(storedRate ?? new Prisma.Decimal(0)) }
}
