import { reportUnrecordedShadow } from '@/lib/domain/outbound-shadow/unrecorded'
import { db } from '@/lib/db'
import { withSavepoint } from '@/lib/db/savepoint'
import { recordOutboundShadow } from '@/lib/domain/outbound-shadow/record'
import { producerShadowNotice, type ProducerReason } from '@/lib/security/producer-disposition-constants'
import type { ProducerDecisionContext } from '@/lib/security/producer-disposition'
import { producerSeamVerdict, readProducerEnforcement } from '@/lib/security/producer-seam'
export { wooDrainHold, wooEgressHold } from './producer-egress'
import type { MappedOperation } from '@/lib/security/writer-ownership-map'

/**
 * THE WOOCOMMERCE PRODUCER SEAM: WHAT A WOOCOMMERCE WRITER ASKS BEFORE IT PRODUCES OR SENDS ANYTHING.
 *
 * One module, three questions, one answer shape. Every place IMS can write to WooCommerce (a stock push, an order status,
 * tracking, a partial shipment, product metadata, the WMS-status meta, FX rates, an invoice note, a webhook registration,
 * the FX helper probe) asks through here, so the rule has one implementation.
 *
 *   {@link wooProducerSeam}   a producer asks, for ONE operation of the ownership map, before it creates work or calls out.
 *                             `proceed` when the hold is not enforced for WooCommerce (legacy) or the decision is LIVE.
 *                             Otherwise it records the shadow (outbound_shadow_writes, in the caller's transaction when
 *                             one is given) and answers `shadowed`: the producer makes NOTHING.
 *   `wooDrainHold` (producer-egress.ts)      a drain asks, before it claims queued work, whether the destination is in its live phase at
 *                             all. A held drain claims nothing and spends no attempt, so a row queued before enforcement
 *                             was switched on stays exactly as it was and is never sent while the hold stands.
 *   `wooEgressHold` (producer-egress.ts)     the last barrier in front of the WooCommerce transport (wcPost, wcPut and the two raw helper
 *                             POSTs). A producer that slipped past the seams still sends nothing.
 *
 * A SHADOW IS NOT A QUEUED, NOT A SENT AND NOT A FAILED OUTCOME. It is its own answer (`shadowed`), and every caller handles
 * it explicitly: it must never be stamped as pushed, retried as a failure, or counted as queued work.
 */

export type WooOperation = MappedOperation<'woocommerce'>

export type WooShadow = {
  shadowed: true
  /** The single-sourced operator sentence: IMS did not send it, and this says nothing about the owner. */
  notice: string
  reason: ProducerReason
  /** Whether the durable record could be written. False is lost evidence (logged), never lost work: nothing was queued either way. */
  recorded: boolean
  /** How many times this exact work has been shadowed, or null when it could not be recorded. */
  occurrences: number | null
}

export type WooSeamAnswer = { proceed: true } | ({ proceed: false } & WooShadow)

export type WooSeamInput = {
  operation: WooOperation
  /** The kind of thing the work is about (Product, SalesOrder, ...) and its id: the shadow's identity with the digest. */
  subjectType: string
  subjectId: string
  /** What would have been sent. Digested, never stored. */
  payload: unknown
  summary?: Record<string, string | number | boolean | null>
  /** The business-event time, for an operation the ownership map marks as requiring it. */
  obligationAt?: Date
  /**
   * Resolves the business-event time lazily, ONLY when the hold is enforced for WooCommerce (so an installation that does not
   * enforce it makes no extra read). Ignored when `obligationAt` is given. A resolver that throws or returns nothing leaves
   * the time absent, and an operation that requires it is then a shadow: unreadable is never live.
   */
  resolveObligationAt?: () => Promise<Date | undefined>
  /** The caller's client (a transaction) so the record commits or rolls back with the business change. Defaults to the pool. */
  client?: object
  /** Test seam: the environment and clock the decision reads. */
  context?: ProducerDecisionContext
}

export async function wooProducerSeam(input: WooSeamInput): Promise<WooSeamAnswer> {
  let obligationAt = input.obligationAt
  if (obligationAt === undefined && input.resolveObligationAt) {
    const enforcement = readProducerEnforcement(input.context?.env ?? process.env)
    if (enforcement.enforced && enforcement.destinations.has('woocommerce')) {
      try {
        obligationAt = await input.resolveObligationAt()
      } catch {
        obligationAt = undefined
      }
    }
  }
  const verdict = producerSeamVerdict('woocommerce', input.operation, obligationAt, input.context)
  if (verdict.kind !== 'shadow') return { proceed: true }
  const notice = producerShadowNotice({ connector: 'woocommerce', reason: verdict.decision.reason, owner: verdict.decision.owner })
  let occurrences: number | null = null
  let recorded = false
  try {
    const client = input.client ?? db
    const result = await withSavepoint(client, () => recordOutboundShadow(client, {
      destination: 'woocommerce',
      operation: input.operation,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      payload: input.payload,
      ...(input.summary ? { summary: input.summary } : {}),
      decision: verdict.decision,
    }))
    occurrences = result.occurrences
    recorded = true
  } catch (error) {
    reportUnrecordedShadow({ destination: 'woocommerce', operation: input.operation, subject: `${input.subjectType} ${input.subjectId}`, error })
  }
  return { proceed: false, shadowed: true, notice, reason: verdict.decision.reason, recorded, occurrences }
}
