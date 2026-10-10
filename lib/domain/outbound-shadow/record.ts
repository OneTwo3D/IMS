import { Prisma } from '@/app/generated/prisma/client'
import { payloadDigest } from '@/lib/domain/outbound-shadow/digest'
import type { ProducerDecision } from '@/lib/security/producer-disposition'
import type { OutboundConnector } from '@/lib/security/outbound-write-hold-constants'

/**
 * THE ONE WRITER OF `outbound_shadow_writes`: a RECORD of what IMS would have written while the producer-side hold
 * said SHADOW. It is never read to deliver anything.
 *
 * One row per distinct unit of work (destination, operation, subject, payload digest). The same work produced again
 * adds to `occurrences` and moves `last_produced_at`: one atomic `INSERT ... ON CONFLICT DO UPDATE`, so two
 * concurrent producers of the same work make one row with occurrences 2, in the caller's own client and
 * transaction (the row commits or rolls back with the business change that produced it).
 *
 * The payload is NOT stored: only its digest and a small `summary` the caller composes from non-secret fields.
 */
export type ShadowRawClient = {
  $queryRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<T>
  $executeRaw(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<number>
}

export type OutboundShadowInput = {
  destination: OutboundConnector
  operation: string
  subjectType: string
  subjectId: string
  /** What would have been sent. Digested, never stored. */
  payload: unknown
  summary?: Record<string, string | number | boolean | null>
  decision: ProducerDecision
}

export type OutboundShadowRecorded = {
  id: string
  /** True when this call created the row; false when it counted a repeat of existing work. */
  inserted: boolean
  occurrences: number
  /** The sync-log row that already carries this shadow's standing (Xero), when it still exists. */
  accountingSyncLogId: string | null
  digest: string
}

type RawResult = {
  id: string
  inserted: boolean
  occurrences: number
  accounting_sync_log_id: string | null
  sync_row_exists: boolean
}

export async function recordOutboundShadow(client: object, input: OutboundShadowInput): Promise<OutboundShadowRecorded> {
  const raw = client as ShadowRawClient
  const digest = payloadDigest(input.payload)
  const summary = JSON.stringify(input.summary ?? {})
  const cutoff = input.decision.cutoff === null ? null : input.decision.cutoff.toISOString()
  const rows = await raw.$queryRaw<RawResult[]>(Prisma.sql`
    INSERT INTO outbound_shadow_writes
      (id, destination, operation, subject_type, subject_id, payload_digest, summary, reason, owner, phase, cutoff, grant_state,
       first_produced_at, last_produced_at)
    VALUES
      (gen_random_uuid()::text, ${input.destination}, ${input.operation}, ${input.subjectType}, ${input.subjectId}, ${digest},
       ${summary}::jsonb, ${input.decision.reason}, ${input.decision.owner}, ${input.decision.phase},
       (${cutoff}::timestamptz AT TIME ZONE 'UTC'), ${input.decision.grant},
       (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))
    ON CONFLICT (destination, operation, subject_type, subject_id, payload_digest)
    DO UPDATE SET
      occurrences = outbound_shadow_writes.occurrences + 1,
      last_produced_at = (clock_timestamp() AT TIME ZONE 'UTC'),
      reason = EXCLUDED.reason,
      owner = EXCLUDED.owner,
      phase = EXCLUDED.phase,
      cutoff = EXCLUDED.cutoff,
      grant_state = EXCLUDED.grant_state
    RETURNING
      id,
      (xmax = 0) AS inserted,
      occurrences,
      accounting_sync_log_id,
      EXISTS (SELECT 1 FROM accounting_sync_logs s WHERE s.id = outbound_shadow_writes.accounting_sync_log_id) AS sync_row_exists
  `)
  const row = rows[0]
  if (!row) throw new Error('outbound_shadow_writes upsert returned no row')
  return {
    id: row.id,
    inserted: row.inserted === true,
    occurrences: Number(row.occurrences),
    accountingSyncLogId: row.sync_row_exists ? row.accounting_sync_log_id : null,
    digest,
  }
}

/** Point a shadow at the sync-log row that carries its standing (Xero). */
export async function attachShadowSyncLog(client: object, shadowId: string, accountingSyncLogId: string): Promise<void> {
  const raw = client as ShadowRawClient
  await raw.$executeRaw(Prisma.sql`UPDATE outbound_shadow_writes SET accounting_sync_log_id = ${accountingSyncLogId} WHERE id = ${shadowId}`)
}
