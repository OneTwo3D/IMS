import type { Prisma } from '@/app/generated/prisma/client'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import type {
  RefundBasisOrderLineRow,
  RefundBasisRefundLineRow,
} from './refund-basis-audit'

/**
 * How far the header may sit from the sum of its lines and still count as the same number.
 *
 * Deliberately TIGHT — a few rounding ulps per VALUE-BEARING line, not a proportional slack, and
 * CAPPED so it can never approach a plausible net/gross gap.
 *
 * The cap is the point. Counting every line, zero ones included, let padding widen the window: a
 * 0.05 net line with a 0.06 header and 199 zero lines reconciled at a tolerance of 0.01005, which is
 * exactly the one-penny net/gross divergence the gate exists to catch. Rounding error comes from
 * lines that carry value; a zero line contributes none, so it must not buy tolerance.
 */
const HEADER_RECONCILE_EPSILON_PER_LINE = 0.00005

/**
 * The cap is expressed as a FRACTION OF THE REFUND'S OWN net/gross separation, not as a fixed
 * amount.
 *
 * A flat cap gets the trade wrong in both directions. Too loose and zero-line padding widens the
 * window until it spans a real net/gross gap; too tight and it rejects legitimate refunds — a flat
 * 0.005 rejected anything above roughly 99 value lines, because the historical writer sums unrounded
 * inputs for the header while lines are stored at four decimal places, so honest drift grows with
 * line count.
 *
 * Bounding by the gap keeps the property that actually matters: the window can never reach the
 * smallest difference that distinguishes NET from GROSS for THIS refund, however many lines it has.
 */
const HEADER_RECONCILE_GAP_FRACTION = 0.25

/**
 * o3d-lvk: stamp `totalsBasis` on refunds written BEFORE the totals_basis migration.
 *
 * WHY THIS IS OPERATIONAL, NOT ANALYTICS. o3d-w00's fail-closed shipped in #516: a second refund
 * on an order whose EARLIER refund has a NULL basis is refused and quarantined, because a legacy
 * total may be GROSS and summing it with a new NET total can over-refund. Every pre-migration
 * refund has a NULL basis — so every order that already carried one now quarantines its next
 * refund. This backfill is what stops that, by establishing the basis where it is PROVABLE.
 *
 * CONSERVATIVE BY CONSTRUCTION. classifyRefundBasis stamps NET or GROSS only on unanimous,
 * unambiguous linked-line evidence and returns UNKNOWN otherwise. An UNKNOWN refund is LEFT NULL
 * rather than guessed at: a wrong basis silently changes what a later refund is allowed to post,
 * which is worse than continuing to quarantine. The fail-closed path is the safe default and this
 * only removes orders from it where the evidence is unambiguous.
 */

export type RefundBasisBackfillRefund = {
  id: string
  totalsBasis: string | null
  /**
   * The refund HEADER total. `totalsBasis` describes THIS number — it is what the cumulative refund
   * ceiling and the status reconciliation consume — so a basis proven from the lines may only be
   * stamped when the header actually agrees with them. The schema does not enforce that equality.
   */
  totalBase: DecimalInput
  lines: RefundBasisRefundLineRow[]
}

export type RefundBasisBackfillOrder = {
  id: string
  lines: RefundBasisOrderLineRow[]
  refunds: RefundBasisBackfillRefund[]
}

export type RefundBasisBackfillDecision = {
  refundId: string
  orderId: string
  basis: 'NET' | 'GROSS'
}

export type RefundBasisBackfillPlan = {
  /** Refunds whose basis is provable and will be stamped. */
  decisions: RefundBasisBackfillDecision[]
  /** Refunds left NULL because the evidence is not unanimous — they keep failing closed. */
  unresolved: Array<{ refundId: string; orderId: string }>
  /** Refunds that already carry a basis; never re-stamped. */
  alreadyStamped: number
}

/**
 * Decide what to stamp, WITHOUT writing. Pure, so the decision can be tested and reviewed
 * independently of the transaction that applies it — and so `--dry-run` reports exactly what a
 * real run would do rather than an approximation of it.
 */
export async function planRefundBasisBackfill(
  orders: RefundBasisBackfillOrder[],
): Promise<RefundBasisBackfillPlan> {
  // LAZY import, deliberately. refund-basis-audit imports `db` at module level, which builds the pg
  // Pool from process.env.DATABASE_URL at IMPORT time — so a static import here would construct a
  // pool before a script's own dotenv call had run, failing with an opaque SASL
  // "client password must be a string". The classifier itself is pure; only its module's neighbours
  // touch the database.
  const { classifyRefundBasis } = await import('./refund-basis-audit')

  const decisions: RefundBasisBackfillDecision[] = []
  const unresolved: Array<{ refundId: string; orderId: string }> = []
  let alreadyStamped = 0

  for (const order of orders) {
    const orderLinesById = new Map(order.lines.map((line) => [line.id, line]))
    for (const refund of order.refunds) {
      // Never overwrite an existing basis. A stamped row was either written by the current code
      // path (authoritative) or by a previous run of this backfill, and re-deriving it could
      // change an answer someone has already acted on.
      if (refund.totalsBasis) {
        alreadyStamped++
        continue
      }
      const basis = classifyRefundBasis(refund.lines, orderLinesById)
      if (basis !== 'NET' && basis !== 'GROSS') {
        unresolved.push({ refundId: refund.id, orderId: order.id })
        continue
      }

      // The lines proved a basis; the HEADER is what that basis will describe. If the two disagree,
      // stamping would tell the cumulative ceiling and the status reconciliation to trust a number
      // the lines never justified — so an unreconciled header stays unresolved and keeps failing
      // closed, exactly as the audit's own header path treats it.
      // Summed as Decimal, not float: accumulating 200 line totals in binary floating point
      // introduces its own drift, which would then be compared against a tolerance meant to measure
      // the DATA's drift.
      const lineSum = refund.lines.reduce(
        (sum, line) => sum.add(toDecimal(line.totalBase)),
        toDecimal(0),
      )
      const valueLines = refund.lines.filter((line) => !toDecimal(line.totalBase).isZero())

      // The smallest net/gross separation among the lines that carry value. For a line, that gap is
      // its tax scaled to the refunded quantity — the exact distance between the two readings the
      // classifier had to choose between.
      let smallestBasisGap = Number.POSITIVE_INFINITY
      for (const line of valueLines) {
        const orderLine = line.salesOrderLineId ? orderLinesById.get(line.salesOrderLineId) : undefined
        if (!orderLine) continue
        const lineQty = toDecimal(orderLine.qty).abs()
        if (lineQty.isZero()) continue
        const gap = toDecimal(orderLine.taxBase).abs().div(lineQty).mul(toDecimal(line.qty).abs()).toNumber()
        if (gap > 0 && gap < smallestBasisGap) smallestBasisGap = gap
      }

      const roundingBound = HEADER_RECONCILE_EPSILON_PER_LINE * (valueLines.length + 1)
      const tolerance = Number.isFinite(smallestBasisGap)
        ? Math.min(roundingBound, smallestBasisGap * HEADER_RECONCILE_GAP_FRACTION)
        : roundingBound
      if (toDecimal(refund.totalBase).sub(lineSum).abs().toNumber() > tolerance) {
        unresolved.push({ refundId: refund.id, orderId: order.id })
        continue
      }

      decisions.push({ refundId: refund.id, orderId: order.id, basis })
    }
  }

  return { decisions, unresolved, alreadyStamped }
}

/**
 * Apply a plan. Each stamp is conditional on the row STILL having a null basis, so a refund
 * created or stamped between planning and applying is not overwritten — the same compare-and-set
 * shape the rest of the codebase uses for claim-like writes.
 *
 * Returns how many rows were actually changed, which can be lower than the plan when something
 * else stamped a row first. That difference is reported rather than hidden.
 */
export async function applyRefundBasisBackfill(
  tx: Prisma.TransactionClient,
  decisions: RefundBasisBackfillDecision[],
): Promise<{ stamped: number; skippedRaced: number }> {
  let stamped = 0
  for (const decision of decisions) {
    const result = await tx.salesOrderRefund.updateMany({
      where: { id: decision.refundId, totalsBasis: null },
      data: { totalsBasis: decision.basis },
    })
    stamped += result.count
  }
  return { stamped, skippedRaced: decisions.length - stamped }
}
