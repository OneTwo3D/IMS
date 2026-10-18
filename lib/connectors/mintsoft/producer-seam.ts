import { reportUnrecordedShadow } from '@/lib/domain/outbound-shadow/unrecorded'
import { db } from '@/lib/db'
import { withSavepoint } from '@/lib/db/savepoint'
import { recordOutboundShadow } from '@/lib/domain/outbound-shadow/record'
import { producerShadowNotice, type ProducerReason } from '@/lib/security/producer-disposition-constants'
import type { ProducerDecisionContext } from '@/lib/security/producer-disposition'
import { producerSeamVerdict, readProducerEnforcement } from '@/lib/security/producer-seam'
export { mintsoftDrainHold, mintsoftEgressHold, mintsoftEgressRefusalText } from './producer-egress'
import type { MappedOperation } from '@/lib/security/writer-ownership-map'
import { mintWmsWriteClearance } from '@/lib/connectors/wms/clearance'
import type { WmsWriteClearance, WmsWriteOperation } from '@/lib/connectors/wms/types'

/**
 * THE MINTSOFT PRODUCER SEAM: WHAT A MINTSOFT WRITER ASKS BEFORE IT PRODUCES OR SENDS ANYTHING.
 *
 * One module, three questions, one answer shape. Every place IMS can write to Mintsoft (an order create, amend, cancel or hold,
 * an order comment, a product upsert, a bundle create, an ASN, a product content update) asks through here, so the rule has
 * one implementation.
 *
 *   {@link mintsoftProducerSeam}   a producer asks, for ONE operation of the ownership map, before it claims, records or calls
 *                                  anything. `proceed` when the hold is not enforced for Mintsoft (legacy) or the decision is
 *                                  LIVE. Otherwise it records the shadow (outbound_shadow_writes, in the caller's transaction
 *                                  when one is given) and answers `shadowed`: the producer makes NOTHING and changes no state.
 *   `mintsoftDrainHold` (producer-egress.ts)   a pass over already-queued work asks, before it re-opens or claims any of it,
 *                                  whether the destination is in its live phase at all.
 *   `mintsoftEgressHold` (producer-egress.ts)  the last barrier in front of the Mintsoft transport. A producer that slipped past
 *                                  the seams still sends nothing.
 *
 * A SHADOW IS NOT A QUEUED, NOT A SENT AND NOT A FAILED OUTCOME. It is its own answer (`shadowed`), and every caller handles it
 * explicitly: it must never claim a link, stamp an order as pushed, count as a failure to retry, or be revived into a live write.
 */

export type MintsoftOperation = MappedOperation<'mintsoft'>

export type MintsoftShadow = {
  shadowed: true
  /** The single-sourced operator sentence: IMS did not send it, and this says nothing about the owner. */
  notice: string
  reason: ProducerReason
  /** Whether the durable record could be written. False is lost evidence (logged), never lost work: nothing was queued either way. */
  recorded: boolean
  /** How many times this exact work has been shadowed, or null when it could not be recorded. */
  occurrences: number | null
}

/** Compile-time: every operation a warehouse write can be cleared for is an operation of the ownership map for this destination. */
type EveryWriteOperationIsMapped = WmsWriteOperation extends MintsoftOperation ? true : never
const everyWriteOperationIsMapped: EveryWriteOperationIsMapped = true
void everyWriteOperationIsMapped

/**
 * `proceed: true` carries the CLEARANCE the warehouse write methods require as their last argument; a shadow carries none, so the
 * compiler makes every caller handle the shadow before it can write. The operation is part of the clearance's type.
 */
export type MintsoftSeamAnswer<Op extends WmsWriteOperation = WmsWriteOperation> =
  | { proceed: true; clearance: WmsWriteClearance<Op> }
  | ({ proceed: false } & MintsoftShadow)

export type MintsoftSeamInput<Op extends WmsWriteOperation = WmsWriteOperation> = {
  operation: Op
  /** The kind of thing the work is about (SalesOrder, Product, ...) and its id: the shadow's identity with the digest. */
  subjectType: string
  subjectId: string
  /**
   * What would have been sent. Digested, never stored. A function is evaluated ONLY when the decision is SHADOW, so a legacy
   * or LIVE producer builds nothing extra; one that throws is recorded as an unbuildable payload (the shadow is still kept).
   */
  payload: unknown | (() => unknown)
  summary?: Record<string, string | number | boolean | null>
  /** The business-event time, for an operation the ownership map marks as requiring it. */
  obligationAt?: Date | null
  /**
   * Resolves the business-event time lazily, ONLY when the hold is enforced for Mintsoft. Ignored when `obligationAt` is given.
   * A resolver that throws or returns nothing leaves the time absent, and an operation that requires it is then a shadow:
   * unreadable is never live.
   */
  resolveObligationAt?: () => Promise<Date | null | undefined>
  /** The caller's client (a transaction) so the record commits or rolls back with the business change. Defaults to the pool. */
  client?: object
  /** Test seam: the environment and clock the decision reads. */
  context?: ProducerDecisionContext
}

function evaluatePayload(payload: unknown | (() => unknown)): unknown {
  if (typeof payload !== 'function') return payload
  try {
    return (payload as () => unknown)()
  } catch (error) {
    return { unbuildable: error instanceof Error ? error.message.slice(0, 300) : 'payload could not be built' }
  }
}

export async function mintsoftProducerSeam<Op extends WmsWriteOperation>(input: MintsoftSeamInput<Op>): Promise<MintsoftSeamAnswer<Op>> {
  let obligationAt: Date | undefined = input.obligationAt ?? undefined
  if (obligationAt === undefined && input.resolveObligationAt) {
    const enforcement = readProducerEnforcement(input.context?.env ?? process.env)
    if (enforcement.enforced && enforcement.destinations.has('mintsoft')) {
      try {
        obligationAt = (await input.resolveObligationAt()) ?? undefined
      } catch {
        obligationAt = undefined
      }
    }
  }
  const verdict = producerSeamVerdict('mintsoft', input.operation, obligationAt, input.context)
  if (verdict.kind !== 'shadow') return { proceed: true, clearance: mintWmsWriteClearance<Op>() }
  const notice = producerShadowNotice({ connector: 'mintsoft', reason: verdict.decision.reason, owner: verdict.decision.owner })
  let occurrences: number | null = null
  let recorded = false
  try {
    const client = input.client ?? db
    const payload = evaluatePayload(input.payload)
    const result = await withSavepoint(client, () => recordOutboundShadow(client, {
      destination: 'mintsoft',
      operation: input.operation,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      payload,
      ...(input.summary ? { summary: input.summary } : {}),
      decision: verdict.decision,
    }))
    occurrences = result.occurrences
    recorded = true
  } catch (error) {
    reportUnrecordedShadow({ destination: 'mintsoft', operation: input.operation, subject: `${input.subjectType} ${input.subjectId}`, error })
  }
  return { proceed: false, shadowed: true, notice, reason: verdict.decision.reason, recorded, occurrences }
}
