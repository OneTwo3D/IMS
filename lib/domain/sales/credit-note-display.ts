/**
 * WHAT EACH CREDIT-NOTE LINE POSTS, for display: the net it carries and the rate of the tax code it posts under.
 *
 * Both come from the definitions the credit-note payload and its fences already use, not from a copy of them:
 *   · the NET is `creditNotePostedNet` (the base column on a base-currency order, the foreign one otherwise; a refund line may carry
 *     real money in only one of the two);
 *   · the tax CODE is `creditNoteLineTaxTypeResolver` (the persisted snapshot on the refund line, else the order line's own code, else the
 *     order default), and its RATE is `priceSnapshottedTaxIdentity` against the sales tax table.
 * The rate stored on the refund line at creation (`postedTaxRate`) wins over all of this; the table is read only for a line that has none.
 * A code that cannot be priced (unmapped, or mapped two ways) yields a null rate: the caller falls back to the order line's own rate
 * rather than inventing a figure here.
 */
import {
  buildTaxTypeRateIndex,
  creditNoteLineTaxTypeResolver,
  creditNotePostedNet,
  priceSnapshottedTaxIdentity,
  type PostedRefundTaxRate,
} from '@/lib/domain/sales/refund-posted-tax-identity'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

export function creditNoteLineFacts(input: {
  orderCurrency: string
  baseCurrency: string
  orderLines: readonly { id: string; taxRate?: PostedRefundTaxRate | null }[]
  reverseChargeSalesTaxType?: string | null
  orderDefaultTaxType?: string | null
  /** Sales-usable tax rates (every rate that is not PURCHASE-only). */
  taxRates: readonly { accountingTaxType?: string | null; rate?: DecimalInput }[]
  refundLines: readonly {
    salesOrderLineId: string | null
    accountingTaxType?: string | null
    /** The rate (a fraction) the line's tax code carried when the refund was created (`SalesOrderRefundLine.postedTaxRate`); NULL on an older row. */
    postedTaxRate?: DecimalInput | null
    totalForeign: DecimalInput
    totalBase: DecimalInput
  }[]
}): { salesOrderLineId: string | null; postedNet: number; vatRate: number | null; vatRateEstimated: boolean }[] {
  const taxTypeOf = creditNoteLineTaxTypeResolver({
    orderLines: input.orderLines,
    reverseChargeSalesTaxType: input.reverseChargeSalesTaxType,
    orderDefaultTaxType: input.orderDefaultTaxType,
  })
  const rateByTaxType = buildTaxTypeRateIndex(input.taxRates)
  return input.refundLines.map((line) => {
    const taxType = taxTypeOf({ accountingTaxType: line.accountingTaxType, lineId: line.salesOrderLineId })
    // o3d-hqvrp.321: the rate STORED at creation wins, so a tax mapping edited since cannot change a posted credit note's VAT or gross. Only a refund with none stored (older rows) is priced from the current table, and says so.
    const stored = line.postedTaxRate == null ? null : toDecimal(line.postedTaxRate)
    const priced = stored === null && taxType ? priceSnapshottedTaxIdentity({ accountingTaxType: taxType, rateByTaxType, label: 'credit note line' }) : null
    return {
      salesOrderLineId: line.salesOrderLineId,
      postedNet: creditNotePostedNet({
        totalForeign: line.totalForeign,
        totalBase: line.totalBase,
        orderCurrency: input.orderCurrency,
        baseCurrency: input.baseCurrency,
      }).toNumber(),
      vatRate: stored !== null ? stored.toNumber() : priced?.ok ? priced.rate.toNumber() : null,
      vatRateEstimated: stored === null,
    }
  })
}
