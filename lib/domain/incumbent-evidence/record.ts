/**
 * KEEP THE INCUMBENT EVIDENCE OF AN IMPORTED STOREFRONT ORDER. BEST EFFORT, NEVER BLOCKS THE IMPORT.
 *
 * Called once for every order payload the storefront import handles, before it decides anything. It writes at most one row per
 * (order, kind) and only for an order that carries a mark, so an ordinary order costs no write. The row is evidence for the
 * coexistence check and drives nothing.
 *
 * A failure to keep the evidence must not fail (or even delay) the import, and must not be silent: it is logged as
 * `incumbent_evidence_unrecorded` with the closed kinds and the paid-time state, and `npm run writers:check` then refuses to
 * report ok (exit code `evidence-gap`) while such entries exist for work that could matter.
 */

import { db } from '@/lib/db'
import { logActivityPersisted } from '@/lib/activity-log'
import { INCUMBENT_EVIDENCE_UNRECORDED_ACTION, type IncumbentEvidenceKind } from '@/lib/security/writers-check-constants'
import { classifyIncumbentMeta, readWcPaidTime } from './classify'

export type EvidenceRecordResult =
  | { recorded: number }
  | { recorded: 0; unrecorded: true }

type OrderPayloadForEvidence = { id: number | string; meta_data?: unknown; date_paid_gmt?: unknown }

type EvidenceWriter = (input: { externalOrderId: string; kind: IncumbentEvidenceKind; paidAt: Date | null }) => Promise<void>
type UnrecordedWriter = (input: { kinds: string[]; paidState: 'paid' | 'unpaid' | 'unreadable'; paidAt: Date | null; reason: string }) => Promise<void>

async function upsertEvidence(input: { externalOrderId: string; kind: IncumbentEvidenceKind; paidAt: Date | null }): Promise<void> {
  // One statement, so two deliveries of one order cannot collide on the unique key.
  await db.$executeRaw`
    INSERT INTO incumbent_writer_evidence (id, connector, external_order_id, kind, paid_at, first_seen_at, last_seen_at)
    VALUES (gen_random_uuid()::text, 'woocommerce', ${input.externalOrderId}, ${input.kind}, ${input.paidAt}, now(), now())
    ON CONFLICT (connector, external_order_id, kind)
    DO UPDATE SET paid_at = EXCLUDED.paid_at, last_seen_at = now()`
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
  deps: { write?: EvidenceWriter; unrecorded?: UnrecordedWriter } = {},
): Promise<EvidenceRecordResult> {
  const write = deps.write ?? upsertEvidence
  const unrecorded = deps.unrecorded ?? logUnrecorded
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
    for (const kind of kinds as IncumbentEvidenceKind[]) {
      await write({ externalOrderId, kind, paidAt: paid.state === 'paid' ? paid.at : null })
    }
    return { recorded: kinds.length }
  } catch (error) {
    try {
      await unrecorded({ kinds, paidState: paid.state, paidAt: paid.state === 'paid' ? paid.at : null, reason: error instanceof Error ? error.name : 'error' })
    } catch (inner) {
      console.error('[incumbent-evidence] could not keep evidence or log that it could not', inner)
    }
    return { recorded: 0, unrecorded: true }
  }
}
