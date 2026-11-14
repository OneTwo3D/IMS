/**
 * THE VAT THE ORDER'S OTHER REFUNDS HAVE ALREADY RETURNED, so a rate-182 refund can be held to what is left (`eas182RefundFigures`). Shared by the refund writer's creation fence (inside the refund transaction) and the credit-note treatment.
 */
import type { db } from '@/lib/db'
import { toDecimal, type Decimal } from '@/lib/domain/math/decimal'

/**
 * The VAT the order's OTHER refunds have already returned, so a rate-182 refund can be held to what is left. A stated gross gives its tax outright (gross less the net, which every NET refund stores); a refund with none is priced from its lines' frozen rates; a whole-order reversal returned all the order's VAT.
 * Null when any of them cannot be established (a legacy gross-basis refund, a line with no frozen rate): the caller refuses rather than guesses.
 */
export async function priorRefundedTax(client: Pick<typeof db, 'salesOrderRefund'>, orderId: string, refundId: string | null, orderTax: Decimal): Promise<Decimal | null> {
  const others = await client.salesOrderRefund.findMany({
    where: refundId === null ? { orderId } : { orderId, id: { not: refundId } },
    select: { source: true, totalsBasis: true, totalForeign: true, statedGrossForeign: true, lines: { select: { totalForeign: true, schemeTaxRateValue: true } } },
  })
  let sum = toDecimal(0)
  for (const other of others) {
    if (other.source === 'CHARGEBACK_POLLER') { sum = sum.plus(orderTax); continue }
    if (other.totalsBasis !== 'NET') return null
    if (other.statedGrossForeign !== null) { sum = sum.plus(toDecimal(other.statedGrossForeign).minus(toDecimal(other.totalForeign))); continue }
    for (const line of other.lines) {
      if (line.schemeTaxRateValue === null) return null
      sum = sum.plus(toDecimal(line.totalForeign).times(toDecimal(line.schemeTaxRateValue)))
    }
  }
  return sum
}
