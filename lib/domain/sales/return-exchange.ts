/**
 * EXCHANGES INSIDE A RETURN: the rules, as pure functions (no database, no clock), so the refund dialog, the server action and the tests read ONE rule.
 *
 * What an exchange is. While a return is recorded in the refund dialog, the operator also picks replacement items (product, quantity, price). The return side is exactly the refund of today: refund lines,
 * stock back, cost reversal, credit note. The replacement items become NEW LINES ON THE SAME ORDER, each linked to the refund it replaces (`SalesOrderLine.exchangeForRefundId`), and from there they are ordinary
 * order lines: they are reserved, shipped and invoiced by the normal flow (the posted invoice is updated through the existing queued update, and its hold).
 *
 * Money. The credit note and the replacement lines net off, so an even exchange moves no customer money in IMS. A difference is only SHOWN ("customer owes X" / "refund X"): IMS never charges or refunds it
 * by itself; the operator uses the existing payment and refund actions for it.
 *
 * Where it is allowed. Only on an order whose lines IMS can still add to, i.e. the confirmed-order edit gates (order-edit-affordance.ts, the warehouse amend gate) with the refund-related blocks lifted
 * (an exchange only ADDS lines, it replaces none, so earlier refunds do not endanger anything), plus three rules of its own: a draft is not returned, a fully refunded order takes no new lines (it holds no demand,
 * so nothing would reserve or ship them) and an order whose revenue or allocated inventory the daily accounting batch already booked ahead of dispatch keeps its total.
 */
import { resolveSalesOrderEditBlock, type SalesOrderEditBlock, type SalesOrderEditBlockCode, type SalesOrderEditInput } from '@/lib/domain/sales/order-edit-affordance'

/** The switch. Off (or absent) by default: with it off the refund dialog shows no exchange and the server refuses an exchange request. */
export const RETURN_EXCHANGE_SETTING_KEY = 'return_exchange_enabled'

export function returnExchangeEnabledFromSetting(value: string | null | undefined): boolean {
  return value === 'true'
}

export const RETURN_EXCHANGE_OFF_REFUSAL = 'Exchanges inside a return are switched off for this system, so nothing was recorded. An administrator can switch them on in the Sales settings (return_exchange_enabled).'

export type ReturnExchangeBlockCode = SalesOrderEditBlockCode | 'EXCHANGE_DRAFT' | 'EXCHANGE_FULLY_REFUNDED' | 'EXCHANGE_BOOKED_AHEAD'

export type ReturnExchangeBlock = { code: ReturnExchangeBlockCode; reason: string }

export type ReturnExchangeGateInput = SalesOrderEditInput & {
  /** True when the daily accounting batch has already booked this order's revenue (deferral) or its allocated inventory ahead of dispatch. */
  accountingBookedAhead?: boolean
}

const PREFIX = 'An exchange cannot be recorded on this order. '

function blocked(code: ReturnExchangeBlockCode, reason: string): ReturnExchangeBlock {
  return { code, reason: `${PREFIX}${reason}` }
}

/**
 * Why replacement lines cannot be added to this order while a return is recorded, or null when they can. The page and the server call this, so a refused exchange is explained before the operator tries it; the server
 * remains the authority and re-reads every input under the order lock.
 */
export function resolveReturnExchangeBlock(input: ReturnExchangeGateInput): ReturnExchangeBlock | null {
  // The edit rule with the refund-related refusals lifted: an exchange only adds lines, so refunds and return expectations already recorded against the existing lines are not endangered.
  const lifted = { ...input, refunds: 0, refundStatus: 'NONE', returnExpectations: 0 }
  if (input.status === 'DRAFT') {
    const terminal = resolveSalesOrderEditBlock({ ...lifted, status: 'PROCESSING' })
    if (terminal && (terminal.code === 'ERASED' || terminal.code === 'CANCELLED' || terminal.code === 'CLOSED')) return blocked(terminal.code, terminal.reason)
    return blocked('EXCHANGE_DRAFT', 'A draft has not been sold yet: edit the draft itself instead.')
  }
  const base: SalesOrderEditBlock | null = resolveSalesOrderEditBlock(lifted)
  if (base) {
    if (base.code === 'DISPATCHED') {
      return blocked('DISPATCHED', 'It has been dispatched, so IMS cannot add lines to it (the warehouse can no longer amend a dispatched order). Record the return as a refund and raise a new order for the replacement.')
    }
    return blocked(base.code, base.reason)
  }
  if ((input.refundStatus ?? 'NONE') === 'FULL') {
    return blocked('EXCHANGE_FULLY_REFUNDED', 'It is already fully refunded, so it holds no demand: lines added to it would not be reserved or shipped. Raise a new order for the replacement.')
  }
  if (input.accountingBookedAhead) {
    return blocked('EXCHANGE_BOOKED_AHEAD', 'The daily accounting batch has already booked this order\'s revenue or allocated inventory ahead of dispatch, and an exchange would change its total after that. Record the return as a refund and raise a new order for the replacement.')
  }
  return null
}

export type ExchangeLineRequestShape = {
  productId: string
  qty: number
  unitPriceForeign: number
  taxRateId?: string | null
}

export const MAX_EXCHANGE_LINES = 50

/** Null when the request is well formed, otherwise the operator-facing refusal. Shape only: the products and rates are checked by the server against the database. */
export function exchangeRequestRefusal(lines: unknown): string | null {
  if (!Array.isArray(lines) || lines.length === 0) return 'Choose at least one replacement item, or switch the exchange off for this return.'
  if (lines.length > MAX_EXCHANGE_LINES) return `An exchange can carry at most ${MAX_EXCHANGE_LINES} replacement lines.`
  const seen = new Set<string>()
  for (const raw of lines as unknown[]) {
    const line = raw as Partial<ExchangeLineRequestShape> | null
    if (!line || typeof line.productId !== 'string' || line.productId.length === 0) return 'Every replacement line needs a product.'
    if (seen.has(line.productId)) return 'A product can appear on only one replacement line: raise its quantity instead.'
    seen.add(line.productId)
    if (typeof line.qty !== 'number' || !Number.isFinite(line.qty) || line.qty <= 0) return 'Every replacement line needs a quantity above zero.'
    if (typeof line.unitPriceForeign !== 'number' || !Number.isFinite(line.unitPriceForeign) || line.unitPriceForeign < 0) return 'Every replacement line needs a price of zero or more.'
    if (line.taxRateId != null && typeof line.taxRateId !== 'string') return 'A replacement line\'s tax rate is not valid.'
  }
  return null
}

export type ExchangeDifference =
  | { kind: 'EVEN'; amount: 0 }
  | { kind: 'CUSTOMER_OWES'; amount: number }
  | { kind: 'REFUND_DUE'; amount: number }

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * The difference between what the replacement lines are worth and what the credit note returns, both VAT included, in the order currency. Shown, never charged: the operator settles it with the existing
 * payment and refund actions. A difference under one cent of rounding reads as even.
 */
export function exchangeDifference(args: { replacementGross: number; creditNoteGross: number }): ExchangeDifference {
  const diff = round2(args.replacementGross - args.creditNoteGross)
  if (Math.abs(diff) < 0.005) return { kind: 'EVEN', amount: 0 }
  return diff > 0 ? { kind: 'CUSTOMER_OWES', amount: diff } : { kind: 'REFUND_DUE', amount: round2(-diff) }
}

/** The sentence the dialog and the result show for a difference. `format` renders an amount with its currency symbol. */
export function exchangeDifferenceLabel(difference: ExchangeDifference, format: (amount: number) => string): string {
  if (difference.kind === 'EVEN') return 'Even exchange: no money moves.'
  if (difference.kind === 'CUSTOMER_OWES') return `Customer owes ${format(difference.amount)}. IMS does not charge it: record the payment when it arrives.`
  return `Refund ${format(difference.amount)}. IMS does not pay it out: use the refund action for the difference.`
}

/**
 * The price a replacement line starts at in the dialog: the product's list price (regular, or the sale price when one is set) converted to the order's currency and to the order's price basis (gross when the order's
 * prices include VAT). The operator can overwrite it. Pure; `rate` is the line's VAT rate as a fraction.
 */
export function exchangeDefaultUnitPrice(args: {
  salesPriceBase: string | null
  salePriceBase: string | null
  salesPriceTaxInclusive: boolean
  pricesIncludeVat: boolean
  rate: number
  fxRateToBase: number
}): number {
  const raw = Number(args.salePriceBase ?? args.salesPriceBase ?? 0)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  const rate = args.rate > 0 ? args.rate : 0
  const listIsGross = args.salesPriceTaxInclusive && rate > 0
  const net = listIsGross ? raw / (1 + rate) : raw
  const display = args.pricesIncludeVat && rate > 0 ? net * (1 + rate) : net
  return round2(display * (args.fxRateToBase > 0 ? args.fxRateToBase : 1))
}

/** What the operator is told about the order page's own exchange lines: the badge text of a replacement line. */
export function exchangeLineBadge(creditNoteNumber: string | null): string {
  return creditNoteNumber ? `Replaces ${creditNoteNumber}` : 'Exchange replacement'
}

/** The refund-refusal sentences the exchange adds. Fixed wording: no remote text is ever copied into them. */
export const returnExchangeRefusals = {
  needsRefundPermission: 'Recording an exchange needs permission to refund, to edit orders and to process (allocate) them. Nothing was recorded.',
  wouldFullyRefund: 'With these replacement items the return would still refund the whole order, so the replacement lines would hold no demand and could not be shipped. Add replacement items worth more than nothing, or record the return without an exchange. Nothing was recorded.',
  internalCaller: 'An exchange can only be recorded by a person in the refund dialog. Nothing was recorded.',
  rateChanged: 'The order\'s currency or booked rate changed while the exchange was being checked. Reload the order and try again. Nothing was recorded.',
  warehouseMoved: 'The warehouse order for this sales order changed while the exchange was being checked. Reload the order and try again. Nothing was recorded.',
  notReturnSide: 'An exchange needs at least one returned item. Select the quantity being returned, then add the replacement. Nothing was recorded.',
} as const

/** A product the refund dialog offers as a replacement, with the price it starts at (order currency, order price basis). */
export type ExchangeCatalogueRow = { id: string; sku: string; name: string; defaultUnitPrice: number }

/** The catalogue the dialog searches: sellable stocked products (not a variable parent, not a service), each with its starting price. Pure. */
export function buildExchangeCatalogue(
  products: ReadonlyArray<{ id: string; sku: string; name: string; type: string; lifecycleStatus: string; salesPriceBase: string | null; salePriceBase: string | null; salesPriceTaxInclusive: boolean }>,
  order: { pricesIncludeVat: boolean; taxRatePercent: number | null; fxRateToBase: number },
): ExchangeCatalogueRow[] {
  return products
    .filter((p) => !['VARIABLE', 'NON_INVENTORY'].includes(p.type) && (p.lifecycleStatus === 'ACTIVE' || p.lifecycleStatus === 'EOL'))
    .map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      defaultUnitPrice: exchangeDefaultUnitPrice({
        salesPriceBase: p.salesPriceBase,
        salePriceBase: p.salePriceBase,
        salesPriceTaxInclusive: p.salesPriceTaxInclusive,
        pricesIncludeVat: order.pricesIncludeVat,
        rate: order.taxRatePercent ?? 0,
        fxRateToBase: order.fxRateToBase,
      }),
    }))
}
