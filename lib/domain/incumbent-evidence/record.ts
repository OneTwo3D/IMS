/**
 * KEEP THE INCUMBENT EVIDENCE OF AN IMPORTED STOREFRONT ORDER. BEST EFFORT, OFF THE IMPORT'S CRITICAL PATH.
 *
 * Started once for every order payload the storefront import handles (`startWcIncumbentEvidence`), and NOT awaited by it: the
 * import never waits for the write, so a write blocked on the table (a lock, a stalled connection) cannot hold the import. It
 * writes at most one row per (order, kind) and only for an order that carries a mark, so an ordinary order costs no write. The row
 * is evidence for the coexistence check and drives nothing.
 *
 * The write is bounded twice: the statement runs with a lock timeout and a statement timeout set on its own transaction, and the
 * whole attempt is raced against a deadline. A failure or a timeout must not be silent: it is counted (`incumbentEvidenceStats`) and
 * logged as `incumbent_evidence_unrecorded` with the closed kinds and the paid-time state, and `npm run writers:check` then refuses
 * to report ok (exit code `evidence-gap`) while such entries exist for work that could matter. Background attempts in flight are
 * capped; an attempt over the cap is not started and is logged the same way.
 *
 * The row only ever moves toward more evidence: kinds are only added, and a paid time is only ever replaced by a later one (see
 * `upsertEvidence`), so no delivery, however stale or out of order, can make a recorded mark stop counting.
 */

import { db } from '@/lib/db'
import { logActivityPersisted } from '@/lib/activity-log'
import { INCUMBENT_EVIDENCE_UNRECORDED_ACTION, type IncumbentEvidenceKind } from '@/lib/security/writers-check-constants'
import { classifyIncumbentMeta, readWcPaidTime } from './classify'

export type EvidenceRecordResult =
  | { recorded: number }
  | { recorded: 0; unrecorded: true }

type OrderPayloadForEvidence = { id: number | string; meta_data?: unknown; date_paid_gmt?: unknown }

/** Bounds for one background attempt, in milliseconds. The two database timeouts sit inside the deadline so the statement ends by itself. */
export const EVIDENCE_LOCK_TIMEOUT_MS = 2_000
export const EVIDENCE_STATEMENT_TIMEOUT_MS = 3_000
export const EVIDENCE_DEADLINE_MS = 4_000
export const EVIDENCE_MAX_IN_FLIGHT = 50

export const incumbentEvidenceStats = { started: 0, recorded: 0, failed: 0, timedOut: 0, dropped: 0 }
export function resetIncumbentEvidenceStats(): void {
  incumbentEvidenceStats.started = 0; incumbentEvidenceStats.recorded = 0; incumbentEvidenceStats.failed = 0
  incumbentEvidenceStats.timedOut = 0; incumbentEvidenceStats.dropped = 0
}

class EvidenceDeadline extends Error {
  constructor() { super('deadline'); this.name = 'EvidenceDeadline' }
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new EvidenceDeadline()), ms)
  })
  // The losing side must never become an unhandled rejection.
  work.catch(() => {})
  return Promise.race([work, late]).finally(() => { if (timer) clearTimeout(timer) })
}

type EvidenceWriter = (input: { externalOrderId: string; kind: IncumbentEvidenceKind; paidAt: Date | null }) => Promise<void>
type UnrecordedWriter = (input: { kinds: string[]; paidState: 'paid' | 'unpaid' | 'unreadable'; paidAt: Date | null; reason: string }) => Promise<void>

async function upsertEvidence(input: { externalOrderId: string; kind: IncumbentEvidenceKind; paidAt: Date | null }): Promise<void> {
  // One upsert statement, so two deliveries of one order cannot collide on the unique key. MONOTONIC: GREATEST ignores a null, so a
  // recorded paid time is never replaced by "unpaid" (null) or by an earlier time, and a null is replaced by any time. A stale,
  // unpaid or out-of-order delivery therefore cannot rewind what a qualifying delivery recorded, in either order of arrival.
  // The two timeouts are local to this transaction (transaction-local settings), so a blocked table ends this statement rather than holding a connection.
  await db.$transaction([
    db.$queryRaw`SELECT set_config('lock_timeout', ${`${EVIDENCE_LOCK_TIMEOUT_MS}ms`}, true)`,
    db.$queryRaw`SELECT set_config('statement_timeout', ${`${EVIDENCE_STATEMENT_TIMEOUT_MS}ms`}, true)`,
    db.$executeRaw`
      INSERT INTO incumbent_writer_evidence (id, connector, external_order_id, kind, paid_at, first_seen_at, last_seen_at)
      VALUES (gen_random_uuid()::text, 'woocommerce', ${input.externalOrderId}, ${input.kind}, ${input.paidAt}, now(), now())
      ON CONFLICT (connector, external_order_id, kind)
      DO UPDATE SET paid_at = GREATEST(incumbent_writer_evidence.paid_at, EXCLUDED.paid_at), last_seen_at = now()`,
  ])
}

async function logUnrecorded(input: { kinds: string[]; paidState: 'paid' | 'unpaid' | 'unreadable'; paidAt: Date | null; reason: string }): Promise<void> {
  const persisted = await logActivityPersisted({
    entityType: 'SYNC',
    entityId: null,
    action: INCUMBENT_EVIDENCE_UNRECORDED_ACTION,
    tag: 'sync',
    level: 'WARNING',
    description: `Incumbent writer evidence for a storefront order could not be kept (${input.reason}); the coexistence check cannot see it.`,
    metadata: { connector: 'woocommerce', kinds: input.kinds, paidState: input.paidState, paidAt: input.paidAt ? input.paidAt.toISOString() : null },
    resolveUser: false,
  })
  if (!persisted) console.error('[incumbent-evidence] could not log that evidence went unrecorded')
}

export async function recordWcIncumbentEvidence(
  order: OrderPayloadForEvidence,
  deps: { write?: EvidenceWriter; unrecorded?: UnrecordedWriter; deadlineMs?: number } = {},
): Promise<EvidenceRecordResult> {
  const write = deps.write ?? upsertEvidence
  const unrecordedWriter = deps.unrecorded ?? logUnrecorded
  const deadlineMs = deps.deadlineMs ?? EVIDENCE_DEADLINE_MS
  const unrecorded: UnrecordedWriter = (input) => withDeadline(unrecordedWriter(input), deadlineMs)
  let kinds: string[] = []
  let paid: ReturnType<typeof readWcPaidTime> = { state: 'unreadable' }
  try {
    const classified = classifyIncumbentMeta(order.meta_data)
    paid = readWcPaidTime(order.date_paid_gmt)
    if (!classified.ok) {
      await unrecorded({ kinds: ['META_UNREADABLE'], paidState: paid.state, paidAt: paid.state === 'paid' ? paid.at : null, reason: 'the order\'s meta list is not a list' })
      return { recorded: 0, unrecorded: true }
    }
    kinds = classified.kinds
    if (kinds.length === 0) return { recorded: 0 }
    if (paid.state === 'unreadable') {
      await unrecorded({ kinds, paidState: 'unreadable', paidAt: null, reason: 'the paid time cannot be read' })
      return { recorded: 0, unrecorded: true }
    }
    const externalOrderId = String(order.id)
    const paidAt = paid.state === 'paid' ? paid.at : null
    await withDeadline((async () => {
      for (const kind of kinds as IncumbentEvidenceKind[]) await write({ externalOrderId, kind, paidAt })
    })(), deadlineMs)
    incumbentEvidenceStats.recorded += 1
    return { recorded: kinds.length }
  } catch (error) {
    if (error instanceof EvidenceDeadline) incumbentEvidenceStats.timedOut += 1
    else incumbentEvidenceStats.failed += 1
    try {
      await unrecorded({ kinds, paidState: paid.state, paidAt: paid.state === 'paid' ? paid.at : null, reason: error instanceof Error ? error.name : 'error' })
    } catch (inner) {
      console.error('[incumbent-evidence] could not keep evidence or log that it could not', inner)
    }
    return { recorded: 0, unrecorded: true }
  }
}

const inFlight = new Set<Promise<unknown>>()

/**
 * Start keeping the evidence WITHOUT making the caller wait for it. Returns nothing: there is no promise for the import to await,
 * so no outcome of the write (success, failure, a hang) can delay or change the import. The attempt is bounded and its failure is
 * counted and logged inside `recordWcIncumbentEvidence`; here only the cap on attempts in flight is added.
 */
export function startWcIncumbentEvidence(
  order: OrderPayloadForEvidence,
  deps: Parameters<typeof recordWcIncumbentEvidence>[1] = {},
): void {
  try {
    incumbentEvidenceStats.started += 1
    if (inFlight.size >= EVIDENCE_MAX_IN_FLIGHT) {
      incumbentEvidenceStats.dropped += 1
      const unrecorded = deps.unrecorded ?? logUnrecorded
      const classified = classifyIncumbentMeta(order.meta_data)
      const paid = readWcPaidTime(order.date_paid_gmt)
      // An order with no mark has nothing to lose; any other (or unreadable) is logged so the check sees the gap.
      if (classified.ok && classified.kinds.length === 0) return
      const attempt = withDeadline(unrecorded({
        kinds: classified.ok ? classified.kinds : ['META_UNREADABLE'], paidState: paid.state, paidAt: paid.state === 'paid' ? paid.at : null, reason: 'too many evidence writes in flight',
      }), deps.deadlineMs ?? EVIDENCE_DEADLINE_MS).catch(() => {})
      inFlight.add(attempt)
      void attempt.finally(() => inFlight.delete(attempt))
      return
    }
    const attempt = recordWcIncumbentEvidence(order, deps).catch(() => {})
    inFlight.add(attempt)
    void attempt.finally(() => inFlight.delete(attempt))
  } catch {
    // Never throws into the import.
  }
}

/** For tests and shutdown: resolves when every attempt started so far has finished. Not for the import. */
export async function settleWcIncumbentEvidence(): Promise<void> {
  await Promise.allSettled([...inFlight])
}
