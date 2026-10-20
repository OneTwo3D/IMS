import { Prisma } from '@/app/generated/prisma/client'

/**
 * THE DURABLE HALF OF "IMS RECORDED A SHADOW": WHAT A DESTRUCTIVE READER ASKS WHEN THE SYNC ROW IS GONE.
 *
 * A shadowed Xero posting is a CANCELLED / HELD_SHADOW AccountingSyncLog row AND a row in `outbound_shadow_writes`. The sync
 * row expires with the sync-log retention window (it holds no ledger claim, so retention does not protect it); the shadow record
 * persists. A shadow is NOT proof that nothing is in the ledger: it says IMS did not send the posting, and the writer that owns
 * the operation in the current phase (Xeroom, a person) may have posted it. So a reader that would DESTROY the local record of
 * the document - an order hard-delete, an in-place edit of a posted movement, a correction of a posted invoice number - must go on
 * refusing after the sync row is gone. It asks here, by the subject the shadow was recorded for.
 *
 * It reads `outbound_shadow_writes` only; it writes nothing. Pass the client of the caller's own transaction.
 */
export type ShadowEvidenceClient = {
  $queryRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<T>
}

export type ShadowSubjectQuery = {
  /** The shadow's subject_type: the sync row's referenceType (SalesOrder, Shipment, StockMovement, DailyBatch ...). */
  subjectType: string
  /** subject_id equals one of these. */
  exactIds?: readonly string[]
  /** subject_id starts with one of these. */
  idPrefixes?: readonly string[]
  /** Restrict to these ownership-map operations; omitted means any operation recorded for the subject. */
  operations?: readonly string[]
}

export type DurableShadowRecord = {
  id: string
  operation: string
  subjectType: string
  subjectId: string
  occurrences: number
}

/**
 * The shadow records of a destination that match any of the subject queries. A client that cannot run the read THROWS: a
 * destructive reader must never read "could not ask" as "none recorded".
 */
export async function findDurableShadowRecords(
  client: ShadowEvidenceClient,
  destination: string,
  queries: readonly ShadowSubjectQuery[],
): Promise<DurableShadowRecord[]> {
  if (typeof client?.$queryRaw !== 'function') {
    throw new Error('findDurableShadowRecords needs a client that can read outbound_shadow_writes; refusing to treat "could not ask" as "none recorded"')
  }
  const arms: Prisma.Sql[] = []
  for (const query of queries) {
    const ids = [...(query.exactIds ?? [])].filter((id) => id !== '')
    const prefixes = [...(query.idPrefixes ?? [])].filter((prefix) => prefix !== '')
    const match: Prisma.Sql[] = []
    if (ids.length > 0) match.push(Prisma.sql`subject_id IN (${Prisma.join(ids)})`)
    for (const prefix of prefixes) match.push(Prisma.sql`left(subject_id, ${prefix.length}) = ${prefix}`)
    if (match.length === 0) continue
    const operation = query.operations && query.operations.length > 0
      ? Prisma.sql` AND operation IN (${Prisma.join([...query.operations])})`
      : Prisma.empty
    arms.push(Prisma.sql`(subject_type = ${query.subjectType} AND (${Prisma.join(match, ' OR ')})${operation})`)
  }
  if (arms.length === 0) return []
  const rows = await client.$queryRaw<Array<{ id: string; operation: string; subject_type: string; subject_id: string; occurrences: number | bigint }>>(Prisma.sql`
    SELECT id, operation, subject_type, subject_id, occurrences
    FROM outbound_shadow_writes
    WHERE destination = ${destination} AND (${Prisma.join(arms, ' OR ')})
    ORDER BY first_produced_at
    LIMIT 20
  `)
  return rows.map((row) => ({
    id: row.id,
    operation: row.operation,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    occurrences: Number(row.occurrences),
  }))
}

/**
 * Whether a durable shadow record names this accounting sync row as the carrier of its standing (`accounting_sync_log_id`). The sync row of a
 * shadow expires with retention while the record persists, so "the row named by a stamp is no longer on record" is not by itself evidence
 * that the posting was settled or abandoned: when this answers true the row WAS a shadow. A client that cannot run the read THROWS.
 */
export async function shadowRecordNamesSyncLog(client: ShadowEvidenceClient, syncLogId: string): Promise<boolean> {
  if (typeof client?.$queryRaw !== 'function') {
    throw new Error('shadowRecordNamesSyncLog needs a client that can read outbound_shadow_writes; refusing to treat "could not ask" as "none recorded"')
  }
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM outbound_shadow_writes WHERE accounting_sync_log_id = ${syncLogId} LIMIT 1
  `)
  return rows.length > 0
}
